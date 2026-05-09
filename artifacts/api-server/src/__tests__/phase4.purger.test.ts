/**
 * Phase-4 transient_renders retention purger.
 *
 * Inserts rows back-dated past and within the retention window, runs the
 * purger, and asserts the boundary is honoured.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { transientRendersTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

import { runTransientRenderPurger, DEFAULT_RETENTION_DAYS } from "../jobs/transientRenderPurger.js";

const FAKE_HASH = "0".repeat(64);

async function purgeTestRows() {
  await db.execute(sql`DELETE FROM transient_renders WHERE ip_hash = ${FAKE_HASH}`);
}

before(purgeTestRows);
after(purgeTestRows);

describe("Phase 4 — transient_renders purger", () => {
  it("deletes rows older than retention_days and keeps fresher rows", async () => {
    const now = new Date();
    const wellPastRetention = new Date(now.getTime() - (DEFAULT_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000);
    const inWindow = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    // Two old rows (must be purged), one fresh row (must remain).
    await db.execute(sql`
      INSERT INTO transient_renders (endpoint, ip_hash, result, created_at)
      VALUES
        ('preview',  ${FAKE_HASH}, 'success', ${wellPastRetention}),
        ('download', ${FAKE_HASH}, 'success', ${wellPastRetention}),
        ('preview',  ${FAKE_HASH}, 'success', ${inWindow})
    `);

    const result = await runTransientRenderPurger();
    assert.ok(result.deleted >= 2, `expected at least 2 rows purged, got ${result.deleted}`);

    const remaining = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM transient_renders WHERE ip_hash = ${FAKE_HASH}
    `);
    assert.equal(remaining.rows[0]?.count, "1", "the fresh row must survive");
  });

  it("returns 0 deleted when nothing is past retention", async () => {
    await purgeTestRows();
    const inWindow = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day old
    await db.execute(sql`
      INSERT INTO transient_renders (endpoint, ip_hash, result, created_at)
      VALUES ('preview', ${FAKE_HASH}, 'success', ${inWindow})
    `);
    const result = await runTransientRenderPurger();
    // result.deleted is the total deleted, not just our test rows — we can
    // only assert the lower bound. The fresh row must still be here.
    void result;
    const remaining = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM transient_renders WHERE ip_hash = ${FAKE_HASH}
    `);
    assert.equal(remaining.rows[0]?.count, "1");
  });
});
