import { test } from "node:test";
import assert from "node:assert/strict";

import {
  recordProblems,
  judgmentProblems,
  adjudicationProblems,
  meetsSamplingPredicate,
  validFindings,
  ledgerBaselineProblem,
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
  allInvalid.judgment.causes = { new: 0, prop: 0, wrong: 0, reRaised: 0, invalid: 3 };
  assert.equal(validFindings(allInvalid), 0);
  ok(allInvalid);

  // A zero-finding loop likewise.
  const clean = record({ adjudication: { status: "n/a" } });
  clean.mechanical.findings = 0;
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
