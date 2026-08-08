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

test("a judgmentDeferred record is excluded from the trend, even with multiple finding-bearing rounds", () => {
  // Without the exclusion, selfInflictedShare reads the absent judgment
  // through optional chaining and scores 0% rather than "not yet
  // classified" — this record would otherwise qualify.
  const deferred = record({ judgment: null, judgmentDeferred: "mechanical only — see row 6 precedent" });
  assert.equal(qualifiesForTrend(deferred), false);
});

test("renderDigest does not crash on a judgmentDeferred record with multiple finding-bearing rounds", () => {
  const deferred = record({ pr: 348, judgment: null, judgmentDeferred: "mechanical only — see row 6 precedent" });
  assert.doesNotThrow(() => renderDigest({ records: [deferred], since: SINCE }));
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

test("expensive-loop ranking is by review hours PLUS known preflight, not review hours alone", () => {
  // Loop A: little review time, heavy preflight. Loop B: more review time,
  // no preflight, listed FIRST in input order. Ranking by review hours
  // alone (or by input order) would put B above A; total attributable cost
  // (review + known preflight) puts A above B. Both records deliberately
  // don't qualify for the churn/trend section (single finding-bearing
  // round), so the only place "#344"/"#346" can appear is the ranking.
  const records = [
    record({
      pr: 346,
      mechanical: { reviewInterval: { hours: 2 }, findings: 4, perRound: [{ round: 1, findings: 4 }] },
      judgment: { causes: { new: 4, prop: 0, wrong: 0, reRaised: 0, invalid: 0 }, preOpenPreflightMin: 0 },
    }), // 120 min
    record({
      pr: 344,
      mechanical: { reviewInterval: { hours: 1 }, findings: 4, perRound: [{ round: 1, findings: 4 }] },
      judgment: { causes: { new: 4, prop: 0, wrong: 0, reRaised: 0, invalid: 0 }, preOpenPreflightMin: 600 },
    }), // 660 min
  ];
  const digest = renderDigest({ records, since: SINCE });
  const section = digest.slice(digest.indexOf("## Most expensive loops"));
  const aIndex = section.indexOf("#344");
  const bIndex = section.indexOf("#346");
  assert.ok(aIndex > -1 && bIndex > -1 && aIndex < bIndex, "expected #344 (higher total cost) to rank above #346");
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

// Comfortably past the 14-day settling window from the fixture's closed_at
// above, so these tests exercise the missing/present logic on its own,
// independent of the settling-window tests below.
const SETTLED_NOW = new Date("2026-08-25T00:00:00Z");

test("a pre-cutover loop is never reported missing", () => {
  const missing = missingRecords([inventoryEntry(FIRST_RECORDED_PR - 1)], [], SETTLED_NOW);
  assert.deepEqual(missing, []);
});

test("the first post-cutover loop with no record is named", () => {
  const missing = missingRecords([inventoryEntry(FIRST_RECORDED_PR)], [], SETTLED_NOW);
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
  const missing = missingRecords(inventory, [], SETTLED_NOW);
  assert.deepEqual(missing.map((m) => m.number), [401]);
});

test("an open PR is not a closed loop", () => {
  assert.deepEqual(missingRecords([inventoryEntry(400, { closed_at: null })], [], SETTLED_NOW), []);
});

test("a loop that has a record is not reported missing", () => {
  assert.deepEqual(missingRecords([inventoryEntry(344)], [record({ pr: 344 })], SETTLED_NOW), []);
});

// ── The settling window: a loop isn't owed a record the moment it closes ──

test("a loop closed less than 14 days ago is not yet reported missing", () => {
  const now = new Date("2026-08-15T00:00:00Z"); // 9 days after the fixture's closed_at
  assert.deepEqual(missingRecords([inventoryEntry(400)], [], now), []);
});

test("a loop closed exactly 14 days ago is reported missing", () => {
  const now = new Date("2026-08-20T00:00:00Z"); // exactly 14 days after closed_at
  const missing = missingRecords([inventoryEntry(400)], [], now);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].number, 400);
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

test("a judgmentDeferred record is counted in the deferred headline, not just listed", () => {
  // The bug: the headline said "0 deferred" while the same record appeared
  // under "Open deferrals" — an aggregate contradicting its own detail.
  const records = [record({ pr: 346, judgment: null, judgmentDeferred: "mechanical only, per row 6 precedent" })];
  const digest = renderDigest({ records, since: SINCE });
  assert.match(digest, /1 deferred/);
});

test("a record deferred both ways is counted once, not twice", () => {
  const records = [
    record({
      pr: 346,
      judgment: null,
      judgmentDeferred: "mechanical only",
      adjudication: { status: "deferred", reason: "adjudicator unavailable" },
    }),
  ];
  const digest = renderDigest({ records, since: SINCE });
  assert.match(digest, /1 deferred/);
  assert.doesNotMatch(digest, /2 deferred/);
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
