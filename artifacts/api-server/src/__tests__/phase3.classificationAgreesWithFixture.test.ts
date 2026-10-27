/**
 * Launch Phase 3, increment 4 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md,
 * Source-of-Truth Analysis: "the legacy fixture allowlist keeps its own export
 * rules; the classification must agree with it, checked"). Two lists answer
 * two questions — what a scrubbed fixture may carry (allowlist.ts), and what a
 * rebuild keeps, seeds or counts (lib/db/src/tableClassification.ts) — and
 * where they speak about the same thing they must not contradict each other:
 *
 *   - child-safety records: the same tables on both sides, never exported;
 *   - sessions and auth state: the same tables on both sides, never exported;
 *   - payment and job state the fixture excludes is never product data here;
 *   - every configuration table travels in the fixture;
 *   - no excluded-class table is exported, except the two named below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TABLE_CLASSIFICATION, type TableEntry } from "@workspace/db/table-classification";
import { LEGACY_FIXTURE_ALLOWLIST, sqlName } from "../testing/legacyFixture/allowlist.js";

/**
 * Payment records the fixture exports scrubbed: synthetic memberships let the
 * acceptance journeys exercise each tier. The obligation itself lives in
 * Stripe, which excludedClassesInventory.ts reads live, never from these rows.
 */
const EXPORTED_PAYMENT_RECORDS = new Set(["membership_entitlements", "membership_history"]);

const fixture = new Map(LEGACY_FIXTURE_ALLOWLIST.map((e) => [sqlName(e.table), e]));
const excludedAs = (entry: TableEntry | undefined, which: string) => entry?.class === "excluded" && entry.excluded === which;
const fixtureClass = (table: string) => {
  const e = fixture.get(table);
  return e?.kind === "exclude" ? e.class : e?.kind;
};

describe("the table classification agrees with the legacy fixture's allowlist", () => {
  it("names the same tables", () => {
    assert.deepEqual([...fixture.keys()].sort(), Object.keys(TABLE_CLASSIFICATION).sort());
  });

  it("puts the same tables in child safety, and in sessions and auth state", () => {
    for (const [fixtureName, ours] of [
      ["child-safety", "childSafety"],
      ["auth-state", "sessions"],
    ] as const) {
      const there = [...fixture.keys()].filter((t) => fixtureClass(t) === fixtureName).sort();
      const here = Object.keys(TABLE_CLASSIFICATION).filter((t) => excludedAs(TABLE_CLASSIFICATION[t], ours)).sort();
      assert.deepEqual(there, here, `${fixtureName} / ${ours}`);
    }
  });

  it("never calls payment or job state the fixture withholds product data", () => {
    const wrong = [...fixture.keys()].filter(
      (t) => ["payment-obligation", "job-state"].includes(String(fixtureClass(t))) && TABLE_CLASSIFICATION[t]?.class === "product",
    );
    assert.deepEqual(wrong, []);
  });

  it("carries every configuration table in the fixture", () => {
    const withheld = Object.keys(TABLE_CLASSIFICATION).filter(
      (t) => TABLE_CLASSIFICATION[t].class === "config" && fixtureClass(t) !== "include",
    );
    assert.deepEqual(withheld, []);
  });

  it("exports no excluded-class table but the named payment records", () => {
    const exported = Object.keys(TABLE_CLASSIFICATION).filter(
      (t) => TABLE_CLASSIFICATION[t].class === "excluded" && fixtureClass(t) === "include",
    );
    assert.deepEqual(exported.sort(), [...EXPORTED_PAYMENT_RECORDS].sort());
    for (const t of EXPORTED_PAYMENT_RECORDS) assert.ok(excludedAs(TABLE_CLASSIFICATION[t], "payments"), t);
  });
});
