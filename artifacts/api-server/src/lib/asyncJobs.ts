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

import { randomUUID } from "node:crypto";
import { eq, and, or, lte, lt, asc, desc, sql, inArray, isNull, isNotNull } from "drizzle-orm";
import { db as defaultDb } from "@workspace/db";
import {
  asyncJobsTable,
  IN_FLIGHT_JOB_STATUSES,
  type AsyncJobRow,
  type AsyncJobStatus,
} from "@workspace/db/schema";
import { getConfigInt } from "./adminConfig";
import { logger } from "./logger";
import { JobInvocation, ownedBy, runAsInvocation } from "./jobFence";
import {
  WORKER_INSTANCE_ID,
  stampLaneScheduled,
  stampTickCompleted,
  publishInFlight,
  decrementInFlight,
  pruneDepartedInstances,
  heartbeatTtlMinutes,
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
  /**
   * Optional: why this handler cannot run right now (e.g. email with no
   * transport configured), or null when it can. A claimed row whose handler is
   * unavailable is put back to `pending` with this reason instead of being run,
   * so it is delivered once the handler becomes available rather than burned
   * through its retries. The handler owns the answer: the worker keeps no copy
   * of any queue's configuration rule.
   */
  unavailableReason?(): string | null;
}

const HANDLERS = new Map<string, JobHandler>();

/**
 * Scheduling lane a queue runs in. Each lane is drained by its own independent
 * worker loop (own timer, own re-entrancy guard, own concurrency bound), so a
 * busy lane can never block another lane's progress:
 *   • `fast`            — short, DB-oriented admin actions with no model/image wait.
 *   • `render`          — single-item, moderator-watched external-API renders.
 *   • `bulk`             — background/batch work nobody's watching a spinner for (default).
 *   • `ai_meme_backfill` — `fact_ai_meme_backfill`, serialized (maxConcurrency 1)
 *     to preserve the "process sequentially" OpenAI rate-limit pacing the
 *     direct-call bulk route used to provide.
 */
export type JobLane = "fast" | "render" | "bulk" | "ai_meme_backfill";

/** Per-queue lane assignment. Kept in lockstep with HANDLERS (same replace/reset). */
const LANE_OF_QUEUE = new Map<string, JobLane>();

/** Per-queue run settings beyond the lane. Kept in lockstep with HANDLERS. */
interface QueueSettings {
  executionLimitMs: number;
  recoveryProtocol: number | null;
  fastReclaim: boolean;
}
const SETTINGS_OF_QUEUE = new Map<string, QueueSettings>();

/**
 * The execution limit a queue gets when its registration names none: the old
 * reclaim cutoff, so an unannotated queue is never cut shorter than it could
 * run before leases existed. Every production queue names its own.
 */
export const DEFAULT_EXECUTION_LIMIT_MS = 30 * 60_000;

/** Options for `registerJobHandler`. */
export interface RegisterJobHandlerOptions {
  /** Scheduling lane. Omit to default to `bulk`. */
  lane?: JobLane;
  /**
   * The longest one run of this queue may take, retries inside the run
   * included, with margin (plan §B). At the limit the run's effect context is
   * stopped for good and the job is put back for a retry (or failed when its
   * attempts are spent). It must exceed the slowest HEALTHY run: it exists to
   * end a wedged run, never a slow one. Omit for `DEFAULT_EXECUTION_LIMIT_MS`.
   */
  executionLimitMs?: number;
  /**
   * The recovery protocol version this handler implements for its queue (plan
   * §A). A row taken back from a stopped holder of a declaring queue becomes
   * `recovering`, and only a worker whose handler declares at least the version
   * stamped on the row may claim it. Omit (the default) for a handler that has
   * no recovery protocol: its reclaimed rows go back to `pending`.
   */
  recoveryProtocol?: number;
  /**
   * Reclaim this queue's rows as soon as their lease lapses (plan §A). Off by
   * default: the row then waits until 30 minutes after its claim, as before
   * leases. Switched on per queue only once that queue's recovery is built.
   */
  fastReclaim?: boolean;
}

/**
 * Register the handler for a given queue. Idempotent — replaces the handler,
 * its lane assignment and its settings, so re-registering reclassifies the
 * queue. An unannotated registration lands the queue in `bulk`.
 */
export function registerJobHandler(
  queue: string,
  handler: JobHandler,
  opts?: RegisterJobHandlerOptions,
): void {
  HANDLERS.set(queue, handler);
  LANE_OF_QUEUE.set(queue, opts?.lane ?? "bulk");
  const executionLimitMs = opts?.executionLimitMs ?? DEFAULT_EXECUTION_LIMIT_MS;
  if (!(Number.isFinite(executionLimitMs) && executionLimitMs > 0)) {
    throw new Error(`[asyncJobs] ${queue}: executionLimitMs must be a positive number of milliseconds`);
  }
  SETTINGS_OF_QUEUE.set(queue, {
    executionLimitMs,
    recoveryProtocol: opts?.recoveryProtocol ?? null,
    fastReclaim: opts?.fastReclaim ?? false,
  });
}

/** A registered queue's run settings, or undefined when it is not registered. */
export function queueSettings(queue: string): Readonly<QueueSettings> | undefined {
  return SETTINGS_OF_QUEUE.get(queue);
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

async function deferWhileHandlerUnavailable(
  row: AsyncJobRow,
  handler: JobHandler,
  tx: unknown,
  lane?: JobLane,
): Promise<boolean> {
  const reason = handler.unavailableReason?.() ?? null;
  if (reason === null) return false;
  const typedTx = tx as Pick<typeof defaultDb, "update">;
  await typedTx
    .update(asyncJobsTable)
    .set({
      // A row in recovery stays in recovery (plan §A).
      status: requeueStatus(row),
      lastError: reason,
      nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[1]!),
      updatedAt: new Date(),
    })
    .where(eq(asyncJobsTable.id, row.id));
  logger.info({ ...laneField(lane), id: row.id, queue: row.queue, reason }, `${lanePrefix(lane)} handler unavailable — leaving job pending`);
  return true;
}

// ─── Leases and fenced effects (plan §A, §B) ─────────────────────────────────

export {
  JobInvocation,
  JobOwnershipLostError,
  assertJobOwnership,
  currentJobInvocation,
  fencedTransaction,
  jobAbortSignal,
} from "./jobFence";

/** A claim's lease: renewed by a live holder well before it lapses. */
export const LEASE_DURATION_MS = 90_000;
/** How often a process renews every lease it holds (its own timer). */
export const LEASE_RENEW_INTERVAL_MS = 20_000;
/** How often the reclaim sweep runs (its own timer). */
export const RECLAIM_INTERVAL_MS = 30_000;
const LEASE_INTERVAL = sql.raw(`interval '${LEASE_DURATION_MS} milliseconds'`);

/** Invocations this process is running, by lease token (the renewal's work list). */
const HELD = new Map<string, JobInvocation>();

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
   * existing non-terminal (pending/recovering/processing) job with the same dedupe key.
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
  const insertOnce = (target: Pick<typeof defaultDb, "insert">) => target
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
  // Inside a caller's transaction, the insert runs under a savepoint: a dedupe
  // conflict then undoes only this insert, not the caller's whole transaction
  // (a fenced write and its child enqueue share one, Issue #1000).
  const inSavepoint = (): ReturnType<typeof insertOnce> => {
    const tx = dbOverride as Partial<Pick<typeof defaultDb, "transaction">> | undefined;
    return (tx && typeof tx.transaction === "function"
      ? tx.transaction((sp) => insertOnce(sp))
      : insertOnce(dbInstance)) as ReturnType<typeof insertOnce>;
  };
  try {
    const [row] = await inSavepoint();
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
            // `recovering` is in flight too (plan §A): the dedupe index covers it.
            inArray(asyncJobsTable.status, [...IN_FLIGHT_JOB_STATUSES]),
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
      const [retry] = await inSavepoint();
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

/** The statuses a finished-for-now (retry, deferral) row goes back to. */
function requeueStatus(row: Pick<AsyncJobRow, "recoveryProtocol">): AsyncJobStatus {
  // A row in recovery stays in recovery until it finishes (plan §A): only a
  // worker that can recover it may run it again.
  return row.recoveryProtocol != null ? "recovering" : "pending";
}

/** What a fenced finalize sets on the row beyond its outcome: the lease is over. */
const LEASE_RELEASED = { leaseExpiresAt: null } as const;

/**
 * Run one claimed job to completion and finalize its own outcome in an
 * independent short transaction. Isolated per job so jobs can run concurrently
 * (a single tx/connection can't) and so one job's finalize never blocks or
 * rolls back another's.
 *
 * The run happens inside its invocation (`runAsInvocation`), so every
 * `fencedTransaction` the handler makes is checked against this claim. The
 * finalize is fenced the same way: a run that lost its lease, or was stopped
 * at its execution limit, writes nothing, and `onAbandon` fires only after a
 * fenced terminal transition succeeded.
 */
async function processClaimedJob(
  dbInstance: DbWithTransaction,
  row: AsyncJobRow,
  lane?: JobLane,
): Promise<void> {
  const handler = HANDLERS.get(row.queue);
  const leaseToken = row.leaseToken;
  if (!handler || !leaseToken) return; // filtered at claim time; defensive.

  const invocation = new JobInvocation(row.id, row.queue, leaseToken);
  HELD.set(leaseToken, invocation);
  const limitMs = SETTINGS_OF_QUEUE.get(row.queue)?.executionLimitMs ?? DEFAULT_EXECUTION_LIMIT_MS;
  let limitTimer: NodeJS.Timeout | undefined;

  try {
    // The handler is responsible for not throwing; if it does, we treat it as a
    // retryable failure with a synthetic error message. A refused fenced write
    // surfaces here as a throw too, and the fenced finalize below then writes
    // nothing, because the claim it would need is gone.
    const run = runAsInvocation(invocation, async (): Promise<HandlerResult> => {
      try {
        return await handler.run(row.payload, row);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    const limit = new Promise<"limit">((resolve) => {
      // Not unref'd: a run in progress is a reason to stay alive. Always cleared
      // in the finally below, so it never outlives the run.
      limitTimer = setTimeout(() => resolve("limit"), limitMs);
    });

    const raced = await Promise.race([run, limit]);
    let outcome: HandlerResult;
    if (raced === "limit") {
      // Plan §B: stop the effect context for good FIRST, so a late result from
      // the still-running handler is refused even while the lease has time
      // left; then make the retry-or-failure transition while we still own it.
      const reason = `execution limit of ${Math.round(limitMs / 1000)} s reached — run stopped`;
      invocation.stop(reason);
      logger.warn(
        { ...laneField(lane), id: row.id, queue: row.queue, limitMs },
        `${lanePrefix(lane)} job reached its execution limit — effects stopped, scheduling retry`,
      );
      outcome = { ok: false, error: reason };
      // The handler keeps running in the background until it notices; its
      // eventual result is discarded, and its effects are refused.
      void run.catch(() => undefined);
    } else {
      outcome = raced;
    }

    await finalizeOutcome(dbInstance, row, handler, leaseToken, outcome, lane);
  } finally {
    if (limitTimer) clearTimeout(limitTimer);
    HELD.delete(leaseToken);
    // Whatever happened, this invocation is over: nothing it still has in
    // flight may write.
    invocation.stop("the run has finished");
  }
}

async function finalizeOutcome(
  dbInstance: DbWithTransaction,
  row: AsyncJobRow,
  handler: JobHandler,
  leaseToken: string,
  outcome: HandlerResult,
  lane?: JobLane,
): Promise<void> {
  const newAttempts = row.attempts + 1;

  // One fenced write: the WHERE carries the ownership predicate, so a reclaim
  // cannot slip between a check and the write. Returns false when the claim is
  // no longer ours.
  const fencedFinalize = async (set: Partial<typeof asyncJobsTable.$inferInsert>): Promise<boolean> =>
    dbInstance.transaction(async (tx) => {
      const updated = await tx
        .update(asyncJobsTable)
        .set({ ...set, ...LEASE_RELEASED, updatedAt: new Date() })
        .where(ownedBy(row.id, leaseToken))
        .returning({ id: asyncJobsTable.id });
      return updated.length > 0;
    });

  // Finalize must never throw out of here: a rejection would exit this worker
  // (dropping its share of the batch's remaining concurrency) and, worse, leave
  // the row committed as `processing`. On a finalize failure we log and rely on
  // the lease lapsing and the reclaim sweep to requeue it.
  let abandoned = false;
  let terminalFailed = false;
  let outcomeError: string | null = null;
  let owned: boolean;
  try {
    if (outcome.ok) {
      owned = await fencedFinalize({
        status: "done",
        attempts: newAttempts,
        result: (outcome.result as object | undefined) ?? null,
        // The latest outcome is a success: an error left from an earlier
        // attempt would read as current on every admin surface (#692).
        lastError: null,
      });
    } else {
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
        owned = await fencedFinalize({
          status: "failed",
          attempts: newAttempts,
          lastError: outcome.error,
          nextAttemptAt: new Date(),
          maxAttempts: effectiveMax,
        });
      } else {
        const { maxAttempts, retryDelays } = await getRetryConfig(row.queue);
        const explicitMax = row.maxAttempts > USE_CONFIGURED_MAX_ATTEMPTS ? row.maxAttempts : undefined;
        const effectiveMax = Math.max(1, explicitMax ?? maxAttempts);
        abandoned = newAttempts >= effectiveMax;
        const scheduledDelay = retryDelays[newAttempts];
        const delayMs = scheduledDelay ?? retryDelays[retryDelays.length - 1] ?? 0;
        owned = await fencedFinalize({
          status: abandoned ? "failed" : requeueStatus(row),
          attempts: newAttempts,
          lastError: outcome.error,
          nextAttemptAt: abandoned ? new Date() : new Date(Date.now() + delayMs),
          // Same reasoning as the terminal branch above, and ONLY on the
          // terminal transition: a still-`pending` row is not yet finalized,
          // so it must keep tracking live config — an admin raising the
          // ceiling mid-flight should let an in-progress job benefit from
          // the extra retries, not freeze it to the value read at this tick.
          ...(abandoned ? { maxAttempts: effectiveMax } : {}),
        });
      }
    }
  } catch (finalizeErr) {
    logger.error(
      { ...laneField(lane), err: finalizeErr, queue: row.queue, id: row.id },
      `${lanePrefix(lane)} finalize failed — row left in processing for the reclaim sweep`,
    );
    return;
  }

  if (!owned) {
    // The claim moved on (lease lapsed and reclaimed, or another run holds it):
    // this run's outcome is not the job's. Nothing was written (plan §A).
    logger.warn(
      { ...laneField(lane), queue: row.queue, id: row.id, ok: outcome.ok, error: outcomeError },
      `${lanePrefix(lane)} job no longer owned at finish — outcome discarded, nothing written`,
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
    // Reached only after the fenced terminal transition succeeded (plan §A).
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

/** Per-tick controls. All optional so `asyncJobsTick(db)` keeps its legacy behavior. */
export interface AsyncJobsTickOptions {
  /**
   * Restrict the claim to these queues (a lane's queue set). Omit to claim across
   * ALL registered queues (legacy behavior). An empty array matches no rows.
   */
  queues?: readonly string[];
  /** Concurrency bound for this tick's batch. Omit to use the bulk-lane default. */
  maxConcurrency?: number;
  /** Lane context, for log attribution only. */
  lane?: JobLane;
}

/** At most this many rows are claimed in one tick (it was the batch size). */
const TICK_CLAIM_LIMIT = 10;

/**
 * Which rows a worker may claim for these queues: any due `pending` row, and a
 * `recovering` row only for a queue whose handler here declares at least the
 * protocol the row requires (plan §A). With no queue declaring recovery (this
 * release), that is `pending` alone, exactly as before.
 */
function claimableFilter(queues: readonly string[]) {
  const recovering = queues.flatMap((queue) => {
    const declared = SETTINGS_OF_QUEUE.get(queue)?.recoveryProtocol;
    if (declared == null) return [];
    return [and(
      eq(asyncJobsTable.queue, queue),
      eq(asyncJobsTable.status, "recovering"),
      lte(asyncJobsTable.recoveryProtocol, declared),
    )];
  });
  return and(
    inArray(asyncJobsTable.queue, [...queues]),
    or(eq(asyncJobsTable.status, "pending"), ...recovering),
  );
}

/**
 * Claim ONE due row, in its own short transaction, stamping this process as its
 * owner under a fresh lease. One at a time, and only when a slot is free (plan
 * §A: no claimed job ever waits locally while its lease runs). Rows whose
 * handler is unavailable are deferred and skipped. Returns null when nothing is
 * due.
 */
async function claimOne(
  dbInstance: DbWithTransaction,
  now: Date,
  queues: readonly string[],
  lane?: JobLane,
): Promise<AsyncJobRow | null> {
  return dbInstance.transaction(async (tx) => {
    // Bounded: each deferred row leaves the due set, so this cannot spin.
    for (let guard = 0; guard < TICK_CLAIM_LIMIT; guard++) {
      const [row] = (await tx
        .select()
        .from(asyncJobsTable)
        .where(and(claimableFilter(queues), lte(asyncJobsTable.nextAttemptAt, now)))
        .orderBy(asc(asyncJobsTable.nextAttemptAt), asc(asyncJobsTable.id))
        .limit(1)
        .for("update", { skipLocked: true })) as AsyncJobRow[];
      if (!row) return null;
      const handler = HANDLERS.get(row.queue)!;
      if (await deferWhileHandlerUnavailable(row, handler, tx, lane)) continue;
      const [claimed] = (await tx
        .update(asyncJobsTable)
        .set({
          status: "processing",
          claimOwner: WORKER_INSTANCE_ID,
          leaseToken: randomUUID(),
          leaseExpiresAt: sql`now() + ${LEASE_INTERVAL}`,
          claimedAt: sql`now()`,
          claimRecoveryProtocol: SETTINGS_OF_QUEUE.get(row.queue)?.recoveryProtocol ?? null,
          updatedAt: new Date(),
        })
        .where(eq(asyncJobsTable.id, row.id))
        .returning()) as AsyncJobRow[];
      return claimed ?? null;
    }
    return null;
  });
}

/**
 * Process one tick: `maxConcurrency` slots, each claiming ONE due row (short
 * transaction, `FOR UPDATE SKIP LOCKED`), running it, and finalizing it, then
 * claiming the next — until nothing is due or the tick has claimed
 * `TICK_CLAIM_LIMIT` rows. A row is claimed only into a free slot, so its lease
 * never runs while it waits locally (plan §A); slots run concurrently, each
 * finalizing its own outcome.
 *
 * A crash leaves a claimed row `processing` under a lease nobody renews; the
 * reclaim sweep returns it once the lease lapses (and, for a queue whose fast
 * reclaim is off, once 30 minutes have passed since the claim).
 * Exported for tests with an injected db.
 */
export async function asyncJobsTick(
  dbInstance: DbWithTransaction,
  now: Date = new Date(),
  options?: AsyncJobsTickOptions,
): Promise<void> {
  const lane = options?.lane;
  // Only queues this worker can run. `inArray(col, [])` would match nothing, so
  // an empty lane claims nothing.
  const queues = (options?.queues ?? [...HANDLERS.keys()]).filter((q) => HANDLERS.has(q));
  if (queues.length === 0) return;

  const maxConcurrency = Math.max(1, options?.maxConcurrency ?? ASYNC_JOBS_MAX_CONCURRENCY);
  let claimedCount = 0;
  let inFlight = 0;

  const slot = async (): Promise<void> => {
    while (claimedCount < TICK_CLAIM_LIMIT) {
      claimedCount++; // reserve before the await, so slots never over-claim
      let row: AsyncJobRow | null;
      try {
        row = await claimOne(dbInstance, now, queues, lane);
      } catch (err) {
        claimedCount--;
        logger.error({ ...laneField(lane), err }, `${lanePrefix(lane)} claim failed`);
        return;
      }
      if (!row) {
        claimedCount--;
        return;
      }
      // Publish the in-flight count as soon as the claim commits, before the
      // handler is awaited: a wedged tick never completes, so a completion-only
      // write would leave the count at its previous value (normally zero) while
      // `worker_lane_wedged` waits for `in_flight_count > 0`.
      inFlight++;
      if (lane) await publishInFlight(lane, inFlight);
      try {
        await processClaimedJob(dbInstance, row, lane);
      } finally {
        inFlight--;
        // Per job, as it leaves the in-flight set — so a long tail of one slow
        // handler reads as "1 in flight", not as the whole batch.
        if (lane) await decrementInFlight(lane);
      }
    }
  };

  await Promise.all(Array.from({ length: maxConcurrency }, () => slot()));
}

// ─── Lease renewal and reclaim (plan §A) ────────────────────────────────────

/**
 * Renew the lease of every row this process holds. Runs on its own timer
 * (`LEASE_RENEW_INTERVAL_MS`), never inside a lane tick, so a long batch cannot
 * hold it up. A held row the renewal does not find — its token changed, it left
 * `processing`, or its lease had already lapsed — means that invocation has
 * lost ownership for good: its effect context is stopped.
 */
export async function renewHeldLeases(
  dbInstance: Pick<typeof defaultDb, "update"> = defaultDb,
): Promise<{ renewed: number; lost: number }> {
  const live = [...HELD.values()].filter((inv) => !inv.stopped);
  if (live.length === 0) return { renewed: 0, lost: 0 };
  const rows = await dbInstance
    .update(asyncJobsTable)
    .set({ leaseExpiresAt: sql`now() + ${LEASE_INTERVAL}` })
    .where(and(
      inArray(asyncJobsTable.leaseToken, live.map((inv) => inv.leaseToken)),
      eq(asyncJobsTable.status, "processing"),
      sql`${asyncJobsTable.leaseExpiresAt} > now()`,
    ))
    .returning({ leaseToken: asyncJobsTable.leaseToken });
  const renewed = new Set(rows.map((r) => r.leaseToken));
  let lost = 0;
  for (const inv of live) {
    if (renewed.has(inv.leaseToken)) continue;
    lost++;
    inv.stop("lease lost — renewal found the claim changed or expired");
    logger.warn({ id: inv.jobId, queue: inv.queue }, "[asyncJobs] lease lost at renewal — run's effects stopped");
  }
  return { renewed: renewed.size, lost };
}

/**
 * Take back rows whose holder has gone quiet, so the next tick runs them.
 * Runs on its own timer (`RECLAIM_INTERVAL_MS`) and once at boot.
 *
 * - A **leased** row is reclaimed once its lease has lapsed — immediately for a
 *   queue whose fast reclaim is on here, otherwise only once `cutoffMinutes`
 *   have also passed since its claim (today's 30-minute rule, plan §A). A live
 *   holder keeps renewing, so a slow but healthy run is never taken.
 * - A row **claimed by the previous release** (no lease token) keeps the old
 *   rule: reclaimed once `updated_at` is older than `cutoffMinutes`, because an
 *   old, unfenced worker may still be running it.
 *
 * A reclaimed row goes to `recovering` when its queue declared recovery (at
 * claim, or earlier) — stamped with the protocol it needs — and to `pending`
 * otherwise. Each reclaim is logged with the owner it was taken from.
 */
export async function recoverStuckProcessing(
  dbInstance: Pick<typeof defaultDb, "update">,
  cutoffMinutes = RECOVER_STUCK_CUTOFF_MIN,
): Promise<number> {
  const cutoff = sql`now() - ${sql.raw(`interval '${Math.max(0, Number(cutoffMinutes) || 0)} minutes'`)}`;
  const fastQueues = [...SETTINGS_OF_QUEUE].filter(([, s]) => s.fastReclaim).map(([q]) => q);

  const leased = await dbInstance
    .update(asyncJobsTable)
    .set({
      status: sql`CASE WHEN COALESCE(${asyncJobsTable.recoveryProtocol}, ${asyncJobsTable.claimRecoveryProtocol}) IS NULL THEN 'pending' ELSE 'recovering' END`,
      recoveryProtocol: sql`GREATEST(${asyncJobsTable.recoveryProtocol}, ${asyncJobsTable.claimRecoveryProtocol})`,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(asyncJobsTable.status, "processing"),
      isNotNull(asyncJobsTable.leaseToken),
      sql`${asyncJobsTable.leaseExpiresAt} <= now()`,
      or(
        fastQueues.length > 0 ? inArray(asyncJobsTable.queue, fastQueues) : sql`false`,
        sql`COALESCE(${asyncJobsTable.claimedAt}, ${asyncJobsTable.updatedAt}) < ${cutoff}`,
      ),
    ))
    .returning({
      id: asyncJobsTable.id,
      queue: asyncJobsTable.queue,
      status: asyncJobsTable.status,
      claimOwner: asyncJobsTable.claimOwner,
    });
  for (const r of leased) {
    logger.info(
      { id: r.id, queue: r.queue, previousOwner: r.claimOwner, to: r.status },
      "[asyncJobs] reclaimed a job whose holder stopped renewing its lease",
    );
  }

  const legacy = await dbInstance
    .update(asyncJobsTable)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(
      eq(asyncJobsTable.status, "processing"),
      isNull(asyncJobsTable.leaseToken),
      sql`${asyncJobsTable.updatedAt} < ${cutoff}`,
    ))
    .returning({ id: asyncJobsTable.id, queue: asyncJobsTable.queue });
  for (const r of legacy) {
    logger.info({ id: r.id, queue: r.queue }, "[asyncJobs] reclaimed an unleased job left processing by an earlier release");
  }
  return leased.length + legacy.length;
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
const DEFAULT_AI_MEME_BACKFILL_INTERVAL_MS = 5_000;
/** Retention purge isn't time-sensitive — don't run it every short tick. */
const PURGE_INTERVAL_MS = 60_000;
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
    ai_meme_backfill: intervalEnv(
      "ASYNC_JOBS_AI_MEME_BACKFILL_INTERVAL_MS",
      DEFAULT_AI_MEME_BACKFILL_INTERVAL_MS,
    ),
  };
}

/** All four lanes, in the order the health surface presents them. */
export const ALL_LANES: readonly JobLane[] = ["fast", "render", "bulk", "ai_meme_backfill"];

/**
 * `max(3 × interval, 60s)`.
 *
 * Three intervals rather than one so a single skipped or slow tick is not an
 * outage, and a 60s floor because the `fast` lane's 2s interval would otherwise
 * give a 6s threshold — tight enough that ordinary scheduler jitter or a brief
 * event-loop pause would raise a false stall on the noisiest lane.
 *
 * Lives here (not in `queueHealth.ts`, which consumes it) because
 * `pruneDepartedInstances`'s cutoff below needs it too, and `workerHeartbeats.ts`
 * is deliberately kept free of any dependency on lane-scheduling concerns —
 * this file already owns `ALL_LANES`/`laneIntervalsMs`, so it's the one place
 * both callers can reach without a cross-file import cycle.
 */
export function staleThresholdMs(intervalMs: number): number {
  return Math.max(3 * intervalMs, 60_000);
}

/**
 * The loosest stall window across all four lanes, in milliseconds.
 *
 * Anything that decides whether a heartbeat row is still worth keeping —
 * `laneHealth`'s live-instance query, `pruneDepartedInstances`'s delete cutoff —
 * must never use a window TIGHTER than this, or it can discard a row before
 * the per-lane stalled check (which uses each lane's OWN, possibly smaller,
 * threshold) ever gets a chance to evaluate it.
 */
export function widestStaleThresholdMs(): number {
  const intervals = laneIntervalsMs();
  return Math.max(...ALL_LANES.map((lane) => staleThresholdMs(intervals[lane])));
}

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
  /** When true (bulk only), this runner also owns the periodic retention purge. */
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
    // Bulk runner only: purge terminal rows. It operates table-wide/all-queues,
    // so one runner owning it is correct — no per-lane duplication. (Reclaim of
    // rows stranded in `processing` runs on its own timer, plan §A.)
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
      //
      // The cutoff is widened the same way laneHealth's own query is — never
      // tighter than the loosest lane's stall window — or this delete would
      // erase a heartbeat before laneHealth's widened query ever got a chance
      // to still see it, defeating that widening entirely.
      const configuredTtlMinutes = await heartbeatTtlMinutes();
      const widenedTtlMinutes = Math.max(configuredTtlMinutes, widestStaleThresholdMs() / 60_000);
      const pruned = await pruneDepartedInstances(defaultDb, widenedTtlMinutes);
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
      lane: "ai_meme_backfill",
      intervalMs: intervalEnv("ASYNC_JOBS_AI_MEME_BACKFILL_INTERVAL_MS", DEFAULT_AI_MEME_BACKFILL_INTERVAL_MS),
      maxConcurrency: Math.max(1, positiveIntEnv("ASYNC_JOBS_AI_MEME_BACKFILL_MAX_CONCURRENCY", 1)),
      maintenance: false,
    },
  ];

  // Lease renewal and reclaim, each on its own timer (plan §A) — never inside a
  // lane tick, so a long batch can hold up neither. Reclaim also runs once now,
  // so a job a previous process left behind is taken back at boot.
  startLeaseTimers();

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

/**
 * Start the renewal timer (`LEASE_RENEW_INTERVAL_MS`) and the reclaim timer
 * (`RECLAIM_INTERVAL_MS`), and run one reclaim now. Each has its own
 * re-entrancy guard and never throws out of its timer.
 */
function startLeaseTimers(): NodeJS.Timeout[] {
  let renewing = false;
  let reclaiming = false;
  const renew = async (): Promise<void> => {
    if (renewing) return;
    renewing = true;
    try {
      await renewHeldLeases(defaultDb);
    } catch (err) {
      // A failed renewal is not a lost lease yet: the next one, inside the
      // lease's 90 s, either renews or finds the lease gone and stops the run.
      logger.error({ err }, "[asyncJobs] lease renewal failed");
    } finally {
      renewing = false;
    }
  };
  const reclaim = async (): Promise<void> => {
    if (reclaiming) return;
    reclaiming = true;
    try {
      await recoverStuckProcessing(defaultDb, RECOVER_STUCK_CUTOFF_MIN);
    } catch (err) {
      logger.error({ err }, "[asyncJobs] reclaim sweep failed");
    } finally {
      reclaiming = false;
    }
  };
  void reclaim();
  return [
    realSchedule(() => void renew(), LEASE_RENEW_INTERVAL_MS),
    realSchedule(() => void reclaim(), RECLAIM_INTERVAL_MS),
  ];
}

// ─── Reset for tests ────────────────────────────────────────────────────────

/** Reset the handler + lane registries — exported for unit tests. */
export function __resetHandlersForTest(): void {
  HANDLERS.clear();
  LANE_OF_QUEUE.clear();
  SETTINGS_OF_QUEUE.clear();
}
