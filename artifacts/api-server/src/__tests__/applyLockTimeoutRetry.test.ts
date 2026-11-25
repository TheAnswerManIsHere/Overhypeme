/**
 * A membership apply that hits `lock_timeout` is retried (Issue #1266).
 *
 * `runBoundedApply` promises up to APPLY_RETRY_ATTEMPTS tries when Postgres
 * cancels a statement on `lock_timeout` (55P03). The error drizzle actually
 * throws carries that code on `.cause`, not on itself, so the retry never ran.
 * This holds a real row lock from another connection across the first
 * attempt's timeout and releases it before the second, against the test
 * database: the apply must succeed on its second attempt.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { runBoundedApply, isLockTimeout } from "../lib/membershipLease.js";
import { APPLY_LOCK_TIMEOUT_MS } from "../lib/membershipTiming.js";

const TABLE = "apply_lock_retry_probe";

before(async () => {
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS ${TABLE} (id integer PRIMARY KEY, n integer NOT NULL DEFAULT 0)`));
  await db.execute(sql.raw(`INSERT INTO ${TABLE} (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 0`));
});

after(async () => {
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
});

describe("runBoundedApply under lock contention", () => {
  it("retries a lock timeout and succeeds once the lock is released", async () => {
    const holder = await pool.connect();
    let attempts = 0;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT * FROM ${TABLE} WHERE id = 1 FOR UPDATE`);
      // Released after the first attempt has timed out and before the second
      // attempt's own budget runs out.
      const release = setTimeout(() => { void holder.query("COMMIT"); }, APPLY_LOCK_TIMEOUT_MS + 500);

      const result = await runBoundedApply(async (tx) => {
        attempts++;
        await tx.execute(sql.raw(`UPDATE ${TABLE} SET n = n + 1 WHERE id = 1`));
        return "applied";
      });
      clearTimeout(release);

      assert.equal(result, "applied");
      assert.equal(attempts, 2, "the first attempt timed out on the lock; the second ran after it was released");
      const rows = await db.execute(sql.raw(`SELECT n FROM ${TABLE} WHERE id = 1`));
      assert.equal(Number((rows.rows[0] as { n: number }).n), 1, "applied exactly once");
    } finally {
      holder.release();
    }
  });

  it("recognises the error drizzle throws on a lock timeout, and nothing else", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT * FROM ${TABLE} WHERE id = 1 FOR UPDATE`);
      let thrown: unknown;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = 100`);
          await tx.execute(sql.raw(`UPDATE ${TABLE} SET n = n + 1 WHERE id = 1`));
        });
      } catch (err) {
        thrown = err;
      }
      assert.equal((thrown as { code?: unknown }).code, undefined, "drizzle does not copy the SQLSTATE up (the premise)");
      assert.equal(isLockTimeout(thrown), true);
      assert.equal(isLockTimeout(new Error("something else")), false);
      assert.equal(isLockTimeout(null), false);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});
