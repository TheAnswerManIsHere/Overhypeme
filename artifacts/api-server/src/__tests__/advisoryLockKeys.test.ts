/**
 * @purpose Proves the fixed advisory-lock keys are distinct, and that a media backup holding its lock does not make an admin-population change wait (#805: both used 7654322).
 * @subsystem security
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { ADVISORY_LOCK_KEYS } from "../lib/advisoryLockKeys.js";

describe("advisory-lock keys (#805)", () => {
  it("no two fixed locks share a key", () => {
    const entries = Object.entries(ADVISORY_LOCK_KEYS);
    const byKey = new Map<number, string[]>();
    for (const [name, key] of entries) byKey.set(key, [...(byKey.get(key) ?? []), name]);
    const shared = [...byKey.values()].filter((names) => names.length > 1);
    assert.deepEqual(shared, [], `locks sharing a key: ${JSON.stringify(shared)}`);
  });

  it("an admin-population lock is free while a media backup holds its lock", async () => {
    const backup = await pool.connect();
    const admin = await pool.connect();
    try {
      const held = await backup.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK_KEYS.mediaBackup]);
      assert.equal(held.rows[0]?.ok, true, "the backup takes its lock");
      await admin.query("BEGIN");
      const got = await admin.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [ADVISORY_LOCK_KEYS.adminPopulation]);
      assert.equal(got.rows[0]?.ok, true, "an admin change does not wait behind the backup");
      await admin.query("ROLLBACK");
    } finally {
      await backup.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEYS.mediaBackup]).catch(() => {});
      backup.release();
      admin.release();
    }
  });
});
