import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TIERS,
  tierCap,
  allowance,
  countRounds,
  budgetPath,
  extensionPath,
  checkPath,
  loadLoop,
  mentionsReviewRequest,
  prNumberFrom,
  targetsThisRepo,
  validateBudget,
  validateExtension,
  validateCheckReceipt,
  assertCountingSnapshot,
  judgeReviewRequest,
  MAX_CHECK_AGE_MS,
  REPO_OWNER,
  REPO_NAME,
} from "../review-budget.mjs";

// ---------------------------------------------------------------------------
// A filesystem the tests can assert against. The guard's whole decision is a
// function of these files plus one fresh snapshot, so faking them is faking
// the world.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

export function fakeIo(files = {}) {
  const store = { ...files };
  return {
    store,
    now: () => new Date(NOW).toISOString(),
    read: (rel) => (rel in store ? store[rel] : null),
    exists: (rel) => rel in store,
    listReceipts: () =>
      Object.keys(store)
        .filter((k) => k.startsWith(".agents/receipts/"))
        .map((k) => k.slice(".agents/receipts/".length)),
    write: (rel, text) => {
      store[rel] = text;
    },
  };
}

const json = (value) => JSON.stringify(value, null, 2);

const budget = (pr, tier = "internal", extra = {}) =>
  json({
    pr,
    tier,
    budget: TIERS[tier].budget,
    criticality: 30,
    artifact: "a thing under review",
    declaredAt: "2026-08-17T00:00:00.000Z",
    ...extra,
  });

/**
 * A round-check receipt: the fresh evidence the guard demands. `spent` is the
 * counted round total; everything else is what makes it trustworthy.
 */
const check = (pr, spent, extra = {}) =>
  json({
    pr,
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    capturedAt: new Date(NOW - 60_000).toISOString(),
    delivered: spent,
    pending: 0,
    spent,
    ...extra,
  });

/**
 * The mechanical record an adjudication cites. It must show the loop AT its
 * cap, which is what proves the adjudication followed a fired tripwire.
 */
const recordFile = (pr, passes = 3) =>
  json({
    generator: "scripts/review-loop-record.mjs",
    pr,
    rounds: { completedReviewerPasses: passes },
  });
const RECORD = (pr) => `.agents/adjudications/${pr}-1.json`;

const adjudication = (pr, extra = {}) => ({
  pr,
  kind: "adjudication",
  verdict: "continue",
  grant: 2,
  risk: "the retry path can double-charge on a 409",
  recordPath: RECORD(pr),
  ...extra,
});

const post = (pr, body = "@codex review") => ({
  toolName: "mcp__github__add_issue_comment",
  toolInput: { owner: REPO_OWNER, repo: REPO_NAME, issue_number: pr, body },
});

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

test("the trigger phrase is detected in the shapes it is actually posted in", () => {
  assert.equal(mentionsReviewRequest("@codex review"), true);
  assert.equal(mentionsReviewRequest("Round 2 fixes pushed.\n\n@codex review — please confirm."), true);
  assert.equal(
    mentionsReviewRequest("@codex review — round 3 of 3"),
    true,
    "trailing text on the trigger line is a shape this repo has used successfully (PR #488 round 10)",
  );
  assert.equal(mentionsReviewRequest("@Codex   review"), true, "case and spacing vary in practice");
  assert.equal(mentionsReviewRequest("@codex reviewed the thing"), false, "word boundary, not a prefix match");
  assert.equal(mentionsReviewRequest("thanks codex, review looks good"), false);
  assert.equal(mentionsReviewRequest(undefined), false);
});

test("the PR number is read from either resource's parameter name", () => {
  assert.equal(prNumberFrom({ issue_number: 502 }), 502, "add_issue_comment addresses the issue resource");
  assert.equal(prNumberFrom({ pullNumber: 502 }), 502, "the pull-resource tools use pullNumber");
  assert.equal(prNumberFrom({ pullNumber: "502" }), 502);
  assert.equal(prNumberFrom({}), null);
  assert.equal(prNumberFrom({ pullNumber: 0 }), null);
});

test("only this repo's loops are budgeted", () => {
  assert.equal(targetsThisRepo({ owner: REPO_OWNER, repo: REPO_NAME }), true);
  assert.equal(targetsThisRepo({ owner: "someone", repo: "else" }), false);
});

// ---------------------------------------------------------------------------
// Tier table
// ---------------------------------------------------------------------------

test("the tiers are the ones the contract declares", () => {
  assert.equal(tierCap("internal"), 3);
  assert.equal(tierCap("product"), 5);
  assert.equal(tierCap("sensitive"), 5, "uncapped, but the mandatory stop is at 5");
  assert.equal(TIERS.sensitive.budget, null);
  assert.equal(TIERS.sensitive.selfServe, false, "auth/payments/migrations never self-serve their tripwire");
});

// ---------------------------------------------------------------------------
// Counting rounds from evidence — the heart of the redesign
// ---------------------------------------------------------------------------

const pass = (iso) => ({ at: iso });
const comment = (iso, body = "@codex review") => ({ created_at: iso, body });

test("a round is a completed reviewer pass, counted from GitHub", () => {
  const counted = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z"), pass("2026-08-17T11:00:00Z")],
    issueComments: [],
  });
  assert.deepEqual(counted, { delivered: 2, pending: 0, spent: 2 });
});

test("the automatic opening review needs no special flag — it is simply a pass", () => {
  // The first design carried an `autoOpeningReview` boolean because it counted
  // trigger posts. Counting passes makes the distinction disappear.
  const counted = countRounds({ reviewerPasses: [pass("2026-08-17T10:00:00Z")], issueComments: [] });
  assert.equal(counted.spent, 1);
});

test("a request awaiting its review counts as one pending round", () => {
  const counted = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z")],
    issueComments: [comment("2026-08-17T10:30:00Z")],
  });
  assert.deepEqual(counted, { delivered: 1, pending: 1, spent: 2 });
});

test("a stall and its retry are ONE pending round, not two", () => {
  // This is what dissolves the first design's phantom round: two trigger
  // comments with no pass between them are one round in flight, and when the
  // retry's pass lands the pending count returns to zero on its own — with no
  // reconciliation step, because nothing was written down to reconcile.
  const stalled = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z")],
    issueComments: [comment("2026-08-17T10:30:00Z"), comment("2026-08-17T10:45:00Z")],
  });
  assert.deepEqual(stalled, { delivered: 1, pending: 1, spent: 2 }, "two requests, one round in flight");

  const answered = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z"), pass("2026-08-17T11:00:00Z")],
    issueComments: [comment("2026-08-17T10:30:00Z"), comment("2026-08-17T10:45:00Z")],
  });
  assert.deepEqual(answered, { delivered: 2, pending: 0, spent: 2 }, "the stall costs nothing once answered");
});

test("a trigger comment BEFORE the last pass is that pass's request, not a pending one", () => {
  const counted = countRounds({
    reviewerPasses: [pass("2026-08-17T11:00:00Z")],
    issueComments: [comment("2026-08-17T10:00:00Z")],
  });
  assert.equal(counted.pending, 0);
});

test("an ordinary comment after the last pass is not a pending round", () => {
  const counted = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z")],
    issueComments: [comment("2026-08-17T10:30:00Z", "Fixed in abc123 — resolving.")],
  });
  assert.equal(counted.pending, 0);
});

// ---------------------------------------------------------------------------
// Budget receipt validation
// ---------------------------------------------------------------------------

test("a budget cannot declare a number its tier does not have", () => {
  const receipt = JSON.parse(budget(1, "internal"));
  assert.equal(validateBudget(1, receipt), null);

  receipt.budget = 20;
  assert.match(
    validateBudget(1, receipt),
    /declares budget 20 but tier "internal" is 3/,
    "a free-text budget field is the no-stopping-rule state wearing a receipt",
  );
});

test("a budget receipt for the wrong PR is refused, not adopted", () => {
  assert.match(validateBudget(2, JSON.parse(budget(1))), /names PR 1, not 2/);
});

test("a budget receipt needs a criticality rating and a named artifact", () => {
  assert.match(validateBudget(1, JSON.parse(budget(1, "internal", { criticality: null }))), /criticality/);
  assert.match(validateBudget(1, JSON.parse(budget(1, "internal", { artifact: "  " }))), /artifact/);
});

// ---------------------------------------------------------------------------
// Extension receipts — the tier-2 rule and the follows-its-tripwire rule
// ---------------------------------------------------------------------------

test("a valid adjudication extension passes", () => {
  assert.equal(validateExtension(1, "internal", adjudication(1), { adjudicationsAlreadySeen: 0, io: null }), null);
});

test("a SECOND adjudication extension is never valid", () => {
  assert.match(
    validateExtension(1, "internal", adjudication(1), { adjudicationsAlreadySeen: 1, io: null }),
    /SECOND adjudication extension is never valid/,
  );
});

test("a continue verdict must name a behavioral risk and grant at most 2", () => {
  assert.match(
    validateExtension(1, "internal", adjudication(1, { risk: "" }), { adjudicationsAlreadySeen: 0, io: null }),
    /must name the specific unaddressed BEHAVIORAL risk/,
  );
  assert.match(
    validateExtension(1, "internal", adjudication(1, { grant: 5 }), { adjudicationsAlreadySeen: 0, io: null }),
    /grants 1-2 rounds/,
  );
});

test("a non-continue verdict is valid but grants nothing", () => {
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "", recordPath: "" });
  assert.equal(validateExtension(1, "internal", shipped, { adjudicationsAlreadySeen: 0, io: null }), null);
  assert.equal(allowance("internal", [shipped], 3), 3, "a stop verdict does not extend the budget");
});

test("the sensitive tier has no self-serve extension at all", () => {
  assert.match(
    validateExtension(1, "sensitive", adjudication(1), { adjudicationsAlreadySeen: 0, io: null }),
    /no self-serve extension/,
  );
});

test("a David authorization must quote his words and grant something concrete", () => {
  const ok = { pr: 1, kind: "david", grant: 3, authorization: "go ahead, three more" };
  assert.equal(validateExtension(1, "internal", ok, { adjudicationsAlreadySeen: 1, io: null }), null);
  assert.equal(allowance("internal", [ok], 3), 6);

  assert.match(
    validateExtension(1, "internal", { ...ok, authorization: "" }, { adjudicationsAlreadySeen: 1, io: null }),
    /quote his words/,
  );
  assert.match(
    validateExtension(1, "internal", { ...ok, grant: 0 }, { adjudicationsAlreadySeen: 1, io: null }),
    /positive integer of rounds or "uncapped"/,
  );
  assert.equal(allowance("sensitive", [{ ...ok, grant: "uncapped" }], 5), Infinity);
});

test("an unknown extension kind is refused rather than ignored", () => {
  assert.match(
    validateExtension(1, "internal", { pr: 1, kind: "self", grant: 9 }, { adjudicationsAlreadySeen: 0, io: null }),
    /is not "adjudication" or "david"/,
  );
});

test("a continue verdict citing a missing, foreign, or hand-written record grants nothing", () => {
  const withReceipt = (extra) =>
    fakeIo({
      [budgetPath(1)]: budget(1),
      [extensionPath(1, 1)]: json(adjudication(1)),
      ...extra,
    });

  assert.match(loadLoop(1, withReceipt({})).detail, /does not exist/);
  assert.match(loadLoop(1, withReceipt({ [RECORD(1)]: recordFile(2) })).detail, /describes PR 2, not 1/);
  assert.match(
    loadLoop(1, withReceipt({ [RECORD(1)]: json({ pr: 1, generator: "hand-written" }) })).detail,
    /was not produced by review-loop-record\.mjs/,
  );
});

test("an adjudication must FOLLOW its tripwire, proven by the record it cites", () => {
  // The bypass this closes: a continue receipt written before the cap was ever
  // reached activates the moment the arithmetic crosses the boundary, so
  // tripwire 1 never refuses and the aggregate is never presented — which is
  // the entire failure this module exists to prevent, arriving through the
  // mechanism meant to prevent it. (Codex, #503 rounds 1 and 3.)
  const early = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1)),
    [RECORD(1)]: recordFile(1, 1), // generated at 1 pass, cap is 3
  });
  assert.match(loadLoop(1, early).detail, /below tier "internal"'s cap of 3/);

  const atCap = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1)),
    [RECORD(1)]: recordFile(1, 3),
  });
  assert.equal(loadLoop(1, atCap).problem, undefined, "generated at the cap is valid");
});

// ---------------------------------------------------------------------------
// loadLoop — fail closed on anything unreadable or ambiguous
// ---------------------------------------------------------------------------

test("a malformed receipt refuses the loop instead of being skipped", () => {
  const io = fakeIo({ [budgetPath(1)]: "{ not json" });
  assert.match(loadLoop(1, io).detail, /could not be read \(malformed/);
});

test("an unreadable receipt is refused, never read as absent", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1) });
  io.read = (rel) => {
    if (rel === budgetPath(1)) throw new Error("EACCES: permission denied");
    return rel in io.store ? io.store[rel] : null;
  };
  assert.match(loadLoop(1, io).detail, /could not be read \(unreadable/);
});

test("an unlistable receipts directory refuses rather than forgetting every extension", () => {
  // Returning [] here used to hide a spent adjudication, showing tripwire 1
  // again instead of the hard stop to David. (Codex, #503 round 3.)
  const io = fakeIo({ [budgetPath(1)]: budget(1) });
  io.listReceipts = () => {
    throw new Error("EACCES: permission denied");
  };
  assert.match(loadLoop(1, io).detail, /could not be listed/);
});

test("a zero-padded extension name is refused, not normalised onto a canonical one", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json({ pr: 1, kind: "david", grant: 2, authorization: "ok" }),
    ".agents/receipts/loop-extension-1-01.json": json({ pr: 1, kind: "david", grant: 2, authorization: "ok" }),
  });
  assert.match(loadLoop(1, io).detail, /not a canonical extension name/);
});

test("two receipts claiming one sequence refuse the loop", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1) });
  io.listReceipts = () => ["loop-extension-1-1.json", "loop-extension-1-1.json"];
  assert.match(loadLoop(1, io).detail, /claim sequence 1/);
});

test("the next extension path is max+1, so a sequence gap never overwrites a receipt", () => {
  // With receipts 1 and 3 on disk, length+1 pointed at 3 and would have
  // overwritten it — destroying authorization history and possibly the active
  // grant. (Codex, #503 round 3.)
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1)),
    [RECORD(1)]: recordFile(1, 3),
    [extensionPath(1, 3)]: json({ pr: 1, kind: "david", grant: 1, authorization: "ok" }),
  });
  assert.equal(loadLoop(1, io).nextSeq, 4);
});

test("extensions are read in sequence order, not directory order", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 2)]: json({ pr: 1, kind: "david", grant: 1, authorization: "ok" }),
    [extensionPath(1, 1)]: json(adjudication(1)),
    [RECORD(1)]: recordFile(1, 3),
  });
  const state = loadLoop(1, io);
  assert.deepEqual(state.extensions.map((e) => e.kind), ["adjudication", "david"]);
  assert.equal(allowance("internal", state.extensions, 5), 3 + 2 + 1);
});

// ---------------------------------------------------------------------------
// Allowance staging
// ---------------------------------------------------------------------------

test("an extension stays dormant until the stage before it is spent", () => {
  const extensions = [adjudication(1, { grant: 2 })];
  assert.equal(allowance("internal", extensions, 1), 3, "dormant: the base cap is not exhausted");
  assert.equal(allowance("internal", extensions, 3), 5, "active at the round it was meant to rule on");
});

test("a David grant activates only after the adjudication before it is spent", () => {
  const extensions = [
    { kind: "adjudication", verdict: "continue", grant: 2 },
    { kind: "david", grant: 4, authorization: "ok" },
  ];
  assert.equal(allowance("internal", extensions, 3), 5, "the David grant is still dormant at 3");
  assert.equal(allowance("internal", extensions, 5), 9, "and activates at 5");
});

test("allowance refuses a nonsense spent count rather than defaulting", () => {
  // The old Infinity default silently activated every extension for any
  // caller that forgot the argument. (Codex, #503 round 3.)
  assert.throws(() => allowance("internal", [], undefined), /non-negative integer roundsSpent/);
  assert.throws(() => allowance("internal", [], -1), /non-negative integer roundsSpent/);
});

// ---------------------------------------------------------------------------
// The round-check receipt: fresh evidence, one post
// ---------------------------------------------------------------------------

test("a round-check receipt must be bound to this PR and repo", () => {
  assert.match(validateCheckReceipt(1, JSON.parse(check(2, 0)), NOW), /names PR 2, not 1/);
  assert.match(
    validateCheckReceipt(1, { ...JSON.parse(check(1, 0)), repo: "someone/else" }, NOW),
    /minted for someone\/else/,
  );
});

test("a stale round-check receipt is refused", () => {
  const old = { ...JSON.parse(check(1, 0)), capturedAt: new Date(NOW - MAX_CHECK_AGE_MS - 1000).toISOString() };
  assert.match(validateCheckReceipt(1, old, NOW), /no longer current/);

  const future = { ...JSON.parse(check(1, 0)), capturedAt: new Date(NOW + 60_000).toISOString() };
  assert.match(validateCheckReceipt(1, future, NOW), /no longer current/, "a future capture is not evidence either");
});

test("a consumed round-check receipt cannot authorize a second post", () => {
  const used = { ...JSON.parse(check(1, 0)), consumedAt: "2026-08-17T11:00:00.000Z" };
  assert.match(validateCheckReceipt(1, used, NOW), /already consumed/);
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("no budget declared refuses the very first round", () => {
  const { blocked, reason } = judgeReviewRequest(post(1), fakeIo(), NOW);
  assert.equal(blocked, true);
  assert.match(reason, /no round budget declared/);
  assert.match(reason, /review-budget\.mjs declare/, "the refusal has to say what to do next");
});

test("a declared budget with no round-check receipt still refuses", () => {
  const { blocked, reason } = judgeReviewRequest(post(1), fakeIo({ [budgetPath(1)]: budget(1) }), NOW);
  assert.equal(blocked, true);
  assert.match(reason, /no round-check receipt/);
  assert.match(reason, /evidence, not recollection/);
  assert.match(reason, /review-budget\.mjs check/);
});

test("an in-budget round is allowed, and consumes its receipt", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1), [checkPath(1)]: check(1, 2) });
  assert.equal(judgeReviewRequest(post(1), io, NOW).blocked, false);
  assert.equal(JSON.parse(io.store[checkPath(1)]).consumedAt, new Date(NOW).toISOString());

  assert.match(
    judgeReviewRequest(post(1), io, NOW).reason,
    /already consumed/,
    "one check authorizes exactly one post",
  );
});

test("the round at the budget is refused, and the refusal names tripwire 1 and Fable", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1), [checkPath(1)]: check(1, 3) });
  const { blocked, reason } = judgeReviewRequest(post(1), io, NOW);
  assert.equal(blocked, true);
  assert.match(reason, /TRIPWIRE 1/);
  assert.match(reason, /ON FABLE/);
  assert.match(reason, /model: "fable"/);
  assert.match(reason, /review-loop-record\.mjs/, "the record is script-generated, never the loop's prose");
  assert.match(reason, /counted from GitHub's own record/);
  assert.equal(JSON.parse(io.store[checkPath(1)]).consumedAt, undefined, "a refused round consumes nothing");
});

test("a valid extension reopens the guard for exactly the rounds it granted", () => {
  const base = {
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 1 })),
    [RECORD(1)]: recordFile(1, 3),
  };
  assert.equal(
    judgeReviewRequest(post(1), fakeIo({ ...base, [checkPath(1)]: check(1, 3) }), NOW).blocked,
    false,
    "round 4 is inside the +1 grant",
  );
  assert.equal(
    judgeReviewRequest(post(1), fakeIo({ ...base, [checkPath(1)]: check(1, 4) }), NOW).blocked,
    true,
    "round 5 is not",
  );
});

test("tripwire 2 is a hard stop to David, with no second self-service extension", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
    [RECORD(1)]: recordFile(1, 3),
    [checkPath(1)]: check(1, 5),
  });
  const { blocked, reason } = judgeReviewRequest(post(1), io, NOW);
  assert.equal(blocked, true);
  assert.match(reason, /TRIPWIRE 2/);
  assert.match(reason, /never a second one/);
  assert.match(reason, /🛑 NEED YOU/);
});

test("a second adjudication receipt refuses the post rather than granting rounds", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
    [extensionPath(1, 2)]: json(adjudication(1, { grant: 2 })),
    [RECORD(1)]: recordFile(1, 3),
    [checkPath(1)]: check(1, 5),
  });
  assert.match(judgeReviewRequest(post(1), io, NOW).reason, /SECOND adjudication extension is never valid/);
});

test("David's authorization clears tripwire 2", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
    [extensionPath(1, 2)]: json({ pr: 1, kind: "david", grant: 2, authorization: "yes, keep going" }),
    [RECORD(1)]: recordFile(1, 3),
    [checkPath(1)]: check(1, 5),
  });
  assert.equal(judgeReviewRequest(post(1), io, NOW).blocked, false);
});

test("the sensitive tier runs to 5 and then stops for David, self-serve unavailable", () => {
  const at4 = fakeIo({ [budgetPath(1)]: budget(1, "sensitive"), [checkPath(1)]: check(1, 4) });
  assert.equal(judgeReviewRequest(post(1), at4, NOW).blocked, false, "uncapped below the mandatory stop");

  const at5 = fakeIo({ [budgetPath(1)]: budget(1, "sensitive"), [checkPath(1)]: check(1, 5) });
  const { blocked, reason } = judgeReviewRequest(post(1), at5, NOW);
  assert.equal(blocked, true);
  assert.match(reason, /TRIPWIRE 2/, "sensitive work skips the self-serve tripwire entirely");
});

test("a review request with no readable PR number is refused, not waved through", () => {
  const call = {
    toolName: "mcp__github__add_issue_comment",
    toolInput: { owner: REPO_OWNER, repo: REPO_NAME, body: "@codex review" },
  };
  assert.match(judgeReviewRequest(call, fakeIo(), NOW).reason, /no readable PR number/);
});

test("ordinary comments, other repos, and other tools are untouched", () => {
  const io = fakeIo();
  assert.equal(judgeReviewRequest(post(1, "Fixed in abc123 — thanks."), io, NOW).blocked, false);
  assert.equal(
    judgeReviewRequest(
      {
        toolName: "mcp__github__add_issue_comment",
        toolInput: { owner: "other", repo: "repo", issue_number: 1, body: "@codex review" },
      },
      io,
      NOW,
    ).blocked,
    false,
  );
  assert.equal(
    judgeReviewRequest({ toolName: "mcp__github__create_pull_request", toolInput: { body: "@codex review" } }, io, NOW)
      .blocked,
    false,
  );
  assert.deepEqual(io.store, {}, "nothing is written for a call that is not a review request");
});

// ---------------------------------------------------------------------------
// Snapshot validation for `check`
// ---------------------------------------------------------------------------

const snapshot = (pr, extra = {}) => ({
  pr: { number: pr },
  reviews: [{ id: 1, user: { login: "chatgpt-codex-connector[bot]" }, submitted_at: "2026-08-17T10:00:00Z" }],
  issueComments: [{ id: 2, user: { login: "TheAnswerManIsHere" }, created_at: "2026-08-17T10:30:00Z", body: "hi" }],
  complete: { reviews: true, issueComments: true },
  ...extra,
});

test("a counting snapshot must describe this PR and be attested complete", () => {
  assert.doesNotThrow(() => assertCountingSnapshot(1, snapshot(1)));
  assert.throws(() => assertCountingSnapshot(2, snapshot(1)), /describes PR 1, but --pr says 2/);
  assert.throws(
    () => assertCountingSnapshot(1, snapshot(1, { complete: { reviews: true, issueComments: false } })),
    /complete\.issueComments === true/,
  );
});

test("a snapshot whose entries lack the counted fields is rejected, not undercounted", () => {
  // An attested-complete snapshot with unusable entries would be silently
  // undercounted by reviewerPasses — wrong in the guard's favour. (Codex,
  // #503 round 3.)
  assert.throws(
    () => assertCountingSnapshot(1, snapshot(1, { reviews: [{ user: { login: "x" }, submitted_at: "2026-08-17T10:00:00Z" }] })),
    /reviews\[0\] is missing id/,
  );
  assert.throws(
    () => assertCountingSnapshot(1, snapshot(1, { reviews: [{ id: 1, user: { login: "x" }, submitted_at: "nope" }] })),
    /parseable submitted_at/,
  );
  assert.throws(
    () => assertCountingSnapshot(1, snapshot(1, { issueComments: [{ id: 1, created_at: "2026-08-17T10:00:00Z" }] })),
    /issueComments\[0\] is missing id, user\.login/,
  );
});
