import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TIERS,
  tierCap,
  LEASH,
  railFor,
  allowance,
  countRounds,
  budgetPath,
  extensionPath,
  checkPath,
  claimPath,
  loadLoop,
  nodeIo,
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
    // Exclusive create, same contract as the real adapter: true once, false
    // ever after. Modelling it as a store key is exactly right — the point of
    // the real one is that the CREATE is the atom, not the read.
    claimOnce: (rel) => {
      if (rel in store) return false;
      store[rel] = "";
      return true;
    },
    releaseClaim: (rel) => {
      delete store[rel];
    },
    // Per-generation nonce. Deterministic in the fake so a test can predict
    // the claim path a check will mint.
    nonce: () => "0123456789abcdef",
    // THE FAKE STORE IS THE DURABLE TREE. That is the point of the redesign:
    // decisions are only ever read from the ref, so the thing the tests
    // populate is the ref's contents, not a working directory that then has
    // to be reconciled with one. A test that wants "not durable" overrides
    // these two members directly.
    durableRef: () => "origin/fake",
    readDurable: (_ref, rel) => (rel in store ? { state: "present", text: store[rel] } : { state: "absent" }),
    listDurable: (_ref, dir) =>
      Object.keys(store)
        .filter((k) => k.startsWith(`${dir}/`))
        .map((k) => k.slice(dir.length + 1)),
  };
}

const json = (value) => JSON.stringify(value, null, 2);

const budget = (pr, tier = "product", extra = {}) =>
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
    nonce: "0123456789abcdef",
    ...extra,
  });

/**
 * The mechanical record an adjudication cites. It must show the loop AT its
 * cap, which is what proves the adjudication followed a fired tripwire.
 */
const recordFile = (pr, passes = 5) =>
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
  decidedAt: "2026-08-19T21:45:00Z",
  reasoning: "the record shows a named, unaddressed behavioral risk in the retry path",
  gaps: [],
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
  assert.equal(tierCap("product"), 5);
  assert.equal(tierCap("sensitive"), 5, "auth/payments/migrations: budget 5, same two-tier tripwire as every tier");
  assert.equal(TIERS.sensitive.budget, 5, "the old uncapped-with-a-mandatory-stop shape is gone (David, 2026-08-26)");
  assert.equal(tierCap("internal"), 3, "the smallest budget: Fable takes over at 3, David gates at 6");
  assert.equal(LEASH, 3, "the second tripwire sits 3 rounds past the first (David, 2026-08-26)");
  // The write-gate rule (David, 2026-08-22) deleted `adjudicatedStop`: no tier
  // commits a terminal receipt mid-budget, because no loop may end on an
  // unreviewed head for such a receipt to unwedge. The two-tier tripwire
  // (David, 2026-08-26) deleted `selfServe` and `escalateAt`: every tier
  // self-serves the leash via the Fable adjudicator, and the David gate is
  // positional (budget + leash + his own grants), not a tier property.
  for (const tier of Object.keys(TIERS)) {
    assert.equal(TIERS[tier].adjudicatedStop, undefined, `${tier} must not carry the deleted adjudicatedStop property`);
    assert.equal(TIERS[tier].selfServe, undefined, `${tier} must not carry the deleted selfServe property`);
    assert.equal(TIERS[tier].escalateAt, undefined, `${tier} must not carry the deleted escalateAt property`);
  }
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
  assert.deepEqual(counted, { delivered: 2, pending: 0, spent: 2, ambiguous: false });
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
  assert.deepEqual(counted, { delivered: 1, pending: 1, spent: 2, ambiguous: false });
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
  assert.deepEqual(stalled, { delivered: 1, pending: 1, spent: 2, ambiguous: false }, "two requests, one round in flight");

  const answered = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z"), pass("2026-08-17T11:00:00Z")],
    issueComments: [comment("2026-08-17T10:30:00Z"), comment("2026-08-17T10:45:00Z")],
  });
  assert.deepEqual(answered, { delivered: 2, pending: 0, spent: 2, ambiguous: false }, "the stall costs nothing once answered");
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
  const receipt = JSON.parse(budget(1, "product"));
  assert.equal(validateBudget(1, receipt), null);

  receipt.budget = 20;
  assert.match(
    validateBudget(1, receipt),
    /declares budget 20 but tier "product" is 5/,
    "a free-text budget field is the no-stopping-rule state wearing a receipt",
  );
});

test("a budget receipt for the wrong PR is refused, not adopted", () => {
  assert.match(validateBudget(2, JSON.parse(budget(1))), /names PR 1, not 2/);
});

test("a budget receipt needs a criticality rating and a named artifact", () => {
  assert.match(validateBudget(1, JSON.parse(budget(1, "product", { criticality: null }))), /criticality/);
  assert.match(validateBudget(1, JSON.parse(budget(1, "product", { artifact: "  " }))), /artifact/);
});

// ---------------------------------------------------------------------------
// Extension receipts — the tier-2 rule and the follows-its-tripwire rule
// ---------------------------------------------------------------------------

test("a valid adjudication extension passes", () => {
  assert.equal(validateExtension(1, "product", adjudication(1), { adjudicationsAlreadySeen: 0, io: null }), null);
});

test("a second adjudication extension is valid -- the bound is the rail, not a count", () => {
  // David, 2026-08-20: the adjudicator owns extension size and may grant more
  // than once; what stops the loop is `allowance` reaching 2x the budget.
  assert.equal(validateExtension(1, "product", adjudication(1), { adjudicationsAlreadySeen: 1, io: null }), null);
});

test("a continue verdict must name a behavioral risk and grant a positive integer", () => {
  assert.match(
    validateExtension(1, "product", adjudication(1, { risk: "" }), { adjudicationsAlreadySeen: 0, io: null }),
    /must name the specific unaddressed BEHAVIORAL risk/,
  );
  assert.equal(
    validateExtension(1, "product", adjudication(1, { grant: 5 }), { adjudicationsAlreadySeen: 0, io: null }),
    null,
    "the adjudicator sizes its own grant; the rail bounds the aggregate",
  );
  assert.match(
    validateExtension(1, "product", adjudication(1, { grant: 0 }), { adjudicationsAlreadySeen: 0, io: null }),
    /positive integer/,
  );
});

test("a non-continue verdict is valid but grants nothing", () => {
  // recordPath is still required -- pr-ready.mjs's merge-gate fallback
  // derives its diff baseline from the cited record, never from a
  // self-declared field on the receipt, so every adjudication verdict
  // (not just `continue`) must cite one. (Codex, PR #539 round 2.)
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "" });
  assert.equal(validateExtension(1, "product", shipped, { adjudicationsAlreadySeen: 0, io: null }), null);
  assert.equal(allowance("product", [shipped], 5), 5, "a stop verdict does not extend the budget");
});

test("a non-continue verdict with no recordPath is rejected", () => {
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "", recordPath: "" });
  assert.match(
    validateExtension(1, "product", shipped, { adjudicationsAlreadySeen: 0, io: null }),
    /must cite the mechanical record/,
  );
});

test("a recordPath outside .agents/adjudications/ is rejected -- pr-ready.mjs's merge gate would never accept it (Codex, #539 round 3)", () => {
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "", recordPath: "docs/fake-record.json" });
  assert.match(
    validateExtension(1, "product", shipped, { adjudicationsAlreadySeen: 0, io: null }),
    /is not under \.agents\/adjudications\//,
  );
});

test("an adjudication receipt with no decidedAt is rejected (Codex, #539 round 3)", () => {
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "", decidedAt: undefined });
  assert.match(
    validateExtension(1, "product", shipped, { adjudicationsAlreadySeen: 0, io: null }),
    /must carry a parseable `decidedAt`/,
  );
});

test("an adjudication receipt with no reasoning, or a non-array gaps, is rejected (Codex, #539 round 3)", () => {
  const noReasoning = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "", reasoning: "" });
  assert.match(
    validateExtension(1, "product", noReasoning, { adjudicationsAlreadySeen: 0, io: null }),
    /must carry the adjudicator's `reasoning`/,
  );
  const noGaps = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "", gaps: "not an array" });
  assert.match(
    validateExtension(1, "product", noGaps, { adjudicationsAlreadySeen: 0, io: null }),
    /must carry the adjudicator's `gaps` array/,
  );
});

test("every tier accepts adjudication receipts -- the two-tier tripwire covers sensitive and internal too", () => {
  // David, 2026-08-26: sensitive's tripwire is no longer his in person, and
  // internal's cap no longer routes straight to him. The Fable adjudicator
  // self-serves the leash on all three tiers; the David gate follows it.
  assert.equal(validateExtension(1, "sensitive", adjudication(1), { adjudicationsAlreadySeen: 0, io: null }), null);
  assert.equal(validateExtension(1, "internal", adjudication(1), { adjudicationsAlreadySeen: 0, io: null }), null);
});

test("a David authorization must quote his words and grant something concrete", () => {
  const ok = { pr: 1, kind: "david", grant: 3, asOf: 5, authorization: "go ahead, three more" };
  assert.equal(validateExtension(1, "product", ok, { adjudicationsAlreadySeen: 1, io: null }), null);
  assert.equal(allowance("product", [ok], 5), 8);

  assert.match(
    validateExtension(1, "product", { ...ok, authorization: "" }, { adjudicationsAlreadySeen: 1, io: null }),
    /quote his words/,
  );
  assert.equal(
    validateExtension(1, "product", { ...ok, grant: 0 }, { adjudicationsAlreadySeen: 1, io: null }),
    null,
    "grant 0 is David endorsing the stop at a gate -- the durable record that he was consulted",
  );
  assert.equal(allowance("product", [{ ...ok, grant: 0 }], 5), 5, "an endorsed stop moves the gate nowhere");
  assert.match(
    validateExtension(1, "product", { ...ok, grant: -1 }, { adjudicationsAlreadySeen: 1, io: null }),
    /non-negative integer of rounds/,
  );
  assert.match(
    validateExtension(1, "product", { ...ok, grant: 2.5 }, { adjudicationsAlreadySeen: 1, io: null }),
    /non-negative integer of rounds/,
  );
  assert.equal(allowance("sensitive", [{ ...ok, grant: "uncapped" }], 5), Infinity);
});

test("an unknown extension kind is refused rather than ignored", () => {
  assert.match(
    validateExtension(1, "product", { pr: 1, kind: "self", grant: 9 }, { adjudicationsAlreadySeen: 0, io: null }),
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
    [RECORD(1)]: recordFile(1, 1), // generated at 1 pass, cap is 5
  });
  assert.match(loadLoop(1, early).detail, /below this receipt's own stage floor of 5/);

  const atCap = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1)),
    [RECORD(1)]: recordFile(1, 5),
  });
  assert.equal(loadLoop(1, atCap).problem, undefined, "generated at the cap is valid");
});

test("a second adjudication cannot reuse the first tripwire's record (Codex, #543)", () => {
  // The repeat-grant hole: with repeat adjudications valid, a second receipt
  // citing the record generated at the BASE cap (5 passes) would satisfy a
  // >= tierCap check forever, and `allowance` would activate it at the second
  // tripwire -- one adjudication silently covering two. The floor for receipt
  // N is the allowance receipts 1..N-1 establish.
  const reused = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
    [extensionPath(1, 2)]: json(adjudication(1, { grant: 2, recordPath: RECORD(1) })),
    [RECORD(1)]: recordFile(1, 5), // proves the FIRST tripwire (5), not the second (7)
  });
  const res = loadLoop(1, reused);
  assert.match(res.detail ?? "", /below this receipt's own stage floor of 7/);

  // A second receipt citing a record generated at the SECOND tripwire is valid.
  const fresh = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 2 })),
    [extensionPath(1, 2)]: json(adjudication(1, { grant: 1, recordPath: ".agents/adjudications/1-2.json" })),
    [RECORD(1)]: recordFile(1, 5),
    [".agents/adjudications/1-2.json"]: recordFile(1, 7),
  });
  assert.equal(loadLoop(1, fresh).problem, undefined, "a record at the current allowance is valid");
});

// ---------------------------------------------------------------------------
// loadLoop — fail closed on anything unreadable or ambiguous
// ---------------------------------------------------------------------------

test("a malformed receipt refuses the loop instead of being skipped", () => {
  const io = fakeIo({ [budgetPath(1)]: "{ not json" });
  assert.match(loadLoop(1, io).detail, /could not be read from origin\/fake \(malformed/);
});

test("an unreadable receipt is refused, never read as absent", () => {
  // Now on the DURABLE path: the fault to model is git failing, not the
  // filesystem. Absent must still stay distinguishable from unreadable, or an
  // I/O fault reopens an exhausted loop.
  const io = fakeIo({ [budgetPath(1)]: budget(1) });
  io.readDurable = (_ref, rel) => {
    if (rel === budgetPath(1)) throw new Error("EACCES: permission denied");
    return rel in io.store ? { state: "present", text: io.store[rel] } : { state: "absent" };
  };
  assert.match(loadLoop(1, io).detail, /could not be read from origin\/fake \(unreadable/);

  // And a ref that cannot be resolved is "unknown", never "absent" -- absent
  // would read as "no budget declared" and refuse with the wrong reason.
  const unknown = fakeIo({ [budgetPath(1)]: budget(1) });
  unknown.readDurable = () => ({ state: "unknown" });
  assert.match(loadLoop(1, unknown).detail, /could not be read from origin\/fake \(unreadable/);
});

test("an upstream that is a LOCAL branch is not durable", () => {
  // #531 round 1. `git branch --set-upstream-to=<local-branch>` is supported
  // and sets `branch.<name>.remote=.`; measured 2026-08-19, the ABBREVIATED
  // upstream is then a bare name indistinguishable from a remote-tracking one,
  // while its receipts die with the checkout. So the check is on the FULL ref:
  // `refs/remotes/...` is durable, `refs/heads/...` is not.
  const io = fakeIo({ [budgetPath(42)]: budget(42) });
  io.durableRef = () => null; // what the adapter now returns for a local upstream
  const verdict = loadLoop(42, io);
  assert.equal(verdict.problem, "bad-receipt");
  assert.match(verdict.detail, /no REMOTE-tracking upstream/);
  assert.match(
    verdict.detail,
    /tracking another LOCAL branch reports the same way/,
    "the refusal covers both causes -- a local upstream IS an upstream, just not a durable one",
  );
});

test("a refs/remotes ref backed by a LOCAL repository is not durable", () => {
  // #531 round 2. `refs/remotes/` is a namespace, not a guarantee:
  // `git remote add local ../other-repo.git` produces `refs/remotes/local/main`
  // while both repositories die with the container. Reproduced 2026-08-19, and
  // discriminated by resolving the remote's URL rather than by URL syntax --
  // syntax is a swamp, since `file://` has a scheme and is local while
  // `git@github.com:owner/repo` has none and is not.
  //
  // Held constant in the live probe: the upstream ref itself
  // (`refs/remotes/local/main`) never changed across the three cases; only the
  // remote's URL did.
  //
  //   ../origin-repo.git            -> null   (bare path, exists on disk)
  //   https://github.com/owner/repo -> local/main
  //   file:///abs/path              -> null   (scheme, still local)
  //
  // The fake cannot model this -- it is entirely about what git reports -- so
  // the discrimination is asserted against real git in the sibling test, and
  // what is pinned here is that a null durableRef refuses the loop.
  const io = fakeIo({ [budgetPath(43)]: budget(43) });
  io.durableRef = () => null;
  assert.match(loadLoop(43, io).detail, /no REMOTE-tracking upstream/);
});

test("the real adapter accepts only refs/remotes as the durable ref", () => {
  // Against real git, because the discrimination lives in what git prints and
  // nothing else can confirm it. This repo's branch tracks a remote, so the
  // positive case is observable directly; the negative is asserted on the
  // prefix rule the adapter applies.
  const ref = nodeIo().durableRef();
  // This repo's origin is an https URL, so the positive case is observable
  // directly; a remote backed by a local path returns null instead (verified
  // live -- see the sibling test's comment for the three-case probe).
  if (ref !== null) {
    assert.ok(
      !ref.startsWith("refs/"),
      "the returned ref is the abbreviated remote-tracking name, usable directly with git show",
    );
    assert.ok(ref.includes("/"), "and carries its remote, e.g. origin/<branch>");
  }
});

test("a budget written but not pushed says so, instead of \"no budget declared\"", () => {
  // The decision is the same either way -- absent from the ref is absent --
  // but this is the likeliest first encounter with the push requirement, and
  // "no budget declared" would send someone back to `declare`, which already
  // worked. The working tree is consulted to phrase the refusal, never to
  // make it.
  const io = fakeIo({});
  io.exists = (rel) => rel === budgetPath(40);
  const verdict = loadLoop(40, io);
  assert.equal(verdict.problem, "bad-receipt");
  assert.match(verdict.detail, /exists in the working tree but is not in origin\/fake/);
  assert.match(verdict.detail, /re-running `declare` will not help/);

  // Genuinely never declared still reports no-budget, so the two stay
  // distinguishable rather than collapsing into one confusing message.
  assert.equal(loadLoop(41, fakeIo({})).problem, "no-budget");
});

test("a branch with no upstream has no durable ref, and refuses", () => {
  // #526 finding 3. There is no HEAD fallback: a commit that never reached a
  // remote dies with this container, which is the exact failure the rule
  // exists to prevent, so local-only can never be "durable enough".
  const io = fakeIo({ [budgetPath(1)]: budget(1) });
  io.durableRef = () => null;
  const verdict = loadLoop(1, io);
  assert.equal(verdict.problem, "bad-receipt");
  assert.match(verdict.detail, /no REMOTE-tracking upstream, so there is no durable ref/);
  assert.match(verdict.detail, /git push -u origin/, "the refusal says how to fix it");
});

test("a working-tree receipt that is not in the ref simply does not exist", () => {
  // The redesign's central claim. Previously this needed a separate durability
  // check comparing two reads; now the working tree is never consulted, so an
  // uncommitted decision is not "present but undurable" -- it is absent, by
  // the only read that happens.
  const io = fakeIo({ [budgetPath(2)]: budget(2) });
  io.store[extensionPath(2, 1)] = json(adjudication(2)); // written locally...
  io.readDurable = (_ref, rel) =>
    rel === extensionPath(2, 1) ? { state: "absent" } : ({ state: "present", text: io.store[rel] });
  io.listDurable = () => ["loop-budget-2.json"]; // ...and absent from the ref
  const state = loadLoop(2, io);
  assert.deepEqual(state.extensions, [], "an uncommitted extension grants nothing");
  assert.equal(state.nextSeq, 1, "and does not consume a sequence number either");
});

test("an unlistable receipts directory refuses rather than forgetting every extension", () => {
  // Returning [] here used to hide a spent adjudication, showing tripwire 1
  // again instead of the hard stop to David. (Codex, #503 round 3.)
  const io = fakeIo({ [budgetPath(1)]: budget(1) });
  io.listDurable = () => null;
  assert.match(loadLoop(1, io).detail, /could not be listed in origin\/fake/);
});

test("a zero-padded extension name is refused, not normalised onto a canonical one", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json({ pr: 1, kind: "david", grant: 2, asOf: 5, authorization: "ok" }),
    ".agents/receipts/loop-extension-1-01.json": json({ pr: 1, kind: "david", grant: 2, asOf: 5, authorization: "ok" }),
  });
  assert.match(loadLoop(1, io).detail, /not a canonical extension name/);
});

test("two receipts claiming one sequence refuse the loop", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1) });
  io.listDurable = () => ["loop-extension-1-1.json", "loop-extension-1-1.json"];
  assert.match(loadLoop(1, io).detail, /claim sequence 1/);
});

test("the next extension path is max+1, so a sequence gap never overwrites a receipt", () => {
  // With receipts 1 and 3 on disk, length+1 pointed at 3 and would have
  // overwritten it — destroying authorization history and possibly the active
  // grant. (Codex, #503 round 3.)
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1)),
    [RECORD(1)]: recordFile(1, 5),
    [extensionPath(1, 3)]: json({ pr: 1, kind: "david", grant: 1, asOf: 7, authorization: "ok" }),
  });
  assert.equal(loadLoop(1, io).nextSeq, 4);
});

test("extensions are read in sequence order, not directory order", () => {
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 2)]: json({ pr: 1, kind: "david", grant: 1, asOf: 7, authorization: "ok" }),
    [extensionPath(1, 1)]: json(adjudication(1)),
    [RECORD(1)]: recordFile(1, 5),
  });
  const state = loadLoop(1, io);
  assert.deepEqual(state.extensions.map((e) => e.kind), ["adjudication", "david"]);
  assert.equal(allowance("product", state.extensions, 7), 5 + 2 + 1);
});

// ---------------------------------------------------------------------------
// Allowance staging
// ---------------------------------------------------------------------------

test("an extension stays dormant until the stage before it is spent", () => {
  const extensions = [adjudication(1, { grant: 2 })];
  assert.equal(allowance("product", extensions, 1), 5, "dormant: the base cap is not exhausted");
  assert.equal(allowance("product", extensions, 5), 7, "active at the round it was meant to rule on");
});

test("a David grant activates only after the adjudication before it is spent", () => {
  const extensions = [
    { kind: "adjudication", verdict: "continue", grant: 2 },
    { kind: "david", grant: 4, authorization: "ok" },
  ];
  assert.equal(allowance("product", extensions, 5), 7, "the David grant is still dormant at 5");
  assert.equal(allowance("product", extensions, 7), 11, "and activates at 7 -- David grants move the gate itself");
});

test("allowance refuses a nonsense spent count rather than defaulting", () => {
  // The old Infinity default silently activated every extension for any
  // caller that forgot the argument. (Codex, #503 round 3.)
  assert.throws(() => allowance("product", [], undefined), /non-negative integer roundsSpent/);
  assert.throws(() => allowance("product", [], -1), /non-negative integer roundsSpent/);
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

test("the no-budget refusal routes internal tooling to the internal tier, not around review", () => {
  // David, 2026-08-21, superseding the 2026-08-20 no-rounds carve-out: fixes
  // to round-1 findings get reviewed, so the refusal must teach the internal
  // declaration -- while still saying a CLEAN automatic pass needs no request
  // at all, which is the half of the carve-out that survives.
  const { reason } = judgeReviewRequest(post(1), fakeIo(), NOW);
  assert.match(reason, /IF THIS IS INTERNAL TOOLING/);
  assert.match(reason, /round 1 \(the automatic pass\) found NOTHING, no request is needed/);
  assert.match(reason, /--tier internal/);
  assert.match(reason, /internal=3, strict/);
  assert.match(reason, /two-tier tripwire/);
  assert.doesNotMatch(reason, /Do NOT declare a budget/, "the old carve-out's instruction must be gone, not merely contradicted");
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
  const io = fakeIo({ [budgetPath(1)]: budget(1), [checkPath(1)]: check(1, 5) });
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
    [RECORD(1)]: recordFile(1, 5),
  };
  assert.equal(
    judgeReviewRequest(post(1), fakeIo({ ...base, [checkPath(1)]: check(1, 5) }), NOW).blocked,
    false,
    "round 6 is inside the +1 grant",
  );
  assert.equal(
    judgeReviewRequest(post(1), fakeIo({ ...base, [checkPath(1)]: check(1, 6) }), NOW).blocked,
    true,
    "round 7 is not",
  );
});

test("tripwire 2 fires at the David gate -- budget + leash -- with a Fable recommendation for him", () => {
  // David, 2026-08-26: the adjudicator still owns extension size, but its
  // grants self-serve at most one leash (3 rounds) past the budget. At the
  // gate a fresh Fable adjudication runs as the RECOMMENDATION and the loop
  // stops for David's decision, whatever it recommends.
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 5 })),
    [RECORD(1)]: recordFile(1, 5),
    [checkPath(1)]: check(1, 8),
  });
  const { blocked, reason } = judgeReviewRequest(post(1), io, NOW);
  assert.equal(blocked, true);
  assert.match(reason, /TRIPWIRE 2 \(the David gate\)/);
  assert.match(reason, /reached 8 rounds/);
  assert.match(reason, /RECOMMENDATION David reviews/);
  assert.match(reason, /🛑 NEED YOU/);
});

test("adjudication grants accumulate up to the leash and no further", () => {
  const extensions = [
    { kind: "adjudication", verdict: "continue", grant: 3 },
    { kind: "adjudication", verdict: "continue", grant: 4 },
  ];
  assert.equal(allowance("product", extensions, 5), 8, "the first grant activates at the cap and fills the leash");
  assert.equal(allowance("product", extensions, 8), 8, "the second is clipped at the David gate, not 12");
});

test("a standing terminal verdict routes to David, never to another self-serve adjudication (Codex, #543 round 2)", () => {
  // A committed ship-with-gaps-recorded receipt is a decision, and a
  // dispatched verdict decides. Without this, the tripwire-1 branch would
  // offer a fresh adjudication that could return continue and overturn it.
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "" });
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(shipped),
    [RECORD(1)]: recordFile(1, 5),
    [checkPath(1)]: check(1, 5),
  });
  const { blocked, reason } = judgeReviewRequest(post(1), io, NOW);
  assert.equal(blocked, true);
  assert.match(reason, /TERMINAL adjudication verdict is standing/);
  assert.match(reason, /only a "david"-kind extension receipt reopens/);
  assert.doesNotMatch(reason, /TRIPWIRE 1/);
});

test("an adjudication receipt AFTER a terminal verdict is invalid at load time (Codex, #543 round 3)", () => {
  // The refusal-side rule alone was bypassable: a later continue receipt
  // would become the last extension and read as reopening the loop. The
  // receipt itself is rejected unless a david receipt intervened.
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "" });
  assert.match(
    validateExtension(1, "product", adjudication(1), { io: null, preceding: [shipped] }),
    /terminal adjudication verdict .* is standing/,
  );
  // With a david receipt between them, a fresh adjudication is valid again.
  assert.equal(
    validateExtension(1, "product", adjudication(1, { recordPath: RECORD(1) }), {
      io: null,
      preceding: [shipped, { pr: 1, kind: "david", grant: 2, asOf: 5, authorization: "go" }],
    }),
    null,
  );
});

test("a david grant after a terminal verdict reopens the loop", () => {
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "" });
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(shipped),
    [extensionPath(1, 2)]: json({ pr: 1, kind: "david", grant: 1, asOf: 5, authorization: "one more round" }),
    [RECORD(1)]: recordFile(1, 5),
    [checkPath(1)]: check(1, 5),
  });
  assert.equal(judgeReviewRequest(post(1), io, NOW).blocked, false);
});

test("David's authorization opens exactly his grant past the gate, then the gate repeats", () => {
  const base = {
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 5 })),
    [extensionPath(1, 2)]: json({ pr: 1, kind: "david", grant: 2, asOf: 8, authorization: "yes, keep going" }),
    [RECORD(1)]: recordFile(1, 5),
  };
  assert.equal(
    judgeReviewRequest(post(1), fakeIo({ ...base, [checkPath(1)]: check(1, 9) }), NOW).blocked,
    false,
    "round 10 is inside David's 2-round grant past the 8-round gate",
  );
  const { blocked, reason } = judgeReviewRequest(post(1), fakeIo({ ...base, [checkPath(1)]: check(1, 10) }), NOW);
  assert.equal(blocked, true, "his grant spent, the gate stands again -- adjudicator grants cannot pass it");
  assert.match(reason, /TRIPWIRE 2 \(the David gate\)/);
  assert.match(reason, /exactly where David's latest grant runs out/);
});

test("a direct David grant before the leash is spent places the next gate at its end (Codex, #574 round 1)", () => {
  // A product escalation can bring David in BELOW the leash. His grant of 2
  // at round 5 yields allowance 7 -- and the gate must stand at 7, not at
  // the never-used budget+leash rail of 8, or Fable could self-serve rounds
  // he did not grant on top of the ones he just did.
  const direct = [{ kind: "david", grant: 2, asOf: 5, authorization: "two more" }];
  assert.equal(allowance("product", direct, 5), 7);
  assert.equal(railFor("product", direct, 7), 7, "the unused leash is discarded, not carried forward");
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json({ pr: 1, kind: "david", grant: 2, asOf: 5, authorization: "two more" }),
    [checkPath(1)]: check(1, 7),
  });
  const { blocked, reason } = judgeReviewRequest(post(1), io, NOW);
  assert.equal(blocked, true);
  assert.match(reason, /TRIPWIRE 2 \(the David gate\)/);
});

test("an anchored direct grant during an ACTIVE leash activates immediately and cuts it short (Codex, #574 round 2)", () => {
  // Codex's exact scenario: budget 5, adjudication grant 3 (leash to 8),
  // 6 rounds spent, product escalation, David grants 2. Anchored at 6, his
  // rounds are 7-8 and the gate stands at 8 -- NOT dormant until 8 and then
  // stacked on top of the leash's unspent rounds to open 9-10.
  const chain = [
    { kind: "adjudication", verdict: "continue", grant: 3 },
    { kind: "david", grant: 2, asOf: 6, authorization: "two more" },
  ];
  assert.equal(allowance("product", chain, 6), 8, "asOf 6 + grant 2: his rounds are 7-8");
  assert.equal(railFor("product", chain, 6), 8, "the gate stands at 8");
  assert.equal(allowance("product", chain, 8), 8, "nothing left at 8 -- rounds 9-10 were never granted");
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 3 })),
    [extensionPath(1, 2)]: json({ pr: 1, kind: "david", grant: 2, asOf: 6, authorization: "two more" }),
    [RECORD(1)]: recordFile(1, 5),
    [checkPath(1)]: check(1, 8),
  });
  const { blocked, reason } = judgeReviewRequest(post(1), io, NOW);
  assert.equal(blocked, true);
  assert.match(reason, /TRIPWIRE 2 \(the David gate\)/);
});

test("asOf is required on every finite David grant -- missing or malformed refuses (Codex, #574 round 3)", () => {
  // Round 2 kept the anchor optional; round 3 showed one forgotten field
  // silently re-created the direct-grant stacking bug. Activation semantics
  // bound the typo surface (a wrong anchor goes dormant or drops the
  // allowance -- both fail closed), so requiring it is the safe side.
  const bad = { pr: 1, kind: "david", grant: 2, asOf: "six", authorization: "two more" };
  assert.match(validateExtension(1, "product", bad, { io: null }), /must carry "asOf"/);
  assert.match(validateExtension(1, "product", { ...bad, asOf: -1 }, { io: null }), /must carry "asOf"/);
  const { asOf, ...missing } = bad;
  assert.match(validateExtension(1, "product", missing, { io: null }), /must carry "asOf"/);
  assert.equal(
    validateExtension(1, "product", { pr: 1, kind: "david", grant: "uncapped", authorization: "go" }, { io: null }),
    null,
    "uncapped has no boundary arithmetic to anchor -- exempt",
  );
});

test("a later anchored David receipt supersedes an earlier uncapped grant (Codex, #574 round 3)", () => {
  // The old early return made David's stop invisible after an uncapped
  // authorization: allowance stayed Infinity forever. His newer receipt now
  // re-caps the loop.
  const chain = [
    { kind: "david", grant: "uncapped", asOf: 5, authorization: "keep going, uncapped" },
    { kind: "david", grant: 0, asOf: 9, authorization: "actually, stop" },
  ];
  assert.equal(allowance("product", chain, 9), 9, "his stop re-caps the loop at round 9");
  assert.equal(railFor("product", chain, 9), 9, "the gate stands where he stopped it");
  assert.equal(allowance("product", [chain[0]], 9), Infinity, "uncapped alone is still uncapped");
  const recap = [chain[0], { kind: "david", grant: 2, asOf: 9, authorization: "two more, then stop" }];
  assert.equal(allowance("product", recap, 9), 11, "a finite anchored grant restores a boundary");
});

test("a David grant of 0 collapses the gate to the current allowance -- an endorsed stop opens nothing", () => {
  const stopped = [{ kind: "david", grant: 0, authorization: "agreed, stop" }];
  assert.equal(allowance("product", stopped, 5), 5);
  assert.equal(railFor("product", stopped, 5), 5, "the gate stands exactly where he stopped it");
});

test("the sensitive tier runs the same two-tier tripwire: Fable at 5, David at 8", () => {
  // David, 2026-08-26, superseding the mandatory-stop-for-him-at-5 shape.
  const at4 = fakeIo({ [budgetPath(1)]: budget(1, "sensitive"), [checkPath(1)]: check(1, 4) });
  assert.equal(judgeReviewRequest(post(1), at4, NOW).blocked, false, "in budget");

  const at5 = fakeIo({ [budgetPath(1)]: budget(1, "sensitive"), [checkPath(1)]: check(1, 5) });
  const tripwire1 = judgeReviewRequest(post(1), at5, NOW);
  assert.equal(tripwire1.blocked, true);
  assert.match(tripwire1.reason, /TRIPWIRE 1 \(self-serve\)/, "sensitive self-serves the leash like every tier");

  const at8 = fakeIo({
    [budgetPath(1)]: budget(1, "sensitive"),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 3 })),
    [RECORD(1)]: recordFile(1, 5),
    [checkPath(1)]: check(1, 8),
  });
  const gate = judgeReviewRequest(post(1), at8, NOW);
  assert.equal(gate.blocked, true);
  assert.match(gate.reason, /TRIPWIRE 2 \(the David gate\)/);
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

const SNAPSHOT_NOW = Date.parse("2026-08-17T10:40:00Z");

const snapshot = (pr, extra = {}) => ({
  pr: { number: pr },
  repo: "TheAnswerManIsHere/Overhypeme",
  capturedAt: "2026-08-17T10:35:00Z",
  reviews: [
    {
      id: 1,
      user: { login: "chatgpt-codex-connector[bot]" },
      submitted_at: "2026-08-17T10:00:00Z",
      body: "**Reviewed commit:** `abc1234567`",
    },
  ],
  issueComments: [{ id: 2, user: { login: "TheAnswerManIsHere" }, created_at: "2026-08-17T10:30:00Z", body: "hi" }],
  complete: { reviews: true, issueComments: true },
  ...extra,
});

const assertSnapshot = (pr, snap) => assertCountingSnapshot(pr, snap, SNAPSHOT_NOW);

test("a counting snapshot must describe this PR and be attested complete", () => {
  assert.doesNotThrow(() => assertSnapshot(1, snapshot(1)));
  assert.throws(() => assertSnapshot(2, snapshot(1)), /describes PR 1, but --pr says 2/);
  assert.throws(
    () => assertSnapshot(1, snapshot(1, { complete: { reviews: true, issueComments: false } })),
    /complete\.issueComments === true/,
  );
});

test("a snapshot whose entries lack the counted fields is rejected, not undercounted", () => {
  // An attested-complete snapshot with unusable entries would be silently
  // undercounted by reviewerPasses — wrong in the guard's favour. (Codex,
  // #503 round 3.)
  assert.throws(
    () => assertSnapshot(1, snapshot(1, { reviews: [{ user: { login: "x" }, submitted_at: "2026-08-17T10:00:00Z" }] })),
    /reviews\[0\] is missing a stable id/,
  );
  assert.throws(
    () => assertSnapshot(1, snapshot(1, { reviews: [{ id: 1, user: { login: "x" }, submitted_at: "nope" }] })),
    /parseable submitted_at/,
  );
  assert.throws(
    () => assertSnapshot(1, snapshot(1, { issueComments: [{ id: 1, created_at: "2026-08-17T10:00:00Z" }] })),
    /issueComments\[0\] is missing a stable id/,
  );
});

// ---------------------------------------------------------------------------
// Codex, #503 round 4. Six findings, all against the counting mechanism —
// which is new code on its first review, not the previous round's fixes.
// ---------------------------------------------------------------------------

test("the trigger is refused on any surface the count cannot see", () => {
  // countRounds detects a pending round by scanning issue comments. A trigger
  // posted through a thread reply or a review body lands somewhere else, so a
  // check taken while it is in flight reports no pending round and can
  // authorize another request at the cap. Narrowing the POSTING surface makes
  // issueComments complete by construction.
  const io = fakeIo({ [budgetPath(7)]: budget(7), [checkPath(7)]: check(7, 0) });
  for (const toolName of [
    "mcp__github__add_reply_to_pull_request_comment",
    "mcp__github__pull_request_review_write",
  ]) {
    const verdict = judgeReviewRequest(
      { toolName, toolInput: { owner: REPO_OWNER, repo: REPO_NAME, pullNumber: 7, body: "@codex review" } },
      io,
      NOW,
    );
    assert.equal(verdict.blocked, true, `${toolName} must not be able to post a trigger`);
    assert.match(verdict.reason, /Post the re-request as an issue comment/);
  }
  assert.equal(
    judgeReviewRequest(post(7), io, NOW).blocked,
    false,
    "the sanctioned surface still works — this narrows posting, it does not break it",
  );
});

test("a reply that does not carry the trigger is untouched by the surface rule", () => {
  // Replying to review threads is most of what this session does; only a body
  // carrying the trigger is judged at all.
  const io = fakeIo({ [budgetPath(7)]: budget(7) });
  const verdict = judgeReviewRequest(
    {
      toolName: "mcp__github__add_reply_to_pull_request_comment",
      toolInput: { owner: REPO_OWNER, repo: REPO_NAME, pullNumber: 7, body: "Fixed in abc1234." },
    },
    io,
    NOW,
  );
  assert.equal(verdict.blocked, false);
});

test("a counting snapshot is bound to the repository, not just the PR number", () => {
  // Every repo has a #503. A foreign snapshot with fewer passes would be
  // laundered into a lower count while `check` stamped this repo's name on it.
  assert.throws(() => assertSnapshot(1, snapshot(1, { repo: undefined })), /must name its source repository/);
  assert.throws(() => assertSnapshot(1, snapshot(1, { repo: "someone/else" })), /must name its source repository/);
  assert.doesNotThrow(() => assertSnapshot(1, snapshot(1, { repo: "theanswermanishere/overhypeme" })));
});

test("freshness is a property of the evidence, not of the command", () => {
  // Stamping the receipt with the command time let a snapshot saved hours ago
  // — after which more passes landed — mint a receipt that looked current for
  // another hour while carrying the older, lower count.
  assert.throws(() => assertSnapshot(1, snapshot(1, { capturedAt: undefined })), /parseable "capturedAt"/);
  assert.throws(() => assertSnapshot(1, snapshot(1, { capturedAt: "not a time" })), /parseable "capturedAt"/);
  assert.throws(
    () => assertSnapshot(1, snapshot(1, { capturedAt: "2026-08-17T11:00:00Z" })),
    /is in the future/,
  );
  assert.throws(
    () => assertSnapshot(1, snapshot(1, { capturedAt: new Date(SNAPSHOT_NOW - MAX_CHECK_AGE_MS - 1000).toISOString() })),
    /older than the 60-minute limit/,
  );
});

test("a body is required exactly where the count reads one", () => {
  // Reviewer reviews: the pass count keys on the "Reviewed commit:"
  // announcement in the body, so an omitted one silently changes the count.
  assert.throws(
    () =>
      assertSnapshot(
        1,
        snapshot(1, {
          reviews: [{ id: 1, user: { login: "chatgpt-codex-connector[bot]" }, submitted_at: "2026-08-17T10:00:00Z" }],
        }),
      ),
    /reviewer record with no string body/,
  );
  // Non-reviewer reviews are not: demanding a body there would mean inventing
  // empty ones for the dozens of my own replies a real snapshot carries.
  assert.doesNotThrow(() =>
    assertSnapshot(
      1,
      snapshot(1, {
        reviews: [
          {
            id: 1,
            user: { login: "chatgpt-codex-connector[bot]" },
            submitted_at: "2026-08-17T10:00:00Z",
            body: "**Reviewed commit:** `abc1234567`",
          },
          { id: 2, user: { login: "TheAnswerManIsHere" }, submitted_at: "2026-08-17T10:10:00Z" },
        ],
      }),
    ),
  );
  // Every issue comment's body is load-bearing: it is the only place a pending
  // trigger can be seen, and an absent body reads as "no trigger".
  assert.throws(
    () =>
      assertSnapshot(
        1,
        snapshot(1, {
          issueComments: [{ id: 2, user: { login: "TheAnswerManIsHere" }, created_at: "2026-08-17T10:30:00Z" }],
        }),
      ),
    /issueComments\[0\] has no string body/,
  );
});

test("a retry of a stalled round is allowed at the cap; a NEW round is not", () => {
  // The deadlock: product cap 5, four passes delivered, one request stalled.
  // spent === 5 === cap refused the retry — and the documented recovery could
  // not clear it either, because the adjudication record would show 2
  // completed passes against a required 3. A reviewer outage at the cap became
  // a hard stop until David intervened.
  const stalled = fakeIo({
    [budgetPath(8)]: budget(8),
    [checkPath(8)]: check(8, 5, { delivered: 4, pending: 1 }),
  });
  assert.equal(
    judgeReviewRequest(post(8), stalled, NOW).blocked,
    false,
    "pending === 1 means nothing has been answered since that request, so this IS the same round",
  );

  const atCap = fakeIo({
    [budgetPath(9)]: budget(9),
    [checkPath(9)]: check(9, 5, { delivered: 5, pending: 0 }),
  });
  const verdict = judgeReviewRequest(post(9), atCap, NOW);
  assert.equal(verdict.blocked, true, "with nothing in flight, the next request is a sixth round");
  assert.match(verdict.reason, /TRIPWIRE 1/);
});

test("the tripwire still fires the moment the stalled round is answered", () => {
  // The retry allowance must not become a way to sit past the cap forever.
  const answered = fakeIo({
    [budgetPath(10)]: budget(10),
    [checkPath(10)]: check(10, 5, { delivered: 5, pending: 0 }),
  });
  assert.equal(judgeReviewRequest(post(10), answered, NOW).blocked, true);
});

test("one check authorizes one post even when two are issued together", () => {
  // consumedAt alone is a read-then-write, and the guard runs once per tool
  // call in its own process. The claim is an exclusive create, so exactly one
  // caller wins whatever the interleaving.
  const io = fakeIo({ [budgetPath(11)]: budget(11), [checkPath(11)]: check(11, 0) });
  assert.equal(judgeReviewRequest(post(11), io, NOW).blocked, false);

  // Simulate the race precisely: the second process read the receipt BEFORE
  // the first wrote consumedAt, so consumedAt cannot be what stops it.
  io.store[checkPath(11)] = check(11, 0);
  const second = judgeReviewRequest(post(11), io, NOW);
  assert.equal(second.blocked, true, "only the claim can catch this; consumedAt is already gone");
  assert.match(second.reason, /already been claimed by another post in flight/);
});

// ---------------------------------------------------------------------------
// Codex, #503 head pass. Three fail-open routes, each of which let a single
// authorization produce more than the one round it authorized.
// ---------------------------------------------------------------------------

test("a fresh check cannot destroy a live claim, because the claim is keyed to the receipt's generation", () => {
  // The route: `check` used to delete the PR's one claim file before writing a
  // fresh receipt. A `check` running while a post was mid-flight destroyed
  // that post's LIVE claim, so a second post could claim the new receipt while
  // the first still proceeded on the one it had already read -- two requests
  // from one single-use authorization.
  const io = fakeIo({ [budgetPath(20)]: budget(20), [checkPath(20)]: check(20, 0) });
  assert.equal(judgeReviewRequest(post(20), io, NOW).blocked, false, "the first post claims generation A");

  const claimA = claimPath(20, "0123456789abcdef");
  assert.equal(claimA in io.store, true, "generation A's claim is on disk");

  // A new generation arrives (a fresh `check` run). It is a DIFFERENT file, so
  // nothing needs deleting and generation A's claim survives untouched.
  io.store[checkPath(20)] = check(20, 0, { nonce: "fedcba9876543210" });
  assert.equal(claimA in io.store, true, "the new generation cannot reach the old claim");

  // And a post replaying generation A is still refused by A's own claim.
  io.store[checkPath(20)] = check(20, 0);
  const replay = judgeReviewRequest(post(20), io, NOW);
  assert.equal(replay.blocked, true);
  assert.match(replay.reason, /already been claimed by another post in flight/);
});

test("the claim path is derived from the nonce, and a receipt without one is refused", () => {
  assert.equal(claimPath(20, "0123456789abcdef"), `${checkPath(20)}.0123456789abcdef.claim`);
  assert.notEqual(
    claimPath(20, "0123456789abcdef"),
    claimPath(20, "fedcba9876543210"),
    "two generations must never share a claim file -- that sharing IS the race",
  );
  // Fail closed rather than falling back to a shared path.
  assert.throws(() => claimPath(20, undefined), /carries no usable nonce/);
  assert.throws(() => claimPath(20, "not-hex"), /carries no usable nonce/);

  // A receipt minted before this keying existed has no generation to key to,
  // so it is refused at validation rather than claimed on a guessed path.
  const stale = fakeIo({ [budgetPath(21)]: budget(21), [checkPath(21)]: check(21, 0, { nonce: undefined }) });
  const verdict = judgeReviewRequest(post(21), stale, NOW);
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /carries no generation nonce/);
});

test("a request in the same second as the latest pass is cannot-determine, not zero", () => {
  // The route: `pending` was computed with a strict `>`, so a request sharing
  // its second with the latest completed pass read as pending 0 -- which at
  // the cap frees the tripwire to authorize one more request that may already
  // be in flight. Second-resolution timestamps make the tie ordinary, not
  // exotic.
  const tie = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z")],
    issueComments: [comment("2026-08-17T10:00:00Z")],
  });
  assert.equal(tie.pending, 0, "the tie cannot be counted as pending either -- it is unordered");
  assert.equal(tie.ambiguous, true, "so the count is flagged as undeterminable rather than reported as fact");

  // A tie is only ambiguous when nothing later resolves it: a request strictly
  // after the pass is an ordinary pending round, tie or no tie.
  const resolved = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z")],
    issueComments: [comment("2026-08-17T10:00:00Z"), comment("2026-08-17T10:30:00Z")],
  });
  assert.deepEqual(resolved, { delivered: 1, pending: 1, spent: 2, ambiguous: false });
});

test("an unresolvable tie counts as answered, and the loop stays LIVE", () => {
  // #526 finding 6. The first fix made `check` refuse to mint on a tie. That
  // was safe and dead: if the tied request came just BEFORE the pass that
  // answered it, neither timestamp ever changes again, so the condition held
  // forever -- and the one thing that would clear it, a later request, was
  // itself refused. The PR could never be reviewed again, and no
  // authorization could rescue it, because the refusal happened before
  // allowance was consulted.
  //
  // `pending: 0` is the cap-preserving reading, so the tie is counted that
  // way and the loop keeps moving. Below the cap it changes nothing at all:
  const belowCap = fakeIo({
    [budgetPath(30)]: budget(30),
    [checkPath(30)]: check(30, 1, { delivered: 1, pending: 0, ambiguous: true }),
  });
  assert.equal(judgeReviewRequest(post(30), belowCap, NOW).blocked, false, "a tie is not itself a refusal");

  // At the cap it refuses -- the safe half -- and SAYS the count may be one
  // low, so whoever adjudicates knows this might be a retry rather than a new
  // round.
  const atCap = fakeIo({
    [budgetPath(31)]: budget(31),
    [checkPath(31)]: check(31, 5, { delivered: 5, pending: 0, ambiguous: true }),
  });
  const refused = judgeReviewRequest(post(31), atCap, NOW);
  assert.equal(refused.blocked, true);
  assert.match(refused.reason, /TRIPWIRE 1/, "an ordinary tripwire, not a dead end");
  assert.match(refused.reason, /SAME second/, "and it explains the tie rather than reporting a bare count");

  // THE LIVENESS CLAIM: the ordinary escalation releases it. Under the old
  // design no receipt could be minted at all, so this was unreachable.
  const released = fakeIo({
    [budgetPath(32)]: budget(32),
    [RECORD(32)]: recordFile(32),
    [extensionPath(32, 1)]: json(adjudication(32)),
    [checkPath(32)]: check(32, 3, { delivered: 3, pending: 0, ambiguous: true }),
  });
  assert.equal(
    judgeReviewRequest(post(32), released, NOW).blocked,
    false,
    "an extension clears a tied refusal exactly as it clears any other tripwire",
  );
});

test("the real git adapter distinguishes absent-from-the-tree from cannot-tell", () => {
  // The fake models readDurable as a three-way answer; this asserts the REAL
  // adapter produces all three. It matters because a single git call cannot:
  // `git show` exits 128 BOTH for a path missing from the tree and for a ref
  // that does not exist, so the "commit and push it" branch would be
  // unreachable and every missing decision would report the vaguer "could not
  // be established". Resolving the ref first is what splits them, and only a
  // test against real git can catch it going back.
  const io = nodeIo();
  const tracked = io.readDurable("HEAD", "CLAUDE.md");
  assert.equal(tracked.state, "present", "a tracked file in HEAD");
  assert.ok(tracked.text.length > 0, "and its CONTENTS come back -- that is what gets parsed");
  assert.deepEqual(
    io.readDurable("HEAD", "no-such-file-at-the-repo-root.md"),
    { state: "absent" },
    "the ref resolves and the path is not in it -- an answer",
  );
  assert.deepEqual(
    io.readDurable("no-such-ref-exists-here", "CLAUDE.md"),
    { state: "unknown" },
    "no such ref -- not an answer, which the caller must treat as refuse",
  );
});

test("the real git adapter lists a directory from a ref, and reports an unreadable ref as null", () => {
  const io = nodeIo();
  const names = io.listDurable("HEAD", ".agents/receipts");
  assert.ok(Array.isArray(names));
  assert.ok(names.includes("README.md"), "names are relative to the directory, not full paths");
  assert.ok(
    names.every((n) => !n.includes("/")),
    "and carry no path separators, since extensionSequence parses them as bare filenames",
  );
  assert.equal(
    io.listDurable("no-such-ref-exists-here", ".agents/receipts"),
    null,
    "null, never [] -- an empty list would silently forget every extension",
  );
});

test("only what is in the ref grants rounds, whatever the working tree says", () => {
  // This replaces the old extensionDurability matrix. That function existed
  // only because decisions were read from the filesystem and then compared to
  // git; with the compare gone, the invariant is simpler and stronger -- the
  // bytes that are parsed ARE the durable bytes, so there is no window in
  // which a local edit is what grants the rounds. (#526 findings 1, 4, 5, 7.)
  const rel = extensionPath(22, 1);
  const files = {
    [budgetPath(22)]: budget(22),
    [RECORD(22)]: recordFile(22),
    [rel]: json(adjudication(22)),
    [checkPath(22)]: check(22, 5),
  };

  // In the ref: the grant is live and the loop may continue past its cap.
  assert.equal(judgeReviewRequest(post(22), fakeIo(files), NOW).blocked, false);

  // A LOCAL EDIT IS NOT MERELY IGNORED -- IT IS UNOBSERVABLE. The previous
  // design needed a byte comparison to catch it, and that comparison is what
  // findings 1, 4 and 7 were about. Here the working tree is not on the
  // decision path at all, which is the claim worth pinning: blow up both
  // filesystem readers and the loop still loads. If either is ever wired back
  // in, this fails immediately rather than years later on someone's CRLF
  // checkout.
  const noWorktree = fakeIo(files);
  noWorktree.read = () => {
    throw new Error("the working tree must not be consulted for a durable decision");
  };
  noWorktree.listReceipts = () => {
    throw new Error("the working tree must not be listed for durable decisions");
  };
  const state = loadLoop(22, noWorktree);
  assert.equal(state.problem, undefined, "loadLoop reads decisions from the ref alone");
  assert.equal(state.extensions.length, 1);
  assert.equal(state.extensions[0].grant, adjudication(22).grant, "and gets them from the ref");

  // Absent from the ref: no grant, so the tripwire still refuses.
  const local = fakeIo(files);
  local.readDurable = (_r, r) => (r === rel ? { state: "absent" } : { state: "present", text: local.store[r] });
  local.listDurable = () => ["loop-budget-22.json"];
  const uncommitted = judgeReviewRequest(post(22), local, NOW);
  assert.equal(uncommitted.blocked, true);
  assert.match(uncommitted.reason, /TRIPWIRE 1/, "and it is the ordinary tripwire, not a special durability error");

  // Unreadable ref: refuse, because "I could not check" is not evidence.
  const unknown = fakeIo(files);
  unknown.readDurable = () => ({ state: "unknown" });
  assert.equal(judgeReviewRequest(post(22), unknown, NOW).blocked, true);
});

test("a round-check receipt must carry a coherent delivered/pending split", () => {
  // The gate reads these directly now, so neither may be absent or wrong.
  const base = {
    pr: 1,
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    capturedAt: new Date(NOW - 60_000).toISOString(),
    nonce: "0123456789abcdef",
  };
  assert.match(
    validateCheckReceipt(1, { ...base, spent: 2, pending: 0 }, NOW),
    /no usable delivered count/,
  );
  assert.match(
    validateCheckReceipt(1, { ...base, spent: 2, delivered: 2, pending: 2 }, NOW),
    /at most one round can be in flight/,
  );
  assert.match(
    validateCheckReceipt(1, { ...base, spent: 5, delivered: 2, pending: 1 }, NOW),
    /does not add up/,
  );
  assert.equal(validateCheckReceipt(1, { ...base, spent: 3, delivered: 2, pending: 1 }, NOW), null);
});

// ---------------------------------------------------------------------------
// Codex, #503 round 5. Four of the five are round-4 fixes that were incomplete
// — the gate change, the claim (twice), and the surface claim — which is the
// oscillation signal that ended this loop.
// ---------------------------------------------------------------------------

test("a reviewer's own footer quoting the trigger is not a pending request", () => {
  // Codex's connector footer says: Reviews are triggered when you ... comment
  // "@codex review". Counting that as pending would SUPPRESS the tripwire,
  // because `pending` now gates the refusal — and re-suppress it every time a
  // later response carried a newer footer.
  const footer = 'Reviews are triggered when you comment "@codex review".';
  const withReviewerFooter = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z")],
    issueComments: [
      { user: { login: "chatgpt-codex-connector[bot]" }, created_at: "2026-08-17T10:30:00Z", body: footer },
    ],
  });
  assert.equal(withReviewerFooter.pending, 0, "a reviewer never requests its own review");

  const mine = countRounds({
    reviewerPasses: [pass("2026-08-17T10:00:00Z")],
    issueComments: [
      { user: { login: "TheAnswerManIsHere" }, created_at: "2026-08-17T10:30:00Z", body: "@codex review" },
    ],
  });
  assert.equal(mine.pending, 1, "a real request still counts");
});

test("a claim or consume failure blocks the post rather than escaping", () => {
  // An escaping throw does NOT fail closed: main() is `.then(code => exit(code))`,
  // so a rejection exits 1, guard.sh forwards it, and 1 is a hook error rather
  // than the blocking code 2 — the post proceeds. The exact filesystem faults
  // the comments promise will fail closed were the ones letting requests through.
  for (const broken of [
    { claimOnce: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); } },
    { write: () => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); } },
  ]) {
    const io = { ...fakeIo({ [budgetPath(12)]: budget(12), [checkPath(12)]: check(12, 0) }), ...broken };
    const verdict = judgeReviewRequest(post(12), io, NOW);
    assert.equal(verdict.blocked, true);
    assert.match(verdict.reason, /could not be claimed or consumed/);
  }
});

test("a snapshot must be strictly newer than the evidence already on file", () => {
  // The claim closed the concurrent race and opened a sequential one: re-running
  // check with the same still-fresh snapshot overwrote the consumed receipt and
  // released the claim, so one evidence state could authorize post after post
  // for a whole hour.
  const receipt = {
    pr: 1,
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    capturedAt: "2026-08-17T10:35:00Z",
    delivered: 1,
    pending: 0,
    spent: 1,
    consumedAt: "2026-08-17T10:36:00Z",
  };
  // Same capture time as the receipt on file -> refused.
  assert.equal(Date.parse(snapshot(1).capturedAt) <= Date.parse(receipt.capturedAt), true);
  // Strictly newer -> accepted. (Both asserted through assertSnapshot's own
  // clock so the freshness window is not what is being measured here.)
  const newer = snapshot(1, { capturedAt: "2026-08-17T10:38:00Z" });
  assert.doesNotThrow(() => assertSnapshot(1, newer));
  assert.equal(Date.parse(newer.capturedAt) > Date.parse(receipt.capturedAt), true);
});

test("a record with no stable id is rejected, not silently deduplicated", () => {
  // reviewerPasses deduplicates by id, so two records sharing one collapse into
  // one delivered pass — an undercount, which hands the loop free rounds. The
  // old check rejected only `undefined`, and every null equals every other.
  for (const id of [null, undefined, "", {}]) {
    assert.throws(
      () =>
        assertSnapshot(
          1,
          snapshot(1, {
            reviews: [
              {
                id,
                user: { login: "chatgpt-codex-connector[bot]" },
                submitted_at: "2026-08-17T10:00:00Z",
                body: "**Reviewed commit:** `abc1234567`",
              },
            ],
          }),
        ),
      /reviews\[0\] is missing a stable id/,
      `reviews id ${JSON.stringify(id)} must be rejected`,
    );
    assert.throws(
      () =>
        assertSnapshot(
          1,
          snapshot(1, {
            issueComments: [
              { id, user: { login: "TheAnswerManIsHere" }, created_at: "2026-08-17T10:30:00Z", body: "hi" },
            ],
          }),
        ),
      /issueComments\[0\] is missing a stable id/,
      `issueComments id ${JSON.stringify(id)} must be rejected`,
    );
  }
  // Numeric and non-empty string ids are both real GitHub shapes.
  assert.doesNotThrow(() => assertSnapshot(1, snapshot(1)));
  assert.doesNotThrow(() =>
    assertSnapshot(
      1,
      snapshot(1, {
        issueComments: [
          { id: "PRRC_kwDO", user: { login: "TheAnswerManIsHere" }, created_at: "2026-08-17T10:30:00Z", body: "hi" },
        ],
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// The internal tier loops, strictly (David, 2026-08-21)
// ---------------------------------------------------------------------------


test("the internal tier self-serves the leash like every tier (David, 2026-08-26)", () => {
  // The strictness stayed where it belongs -- the adjudicator's internal
  // rubric (write only for a near-certain CRITICAL flaw) -- while the cap
  // stopped routing straight to David: Fable rules at 3, he gates at 6.
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "" });
  assert.equal(validateExtension(1, "internal", shipped, { io: null }), null);
  const extensions = [{ kind: "adjudication", verdict: "continue", grant: 5 }];
  assert.equal(allowance("internal", extensions, 3), 6, "an oversized grant is clipped at the 6-round David gate");
});

test("an internal loop at its cap gets the self-serve tripwire; the David gate stands at 6", () => {
  const at3 = fakeIo({ [budgetPath(1)]: budget(1, "internal"), [checkPath(1)]: check(1, 3) });
  const tripwire1 = judgeReviewRequest(post(1), at3, NOW);
  assert.equal(tripwire1.blocked, true);
  assert.match(tripwire1.reason, /tier "internal"/);
  assert.match(tripwire1.reason, /TRIPWIRE 1 \(self-serve\)/);
  assert.match(tripwire1.reason, /David gate of 6 rounds/);

  const at6 = fakeIo({
    [budgetPath(1)]: budget(1, "internal"),
    [extensionPath(1, 1)]: json(adjudication(1, { grant: 3 })),
    [RECORD(1)]: recordFile(1, 3),
    [checkPath(1)]: check(1, 6),
  });
  const gate = judgeReviewRequest(post(1), at6, NOW);
  assert.equal(gate.blocked, true);
  assert.match(gate.reason, /TRIPWIRE 2 \(the David gate\)/);
});

test("an in-budget internal round is allowed like any other declared loop", () => {
  const io = fakeIo({ [budgetPath(1)]: budget(1, "internal"), [checkPath(1)]: check(1, 2) });
  assert.equal(judgeReviewRequest(post(1), io, NOW).blocked, false);
});

test("a standing terminal verdict refuses even a pending-round retry (Codex, #553 round 2)", () => {
  // A retry posts a fresh trigger and spawns a fresh round -- exactly what
  // only a david-kind receipt may authorize once a terminal verdict stands,
  // so `pending` must not convert a refused round into a permitted retry.
  // Pinned on the product tier: under the write-gate rule (David,
  // 2026-08-22) that is the only tier whose loop commits terminal receipts
  // at all, and its own MID-budget case cannot arise -- a terminal receipt
  // requires the record to show the loop already at its cap.
  const shipped = adjudication(1, { verdict: "ship-with-gaps-recorded", grant: 0, risk: "" });
  const io = fakeIo({
    [budgetPath(1)]: budget(1),
    [extensionPath(1, 1)]: json(shipped),
    [RECORD(1)]: recordFile(1, 5),
    [checkPath(1)]: check(1, 6, { pending: 1, delivered: 5 }),
  });
  const { blocked, reason } = judgeReviewRequest(post(1), io, NOW);
  assert.equal(blocked, true);
  assert.match(reason, /TERMINAL adjudication verdict is standing/);
});

