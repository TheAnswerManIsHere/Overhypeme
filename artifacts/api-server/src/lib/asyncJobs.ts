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

import { eq, and, or, lte, lt, asc, desc, sql, inArray } from "drizzle-orm";
import { db as defaultDb } from "@workspace/db";
import { asyncJobsTable, type AsyncJobRow, type AsyncJobStatus } from "@workspace/db/schema";
import { getConfigInt } from "./adminConfig";
import { logger } from "./logger";
import {
  stampLaneScheduled,
  stampTickCompleted,
  publishInFlight,
  decrementInFlight,
  pruneDepartedInstances,
} from "./workerHeartbeats";

// ─── Handler registry ───────────────────────────────────────────────────────

/**
 * A handler outcome.
 *
 * The failure variant is deliberately ADDITIVE (rev-7 plan §12): existing
 * handlers that return `{ ok:false, error }` keep the historical behavior —
 * retryable with exponential backoff up to maxAttempts — with zero changes.
 * A handler may OPT IN to two extra failure semantics:
 *
 *   • `retryable: false` — a DETERMINISTIC failure that re-running cannot fix
 *     (invalid persisted input, a fail-loud corruption state). The worker marks
 *     the row `failed` immediately after this attempt instead of scheduling
 *     retries. `code` is REQUIRED here so consumers classify by a typed code,
 *     never by parsing the human `error` string.
 *   • `retryable: true` (or omitted) — the historical transient failure; retries.
 *     `code` is optional.
 *
 * Use the `terminalFailure()` helper to construct the terminal variant so a
 * malformed `{ retryable:false }` without a code can't be built by accident.
 */
export type HandlerResult =
  | { ok: true; result?: unknown }
  | { ok: false; error: string; retryable?: true; code?: string }
  | { ok: false; error: string; retryable: false; code: string };

/** Build a terminal (non-retryable) failure with its required typed code. */
export function terminalFailure(code: string, error: string): HandlerResult {
  return { ok: false, error, retryable: false, code };
}

export interface JobHandler {
  /**
   * Process one row. Should never throw; return `{ ok:false, error }` (retryable)
   * or `terminalFailure(code, error)` (deterministic, no retry) instead.
   */
  run(payload: unknown, row: AsyncJobRow): Promise<HandlerResult>;
  /** Optional: fired when a row is marked `failed` after exhausting retries. */
  onAbandon?(row: AsyncJobRow): Promise<void> | void;
  /** Optional: skip a row purge during retention sweep (returns true to keep). */
  retainDuringPurge?(row: AsyncJobRow): boolean;
  /** Optional: per-queue retention override in days (otherwise admin-config / 30). */
  retentionDaysOverride?(): Promise<number | undefined>;
}

const HANDLERS = new Map<string, JobHandler>();

/**
 * Scheduling lane a queue runs in. Each lane is drained by its own independent
 * worker loop (own timer, own re-entrancy guard, own concurrency bound), so a
 * busy lane can never block another lane's progress:
 *   • `fast`            — short, DB-oriented admin actions with no model/image wait.
 *   • `render`          — single-item, moderator-watched external-API renders.
 *   • `bulk`             — background/batch work nobody's watching a spinner for (default).
 *   • `pexels`           — `fact_pexels`, serialized (maxConcurrency 1) to preserve
 *     the 1-second Pexels rate-limit pacing the direct-call path used to provide.
 *   • `ai_meme_backfill` — `fact_ai_meme_backfill`, serialized (maxConcurrency 1)
 *     to preserve the "process sequentially" OpenAI rate-limit pacing the
 *     direct-call bulk route used to provide.
 */
export type JobLane = "fast" | "render" | "bulk" | "pexels" | "ai_meme_backfill";

/** Per-queue lane assignment. Kept in lockstep with HANDLERS (same replace/reset). */
const LANE_OF_QUEUE = new Map<string, JobLane>();

/** Options for `registerJobHandler`. */
export interface RegisterJobHandlerOptions {
  /** Scheduling lane. Omit to default to `bulk`. */
  lane?: JobLane;
}

/**
 * Register the handler for a given queue. Idempotent — replaces BOTH the handler
 * and its lane assignment, so re-registering with a different lane reclassifies
 * the queue. An unannotated registration lands the queue in `bulk`.
 */
export function registerJobHandler(
  queue: string,
  handler: JobHandler,
  opts?: RegisterJobHandlerOptions,
): void {
  HANDLERS.set(queue, handler);
  LANE_OF_QUEUE.set(queue, opts?.lane ?? "bulk");
}

/** Queues currently registered to a given lane. Resolved fresh at each call. */
export function queuesForLane(lane: JobLane): string[] {
  const out: string[] = [];
  for (const [queue, assigned] of LANE_OF_QUEUE) {
    if (assigned === lane) out.push(queue);
  }
  return out;
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

// ─── Logging helpers ──────────────────────────────────────────────────────────

/**
 * Log message prefix carrying lane attribution. Renders `[asyncJobs]` when no
 * lane is in context (e.g. a legacy/direct `asyncJobsTick(db)` call) so we never
 * emit `[asyncJobs:undefined]`, and `[asyncJobs:<lane>]` when one is.
 */
function lanePrefix(lane: JobLane | undefined): string {
  return lane ? `[asyncJobs:${lane}]` : "[asyncJobs]";
}

/** `{ lane }` structured field, omitted entirely when no lane is in context. */
function laneField(lane: JobLane | undefined): { lane?: JobLane } {
  return lane ? { lane } : {};
}

function isEmailDeliveryConfigured(): boolean {
  const isProd = process.env.NODE_ENV === "production";
  return !!(isProd
    ? (process.env.RESEND_API_KEY_PROD || process.env.RESEND_API_KEY)
    : (process.env.RESEND_API_KEY_DEV || process.env.RESEND_API_KEY_PROD || process.env.RESEND_API_KEY));
}

async function deferEmailWhileDeliveryDisabled(
  row: AsyncJobRow,
  tx: unknown,
  lane?: JobLane,
): Promise<boolean> {
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
  logger.info({ ...laneField(lane), id: row.id }, `${lanePrefix(lane)} email delivery not configured — leaving job pending`);
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
 * Parse a positive integer from env, falling back (with a warning) on a value
 * that is non-finite, ≤ 0, or absent. The old `Number(env) || fallback` pattern
 * silently accepted a negative as truthy — a negative-delay `setInterval` hot
 * loop for the interval knobs — so guard it here.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn({ env: name, value: raw, fallback }, "[asyncJobs] invalid env value — using fallback");
    return fallback;
  }
  return Math.floor(n);
}

/** Never poll faster than this — defends against a zero/below-floor misconfig hot loop. */
const MIN_INTERVAL_MS = 500;
const intervalEnv = (name: string, fallback: number): number =>
  Math.max(MIN_INTERVAL_MS, positiveIntEnv(name, fallback));

/**
 * Max jobs a lane's tick processes CONCURRENTLY (phase 2). Bounds fan-out of
 * external calls (LLM planner / fal / email) so a batch can't stampede a
 * provider or exhaust the ~10-connection pool. Each lane sets its own; this is
 * the `bulk`-lane default (down from 4 — the "4" was justified by render's
 * scenario-parallelism need, which now lives in the `render` lane). Raising a
 * lane's bound trades provider cost/rate-limit headroom for drain speed.
 */
const ASYNC_JOBS_MAX_CONCURRENCY = Math.max(1, positiveIntEnv("ASYNC_JOBS_MAX_CONCURRENCY", 3));

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
async function processClaimedJob(
  dbInstance: DbWithTransaction,
  row: AsyncJobRow,
  lane?: JobLane,
): Promise<void> {
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

  // Finalize must never throw out of here: a rejection would exit this worker
  // (dropping its share of the batch's remaining concurrency) and, worse, leave
  // the row committed as `processing`. On a finalize failure we log and rely on
  // the periodic stuck-row recovery to requeue it.
  let abandoned = false;
  let terminalFailed = false;
  let outcomeError: string | null = null;
  try {
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

    outcomeError = outcome.error;
    // A terminal (deterministic, non-retryable) failure is marked `failed`
    // immediately — re-running cannot change the outcome, so backoff/retry would
    // only delay the visible failure and waste attempts (§12). `lastError` keeps
    // the operational detail; the typed `code` is surfaced by the handler onto
    // its own domain row (e.g. image_prompt_attempts.error_code), not the queue.
    const isTerminal = outcome.retryable === false;
    if (isTerminal) {
      terminalFailed = true;
      // Persist the RESOLVED ceiling on a terminal failure, not just the
      // sentinel that meant "use queue config" at enqueue time. `admin_config`
      // is mutable, so re-resolving it later (as the queue-health surface
      // does, to tell a terminal failure apart from genuine exhaustion) would
      // otherwise answer against whatever the ceiling happens to be NOW rather
      // than what it was at finalization — misclassifying a historical row if
      // an admin later raises the queue's ceiling. A `failed` row is terminal
      // and never re-enters this function, so writing this here is a durable
      // fact, not a live decision this queue still has to make.
      const effectiveMax = await effectiveMaxAttempts(row.queue, row.maxAttempts);
      await dbInstance.transaction(async (tx) => {
        await tx
          .update(asyncJobsTable)
          .set({
            status: "failed",
            attempts: newAttempts,
            lastError: outcome.error,
            nextAttemptAt: new Date(),
            updatedAt: new Date(),
            maxAttempts: effectiveMax,
          })
          .where(eq(asyncJobsTable.id, row.id));
      });
    } else {
      const { maxAttempts, retryDelays } = await getRetryConfig(row.queue);
      const explicitMax = row.maxAttempts > USE_CONFIGURED_MAX_ATTEMPTS ? row.maxAttempts : undefined;
      const effectiveMax = Math.max(1, explicitMax ?? maxAttempts);
      abandoned = newAttempts >= effectiveMax;
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
            // Same reasoning as the terminal branch above, and ONLY on the
            // terminal transition: a still-`pending` row is not yet finalized,
            // so it must keep tracking live config — an admin raising the
            // ceiling mid-flight should let an in-progress job benefit from
            // the extra retries, not freeze it to the value read at this tick.
            ...(abandoned ? { maxAttempts: effectiveMax } : {}),
          })
          .where(eq(asyncJobsTable.id, row.id));
      });
    }
  } catch (finalizeErr) {
    logger.error(
      { ...laneField(lane), err: finalizeErr, queue: row.queue, id: row.id },
      `${lanePrefix(lane)} finalize failed — row left in processing for stuck-row recovery`,
    );
    return;
  }

  if (terminalFailed) {
    // A first-attempt terminal failure is NOT "retries exhausted": we do NOT
    // fire onAbandon (its contract is the exhaustion case, and existing hooks
    // are written for that). The image-prompt handler persists its own typed
    // terminal code onto the attempt row inside run() (recordTerminalAttemptFailure),
    // so no queue-level hook is needed here.
    logger.warn(
      { ...laneField(lane), queue: row.queue, id: row.id, error: outcomeError },
      `${lanePrefix(lane)} job failed terminally (deterministic, not retried)`,
    );
    return;
  }

  if (abandoned) {
    logger.error(
      { ...laneField(lane), queue: row.queue, id: row.id, error: outcomeError },
      `${lanePrefix(lane)} job abandoned after max retries`,
    );
    if (handler.onAbandon) {
      try {
        await handler.onAbandon({ ...row, status: "failed", attempts: newAttempts, lastError: outcomeError });
      } catch (hookErr) {
        logger.error(
          { ...laneField(lane), err: hookErr, queue: row.queue, id: row.id },
          `${lanePrefix(lane)} onAbandon hook threw`,
        );
      }
    }
  }
}

/**
/** Per-tick controls. All optional so `asyncJobsTick(db)` keeps its legacy behavior. */
export interface AsyncJobsTickOptions {
  /**
   * Restrict the claim to these queues (a lane's queue set). Omit to claim across
   * ALL queues (legacy behavior). An empty array matches no rows.
   */
  queues?: readonly string[];
  /** Concurrency bound for this tick's batch. Omit to use the bulk-lane default. */
  maxConcurrency?: number;
  /** Lane context, for log attribution only. */
  lane?: JobLane;
}

/**
 * Process one tick in two phases:
 *   1. CLAIM (short transaction): grab up to 10 due rows (optionally filtered to
 *      a lane's queues) with FOR UPDATE SKIP LOCKED, skip unhandled/
 *      delivery-deferred ones, and flip the rest to `processing`. Committing here
 *      releases the row locks immediately so the slow handler work below never
 *      holds them.
 *   2. PROCESS (concurrent, bounded): run the claimed handlers up to
 *      `options.maxConcurrency` (default `ASYNC_JOBS_MAX_CONCURRENCY`) at a time,
 *      each finalizing its own outcome.
 *
 * Claimed rows sit in `processing` across phase 2; a crash leaves them there and
 * `recoverStuckProcessing` (boot, 5-min cutoff) returns them to `pending`.
 * Exported for tests with an injected db.
 */
export async function asyncJobsTick(
  dbInstance: DbWithTransaction,
  now: Date = new Date(),
  options?: AsyncJobsTickOptions,
): Promise<void> {
  const lane = options?.lane;
  const queues = options?.queues;
  const claimed = await dbInstance.transaction(async (tx) => {
    const rows = (await tx
      .select()
      .from(asyncJobsTable)
      .where(and(
        eq(asyncJobsTable.status, "pending"),
        lte(asyncJobsTable.nextAttemptAt, now),
        // `and()` drops an undefined arg, so an omitted `queues` == no filter
        // (legacy behavior). `inArray(col, [])` compiles to `false` — an empty
        // lane safely matches nothing.
        queues ? inArray(asyncJobsTable.queue, queues) : undefined,
      ))
      .orderBy(asc(asyncJobsTable.nextAttemptAt), asc(asyncJobsTable.id))
      .limit(10)
      .for("update", { skipLocked: true })) as AsyncJobRow[];

    const toProcess: AsyncJobRow[] = [];
    for (const row of rows) {
      if (!HANDLERS.get(row.queue)) {
        logger.warn({ ...laneField(lane), queue: row.queue, id: row.id }, `${lanePrefix(lane)} no handler registered for queue — skipping`);
        continue;
      }
      if (await deferEmailWhileDeliveryDisabled(row, tx, lane)) {
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

  const maxConcurrency = options?.maxConcurrency ?? ASYNC_JOBS_MAX_CONCURRENCY;

  // Publish the in-flight count HERE — after the claim transaction has
  // committed, before a single handler is awaited. Writing it at tick
  // completion instead would be useless for the case that matters: a wedged
  // tick never completes, so the durable count would sit at its previous value
  // (normally zero) while `worker_lane_wedged` waits for `in_flight_count > 0`.
  if (lane && claimed.length > 0) {
    await publishInFlight(lane, claimed.length);
  }

  await mapWithConcurrency(claimed, maxConcurrency, async (row) => {
    try {
      await processClaimedJob(dbInstance, row, lane);
    } finally {
      // Per job, as it leaves the in-flight set — so a long tail of one slow
      // handler reads as "1 in flight", not as the whole original batch.
      if (lane) await decrementInFlight(lane);
    }
  });
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
/**
 * Per-lane default poll cadences (ms). Latency knobs, NOT throughput ones —
 * throughput is bounded by the 10-rows/tick claim batch processed up to the
 * lane's concurrency at a time. `fast` polls tighter because its jobs are cheap
 * and tighter polling is what directly cuts perceived "Queued…" latency;
 * `render`/`bulk` keep the historical 5s (isolation, not raw speed, is their fix).
 * Override per-deploy via the `ASYNC_JOBS_*_INTERVAL_MS` env vars (bulk keeps the
 * legacy `ASYNC_JOBS_WORKER_INTERVAL_MS` name).
 */
const DEFAULT_FAST_INTERVAL_MS = 2_000;
const DEFAULT_RENDER_INTERVAL_MS = 5_000;
const DEFAULT_WORKER_INTERVAL_MS = 5_000;
const DEFAULT_PEXELS_INTERVAL_MS = 5_000;
const DEFAULT_AI_MEME_BACKFILL_INTERVAL_MS = 5_000;
/** Retention purge isn't time-sensitive — don't run it every short tick. */
const PURGE_INTERVAL_MS = 60_000;
/**
 * How often to sweep for rows stranded in `processing`. Since claim now commits
 * `processing` before the (concurrent) handler runs, a crash — OR a rejection in
 * the finalize transaction after the handler returned — can leave a row
 * committed as `processing`. Boot-only recovery would never retry it in a
 * long-running process, so sweep periodically too.
 */
const RECOVER_INTERVAL_MS = 60_000;
/**
 * Only reclaim rows whose `updatedAt` (stamped at claim) is older than this.
 * Must sit comfortably above the slowest real handler (planner ≤180s + image
 * gen) so an in-flight job is never yanked out from under itself and re-run
 * concurrently.
 *
 * Raised 10 → 30 min because the margin was not actually wide: this deployment
 * is `deploymentTarget = "autoscale"` (`.replit`) and `index.ts` starts the
 * worker in EVERY instance, so "the slowest handler" is not the only thing
 * racing this cutoff — a *different* instance's in-flight row is. Combined with
 * a finalize that matches on row id alone (no fencing token), a reclaim while
 * the original run is still working means both runs execute and the first to
 * finish overwrites the other. For the `email` queue that is a duplicate send
 * to a real person.
 *
 * The cost is deliberate and bounded: a genuinely crashed job now waits up to
 * 30 min for recovery instead of 10. That is the right trade against silent
 * double-execution, and it is an interim mitigation — the real fix is lease
 * tokens with fenced finalizes (see the "Async-jobs reclaim finalize has no
 * fencing token" entry in docs/engineering/deferred-work.md, Phase 3a),
 * after which this cutoff stops being load-bearing.
 */
export const RECOVER_STUCK_CUTOFF_MIN = 30;

/**
 * The **configured** poll interval for each lane, resolved from the same env
 * vars `runAsyncJobsWorker` uses.
 *
 * Exported so the health surface reports what the worker is actually doing
 * rather than a second hardcoded copy of these numbers. A stalled-lane
 * threshold derived from a stale duplicate would be wrong in exactly the
 * deployments that tuned an interval — i.e. the ones most likely to be
 * investigating queue health in the first place.
 */
export function laneIntervalsMs(): Record<JobLane, number> {
  return {
    fast: intervalEnv("ASYNC_JOBS_FAST_INTERVAL_MS", DEFAULT_FAST_INTERVAL_MS),
    render: intervalEnv("ASYNC_JOBS_RENDER_INTERVAL_MS", DEFAULT_RENDER_INTERVAL_MS),
    bulk: intervalEnv("ASYNC_JOBS_WORKER_INTERVAL_MS", DEFAULT_WORKER_INTERVAL_MS),
    pexels: intervalEnv("ASYNC_JOBS_PEXELS_INTERVAL_MS", DEFAULT_PEXELS_INTERVAL_MS),
    ai_meme_backfill: intervalEnv(
      "ASYNC_JOBS_AI_MEME_BACKFILL_INTERVAL_MS",
      DEFAULT_AI_MEME_BACKFILL_INTERVAL_MS,
    ),
  };
}

/** All five lanes, in the order the health surface presents them. */
export const ALL_LANES: readonly JobLane[] = ["fast", "render", "bulk", "pexels", "ai_meme_backfill"];

/** The lane a registered queue belongs to, or undefined if it is not registered. */
export function laneOfQueue(queue: string): JobLane | undefined {
  return LANE_OF_QUEUE.get(queue);
}

/** Every registered queue name. */
export function registeredQueues(): string[] {
  return [...HANDLERS.keys()];
}

/**
 * The effective retry ceiling for a queue: the row's own override when set,
 * otherwise `async_job_<queue>_max_attempts`.
 *
 * Exported because the health surface needs it to tell "failed after exhausting
 * five attempts" from "failed on its first and only attempt" — two states
 * `async_jobs.status` collapses into one `failed`, and the second is the one
 * `fact_ai_meme_backfill` produces by design.
 */
export async function effectiveMaxAttempts(queue: string, rowMaxAttempts: number): Promise<number> {
  if (rowMaxAttempts > 0) return rowMaxAttempts;
  const { maxAttempts } = await getRetryConfig(queue);
  return Math.max(1, maxAttempts);
}

/** Static scheduling config for one lane's runner. Queues are resolved per-tick. */
export interface LaneConfig {
  lane: JobLane;
  intervalMs: number;
  maxConcurrency: number;
  /** When true (bulk only), this runner also owns periodic recovery + purge. */
  maintenance: boolean;
}

/** Injectable seams for `createLaneRunner`, so tests drive it without real timers. */
export interface LaneRunnerDeps {
  /** Override the whole tick body (tests inject a controlled promise). */
  runTick?: (config: LaneConfig) => Promise<void>;
  /** Override the scheduler (tests pass a no-op so only the returned `tick` runs). */
  schedule?: (fn: () => void, intervalMs: number) => NodeJS.Timeout;
  /**
   * Override the heartbeat writes.
   *
   * Exists for the same reason `schedule` does: these are database round-trips
   * on the tick path, and a test asserting *scheduling* behavior should not have
   * its timing decided by how fast the test database happens to be. Tests that
   * care about lane independence inject no-ops; the heartbeat writes themselves
   * are covered directly in `workerHeartbeats.test.ts`.
   */
  heartbeats?: {
    scheduled: (lane: JobLane) => Promise<void>;
    completed: (lane: JobLane) => Promise<void>;
  };
}

const realSchedule = (fn: () => void, intervalMs: number): NodeJS.Timeout => {
  const handle = setInterval(fn, intervalMs);
  handle.unref();
  return handle;
};

/**
 * Build one lane's independent, re-entrant, self-scheduling runner. Each runner
 * owns a CLOSURE-LOCAL `ticking` boolean — this is the core of the fix: a slow
 * tick in one lane can no longer suppress another lane's timer, because they no
 * longer share the guard (or the loop). Returns the runner's `tick` (for tests
 * to drive by hand) alongside its timer `handle`.
 *
 * Queues are resolved via `queuesForLane(config.lane)` on EVERY tick, never
 * captured once, so a later (re-)registration is picked up by the running worker.
 */
export function createLaneRunner(
  config: LaneConfig,
  deps: LaneRunnerDeps = {},
): { tick: () => Promise<void>; handle: NodeJS.Timeout } {
  const schedule = deps.schedule ?? realSchedule;
  const heartbeats = deps.heartbeats ?? {
    scheduled: stampLaneScheduled,
    completed: stampTickCompleted,
  };
  let ticking = false;
  let lastPurgeAt = 0;
  let lastRecoverAt = Date.now();

  const defaultBody = async (): Promise<void> => {
    try {
      await asyncJobsTick(defaultDb, new Date(), {
        queues: queuesForLane(config.lane),
        maxConcurrency: config.maxConcurrency,
        lane: config.lane,
      });
    } catch (err) {
      logger.error({ lane: config.lane, err }, `[asyncJobs:${config.lane}] worker tick failed`);
    }
    if (!config.maintenance) return;
    // Backstop (bulk runner only): requeue rows stranded in `processing` and
    // purge terminal rows. Both operate table-wide/all-queues, so one runner
    // owning them is correct — no per-lane duplication.
    if (Date.now() - lastRecoverAt >= RECOVER_INTERVAL_MS) {
      lastRecoverAt = Date.now();
      try {
        await recoverStuckProcessing(defaultDb, RECOVER_STUCK_CUTOFF_MIN);
      } catch (err) {
        logger.error({ lane: config.lane, err }, `[asyncJobs:${config.lane}] periodic stuck-row recovery failed`);
      }
    }
    if (Date.now() - lastPurgeAt >= PURGE_INTERVAL_MS) {
      lastPurgeAt = Date.now();
      for (const queue of HANDLERS.keys()) {
        try {
          await purgeTerminalJobs(defaultDb, queue);
        } catch (err) {
          logger.error({ lane: config.lane, err, queue }, `[asyncJobs:${config.lane}] retention purge failed`);
        }
      }
      // Same cadence as the purge: drop heartbeat rows for instances that have
      // stopped writing. Without this, every autoscale scale-down leaves a row
      // that never advances again and the lane reads as permanently stalled.
      const pruned = await pruneDepartedInstances();
      if (pruned > 0) {
        logger.info({ lane: config.lane, pruned }, `[asyncJobs:${config.lane}] pruned departed worker heartbeats`);
      }
    }
  };

  const body = deps.runTick ?? defaultBody;

  const tick = async (): Promise<void> => {
    // Stamped BEFORE the re-entrancy guard, deliberately. This column is pure
    // scheduler liveness: a lane whose timer fires every interval while its
    // previous tick is still running is *healthy but slow*, and it must not read
    // as dead. Writing this only on ticks that actually run would conflate a
    // stopped timer with a slow handler — two conditions with two different
    // remediations, which is exactly why they get two different signals.
    //
    // AWAITED rather than fire-and-forget. Fire-and-forget looks safer — it
    // keeps telemetry off the tick's critical path — but it makes the signal
    // non-deterministic: two rapid fires can land out of order, so
    // `last_scheduled_at` can go backwards, and nothing can observe whether the
    // write happened at all.
    //
    // Started but NOT awaited before the body: telemetry must never delay
    // claiming. Awaiting here puts a database round-trip in front of every
    // tick, which on the `fast` lane is a meaningful fraction of its interval —
    // and it broke the lane-isolation test guarding PR #216/#256's invariant,
    // which is precisely the regression that rule exists to catch. The promise
    // is awaited before `tick()` resolves instead, so the write is
    // deterministic for tests without ever sitting in front of real work.
    const scheduled = heartbeats.scheduled(config.lane);
    if (ticking) {
      // A skipped tick does no work, so there is nothing left to delay.
      await scheduled;
      return;
    }
    ticking = true;
    try {
      await body(config);
      // Reached only when the tick finished. A wedged tick never gets here,
      // which is what makes the gap between this and `last_scheduled_at`
      // meaningful.
      await heartbeats.completed(config.lane);
    } finally {
      ticking = false;
      await scheduled;
    }
  };

  const handle = schedule(() => void tick(), config.intervalMs);
  // Fire an immediate tick so newly-enqueued jobs don't wait the first interval.
  void tick();
  return { tick, handle };
}

/**
 * Start the durable async-jobs background worker as 3 independent lanes (fast /
 * render / bulk). Should be called once on server startup AFTER all handlers are
 * registered. Interval override is via env vars only (the old `intervalMs`
 * positional arg is gone — a single interval no longer maps to 3 lanes).
 * Returns the 3 lane timer handles (unused by the production caller).
 */
export function runAsyncJobsWorker(): NodeJS.Timeout[] {
  if (HANDLERS.size === 0) {
    logger.warn("[asyncJobs] no handlers registered — worker still started for future registrations");
  }

  const laneConfigs: LaneConfig[] = [
    {
      lane: "fast",
      intervalMs: intervalEnv("ASYNC_JOBS_FAST_INTERVAL_MS", DEFAULT_FAST_INTERVAL_MS),
      maxConcurrency: Math.max(1, positiveIntEnv("ASYNC_JOBS_FAST_MAX_CONCURRENCY", 2)),
      maintenance: false,
    },
    {
      lane: "render",
      intervalMs: intervalEnv("ASYNC_JOBS_RENDER_INTERVAL_MS", DEFAULT_RENDER_INTERVAL_MS),
      // Falls back to the legacy ASYNC_JOBS_MAX_CONCURRENCY (not a bare literal):
      // that knob's own doc comment says it exists to bound LLM-planner/fal
      // fan-out, i.e. exactly this lane's queues. A deploy that already tuned it
      // down for a provider rate limit must keep that cap after this upgrade,
      // not silently jump to a fresh independent default.
      maxConcurrency: Math.max(1, positiveIntEnv("ASYNC_JOBS_RENDER_MAX_CONCURRENCY", ASYNC_JOBS_MAX_CONCURRENCY)),
      maintenance: false,
    },
    {
      lane: "bulk",
      intervalMs: intervalEnv("ASYNC_JOBS_WORKER_INTERVAL_MS", DEFAULT_WORKER_INTERVAL_MS),
      maxConcurrency: ASYNC_JOBS_MAX_CONCURRENCY,
      maintenance: true,
    },
    {
      lane: "pexels",
      intervalMs: intervalEnv("ASYNC_JOBS_PEXELS_INTERVAL_MS", DEFAULT_PEXELS_INTERVAL_MS),
      maxConcurrency: Math.max(1, positiveIntEnv("ASYNC_JOBS_PEXELS_MAX_CONCURRENCY", 1)),
      maintenance: false,
    },
    {
      lane: "ai_meme_backfill",
      intervalMs: intervalEnv("ASYNC_JOBS_AI_MEME_BACKFILL_INTERVAL_MS", DEFAULT_AI_MEME_BACKFILL_INTERVAL_MS),
      maxConcurrency: Math.max(1, positiveIntEnv("ASYNC_JOBS_AI_MEME_BACKFILL_MAX_CONCURRENCY", 1)),
      maintenance: false,
    },
  ];

  // Startup recovery once (the bulk runner also sweeps periodically thereafter).
  // Pass the cutoff EXPLICITLY rather than relying on `recoverStuckProcessing`'s
  // 5-minute default: on an autoscaled deployment a booting instance runs this
  // against rows that other, healthy instances are actively processing, so the
  // boot path is if anything more exposed to the reclaim race than the periodic
  // sweep — it must not silently use a shorter, more aggressive cutoff.
  recoverStuckProcessing(defaultDb, RECOVER_STUCK_CUTOFF_MIN).catch((err) => {
    logger.error({ err }, "[asyncJobs] startup recovery failed");
  });

  // Structured startup classification: makes the effective lane of every
  // registered queue visible at boot (a queue that forgot its lane option shows
  // up under `bulk` here).
  logger.info(
    {
      lanes: Object.fromEntries(
        laneConfigs.map((c) => [
          c.lane,
          { queues: queuesForLane(c.lane), intervalMs: c.intervalMs, maxConcurrency: c.maxConcurrency },
        ]),
      ),
    },
    "[asyncJobs] worker lanes started",
  );

  return laneConfigs.map((config) => createLaneRunner(config).handle);
}

// ─── Reset for tests ────────────────────────────────────────────────────────

/** Reset the handler + lane registries — exported for unit tests. */
export function __resetHandlersForTest(): void {
  HANDLERS.clear();
  LANE_OF_QUEUE.clear();
}
