import { test } from "node:test";
import assert from "node:assert/strict";

import {
  recordProblems,
  judgmentProblems,
  adjudicationProblems,
  meetsSamplingPredicate,
  validFindings,
  ledgerBaselineProblem,
  ledgerCheckProblem,
} from "../check-loop-metrics.mjs";

/** A valid measured record. PR 344 is not divisible by 5 and has < 30 findings,
 *  so its settled adjudication state is `never-run`. */
function record(overrides = {}) {
  return {
    schemaVersion: 1,
    pr: 344,
    closedAt: "2026-08-07T18:22:10Z",
    mechanical: {
      title: "Add a thing",
      cohort: "feature/code",
      size: { files: 5, added: 120, removed: 8 },
      rounds: 3,
      findings: 7,
      perRound: [{ round: 1, findings: 4 }, { round: 2, findings: 3 }, { round: 3, findings: 0 }],
      reviewInterval: { hours: 24 },
      warnings: [],
    },
    judgment: {
      causes: { new: 5, prop: 1, wrong: 1, reRaised: 0, invalid: 0 },
      preOpenPreflightMin: 12,
      breakersFired: "none",
    },
    adjudication: { status: "never-run" },
    notes: "",
    ...overrides,
  };
}

const problemsFor = (r, filename = `${r.pr}.json`) => recordProblems(r, filename);
const ok = (r, filename) => assert.deepEqual(problemsFor(r, filename), []);
const failsWith = (r, needle, filename) => {
  const problems = problemsFor(r, filename);
  assert.ok(
    problems.some((p) => p.includes(needle)),
    `expected a problem containing ${JSON.stringify(needle)}, got: ${JSON.stringify(problems)}`,
  );
};

test("a well-formed measured record passes", () => {
  ok(record());
});

test("the filename must agree with the pr field", () => {
  failsWith(record(), "filename is 999.json", "999.json");
});

// ── The mechanical allowlist ────────────────────────────────────────────────

test("mechanical carrying adjudication_sample fails the allowlist", () => {
  const r = record();
  r.mechanical.adjudication_sample = { size: 7 };
  failsWith(r, 'mechanical carries "adjudication_sample"');
});

test("mechanical carrying a coarse state fails the allowlist", () => {
  const r = record();
  r.mechanical.state = "merged";
  failsWith(r, 'mechanical carries "state"');
});

test("mechanical carrying its own pr or judgment fails the allowlist", () => {
  const withPr = record();
  withPr.mechanical.pr = 344;
  failsWith(withPr, 'mechanical carries "pr"');

  const withJudgment = record();
  withJudgment.mechanical.judgment = { new_ground: null };
  failsWith(withJudgment, 'mechanical carries "judgment"');
});

// ── Causal arithmetic ───────────────────────────────────────────────────────

test("causal counts must sum exactly to findings", () => {
  const r = record();
  r.judgment.causes.new = 4; // sums to 6, not 7
  failsWith(r, "causal counts sum to 6 but findings is 7");
});

// ── Judgment completeness ───────────────────────────────────────────────────

test("a committed --write scaffold fails rather than sitting valid-looking", () => {
  // The crash case: a session interrupted between --write and filling the
  // judgment, whose scaffold then gets committed.
  const scaffold = record({ judgment: null, adjudication: null });
  failsWith(scaffold, "judgment is null");
});

test("an explicit judgmentDeferred reason is accepted in place of a judgment", () => {
  ok(record({ judgment: null, judgmentDeferred: "mechanical only — see row 6 precedent", adjudication: null }));
});

test("a record cannot both defer judgment and carry one", () => {
  failsWith(record({ judgmentDeferred: "because" }), "cannot both defer judgment and carry one");
});

test("an empty judgmentDeferred reason is not a deferral", () => {
  failsWith(record({ judgment: null, judgmentDeferred: "   " }), "must state a reason");
});

test("null preflight with a stated reason is complete, and stays distinct from a measured zero", () => {
  const unknown = record();
  unknown.judgment.preOpenPreflightMin = null;
  unknown.judgment.preOpenPreflightReason = "branch carried unrelated earlier work";
  ok(unknown);

  const measuredZero = record();
  measuredZero.judgment.preOpenPreflightMin = 0;
  ok(measuredZero);
});

test("null preflight with no reason is a hole, not a measurement", () => {
  const r = record();
  r.judgment.preOpenPreflightMin = null;
  failsWith(r, "must say why it is unknown");
});

// ── The adjudication state matrix, both directions ──────────────────────────

test("the sampling predicate is loop-number or size", () => {
  assert.equal(meetsSamplingPredicate(345, 1), true); // 345 % 5 === 0
  assert.equal(meetsSamplingPredicate(344, 30), true); // findings >= 30
  assert.equal(meetsSamplingPredicate(344, 29), false);
  assert.equal(meetsSamplingPredicate(344, 7), false);
});

test("a loop that meets the predicate may not claim never-run", () => {
  const sampled = record({ pr: 345, closedAt: "2026-08-07T00:00:00Z" });
  failsWith(sampled, 'may not be "never-run"', "345.json");
});

test("a loop that does not meet the predicate may not claim completed", () => {
  const r = record({ adjudication: { status: "completed", population: 7, disagreements: 1 } });
  failsWith(r, "does not meet the sampling predicate");
});

test("a findings>=30 loop meets the predicate even when its number does not", () => {
  const big = record();
  big.mechanical.findings = 30;
  big.mechanical.perRound = [{ round: 1, findings: 30 }];
  big.mechanical.rounds = 1;
  big.judgment.causes = { new: 30, prop: 0, wrong: 0, reRaised: 0, invalid: 0 };
  failsWith(big, 'may not be "never-run"');

  big.adjudication = { status: "completed", population: 30, disagreements: 3 };
  ok(big);
});

test("a completed adjudication must cover the full finding population", () => {
  const r = record({ pr: 345, adjudication: { status: "completed", population: 5, disagreements: 1 } });
  failsWith(r, "covers the FULL population", "345.json");
});

test("disagreements must lie between zero and the population", () => {
  const tooMany = record({ pr: 345, adjudication: { status: "completed", population: 7, disagreements: 8 } });
  failsWith(tooMany, "must be between 0 and 7", "345.json");

  const negative = record({ pr: 345, adjudication: { status: "completed", population: 7, disagreements: -1 } });
  failsWith(negative, "must be between 0 and 7", "345.json");
});

test("a stored disagreementPct or verdict is rejected as a second representation", () => {
  const withPct = record({
    pr: 345,
    adjudication: { status: "completed", population: 7, disagreements: 1, disagreementPct: 14.3 },
  });
  failsWith(withPct, "adjudication.disagreementPct is derived", "345.json");

  const withVerdict = record({
    pr: 345,
    adjudication: { status: "completed", population: 7, disagreements: 1, verdict: "measured" },
  });
  failsWith(withVerdict, "adjudication.verdict is derived", "345.json");
});

test("n/a is accepted only when the valid-finding denominator is zero", () => {
  // Every finding invalid — the #284 shape. Denominator is zero, so there is
  // genuinely nothing to adjudicate.
  const allInvalid = record({ adjudication: { status: "n/a" } });
  allInvalid.mechanical.findings = 3;
  allInvalid.mechanical.perRound = [{ round: 1, findings: 3 }];
  allInvalid.mechanical.rounds = 1;
  allInvalid.judgment.causes = { new: 0, prop: 0, wrong: 0, reRaised: 0, invalid: 3 };
  assert.equal(validFindings(allInvalid), 0);
  ok(allInvalid);

  // A zero-finding loop likewise.
  const clean = record({ adjudication: { status: "n/a" } });
  clean.mechanical.findings = 0;
  clean.mechanical.perRound = [];
  clean.mechanical.rounds = 0;
  clean.judgment.causes = { new: 0, prop: 0, wrong: 0, reRaised: 0, invalid: 0 };
  ok(clean);

  // But a loop with real valid findings using n/a is a skipped adjudication
  // wearing a legitimate label.
  failsWith(record({ adjudication: { status: "n/a" } }), 'requires a zero valid-finding denominator');
});

test("a deferred adjudication needs a reason", () => {
  failsWith(record({ adjudication: { status: "deferred" } }), "needs a reason");
  ok(record({ adjudication: { status: "deferred", reason: "David deferred pending the replay" } }));
});

test("an unknown adjudication status is rejected", () => {
  failsWith(record({ adjudication: { status: "sampled" } }), "unknown adjudication status");
});

// ── The exempt branch ───────────────────────────────────────────────────────

test("an exempt record is a schema union branch, not a measured record with holes", () => {
  ok({ schemaVersion: 1, pr: 351, exempt: "Dependabot bump triaged under /maintenance" }, "351.json");
});

test("an exempt record needs a reason", () => {
  failsWith({ schemaVersion: 1, pr: 351, exempt: "" }, "needs a reason", "351.json");
});

test("an exempt record must not smuggle in measured fields", () => {
  failsWith(
    { schemaVersion: 1, pr: 351, exempt: "why", mechanical: { findings: 3 } },
    'must not carry "mechanical"',
    "351.json",
  );
});

// ── The frozen ledger baseline ──────────────────────────────────────────────

test("a missing baseline is itself a failure, since the check would be decorative without one", () => {
  const problem = ledgerBaselineProblem("abc123", null);
  assert.match(problem, /no frozen-ledger baseline/);
  assert.match(problem, /AFTER the header edit/);
});

test("a content change is caught by the baseline mismatch", () => {
  const problem = ledgerBaselineProblem("actualhash", "expectedhash");
  assert.match(problem, /has changed since it was frozen/);
  assert.match(problem, /expectedhash/);
  assert.match(problem, /actualhash/);
});

test("a matching baseline passes", () => {
  assert.equal(ledgerBaselineProblem("samehash", "samehash"), null);
});

// ── Helper-level checks ─────────────────────────────────────────────────────

test("judgmentProblems reports every missing cause, not just the first", () => {
  const problems = judgmentProblems({ judgment: { causes: {}, preOpenPreflightMin: 0, breakersFired: "none" } });
  assert.equal(problems.length, 5);
});

test("adjudicationProblems requires a status at all", () => {
  assert.deepEqual(adjudicationProblems({ pr: 344, mechanical: { findings: 1 }, adjudication: {} }), [
    "adjudication is missing a status",
  ]);
});

// ── Negative causal counts ──────────────────────────────────────────────────

test("a negative causal count is rejected even though it is an integer", () => {
  const r = record();
  r.judgment.causes = { new: 8, prop: -1, wrong: 0, reRaised: 0, invalid: 0 }; // still sums to 7
  failsWith(r, "judgment.causes.prop must be a non-negative integer");
});

// ── closedAt must be a real date, not just present ──────────────────────────

test("an unparseable closedAt is rejected, not silently excluded downstream", () => {
  failsWith(record({ closedAt: "not-a-date" }), "closedAt is not a parseable date");
});

test("closedAt still accepts a real ISO timestamp", () => {
  ok(record({ closedAt: "2026-08-07T18:22:10Z" }));
});

// ── never-run requires at least one valid finding ───────────────────────────

test("never-run is rejected when there are zero valid findings — that state is n/a", () => {
  const r = record({ adjudication: { status: "never-run" } });
  r.mechanical.findings = 0;
  r.mechanical.perRound = [];
  r.mechanical.rounds = 0;
  r.judgment.causes = { new: 0, prop: 0, wrong: 0, reRaised: 0, invalid: 0 };
  failsWith(r, 'the settled state is "n/a", not "never-run"');
});

test("never-run is still accepted with a nonzero denominator (the common case)", () => {
  ok(record({ adjudication: { status: "never-run" } }));
});

// ── perRound must actually agree with rounds/findings ───────────────────────

test("mechanical.perRound must be an array", () => {
  const r = record();
  r.mechanical.perRound = null;
  failsWith(r, "mechanical.perRound must be an array");
});

test("perRound entry count must match mechanical.rounds", () => {
  const r = record();
  r.mechanical.perRound = [{ round: 1, findings: 7 }]; // one entry, rounds says 3
  failsWith(r, "mechanical.perRound has 1 entries but mechanical.rounds is 3");
});

test("perRound findings must sum to mechanical.findings", () => {
  const r = record();
  r.mechanical.perRound = [{ round: 1, findings: 4 }, { round: 2, findings: 2 }, { round: 3, findings: 0 }]; // sums to 6, not 7
  failsWith(r, "mechanical.perRound findings sum to 6 but mechanical.findings is 7");
});

test("mechanical.rounds must be an integer", () => {
  const r = record();
  r.mechanical.rounds = "3";
  failsWith(r, "mechanical.rounds must be an integer");
});

// ── reviewInterval must be usable by the digest's formatter ────────────────

test("reviewInterval.hours must be a finite non-negative number", () => {
  const r = record();
  r.mechanical.reviewInterval = { hours: "24" }; // a string — h.toFixed(1) would throw
  failsWith(r, "mechanical.reviewInterval must be null or have a finite, non-negative numeric hours");

  const negative = record();
  negative.mechanical.reviewInterval = { hours: -1 };
  failsWith(negative, "mechanical.reviewInterval must be null or have a finite, non-negative numeric hours");

  const infinite = record();
  infinite.mechanical.reviewInterval = { hours: Infinity };
  failsWith(infinite, "mechanical.reviewInterval must be null or have a finite, non-negative numeric hours");
});

test("reviewInterval is allowed to be null (a loop with no reviews)", () => {
  ok(record({ mechanical: { ...record().mechanical, reviewInterval: null } }));
});

// ── The zero-denominator rule applies to every adjudication status ─────────

test("a sampled, zero-finding loop may not claim completed — that's also n/a", () => {
  // PR #345 is divisible by 5, so it meets the sampling predicate even with
  // zero findings. The prior fix only checked this inside the never-run
  // branch; completed needs the same rule.
  const r = record({ pr: 345, adjudication: { status: "completed", population: 0, disagreements: 0 } });
  r.mechanical.findings = 0;
  r.mechanical.perRound = [];
  r.mechanical.rounds = 0;
  r.judgment.causes = { new: 0, prop: 0, wrong: 0, reRaised: 0, invalid: 0 };
  failsWith(r, 'the settled state is "n/a", not "completed"', "345.json");
});

test("a sampled, all-invalid loop may not claim completed either", () => {
  const r = record({ pr: 345, adjudication: { status: "completed", population: 3, disagreements: 0 } });
  r.mechanical.findings = 3;
  r.mechanical.perRound = [{ round: 1, findings: 3 }];
  r.mechanical.rounds = 1;
  r.judgment.causes = { new: 0, prop: 0, wrong: 0, reRaised: 0, invalid: 3 };
  failsWith(r, 'the settled state is "n/a", not "completed"', "345.json");
});

// ── The frozen ledger: presence, not just content ───────────────────────────

test("ledgerCheckProblem: neither file exists — nothing frozen yet", () => {
  assert.equal(
    ledgerCheckProblem({ ledgerExists: false, baselineExists: false, actualHash: null, expectedHash: null }),
    null,
  );
});

test("ledgerCheckProblem: the ledger is deleted while a baseline still expects it", () => {
  const problem = ledgerCheckProblem({
    ledgerExists: false,
    baselineExists: true,
    actualHash: null,
    expectedHash: "somehash",
  });
  assert.match(problem, /loop-ledger\.md is missing/);
  assert.match(problem, /must not be deleted/);
});

test("ledgerCheckProblem: ledger present with no baseline is the cutover-not-yet-recorded case", () => {
  const problem = ledgerCheckProblem({
    ledgerExists: true,
    baselineExists: false,
    actualHash: "abc123",
    expectedHash: null,
  });
  assert.match(problem, /no frozen-ledger baseline/);
});

test("ledgerCheckProblem: matching hash passes", () => {
  assert.equal(
    ledgerCheckProblem({
      ledgerExists: true,
      baselineExists: true,
      actualHash: "samehash",
      expectedHash: "samehash",
    }),
    null,
  );
});

test("ledgerCheckProblem: mismatched hash fails", () => {
  const problem = ledgerCheckProblem({
    ledgerExists: true,
    baselineExists: true,
    actualHash: "actual",
    expectedHash: "expected",
  });
  assert.match(problem, /has changed since it was frozen/);
});
