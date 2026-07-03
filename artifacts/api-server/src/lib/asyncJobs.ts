/**
 * Shared async-jobs worker.
 *
 * One durable queue table (`async_jobs`) + one polling worker + many
 * per-queue handlers. Generalized from the original `email_outbox` worker
 * (Phase 2A - see migration 0063). Any feature can register a handler:
 *
 *   registerJobHandler("email",      emailHandler)
 *   registerJobHandler("enrichment", enrichmentHandler)
 *   registerJobHandler("preview",    previewHandler)
 *
 * and enqueue work via `enqueueJob({ queue, payload, dedupeKey? })`. The
 * worker reclaims stuck rows on boot, claims due pending rows with
 * `FOR UPDATE SKIP LOCKED`, applies exponential backoff on failure, and
 * abandons (marks `failed`) after maxAttempts.
 *
 * The `external_id` column on the table is reserved for future queues that
 * submit to a third-party service and poll for completion (e.g. a future
 * "fal_video" queue) - handlers may stash the third-party request id there.
 */

import { eq, and, or, lte, lt, asc, desc, sql } from "drizzle-orm";
import { db as defaultDb } from "@workspace/db";
import { asyncJobsTable, type AsyncJobRow, type AsyncJobStatus } from "@workspace/db/schema";
import { getConfigInt } from "./adminConfig";
import { logger } from "./logger";

// ─── Handler registry ───────────────────────────────────────────────────────

export type HandlerResult = { ok: true; result?: unknown } | { ok: false; error: string };

export interface JobHandler {
  /** Process one row. Should never throw; return { ok:false, error } instead. */
  run(payload: unknown, row: AsyncJobRow): Promise<HandlerResult>;
  /** Optional: fired when a row is marked `failed` after exhausting retries. */
  onAbandon?(row: AsyncJobRow): Promise<void> | void;
  /** Optional: skip a row purge during retention sweep (returns true to keep). */
  retainDuringPurge?(row: AsyncJobRow): boolean;
  /** Optional: per-queue retention override in days (otherwise admin-config / 30). */
  retentionDaysOverride?(): Promise<number | undefined>;
}

const HANDLERS = new Map<string, JobHandler>();

/** Register the handler for a given queue. Idempotent (replaces). */
export function registerJobHandler(queue: string, handler: JobHandler): void {
  HANDLERS.set(queue, handler);
}

export function getRegisteredQueues(): string[] {
  return Array.from(HANDLERS.keys());
}

// ─── Retry schedule ─────────────────────────────────────────────────────────

/**
 * Per-attempt delay in ms. Attempt N delay = `RETRY_DELAYS_MS[N]` (attempt 1 = first
 * failure scheduled to retry after 5min, attempt 4 = 8h). Overridable per queue
 * via admin_config (`async_job_<queue>_retry_delay_<N>_ms`).
 */
export const RETRY_DELAYS_MS = [0, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000];

/** max_attempts=0 means "use async_job_<queue>_max_attempts from admin_config". */
export const USE_CONFIGURED_MAX_ATTEMPTS = 0;

async function getRetryConfig(queue: string): Promise<{ maxAttempts: number; retryDelays: number[] }> {
  const [maxAttempts, d1, d2, d3, d4] = await Promise.all([
    getConfigInt(`async_job_${queue}_max_attempts`, 5),
    getConfigInt(`async_job_${queue}_retry_delay_1_ms`, RETRY_DELAYS_MS[1]!),
    getConfigInt(`async_job_${queue}_retry_delay_2_ms`, RETRY_DELAYS_MS[2]!),
    getConfigInt(`async_job_${queue}_retry_delay_3_ms`, RETRY_DELAYS_MS[3]!),
    getConfigInt(`async_job_${queue}_retry_delay_4_ms`, RETRY_DELAYS_MS[4]!),
  ]);
  return { maxAttempts, retryDelays: [0, d1, d2, d3, d4] };
}

function isEmailDeliveryConfigured(): boolean {
  const isProd = process.env.NODE_ENV === "production";
  return !!(isProd
    ? (process.env.RESEND_API_KEY_PROD || process.env.RESEND_API_KEY)
    : (process.env.RESEND_API_KEY_DEV || process.env.RESEND_API_KEY_PROD || process.env.RESEND_API_KEY));
}

async function deferEmailWhileDeliveryDisabled(row: AsyncJobRow, tx: unknown): Promise<boolean> {
  if (row.queue !== "email" || isEmailDeliveryConfigured()) return false;
  const typedTx = tx as Pick<typeof defaultDb, "update">;
  await typedTx
    .update(asyncJobsTable)
    .set({
      status: "pending",
      lastError: "Email delivery is not configured; leaving job pending",
      nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[1]!),
      updatedAt: new Date(),
    })
    .where(eq(asyncJobsTable.id, row.id));
  logger.info({ id: row.id }, "[asyncJobs] email delivery not configured — leaving job pending");
  return true;
}

// ─── Enqueue ────────────────────────────────────────────────────────────────

export interface EnqueueOptions {
  queue: string;
  payload: Record<string, unknown>;
  /** When set, the partial unique index dedupes non-terminal jobs by (queue, dedupeKey). */
  dedupeKey?: string;
  /** Optional per-job override. Omit to use async_job_<queue>_max_attempts. */
  maxAttempts?: number;
  /** When set, schedules the job for the future instead of running ASAP. */
  nextAttemptAt?: Date;
  /** Optional: stash an external request id (e.g. fal request id) for poll-style handlers. */
  externalId?: string;
}

/**
 * True when an insert failed because of the `(queue, dedupe_key)` partial
 * unique index. Drizzle wraps the driver error ("Failed query: …"), so we walk
 * the cause chain and match the Postgres unique-violation code (23505) /
 * constraint name rather than the wrapper message.
 */
function isDedupeConflict(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e != null && depth < 5; depth++) {
    const o = e as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (o.code === "23505") return true;
    if (o.constraint === "async_jobs_dedupe_idx") return true;
    if (typeof o.message === "string" && o.message.includes("async_jobs_dedupe_idx")) return true;
    e = o.cause;
  }
  return false;
}

/** What `enqueueJob` returns so callers can observe the job by its concrete id. */
export interface EnqueueJobResult {
  jobId: number;
  queue: string;
  dedupeKey: string | null;
  status: AsyncJobStatus;
  /**
   * True when a fresh row was inserted. False when this enqueue attached to an
   * existing non-terminal (pending/processing) job with the same dedupe key.
   */
  inserted: boolean;
}

/**
 * Insert a pending job and return its concrete id. With a `dedupeKey`, the
 * partial unique index (non-terminal rows only) dedupes concurrent enqueues:
 * if a pending/processing job already exists we return *its* id with
 * `inserted:false` so the caller polls the in-flight work. Because the index
 * only covers non-terminal rows, a prior `done`/`failed` job never blocks a
 * fresh enqueue — repeatable actions (e.g. Regenerate Visual Plan) get a new
 * job each time.
 */
export async function enqueueJob(
  options: EnqueueOptions,
  dbOverride?: Pick<typeof defaultDb, "insert">,
): Promise<EnqueueJobResult> {
  const dbInstance = dbOverride ?? defaultDb;
  const dedupeKey = options.dedupeKey ?? null;
  try {
    const [row] = await dbInstance
      .insert(asyncJobsTable)
      .values({
        queue: options.queue,
        payload: options.payload as unknown as object,
        dedupeKey,
        maxAttempts: options.maxAttempts ?? USE_CONFIGURED_MAX_ATTEMPTS,
        nextAttemptAt: options.nextAttemptAt ?? new Date(),
        externalId: options.externalId ?? null,
      })
      .returning({ id: asyncJobsTable.id, status: asyncJobsTable.status });
    return {
      jobId: row!.id,
      queue: options.queue,
      dedupeKey,
      status: row!.status as AsyncJobStatus,
      inserted: true,
    };
  } catch (err) {
    // Unique-index conflict on (queue, dedupe_key) → a non-terminal job for the
    // same key exists. That's the dedupe path; return the existing job's id.
    if (isDedupeConflict(err)) {
      logger.debug({ queue: options.queue, dedupeKey }, "[asyncJobs] enqueue dedupe — pending/processing row exists");
      // Read via the module db (the conflicting row is committed by another tx).
      const [existing] = await defaultDb
        .select({ id: asyncJobsTable.id, status: asyncJobsTable.status })
        .from(asyncJobsTable)
        .where(
          and(
            eq(asyncJobsTable.queue, options.queue),
            dedupeKey == null ? sql`false` : eq(asyncJobsTable.dedupeKey, dedupeKey),
            or(eq(asyncJobsTable.status, "pending"), eq(asyncJobsTable.status, "processing")),
          ),
        )
        .orderBy(desc(asyncJobsTable.id))
        .limit(1);
      if (existing) {
        return {
          jobId: existing.id,
          queue: options.queue,
          dedupeKey,
          status: existing.status as AsyncJobStatus,
          inserted: false,
        };
      }
      // Rare race: the conflicting job went terminal between the failed insert
      // and this read. The dedupe index no longer covers it, so retry once.
      const [retry] = await dbInstance
        .insert(asyncJobsTable)
        .values({
          queue: options.queue,
          payload: options.payload as unknown as object,
          dedupeKey,
          maxAttempts: options.maxAttempts ?? USE_CONFIGURED_MAX_ATTEMPTS,
          nextAttemptAt: options.nextAttemptAt ?? new Date(),
          externalId: options.externalId ?? null,
        })
        .returning({ id: asyncJobsTable.id, status: asyncJobsTable.status });
      return {
        jobId: retry!.id,
        queue: options.queue,
        dedupeKey,
        status: retry!.status as AsyncJobStatus,
        inserted: true,
      };
    }
    throw err;
  }
}

// ─── Worker tick ────────────────────────────────────────────────────────────

type DbWithTransaction = Pick<typeof defaultDb, "transaction" | "delete">;

/**
 * Max jobs a single tick processes CONCURRENTLY (phase 2). Bounds fan-out of
 * external calls (LLM planner / fal / email) so a batch can't stampede a
 * provider or exhaust the ~10-connection pool. Tunable per-deploy; default 4 is
 * enough to run a moderation review's 3–4 scenario renders in parallel instead
 * of back-to-back. Raising it trades provider cost/rate-limit headroom for
 * drain speed.
 */
const ASYNC_JOBS_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env["ASYNC_JOBS_MAX_CONCURRENCY"]) || 4,
);

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Run one claimed job to completion and finalize its own outcome in an
 * independent short transaction. Isolated per job so jobs can run concurrently
 * (a single tx/connection can't) and so one job's finalize never blocks or
 * rolls back another's.
 */
async function processClaimedJob(dbInstance: DbWithTransaction, row: AsyncJobRow): Promise<void> {
  const handler = HANDLERS.get(row.queue);
  if (!handler) return; // filtered at claim time; defensive.

  // The handler is responsible for not throwing; if it does, we treat it as a
  // retryable failure with a synthetic error message.
  let outcome: HandlerResult;
  try {
    outcome = await handler.run(row.payload, row);
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const newAttempts = row.attempts + 1;

  if (outcome.ok) {
    await dbInstance.transaction(async (tx) => {
      await tx
        .update(asyncJobsTable)
        .set({
          status: "done",
          attempts: newAttempts,
          result: (outcome.result as object | undefined) ?? null,
          updatedAt: new Date(),
        })
        .where(eq(asyncJobsTable.id, row.id));
    });
    return;
  }

  const { maxAttempts, retryDelays } = await getRetryConfig(row.queue);
  const explicitMax = row.maxAttempts > USE_CONFIGURED_MAX_ATTEMPTS ? row.maxAttempts : undefined;
  const effectiveMax = Math.max(1, explicitMax ?? maxAttempts);
  const abandoned = newAttempts >= effectiveMax;
  const scheduledDelay = retryDelays[newAttempts];
  const delayMs = scheduledDelay ?? retryDelays[retryDelays.length - 1] ?? 0;
  await dbInstance.transaction(async (tx) => {
    await tx
      .update(asyncJobsTable)
      .set({
        status: abandoned ? "failed" : "pending",
        attempts: newAttempts,
        lastError: outcome.error,
        nextAttemptAt: abandoned ? new Date() : new Date(Date.now() + delayMs),
        updatedAt: new Date(),
      })
      .where(eq(asyncJobsTable.id, row.id));
  });

  if (abandoned) {
    logger.error({ queue: row.queue, id: row.id, error: outcome.error }, "[asyncJobs] job abandoned after max retries");
    if (handler.onAbandon) {
      try {
        await handler.onAbandon({ ...row, status: "failed", attempts: newAttempts, lastError: outcome.error });
      } catch (hookErr) {
        logger.error({ err: hookErr, queue: row.queue, id: row.id }, "[asyncJobs] onAbandon hook threw");
      }
    }
  }
}

/**
 * Process one tick in two phases:
 *   1. CLAIM (short transaction): grab up to 10 due rows with FOR UPDATE SKIP
 *      LOCKED, skip unhandled/delivery-deferred ones, and flip the rest to
 *      `processing`. Committing here releases the row locks immediately so the
 *      slow handler work below never holds them.
 *   2. PROCESS (concurrent, bounded): run the claimed handlers up to
 *      ASYNC_JOBS_MAX_CONCURRENCY at a time, each finalizing its own outcome.
 *
 * Claimed rows sit in `processing` across phase 2; a crash leaves them there and
 * `recoverStuckProcessing` (boot, 5-min cutoff) returns them to `pending`.
 * Exported for tests with an injected db.
 */
export async function asyncJobsTick(
  dbInstance: DbWithTransaction,
  now: Date = new Date(),
): Promise<void> {
  const claimed = await dbInstance.transaction(async (tx) => {
    const rows = (await tx
      .select()
      .from(asyncJobsTable)
      .where(and(
        eq(asyncJobsTable.status, "pending"),
        lte(asyncJobsTable.nextAttemptAt, now),
      ))
      .orderBy(asc(asyncJobsTable.nextAttemptAt), asc(asyncJobsTable.id))
      .limit(10)
      .for("update", { skipLocked: true })) as AsyncJobRow[];

    const toProcess: AsyncJobRow[] = [];
    for (const row of rows) {
      if (!HANDLERS.get(row.queue)) {
        logger.warn({ queue: row.queue, id: row.id }, "[asyncJobs] no handler registered for queue — skipping");
        continue;
      }
      if (await deferEmailWhileDeliveryDisabled(row, tx)) {
        continue;
      }
      await tx
        .update(asyncJobsTable)
        .set({ status: "processing", updatedAt: new Date() })
        .where(eq(asyncJobsTable.id, row.id));
      toProcess.push(row);
    }
    return toProcess;
  });

  await mapWithConcurrency(claimed, ASYNC_JOBS_MAX_CONCURRENCY, (row) =>
    processClaimedJob(dbInstance, row),
  );
}

// ─── Stuck-row recovery (on boot) ───────────────────────────────────────────

/**
 * Reset rows stuck in `processing` (crashed mid-run) back to `pending` so the
 * next tick will retry them. Only rows older than `cutoffMinutes` are touched.
 */
export async function recoverStuckProcessing(
  dbInstance: Pick<typeof defaultDb, "update">,
  cutoffMinutes = 5,
): Promise<void> {
  const cutoff = new Date(Date.now() - cutoffMinutes * 60_000);
  await dbInstance
    .update(asyncJobsTable)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(asyncJobsTable.status, "processing"), lt(asyncJobsTable.updatedAt, cutoff)));
}

// ─── Retention purge ────────────────────────────────────────────────────────

/**
 * Delete done/failed rows older than `retentionDays` days for a given queue.
 * Per-queue retention via admin_config `async_job_<queue>_retention_days`
 * (default 30). Handlers can implement `retainDuringPurge(row)` to keep
 * specific rows around longer (used by the email handler to retain the
 * abandoned-email admin-alert thread).
 */
export async function purgeTerminalJobs(
  dbInstance: Pick<typeof defaultDb, "delete" | "select">,
  queue: string,
  now: Date = new Date(),
): Promise<number> {
  const handler = HANDLERS.get(queue);
  const overrideDays = handler?.retentionDaysOverride
    ? await handler.retentionDaysOverride()
    : undefined;
  const retentionDays = overrideDays ?? (await getConfigInt(`async_job_${queue}_retention_days`, 30));
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3_600_000);

  if (handler?.retainDuringPurge) {
    // Per-row filtering — slower but supports the abandoned-email retain path.
    const candidates = await dbInstance
      .select()
      .from(asyncJobsTable)
      .where(and(
        eq(asyncJobsTable.queue, queue),
        or(eq(asyncJobsTable.status, "done"), eq(asyncJobsTable.status, "failed")),
        lt(asyncJobsTable.createdAt, cutoff),
      ));
    let deleted = 0;
    for (const row of candidates) {
      if (handler.retainDuringPurge(row)) continue;
      await dbInstance.delete(asyncJobsTable).where(eq(asyncJobsTable.id, row.id));
      deleted++;
    }
    return deleted;
  }

  const result = await dbInstance
    .delete(asyncJobsTable)
    .where(and(
      eq(asyncJobsTable.queue, queue),
      or(eq(asyncJobsTable.status, "done"), eq(asyncJobsTable.status, "failed")),
      lt(asyncJobsTable.createdAt, cutoff),
    ))
    .returning({ id: asyncJobsTable.id });
  return result.length;
}

// ─── Worker startup ─────────────────────────────────────────────────────────

/**
 * Start the durable async-jobs background worker. Should be called once on
 * server startup AFTER all handlers are registered.
 */
/**
 * Default poll cadence. Short enough that a queued job (an enrichment, a
 * transactional email, an image render) starts within a few seconds rather
 * than waiting up to half a minute. Override per-deploy with
 * `ASYNC_JOBS_WORKER_INTERVAL_MS`. This is a *latency* knob, NOT a throughput
 * one — throughput is bounded by the batch size (10/tick) processed up to
 * `ASYNC_JOBS_MAX_CONCURRENCY` at a time; raise those, not this, to drain a
 * backlog faster (and only after weighing external-API cost / rate limits).
 */
const DEFAULT_WORKER_INTERVAL_MS = 5_000;
/** Retention purge isn't time-sensitive — don't run it every short tick. */
const PURGE_INTERVAL_MS = 60_000;

export function runAsyncJobsWorker(
  intervalMs = Number(process.env["ASYNC_JOBS_WORKER_INTERVAL_MS"]) || DEFAULT_WORKER_INTERVAL_MS,
): NodeJS.Timeout {
  if (HANDLERS.size === 0) {
    logger.warn("[asyncJobs] no handlers registered — worker still started for future registrations");
  }

  recoverStuckProcessing(defaultDb).catch((err) => {
    logger.error({ err }, "[asyncJobs] startup recovery failed");
  });

  // Re-entrancy guard: a tick can take longer than `intervalMs` (a batch of
  // slow LLM/image jobs, processed up to ASYNC_JOBS_MAX_CONCURRENCY at a time).
  // Without this, setInterval would fire overlapping ticks and re-claim rows /
  // multiply concurrent external calls beyond the intended bound. With it, the
  // cadence is effectively "interval AFTER the previous tick finishes" —
  // responsive when idle, self-throttling under load.
  let ticking = false;
  let lastPurgeAt = 0;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      try {
        await asyncJobsTick(defaultDb);
      } catch (err) {
        logger.error({ err }, "[asyncJobs] worker tick failed");
      }
      if (Date.now() - lastPurgeAt >= PURGE_INTERVAL_MS) {
        lastPurgeAt = Date.now();
        for (const queue of HANDLERS.keys()) {
          try {
            await purgeTerminalJobs(defaultDb, queue);
          } catch (err) {
            logger.error({ err, queue }, "[asyncJobs] retention purge failed");
          }
        }
      }
    } finally {
      ticking = false;
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref();
  // Run an initial tick immediately so newly-enqueued jobs don't wait the
  // first interval.
  void tick();
  return handle;
}

// ─── Reset for tests ────────────────────────────────────────────────────────

/** Reset the handler registry — exported for unit tests. */
export function __resetHandlersForTest(): void {
  HANDLERS.clear();
}
