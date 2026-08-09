/**
 * Retention job for `rate_limit_counters`.
 *
 * `checkSharedRateLimit` writes one persistent row per distinct
 * (endpoint, ip, userId, recipientEmail) key it has ever seen, and nothing ever
 * removed them: the table had no production cleanup at all, so it grew without
 * bound. `purgeExpiredRateLimitCounters` existed but was never called from
 * anywhere but a test.
 *
 * **This is a privacy problem before it is a table-size one.** `key_raw` (see
 * `normalizeRateLimitKey`) stores the raw IP, the raw user id, and — for
 * endpoints scoped by recipient — a normalized email address. For every route
 * behind `createRateLimiter`/`createFactSubmitRateLimiter`, that "user id" is
 * `getSessionId(req)`: this repo's 32-byte session cookie/Bearer token, not an
 * opaque account id. Sessions live 7 days (`auth.ts`'s `SESSION_TTL`), so an
 * un-purged table retains *live, replayable* session tokens for that window,
 * and dead ones forever after. Deletion is therefore the point — archiving
 * would extend the retention window on exactly the rows that matter most.
 *
 * **Why batched, rather than one `DELETE ... WHERE expires_at <= now()`:** the
 * first run after this ships faces the entire accumulated backlog, and a single
 * unbounded statement would hold locks across all of it on the same connection
 * pool the request path is using. Each batch is a bounded statement, and the
 * run as a whole is bounded by a batch budget; when that budget is spent with
 * rows still eligible, the caller reschedules rather than the run growing
 * without limit.
 *
 * Scheduled from `src/index.ts` with the same self-rescheduling `setTimeout`
 * pattern as `transientRenderPurger`.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getConfigInt } from "../lib/adminConfig";
import { logger } from "../lib/logger";

export const DEFAULT_BATCH_SIZE = 5_000;
export const DEFAULT_MAX_BATCHES = 20;

/**
 * Hard bounds on the operator-tunable values. `getConfigInt` returns whatever
 * an admin row happens to parse to, so a zeroed or negative row must not be
 * able to turn this job into a spinner (a batch size of 0 deletes nothing,
 * forever) or into the unbounded statement it exists to avoid.
 */
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 50_000;
export const MIN_MAX_BATCHES = 1;
export const MAX_MAX_BATCHES = 1_000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export interface RateLimitCounterPurgeResult {
  deleted: number;
  batches: number;
  batchSize: number;
  maxBatches: number;
  /**
   * The run stopped on its batch budget rather than because the table was
   * drained, so eligible rows may remain. The scheduler uses this to come back
   * promptly instead of waiting out a full cycle — which is what lets the
   * one-time accumulated backlog drain in minutes rather than days.
   */
  budgetExhausted: boolean;
}

/**
 * Delete up to `batchSize` expired rows. Returns how many actually went.
 *
 * Postgres has no `DELETE ... LIMIT`, so the bounded set is chosen by a
 * sub-select and removed by `key_hash` (the primary key). `ORDER BY expires_at`
 * takes the oldest first — the right priority when a budget cannot drain
 * everything, since those rows have been retaining their payload longest — and
 * is served by `idx_rate_limit_counters_expires_at`.
 *
 * `FOR UPDATE SKIP LOCKED` makes concurrent runs cooperate rather than collide:
 * on autoscale every instance schedules this job, and without it they would all
 * serialize on the same oldest rows. Skipping locked rows can make a batch come
 * back short while rows still remain, which this function's caller reads as
 * "drained" and ends the run on — that is correct, because the instance holding
 * those locks is itself deleting them.
 *
 * Column and table names are written out here rather than built from the
 * Drizzle schema object, matching `checkSharedRateLimit`'s hand-written upsert
 * directly above it in `sharedRateLimiter.ts`; both are coupled to
 * `rateLimitCountersTable` and must move with it.
 */
async function deleteOneBatch(batchSize: number): Promise<number> {
  const result = await db.execute<{ deleted: number }>(sql`
    WITH victims AS (
      SELECT key_hash
      FROM rate_limit_counters
      WHERE expires_at <= now()
      ORDER BY expires_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM rate_limit_counters
      WHERE key_hash IN (SELECT key_hash FROM victims)
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted FROM removed
  `);
  return Number(result.rows[0]?.deleted ?? 0);
}

export async function runRateLimitCounterPurger(
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<RateLimitCounterPurgeResult> {
  const batchSize = clamp(
    opts.batchSize ?? (await getConfigInt("rate_limit_counters.purge_batch_size", DEFAULT_BATCH_SIZE)),
    MIN_BATCH_SIZE,
    MAX_BATCH_SIZE,
  );
  const maxBatches = clamp(
    opts.maxBatches ?? (await getConfigInt("rate_limit_counters.purge_max_batches", DEFAULT_MAX_BATCHES)),
    MIN_MAX_BATCHES,
    MAX_MAX_BATCHES,
  );

  let deleted = 0;
  let batches = 0;
  let budgetExhausted = false;

  for (;;) {
    if (batches >= maxBatches) {
      // Reaching here means every batch so far came back full, so the run is
      // stopping on its budget rather than on a drained table.
      budgetExhausted = true;
      break;
    }
    const deletedInBatch = await deleteOneBatch(batchSize);
    batches += 1;
    deleted += deletedInBatch;
    if (deletedInBatch < batchSize) break;
  }

  if (deleted > 0 || budgetExhausted) {
    logger.info({ deleted, batches, batchSize, maxBatches, budgetExhausted }, "rate_limit_counters purged");
  }
  return { deleted, batches, batchSize, maxBatches, budgetExhausted };
}

/**
 * Test seam: rows currently in the table. Mirrors `countTransientRenders`, and
 * exists so the integration test can assert pre/post-purge state without
 * reaching for raw SQL of its own.
 */
export async function countRateLimitCounters(): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM rate_limit_counters`);
  return Number(result.rows[0]?.count ?? "0");
}
