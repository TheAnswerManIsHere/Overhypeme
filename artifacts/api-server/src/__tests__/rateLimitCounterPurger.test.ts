/**
 * Regression tests for the `rate_limit_counters` retention job.
 *
 * The bug: nothing in production ever deleted expired rows, so the table grew
 * without bound while retaining the raw IPs and live session tokens that
 * `normalizeRateLimitKey` writes into `key_raw`. The fix has to delete them —
 * and has to do it in bounded batches, because the first run faces the whole
 * accumulated backlog on the same pool the request path uses.
 *
 * So these cover both halves: that expired rows actually go (and unexpired ones
 * survive), and that a single run stays inside its batch size and its whole-run
 * budget against a high-cardinality backlog rather than turning back into the
 * unbounded `DELETE` this replaced.
 *
 * Each test shard gets its own database (`run-tests-sharded.sh`), so clearing
 * the table wholesale between cases is safe and the counts are exact.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  runRateLimitCounterPurger,
  countRateLimitCounters,
} from "../jobs/rateLimitCounterPurger.js";

async function clearAllCounters(): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limit_counters`);
}

/**
 * Bulk-seed `count` rows via `generate_series` — seeding a few hundred rows one
 * INSERT at a time made the budget tests slow enough to matter.
 *
 * `md5(prefix || n)` gives a distinct 32-char `key_hash` per row (the column is
 * `varchar(64)`), so distinct prefixes never collide across calls.
 */
async function seedCounters(opts: { prefix: string; count: number; expired: boolean }): Promise<void> {
  const offset = opts.expired ? sql`now() - interval '1 minute'` : sql`now() + interval '1 hour'`;
  await db.execute(sql`
    INSERT INTO rate_limit_counters (key_hash, key_raw, count, expires_at, updated_at)
    SELECT md5(${opts.prefix} || g::text), ${opts.prefix} || g::text, 1, ${offset}, now()
    FROM generate_series(1, ${opts.count}) AS g
  `);
}

async function countExpired(): Promise<number> {
  const result = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM rate_limit_counters WHERE expires_at <= now()`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("runRateLimitCounterPurger", () => {
  before(async () => { await clearAllCounters(); });
  beforeEach(async () => { await clearAllCounters(); });
  after(async () => { await clearAllCounters(); });

  it("deletes expired rows and leaves unexpired ones alone", async () => {
    // The regression itself: before the fix nothing deleted either group.
    await seedCounters({ prefix: "expired-", count: 12, expired: true });
    await seedCounters({ prefix: "live-", count: 5, expired: false });

    const result = await runRateLimitCounterPurger({ batchSize: 100, maxBatches: 10 });

    assert.equal(result.deleted, 12);
    assert.equal(result.budgetExhausted, false);
    // The five unexpired rows are still enforcing live rate limits — deleting
    // them would silently reset counters mid-window.
    assert.equal(await countRateLimitCounters(), 5);
    assert.equal(await countExpired(), 0);
  });

  it("is a no-op on an empty table", async () => {
    const result = await runRateLimitCounterPurger({ batchSize: 100, maxBatches: 10 });
    assert.equal(result.deleted, 0);
    assert.equal(result.batches, 1);
    assert.equal(result.budgetExhausted, false);
  });

  it("never exceeds its whole-run budget on a high-cardinality backlog", async () => {
    // The shape of the first run after deploy: far more eligible rows than one
    // run should touch. Pre-fix this was a single unbounded DELETE across all
    // of them.
    await seedCounters({ prefix: "backlog-", count: 250, expired: true });

    const result = await runRateLimitCounterPurger({ batchSize: 20, maxBatches: 4 });

    // Hard ceiling: batchSize * maxBatches, not the whole backlog.
    assert.equal(result.deleted, 80);
    assert.equal(result.batches, 4);
    assert.equal(result.budgetExhausted, true, "must report that rows remain so the caller reschedules");
    assert.equal(await countRateLimitCounters(), 170);
  });

  it("drains a multi-batch backlog when the budget allows, without reporting exhaustion", async () => {
    await seedCounters({ prefix: "drainable-", count: 45, expired: true });

    const result = await runRateLimitCounterPurger({ batchSize: 20, maxBatches: 10 });

    assert.equal(result.deleted, 45);
    // 20 + 20 + 5: the short final batch is what ends the run.
    assert.equal(result.batches, 3);
    assert.equal(result.budgetExhausted, false);
    assert.equal(await countRateLimitCounters(), 0);
  });

  it("resumes across runs until the backlog is gone", async () => {
    // What the scheduler's fast follow-up actually relies on.
    await seedCounters({ prefix: "resume-", count: 50, expired: true });

    const first = await runRateLimitCounterPurger({ batchSize: 20, maxBatches: 1 });
    assert.equal(first.deleted, 20);
    assert.equal(first.budgetExhausted, true);

    const second = await runRateLimitCounterPurger({ batchSize: 20, maxBatches: 1 });
    assert.equal(second.deleted, 20);
    assert.equal(second.budgetExhausted, true);

    const third = await runRateLimitCounterPurger({ batchSize: 20, maxBatches: 1 });
    assert.equal(third.deleted, 10);
    assert.equal(third.budgetExhausted, false, "a short batch means drained, not budget-capped");
    assert.equal(await countRateLimitCounters(), 0);
  });

  it("clamps a non-positive batch size instead of spinning on zero-row batches", async () => {
    // A zeroed or typo'd admin config row must not be able to produce
    // `LIMIT 0` — that deletes nothing, forever, while looking healthy.
    await seedCounters({ prefix: "clamped-", count: 10, expired: true });

    const zero = await runRateLimitCounterPurger({ batchSize: 0, maxBatches: 3 });
    assert.equal(zero.batchSize, 1, "batch size clamps up to 1");
    assert.equal(zero.deleted, 3, "still makes progress rather than deleting nothing");

    const negative = await runRateLimitCounterPurger({ batchSize: -5, maxBatches: 2 });
    assert.equal(negative.batchSize, 1);
    assert.equal(negative.deleted, 2);

    assert.equal(await countRateLimitCounters(), 5);
  });

  it("clamps an oversized batch size back under the hard ceiling", async () => {
    const result = await runRateLimitCounterPurger({ batchSize: 10_000_000, maxBatches: 1 });
    assert.equal(result.batchSize, 50_000);
  });

  it("lets concurrent runs divide the work without double-deleting or dropping rows", async () => {
    // Autoscale runs this on every instance at once. FOR UPDATE SKIP LOCKED is
    // what keeps that from serializing — or from two runs claiming one row.
    await seedCounters({ prefix: "concurrent-", count: 200, expired: true });

    const [a, b] = await Promise.all([
      runRateLimitCounterPurger({ batchSize: 25, maxBatches: 20 }),
      runRateLimitCounterPurger({ batchSize: 25, maxBatches: 20 }),
    ]);

    // Every row deleted exactly once, by whichever run got to it.
    assert.equal(a.deleted + b.deleted, 200);
    assert.equal(await countRateLimitCounters(), 0);
  });

  it("skips a row locked by another run instead of blocking on it (Codex round 1)", async () => {
    // The test above only proved the two runs' totals summed to 200 with none
    // left over — full serialization (each run waiting for the other's lock,
    // one after another) satisfies that assertion just as well as real
    // concurrency, so it never actually exercised SKIP LOCKED. This one holds
    // a batch's rows locked-but-uncommitted in an explicit transaction and
    // proves a concurrent purger run claims the OTHER rows instead of
    // blocking on the held ones.
    await seedCounters({ prefix: "lockproof-", count: 10, expired: true });

    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      // Same shape as deleteOneBatch's own claim, but the transaction is left
      // open — the lock is held, not released.
      const held = await holder.query(
        "SELECT key_hash FROM rate_limit_counters WHERE expires_at <= now() ORDER BY expires_at LIMIT 5 FOR UPDATE SKIP LOCKED",
      );
      assert.equal(held.rows.length, 5, "test setup: expected 5 rows available to lock");

      // While those 5 are locked but uncommitted, a real purger run must skip
      // them rather than block waiting for `holder` to finish. If it blocked,
      // this call would hang until node:test's own timeout fails the test —
      // completing at all, with exactly 5 deleted, is the proof it didn't.
      const result = await runRateLimitCounterPurger({ batchSize: 10, maxBatches: 1 });
      assert.equal(result.deleted, 5, "must delete only the 5 unlocked rows, not block on the 5 held ones");

      const stillLocked = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM rate_limit_counters WHERE key_raw LIKE 'lockproof-%'`,
      );
      assert.equal(
        Number(stillLocked.rows[0]?.count ?? "0"),
        5,
        "the 5 held rows must still exist — SKIP LOCKED means skipped, not blocked-then-deleted",
      );

      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }

    // With the lock released, the previously-held rows are still expired and
    // eligible — a follow-up run must be able to claim them.
    const cleanup = await runRateLimitCounterPurger({ batchSize: 10, maxBatches: 1 });
    assert.equal(cleanup.deleted, 5);
    assert.equal(await countRateLimitCounters(), 0);
  });
});
