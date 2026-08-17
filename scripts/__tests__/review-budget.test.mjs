import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TIERS,
  tierCap,
  allowance,
  budgetPath,
  roundsPath,
  extensionPath,
  loadLoop,
  mentionsReviewRequest,
  prNumberFrom,
  targetsThisRepo,
  validateBudget,
  validateExtension,
  validateRounds,
  roundsSpent,
  reconcileRounds,
  judgeReviewRequest,
  REPO_OWNER,
  REPO_NAME,
} from "../review-budget.mjs";

// ---------------------------------------------------------------------------
// A filesystem the tests can assert against. The guard's whole decision is a
// function of these files, so faking them is faking the world.
// ---------------------------------------------------------------------------

export function fakeIo(files = {}) {
  const store = { ...files };
  return {
    store,
    now: () => "2026-08-17T00:00:00.000Z",
    read: (rel) => (rel in store ? store[rel] : null),
    exists: (rel) => rel in store,
    listReceipts: () =>
      Object.keys(store)
        .filter((k) => k.startsWith(".agents/receipts/"))
        .map((k) => k.slice(".agents/receipts/".length)),
    write: (rel, text) => {
      store[rel] = text;
    },
    // Defaults to "the tally on disk is what HEAD has", so the durability
    // check is out of the way of every test that is not about it.
    committedRounds: (rel) => (rel in store ? JSON.parse(store[rel]).rounds.length : 0),
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
    // false by default so each test's round arithmetic is the tally alone;
    // the opening-pass accounting has its own tests below.
    autoOpeningReview: false,
    declaredAt: "2026-08-17T00:00:00.000Z",
    ...extra,
  });

/**
 * The mechanical record an adjudication receipt cites. The guard resolves it,
 * so a store without it is a receipt citing a record that does not exist —
 * which is its own test below, not the default for every other one.
 */
const recordFile = (pr) =>
  json({ generator: "scripts/review-loop-record.mjs", pr, generatedAt: "2026-08-17T00:00:00.000Z" });
const RECORD = (pr) => `.agents/adjudications/${pr}-1.json`;

const rounds = (pr, n) =>
  json({ pr, rounds: Array.from({ length: n }, () => ({ at: "2026-08-17T00:00:00.000Z", tool: "t" })) });

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

test("the trigger phrase is detected in the shapes it is actually posted in", () => {
  assert.equal(mentionsReviewRequest("@codex review"), true);
  assert.equal(mentionsReviewRequest("Round 2 fixes pushed.\n\n@codex review — please confirm."), true);
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
  const noCriticality = JSON.parse(budget(1, "internal", { criticality: null }));
  assert.match(validateBudget(1, noCriticality), /criticality/);
  const noArtifact = JSON.parse(budget(1, "internal", { artifact: "  " }));
  assert.match(validateBudget(1, noArtifact), /artifact/);
});

// ---------------------------------------------------------------------------
// Extension receipt validation — the tier-2 rule lives here
// ---------------------------------------------------------------------------

const adjudication = (pr, extra = {}) => ({
  pr,
  kind: "adjudication",
  verdict: "continue",
  grant: 2,
  risk: "the retry path can double-charge on a 409",
  recordPath: ".agents/adjudications/1-1.json",
  ...extra,
});

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
  assert.equal(
    allowance("sensitive", [{ ...ok, grant: "uncapped" }], 5),
    Infinity,
    "uncapped is what the sensitive tier means once David has been asked",
  );
});

test("an unknown extension kind is refused rather than ignored", () => {
  assert.match(
    validateExtension(1, "internal", { pr: 1, kind: "self", grant: 9 }, { adjudicationsAlreadySeen: 0, io: null }),
    /is not "adjudication" or "david"/,
  );
});

// ---------------------------------------------------------------------------
// loadLoop — fail closed on anything unreadable
// ---------------------------------------------------------------------------

test("a malformed receipt refuses the loop instead of being skipped", () => {
  const io = fakeIo({ [budgetPath(1)]: "{ not json" });
  assert.deepEqual(loadLoop(1, io), {
    problem: "bad-receipt",
    detail: loadLoop(1, io).detail,
  });
  assert.match(loadLoop(1, io).detail, /could not be read \(malformed/);
});

test("a malformed rounds tally refuses too — an unreadable tally is not zero rounds", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1), [roundsPath(1)]: JSON.stringify({ pr: 1, rounds: {} }) });
  assert.match(loadLoop(1, io).detail, /"rounds" must be an array/);
});

test("extensions are read in sequence order, not directory order", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 2)]: json({ pr: 1, kind: "david", grant: 1, authorization: "ok" }),
    [extensionPath(1, 1)]: json(adjudication(1)),
    [RECORD(1)]: recordFile(1),
  });
  const state = loadLoop(1, io);
  assert.deepEqual(
    state.extensions.map((e) => e.kind),
    ["adjudication", "david"],
    "sequence order is what makes 'the adjudication came first' checkable",
  );
  assert.equal(allowance("internal", state.extensions, 5), 3 + 2 + 1);
});

// ---------------------------------------------------------------------------
// The decision itself
// ---------------------------------------------------------------------------

const post = (pr, body = "@codex review") => ({
  toolName: "mcp__github__add_issue_comment",
  toolInput: { owner: REPO_OWNER, repo: REPO_NAME, issue_number: pr, body },
});

test("no budget declared refuses the very first round", () => {
  const { blocked, reason } = judgeReviewRequest(post(1), fakeIo());
  assert.equal(blocked, true);
  assert.match(reason, /no round budget declared/);
  assert.match(reason, /review-budget\.mjs declare/, "the refusal has to say what to do next");
});

test("an in-budget round is allowed and tallied", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1), [roundsPath(1)]: rounds(1, 2) });
  assert.equal(judgeReviewRequest(post(1), io).blocked, false);
  assert.equal(JSON.parse(io.store[roundsPath(1)]).rounds.length, 3, "the tally is written before the post");
});

test("the round at the budget is refused, and the refusal names tripwire 1", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1), [roundsPath(1)]: rounds(1, 3) });
  const { blocked, reason } = judgeReviewRequest(post(1), io);
  assert.equal(blocked, true);
  assert.match(reason, /TRIPWIRE 1/);
  assert.match(reason, /review-loop-record\.mjs/, "the record is script-generated, never the loop's prose");
  assert.match(reason, /fresh-context adjudicator/);
  assert.equal(io.store[roundsPath(1)], rounds(1, 3), "a refused round is not counted");
});

test("a valid extension reopens the guard for exactly the rounds it granted", () => {
  const files = {
    [budgetPath(1)]: budget(1),
    [roundsPath(1)]: rounds(1, 3),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 1 })),
    [RECORD(1)]: recordFile(1),
  };
  assert.equal(judgeReviewRequest(post(1), fakeIo(files)).blocked, false, "round 4 is inside the +1 grant");

  const spent = fakeIo({ ...files, [roundsPath(1)]: rounds(1, 4) });
  assert.equal(judgeReviewRequest(post(1), spent).blocked, true, "round 5 is not");
});

test("tripwire 2 is a hard stop to David, with no second self-service extension", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [roundsPath(1)]: rounds(1, 5),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
    [RECORD(1)]: recordFile(1),
  });
  const { blocked, reason } = judgeReviewRequest(post(1), io);
  assert.equal(blocked, true);
  assert.match(reason, /TRIPWIRE 2/);
  assert.match(reason, /never a second one/);
  assert.match(reason, /🛑 NEED YOU/);
});

test("a second adjudication receipt refuses the post rather than granting rounds", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [roundsPath(1)]: rounds(1, 5),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
    [extensionPath(1, 2)]: json(adjudication(1, { grant: 2 })),
    [RECORD(1)]: recordFile(1),
  });
  const { blocked, reason } = judgeReviewRequest(post(1), io);
  assert.equal(blocked, true);
  assert.match(reason, /SECOND adjudication extension is never valid/);
});

test("David's authorization clears tripwire 2", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [roundsPath(1)]: rounds(1, 5),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
    [extensionPath(1, 2)]: json({ pr: 1, kind: "david", grant: 2, authorization: "yes, keep going" }),
    [RECORD(1)]: recordFile(1),
  });
  assert.equal(judgeReviewRequest(post(1), io).blocked, false);
});

test("the sensitive tier runs to 5 and then stops for David, self-serve unavailable", () => {
  const at4 = fakeIo({ [budgetPath(1)]: budget(1, "sensitive"), [roundsPath(1)]: rounds(1, 4) });
  assert.equal(judgeReviewRequest(post(1), at4).blocked, false, "uncapped below the mandatory stop");

  const at5 = fakeIo({ [budgetPath(1)]: budget(1, "sensitive"), [roundsPath(1)]: rounds(1, 5) });
  const { blocked, reason } = judgeReviewRequest(post(1), at5);
  assert.equal(blocked, true);
  assert.match(reason, /TRIPWIRE 2/, "sensitive work skips the self-serve tripwire entirely");
});

test("a review request with no readable PR number is refused, not waved through", () => {
  const call = { toolName: "mcp__github__add_issue_comment", toolInput: { owner: REPO_OWNER, repo: REPO_NAME, body: "@codex review" } };
  assert.match(judgeReviewRequest(call, fakeIo()).reason, /no readable PR number/);
});

test("ordinary comments, other repos, and other tools are untouched", () => {
  const io = fakeIo();
  assert.equal(judgeReviewRequest(post(1, "Fixed in abc123 — thanks."), io).blocked, false);
  assert.equal(
    judgeReviewRequest(
      { toolName: "mcp__github__add_issue_comment", toolInput: { owner: "other", repo: "repo", issue_number: 1, body: "@codex review" } },
      io,
    ).blocked,
    false,
  );
  assert.equal(
    judgeReviewRequest({ toolName: "mcp__github__create_pull_request", toolInput: { body: "@codex review" } }, io).blocked,
    false,
  );
  assert.deepEqual(io.store, {}, "nothing is tallied for a call that is not a review request");
});

// ---------------------------------------------------------------------------
// Codex round 1. Each test below pins one finding's fix — every one of them a
// route by which the guard could have been passed, silently, without the
// tripwire ever firing.
// ---------------------------------------------------------------------------

test("the automatic opening review counts as a round", () => {
  // Codex reviews every non-draft PR on open with no trigger comment, and
  // loop-metrics.mjs calls that pass round 1. Counting only the posts this
  // guard sees made "3" mean four actual rounds, on every tier.
  const io = fakeIo({
    [budgetPath(1)]: budget(1, "internal", { autoOpeningReview: true }),
    [roundsPath(1)]: rounds(1, 2),
  });
  const { blocked, reason } = judgeReviewRequest(post(1), io);
  assert.equal(blocked, true, "2 posts + 1 automatic pass is already 3 of 3");
  assert.match(reason, /including Codex's automatic opening pass/);

  const draft = fakeIo({
    [budgetPath(1)]: budget(1, "internal", { autoOpeningReview: false }),
    [roundsPath(1)]: rounds(1, 2),
  });
  assert.equal(judgeReviewRequest(post(1), draft).blocked, false, "a draft PR gets no opening pass to count");
});

test("a budget receipt must say whether the opening pass applies", () => {
  const receipt = JSON.parse(budget(1));
  delete receipt.autoOpeningReview;
  assert.match(validateBudget(1, receipt), /autoOpeningReview/);
});

test("roundsSpent is the tally plus the opening pass", () => {
  const state = { rounds: [1, 2], budget: { autoOpeningReview: true } };
  assert.equal(roundsSpent(state), 3);
  assert.equal(roundsSpent({ ...state, budget: { autoOpeningReview: false } }), 2);
});

test("an extension written before the tripwire stays dormant instead of pre-empting it", () => {
  // The failure this closes: a `continue` receipt that raises the allowance
  // the moment it exists means the loop sails past its cap and tripwire 1
  // never fires at all — no refusal, and the aggregate never gets presented.
  const files = {
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
    [RECORD(1)]: recordFile(1),
  };
  const early = loadLoop(1, fakeIo({ ...files, [roundsPath(1)]: rounds(1, 1) }));
  assert.equal(allowance("internal", early.extensions, 1), 3, "dormant: the base cap is not exhausted");

  const atCap = loadLoop(1, fakeIo({ ...files, [roundsPath(1)]: rounds(1, 3) }));
  assert.equal(allowance("internal", atCap.extensions, 3), 5, "active: exactly at the round it was meant to rule on");
});

test("a David grant activates only after the adjudication before it is spent", () => {
  const extensions = [
    { kind: "adjudication", verdict: "continue", grant: 2 },
    { kind: "david", grant: 4, authorization: "ok" },
  ];
  assert.equal(allowance("internal", extensions, 3), 5, "the David grant is still dormant at 3");
  assert.equal(allowance("internal", extensions, 5), 9, "and activates at 5");
});

test("a rounds tally belonging to another PR refuses the loop", () => {
  assert.match(validateRounds(1, { pr: 2, rounds: [] }), /names PR 2, not 1/);
  const io = fakeIo({ [budgetPath(1)]: budget(1), [roundsPath(1)]: rounds(2, 0) });
  assert.match(loadLoop(1, io).detail, /names PR 2, not 1/);
});

test("an unreadable tally is refused, never read as zero rounds spent", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1), [roundsPath(1)]: rounds(1, 3) });
  io.read = (rel) => {
    if (rel === roundsPath(1)) throw new Error("EACCES: permission denied");
    return rel in io.store ? io.store[rel] : null;
  };
  const { blocked, reason } = judgeReviewRequest(post(1), io);
  assert.equal(blocked, true);
  assert.match(reason, /could not be read \(unreadable/);
});

test("a continue verdict citing a missing or foreign record grants nothing", () => {
  const withReceipt = (extra) =>
    fakeIo({
      [budgetPath(1)]: budget(1),
      [roundsPath(1)]: rounds(1, 3),
      [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
      ...extra,
    });

  assert.match(loadLoop(1, withReceipt({})).detail, /does not exist/);
  assert.match(
    loadLoop(1, withReceipt({ [RECORD(1)]: recordFile(2) })).detail,
    /describes PR 2, not 1/,
  );
  assert.match(
    loadLoop(1, withReceipt({ [RECORD(1)]: json({ pr: 1, generator: "hand-written" }) })).detail,
    /was not produced by review-loop-record\.mjs/,
  );
});

test("a round recorded but not committed blocks the next request", () => {
  // An uncommitted tally dies with this ephemeral container, and the next
  // session re-grants the round it recorded. So durability sits on the action
  // path too: commit the last round before asking for another.
  const io = fakeIo({ [budgetPath(1)]: budget(1), [roundsPath(1)]: rounds(1, 1) });
  io.committedRounds = () => 0;
  const { blocked, reason } = judgeReviewRequest(post(1), io);
  assert.equal(blocked, true);
  assert.match(reason, /differs from the one in HEAD/);
  assert.match(reason, /Commit \.agents\/receipts\/loop-rounds-1\.json/);
});

test("an unverifiable committed tally refuses rather than assuming", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1), [roundsPath(1)]: rounds(1, 1) });
  io.committedRounds = () => {
    throw new Error("not a git repository");
  };
  assert.match(judgeReviewRequest(post(1), io).reason, /cannot read the committed round tally/);
});

// --- Codex round 2 ---------------------------------------------------------

test("a zero-padded extension name is refused, not normalised onto a canonical one", () => {
  // Mapping the name to a number and rebuilding the path from it read the
  // canonical receipt twice and never opened the malformed one, so a two-round
  // grant silently became four — from a file nothing had validated.
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [roundsPath(1)]: rounds(1, 3),
    [extensionPath(1, 1)]: json({ pr: 1, kind: "david", grant: 2, authorization: "ok" }),
    ".agents/receipts/loop-extension-1-01.json": json({ pr: 1, kind: "david", grant: 2, authorization: "ok" }),
  });
  const state = loadLoop(1, io);
  assert.equal(state.problem, "bad-receipt");
  assert.match(state.detail, /not a canonical extension name/);
});

test("two receipts claiming one sequence refuse the loop", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1) });
  io.listReceipts = () => ["loop-extension-1-1.json", "loop-extension-1-1.json"];
  assert.match(loadLoop(1, io).detail, /claim sequence 1/);
});

// --- Reconciliation: a request that delivered no round must not be charged ---

test("reconciliation drops requests that produced no reviewer pass", () => {
  // Two requests posted, but only one produced a pass (plus the opening one).
  const { kept, dropped } = reconcileRounds({
    rounds: [{ at: "a" }, { at: "b" }],
    autoOpeningReview: true,
    deliveredPasses: 2,
  });
  assert.equal(dropped, 1);
  assert.deepEqual(kept, [{ at: "a" }]);
});

test("reconciliation never grows the tally", () => {
  // More passes delivered than requests posted (the opening pass, a manual
  // re-review, whatever) must not manufacture headroom.
  const { kept, dropped } = reconcileRounds({
    rounds: [{ at: "a" }],
    autoOpeningReview: false,
    deliveredPasses: 9,
  });
  assert.equal(dropped, 0);
  assert.equal(kept.length, 1, "the guard cannot hand itself rounds it never requested");
});

test("reconciliation floors at zero and counts the opening pass", () => {
  assert.deepEqual(
    reconcileRounds({ rounds: [{ at: "a" }], autoOpeningReview: true, deliveredPasses: 1 }),
    { kept: [], dropped: 1 },
    "one delivered pass IS the opening pass, so the request delivered nothing",
  );
  assert.deepEqual(
    reconcileRounds({ rounds: [{ at: "a" }], autoOpeningReview: true, deliveredPasses: 0 }),
    { kept: [], dropped: 1 },
  );
});

test("reconciliation refuses a nonsense delivered count rather than guessing", () => {
  assert.throws(
    () => reconcileRounds({ rounds: [], autoOpeningReview: true, deliveredPasses: -1 }),
    /non-negative integer/,
  );
});
