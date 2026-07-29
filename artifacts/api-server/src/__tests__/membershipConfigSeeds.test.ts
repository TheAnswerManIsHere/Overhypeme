/**
 * The seeded `admin_config` rows for the entitlement model.
 *
 * Naming a config key does not create it: `getAllConfig` returns only STORED
 * rows and `PATCH /admin/config/:key` 404s when the row is absent, so a key that
 * exists only as a code fallback is invisible in the admin list and un-editable
 * without a deploy. These assert migration 0094 actually seeded each one.
 *
 * The drift guard is the second test: `lease_ttl_seconds`'s `min_value` is a
 * literal in the migration SQL, derived from constants that live in TypeScript.
 * Changing a constant without re-seeding would silently leave the supported UI
 * accepting a lease shorter than the request it must outlive — so the two are
 * asserted equal rather than trusted to stay in step.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { adminConfigTable } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";

import {
  MEMBERSHIP_CONFIG_DEFAULTS,
  minimumLeaseTtlSeconds,
  minimumRunLeaseTtlSeconds,
  type MembershipConfigKey,
} from "../lib/membershipTiming.js";

const KEYS = Object.keys(MEMBERSHIP_CONFIG_DEFAULTS) as MembershipConfigKey[];

async function seededRows() {
  const rows = await db.select().from(adminConfigTable).where(inArray(adminConfigTable.key, KEYS));
  return new Map(rows.map((row) => [row.key, row]));
}

describe("membership admin_config seeds", () => {
  it("stores a row for every key the model introduces", async () => {
    const rows = await seededRows();
    const missing = KEYS.filter((key) => !rows.has(key));
    assert.deepEqual(missing, [], "keys with no stored row are invisible and un-editable");
  });

  it("seeds each key at its code default, so the two cannot disagree on day one", async () => {
    const rows = await seededRows();
    for (const key of KEYS) {
      const row = rows.get(key)!;
      assert.equal(
        Number(row.value),
        MEMBERSHIP_CONFIG_DEFAULTS[key],
        `seeded value for ${key}`,
      );
    }
  });

  it("declares every key as integer or float — the only two discriminators PATCH range-checks", () => {
    // A row seeded as `numeric` matches neither branch of the route's validation,
    // so it would take no numeric parsing and no min/max check at all, and
    // arbitrary text would be accepted.
    return seededRows().then((rows) => {
      for (const key of KEYS) {
        const dataType = rows.get(key)!.dataType;
        assert.ok(
          dataType === "integer" || dataType === "float",
          `${key} is declared "${dataType}", which PATCH does not range-check`,
        );
      }
    });
  });

  it("declares the fraction as float, not integer", async () => {
    const rows = await seededRows();
    assert.equal(rows.get("reconcile_max_downgrade_fraction")!.dataType, "float");
  });

  it("gives every key a min and max, so the route has something to enforce", async () => {
    const rows = await seededRows();
    for (const key of KEYS) {
      const row = rows.get(key)!;
      assert.notEqual(row.minValue, null, `${key} has no min_value`);
      assert.notEqual(row.maxValue, null, `${key} has no max_value`);
    }
  });

  it("keeps lease_ttl_seconds's seeded floor equal to the derived budget minimum", async () => {
    const rows = await seededRows();
    assert.equal(
      rows.get("lease_ttl_seconds")!.minValue,
      minimumLeaseTtlSeconds(),
      "the migration's literal min_value has drifted from the constants it was derived from — " +
        "re-seed it, or the admin UI will accept a lease shorter than the Stripe request it must outlive",
    );
  });

  it("keeps the run-lease floor at three heartbeat intervals of the seeded heartbeat", async () => {
    const rows = await seededRows();
    assert.equal(
      rows.get("reconcile_run_lease_ttl_seconds")!.minValue,
      minimumRunLeaseTtlSeconds(MEMBERSHIP_CONFIG_DEFAULTS.reconcile_heartbeat_interval_seconds),
    );
  });

  it("keeps every seeded default inside its own seeded range", async () => {
    const rows = await seededRows();
    for (const key of KEYS) {
      const row = rows.get(key)!;
      const value = MEMBERSHIP_CONFIG_DEFAULTS[key];
      assert.ok(value >= row.minValue!, `${key} default ${value} is below its own min ${row.minValue}`);
      assert.ok(value <= row.maxValue!, `${key} default ${value} is above its own max ${row.maxValue}`);
    }
  });

  it("keeps every key private — none of this is public config", async () => {
    const rows = await seededRows();
    for (const key of KEYS) {
      assert.equal(rows.get(key)!.isPublic, false, `${key} must not be exposed by GET /api/config`);
    }
  });
});
