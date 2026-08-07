import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selfInflictedShare,
  selfInflictedCount,
  validFindings,
  findingBearingRounds,
  adjudicationVerdict,
  qualifiesForTrend,
  costTotals,
  missingRecords,
  inWindow,
  renderDigest,
  parseArgs,
  FIRST_RECORDED_PR,
} from "../loop-report.mjs";

function record(overrides = {}) {
  const { mechanical, judgment, ...rest } = overrides;
  return {
    schemaVersion: 1,
    pr: 344,
    closedAt: "2026-08-07T12:00:00Z",
    mechanical: {
      title: "Add a thing",
      cohort: "feature/code",
      size: { files: 5, added: 120, removed: 8 },
      rounds: 3,
      findings: 10,
      perRound: [{ round: 1, findings: 6 }, { round: 2, findings: 4 }, { round: 3, findings: 0 }],
      reviewInterval: { hours: 2 },
      warnings: [],
      ...mechanical,
    },
    judgment: {
      causes: { new: 6, prop: 2, wrong: 2, reRaised: 0, invalid: 0 },
      preOpenPreflightMin: 12,
      breakersFired: "none",
      ...judgment,
    },
    adjudication: { status: "never-run" },
    notes: "",
    ...rest,
  };
}

const SINCE = new Date("2026-08-01T00:00:00Z");

// ── Derived values ─────────────────────────────────────────────────────────

test("self-inflicted share is propagation plus wrong-fix over valid findings", () => {
  const r = record();
  assert.equal(selfInflictedCount(r), 4);
  assert.equal(validFindings(r), 10);
  assert.equal(selfInflictedShare(r), 0.4);
});

test("invalid findings are excluded from the denominator", () => {
  const r = record({ mechanical: { findings: 10 }, judgment: { causes: { new: 4, prop: 2, wrong: 2, reRaised: 0, invalid: 2 } } });
  assert.equal(validFindings(r), 8);
  assert.equal(selfInflictedShare(r), 0.5);
});

test("a zero-finding loop reports n/a, not 0%", () => {
  const clean = record({
    mechanical: { findings: 0, perRound: [{ round: 1, findings: 0 }] },
    judgment: { causes: { new: 0, prop: 0, wrong: 0, reRaised: 0, invalid: 0 } },
  });
  assert.equal(selfInflictedShare(clean), null);
});

test("an ALL-INVALID loop reports n/a even though it passes the multi-round filter", () => {
  // The case a findings>0 guard alone would miss: three findings across two
  // finding-bearing rounds, every one invalid, so the denominator is zero.
  // Dividing here would produce NaN or a misleading 0%.
  const allInvalid = record({
    mechanical: { findings: 3, perRound: [{ round: 1, findings: 2 }, { round: 2, findings: 1 }] },
    judgment: { causes: { new: 0, prop: 0, wrong: 0, reRaised: 0, invalid: 3 } },
  });
  assert.equal(findingBearingRounds(allInvalid), 2);
  assert.equal(selfInflictedShare(allInvalid), null);
  assert.equal(qualifiesForTrend(allInvalid), false);
});

// ── The disagreement gate, derived from stored inputs ──────────────────────

test("exactly 20% disagreement is measured; the smallest fraction above is not", () => {
  const at20 = record({ pr: 345, adjudication: { status: "completed", population: 10, disagreements: 2 } });
  assert.equal(adjudicationVerdict(at20), "measured");

  const above = record({ pr: 345, adjudication: { status: "completed", population: 10, disagreements: 3 } });
  assert.equal(adjudicationVerdict(above), "unmeasured");
});

test("a never-run loop has no verdict", () => {
  assert.equal(adjudicationVerdict(record()), null);
});

// ── The qualifying population ──────────────────────────────────────────────

test("never-run loops DO enter churn and trend", () => {
  // They are ~4/5 of all loops; excluding them would leave the digest silent.
  assert.equal(qualifiesForTrend(record()), true);
});

test("an unmeasured loop is excluded from churn and trend", () => {
  const unmeasured = record({
    pr: 345,
    adjudication: { status: "completed", population: 10, disagreements: 5 },
  });
  assert.equal(adjudicationVerdict(unmeasured), "unmeasured");
  assert.equal(qualifiesForTrend(unmeasured), false);
});

test("a single-finding-bearing-round loop is excluded as a structural floor", () => {
  // Propagation and wrong-fix cannot occur before a second finding-bearing
  // round, so such a loop scores 0% by construction rather than by measurement.
  const single = record({
    mechanical: { findings: 4, perRound: [{ round: 1, findings: 4 }, { round: 2, findings: 0 }] },
    judgment: { causes: { new: 4, prop: 0, wrong: 0, reRaised: 0, invalid: 0 } },
  });
  assert.equal(findingBearingRounds(single), 1);
  assert.equal(qualifiesForTrend(single), false);
});

test("an exempt record never enters the population", () => {
  assert.equal(qualifiesForTrend({ schemaVersion: 1, pr: 351, exempt: "dependabot" }), false);
});

// ── Windowing ──────────────────────────────────────────────────────────────

test("the window keys on closedAt, including a loop with no reviews", () => {
  const clean = record({ closedAt: "2026-08-05T00:00:00Z", mechanical: { reviewInterval: null } });
  assert.equal(inWindow(clean, SINCE), true);
  assert.equal(inWindow(record({ closedAt: "2026-07-01T00:00:00Z" }), SINCE), false);
});

test("a record with no closedAt is not placed in any window", () => {
  assert.equal(inWindow(record({ closedAt: null }), SINCE), false);
});

// ── Cost, with unknown preserved as unknown ────────────────────────────────

test("unknown preflight is counted as unknown, never summed as zero", () => {
  const totals = costTotals([
    record({ judgment: { preOpenPreflightMin: 30 } }),
    record({ judgment: { preOpenPreflightMin: null, preOpenPreflightReason: "branch carried earlier work" } }),
    record({ judgment: { preOpenPreflightMin: 10 } }),
  ]);
  assert.equal(totals.preflightMin, 40);
  assert.equal(totals.preflightUnknown, 1);
});

test("the digest reports a known preflight subtotal plus an unknown count, and still ranks the unknown loop", () => {
  const records = [
    record({ pr: 344, judgment: { preOpenPreflightMin: 30 } }),
    record({
      pr: 346,
      mechanical: { reviewInterval: { hours: 99 } },
      judgment: { preOpenPreflightMin: null, preOpenPreflightReason: "unrelated earlier work" },
    }),
  ];
  const digest = renderDigest({ records, since: SINCE });
  assert.match(digest, /1 loop\(s\) unknown/);
  assert.match(digest, /plus 1 loop\(s\) of unmeasured preflight/);
  // The unknown-preflight loop is the most expensive and must still rank.
  assert.match(digest, /#346.*99\.0h review/s);
  assert.match(digest, /preflight \*\*unknown\*\*/);
});

// ── Completeness ───────────────────────────────────────────────────────────

const inventoryEntry = (number, extra = {}) => ({
  number,
  title: `PR ${number}`,
  closed_at: "2026-08-06T00:00:00Z",
  user: { login: "TheAnswerManIsHere" },
  ...extra,
});

test("a pre-cutover loop is never reported missing", () => {
  const missing = missingRecords([inventoryEntry(FIRST_RECORDED_PR - 1)], []);
  assert.deepEqual(missing, []);
});

test("the first post-cutover loop with no record is named", () => {
  const missing = missingRecords([inventoryEntry(FIRST_RECORDED_PR)], []);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].number, FIRST_RECORDED_PR);
});

test("a Dependabot bump is excluded rather than reported as a missing loop", () => {
  // /maintenance merges these without a review loop; listing every weekly
  // bump would train the reader to skip the section.
  const inventory = [
    inventoryEntry(400, { user: { login: "dependabot[bot]" } }),
    inventoryEntry(401),
  ];
  const missing = missingRecords(inventory, []);
  assert.deepEqual(missing.map((m) => m.number), [401]);
});

test("an open PR is not a closed loop", () => {
  assert.deepEqual(missingRecords([inventoryEntry(400, { closed_at: null })], []), []);
});

test("a loop that has a record is not reported missing", () => {
  assert.deepEqual(missingRecords([inventoryEntry(344)], [record({ pr: 344 })]), []);
});

test("without an inventory the digest says completeness was not checked", () => {
  const digest = renderDigest({ records: [record()], since: SINCE, inventory: null });
  assert.match(digest, /Completeness: not checked/);
  assert.doesNotMatch(digest, /every closed loop since/);
});

// ── Deferrals are named, not counted ───────────────────────────────────────

test("every deferral is listed individually by PR and reason", () => {
  const records = [
    record({ pr: 344, adjudication: { status: "deferred", reason: "adjudicator unavailable" } }),
    record({ pr: 346, judgment: null, judgmentDeferred: "mechanical only, per row 6 precedent" }),
  ];
  const digest = renderDigest({ records, since: SINCE });
  assert.match(digest, /Open deferrals/);
  assert.match(digest, /#344.*adjudicator unavailable/);
  assert.match(digest, /#346.*mechanical only/);
});

// ── Cold start ─────────────────────────────────────────────────────────────

test("the trend says 'not yet informative' rather than drawing a line through two points", () => {
  for (const n of [0, 1, 2]) {
    const records = Array.from({ length: n }, (_, i) => record({ pr: 344 + i }));
    const digest = renderDigest({ records, since: SINCE });
    assert.match(digest, /not yet informative|No loops closed/, `n=${n}`);
  }
});

test("three or more qualifying loops produce a real sequence in closure order", () => {
  const records = [
    record({ pr: 344, closedAt: "2026-08-03T00:00:00Z" }),
    record({ pr: 346, closedAt: "2026-08-02T00:00:00Z" }),
    record({ pr: 347, closedAt: "2026-08-04T00:00:00Z" }),
  ];
  const digest = renderDigest({ records, since: SINCE });
  assert.match(digest, /n = 3, in closure order: #346 .* → #344 .* → #347/);
});

test("an empty store renders without throwing", () => {
  const digest = renderDigest({ records: [], since: SINCE });
  assert.match(digest, /No loops closed in this window/);
});

// ── CLI ────────────────────────────────────────────────────────────────────

test("--since defaults to a 14-day window and rejects an unparseable date", () => {
  const { since } = parseArgs(["node", "loop-report.mjs"]);
  const days = (Date.now() - since.getTime()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 13.9 && days < 14.1, `expected ~14 days, got ${days}`);

  assert.throws(() => parseArgs(["node", "loop-report.mjs", "--since", "not-a-date"]), /parseable date/);
});
