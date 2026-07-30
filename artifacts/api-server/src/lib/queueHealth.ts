/**
 * Read-only queue-health aggregation. Phase 1 of the async-queue hardening plan.
 *
 * Everything here derives from `async_jobs` + `worker_lane_heartbeats` by query
 * and stores **nothing**: no counters, no cached rollups, no second source of
 * truth for job state. `async_jobs` stays authoritative.
 *
 * Two things in this file are easy to get subtly wrong, so they are spelled out
 * where they happen rather than left to the caller:
 *
 * 1. **Lane liveness is a fleet-wide quantifier over LIVE instances**, not a
 *    scan of every heartbeat row. This deployment is autoscaled; one instance
 *    pausing or scaling down while another keeps scheduling a lane is normal,
 *    and reporting that as an outage would page an operator for a healthy fleet.
 * 2. **`status` collapses distinctions the UI is required to show.** A
 *    handler-level skip finishes as `done`, and a never-retried abandonment is
 *    just `failed` — so both need deriving here, once, rather than being
 *    re-derived by every consumer.
 */

import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@workspace/db";
import { asyncJobsTable, workerLaneHeartbeatsTable } from "@workspace/db/schema";
import { TAXONOMY_HEALTH_SKIP_REASON_VALUES } from "@workspace/api-zod";
import {
  ALL_LANES,
  laneIntervalsMs,
  laneOfQueue,
  registeredQueues,
  effectiveMaxAttempts,
  type JobLane,
} from "./asyncJobs";
import { heartbeatTtlMinutes } from "./workerHeartbeats";

/** The four raw statuses `async_jobs.status` can hold. */
export const RAW_JOB_STATUSES = ["pending", "processing", "done", "failed"] as const;
export type RawJobStatus = (typeof RAW_JOB_STATUSES)[number];

/**
 * What the UI renders, which is **not** the same set as `status`.
 *
 * `async-ui-status.md` makes "skipped" a first-class terminal state and forbids
 * collapsing it into a checkmark. `async_jobs` has no such status — a skip
 * finishes as `done` with `result.skipped = true` — so the distinction has to be
 * derived. Likewise `abandoned_no_retry`: `fact_ai_meme_backfill` is configured
 * never to retry, so its failures are `failed` after a single attempt, which is
 * a materially different operator story from "exhausted five attempts".
 */
export const DISPLAY_STATUSES = [
  "pending",
  "processing",
  "done",
  "failed",
  "skipped",
  "abandoned_no_retry",
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

/**
 * Skip reasons are **sanitized against a closed set**, never passed through raw.
 *
 * Reusing `TAXONOMY_HEALTH_SKIP_REASON_VALUES` rather than declaring a second
 * list: a handler's skip reason already has exactly one canonical enum in this
 * codebase, and a parallel copy here would drift the moment either side gained a
 * value. Anything outside it becomes `other` — a handler is free to put
 * arbitrary text in `result`, and admin surfaces should not echo it back.
 */
const KNOWN_SKIP_REASONS: readonly string[] = TAXONOMY_HEALTH_SKIP_REASON_VALUES;
export type SanitizedSkipReason = (typeof TAXONOMY_HEALTH_SKIP_REASON_VALUES)[number] | "other";

export function sanitizeSkipReason(raw: unknown): SanitizedSkipReason | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return KNOWN_SKIP_REASONS.includes(raw) ? (raw as SanitizedSkipReason) : "other";
}

/** True when a terminal-ok row's `result` says the handler deliberately did nothing. */
export function isSkipResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { skipped?: unknown }).skipped === true;
}

/**
 * Derive the state the UI shows from the raw row.
 *
 * `effectiveMax` is passed in rather than resolved here because it needs an
 * `admin_config` read per queue, and callers batch that across many rows.
 */
export function deriveDisplayStatus(
  row: { status: string; result: unknown; attempts: number; maxAttempts: number },
  effectiveMax: number,
): { displayStatus: DisplayStatus; skipReason: SanitizedSkipReason | null } {
  if (row.status === "done" && isSkipResult(row.result)) {
    const reason = sanitizeSkipReason((row.result as { reason?: unknown }).reason);
    return { displayStatus: "skipped", skipReason: reason };
  }
  if (row.status === "failed") {
    // `effectiveMax <= 1` is always a safe signal, regardless of WHEN it was
    // resolved: with a ceiling of one, "exhausted" and "terminal on the first
    // attempt" are the identical fact — there is no partial-retry state a
    // later config change could have altered.
    if (effectiveMax <= 1) return { displayStatus: "abandoned_no_retry", skipReason: null };
    // For every other ceiling, only trust `attempts < effectiveMax` when the
    // row's OWN persisted `max_attempts` is non-zero — i.e. it was finalized
    // by the post-PR288 code path, which snapshots the ceiling AT
    // finalization (see processClaimedJob). A row still carrying the `0`
    // sentinel predates that fix — `effectiveMax` for it was just resolved
    // against LIVE admin_config, which may have drifted since this row
    // actually failed, so it is not a safe basis for this distinction.
    // Migration 0094 does not backfill existing rows, so this is the only
    // available treatment for them: render as plain `failed` rather than risk
    // a false "terminal" classification that a raised ceiling could produce.
    if (row.maxAttempts > 0 && row.attempts < effectiveMax) {
      return { displayStatus: "abandoned_no_retry", skipReason: null };
    }
  }
  return { displayStatus: row.status as DisplayStatus, skipReason: null };
}

// ─── Lane liveness ──────────────────────────────────────────────────────────

export interface LaneHealth {
  lane: JobLane;
  /** The interval the worker is actually configured with, not a duplicate constant. */
  intervalMs: number;
  /** A lane is stalled if no live instance scheduled it within this window. */
  staleThresholdMs: number;
  /** Instances whose heartbeat is inside the TTL. Departed ones are excluded first. */
  liveInstanceCount: number;
  /** The most recent schedule across live instances; null when none are live. */
  lastScheduledAt: Date | null;
  /** The most recent completed tick across live instances. */
  lastTickCompletedAt: Date | null;
  /** Total jobs in flight across live instances of this lane. */
  inFlightCount: number;
  /** ∀ live instances: none scheduled this lane inside the threshold. */
  stalled: boolean;
}

/**
 * `max(3 × interval, 60s)`.
 *
 * Three intervals rather than one so a single skipped or slow tick is not an
 * outage, and a 60s floor because the `fast` lane's 2s interval would otherwise
 * give a 6s threshold — tight enough that ordinary scheduler jitter or a brief
 * event-loop pause would raise a false stall on the noisiest lane.
 */
export function staleThresholdMs(intervalMs: number): number {
  return Math.max(3 * intervalMs, 60_000);
}

export async function laneHealth(
  dbInstance: Pick<typeof defaultDb, "select"> = defaultDb,
  ttlMinutes?: number,
): Promise<LaneHealth[]> {
  const ttl = ttlMinutes ?? (await heartbeatTtlMinutes());
  const intervals = laneIntervalsMs();
  // The live-instance filter below must never be TIGHTER than the loosest
  // lane's own stall window — otherwise a heartbeat gets pruned by the TTL
  // cutoff before the per-lane `stalled` check further down ever runs,
  // reporting a merely-slow lane as stalled at the TTL boundary instead of
  // after its documented three missed intervals. Both `ttl` (admin_config)
  // and each lane's interval (env var override) are independently
  // configurable, so nothing else enforces this relationship — widening the
  // query-level cutoff to the max of the two is a pure safety margin: it
  // can only ADMIT more candidate rows, never change the per-lane `stalled`
  // verdict computed below, which still applies each lane's OWN threshold.
  const widestStaleThresholdMs = Math.max(...ALL_LANES.map((lane) => staleThresholdMs(intervals[lane])));
  const liveCutoff = new Date(Date.now() - Math.max(ttl * 60_000, widestStaleThresholdMs));

  // Departed instances are filtered out HERE, before any aggregation. Doing it
  // after would let a scaled-down instance's frozen row decide the lane's
  // verdict forever.
  const rows = await dbInstance
    .select({
      lane: workerLaneHeartbeatsTable.lane,
      liveInstanceCount: sql<number>`count(*)::int`,
      lastScheduledAt: sql<Date | null>`max(${workerLaneHeartbeatsTable.lastScheduledAt})`,
      lastTickCompletedAt: sql<Date | null>`max(${workerLaneHeartbeatsTable.lastTickCompletedAt})`,
      inFlightCount: sql<number>`coalesce(sum(${workerLaneHeartbeatsTable.inFlightCount}), 0)::int`,
    })
    .from(workerLaneHeartbeatsTable)
    .where(sql`${workerLaneHeartbeatsTable.lastScheduledAt} >= ${liveCutoff}`)
    .groupBy(workerLaneHeartbeatsTable.lane);

  const byLane = new Map(rows.map((r) => [r.lane, r]));
  const now = Date.now();

  return ALL_LANES.map((lane) => {
    const intervalMs = intervals[lane];
    const threshold = staleThresholdMs(intervalMs);
    const row = byLane.get(lane);
    const lastScheduledAt = row?.lastScheduledAt ? new Date(row.lastScheduledAt) : null;
    // ∀ live instances, none scheduled inside the window. With no live instance
    // the quantifier is vacuously true, which is the right answer: nothing is
    // scheduling this lane.
    const stalled = lastScheduledAt === null || now - lastScheduledAt.getTime() > threshold;
    return {
      lane,
      intervalMs,
      staleThresholdMs: threshold,
      liveInstanceCount: row?.liveInstanceCount ?? 0,
      lastScheduledAt,
      lastTickCompletedAt: row?.lastTickCompletedAt ? new Date(row.lastTickCompletedAt) : null,
      inFlightCount: row?.inFlightCount ?? 0,
      stalled,
    };
  });
}

// ─── Per-queue tallies ──────────────────────────────────────────────────────

export interface QueueHealth {
  queue: string;
  lane: JobLane | null;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  /** Derived: terminal-ok rows whose handler deliberately did nothing. */
  skipped: number;
  /** Derived: failures on a queue whose effective ceiling is a single attempt. */
  abandonedNoRetry: number;
  done24h: number;
  failed24h: number;
  /** Age of the oldest `pending` row, in seconds. Null when the queue is empty. */
  oldestPendingAgeSeconds: number | null;
}

/**
 * Per-queue tallies, including the two derived states.
 *
 * `skipped` is computed in SQL (`result->>'skipped'`) because it is a property
 * of each row. `abandonedNoRetry` cannot be: the effective ceiling depends on
 * `admin_config`, so failures are grouped by their `max_attempts` override and
 * resolved per queue here.
 */
export async function queueHealth(
  dbInstance: Pick<typeof defaultDb, "select" | "transaction"> = defaultDb,
): Promise<QueueHealth[]> {
  const since24h = new Date(Date.now() - 24 * 3_600_000);

  // Both queries below must read the SAME instant. Read committed (Postgres's
  // default) takes a fresh snapshot per statement, and two statements issued
  // via Promise.all against a plain (non-transactional) db object can land on
  // separate pool connections regardless — so a job finalizing between them
  // could otherwise produce an internally impossible response, e.g.
  // `failed: 0` alongside `abandonedNoRetry: 1`. `repeatable read` pins both
  // statements in this transaction to one snapshot.
  const [tallies, failedByMax] = await dbInstance.transaction(
    async (tx) => {
      const talliesQuery = await tx
        .select({
          queue: asyncJobsTable.queue,
          status: asyncJobsTable.status,
          total: sql<number>`count(*)::int`,
          skipped: sql<number>`count(*) filter (where ${asyncJobsTable.result}->>'skipped' = 'true')::int`,
          last24h: sql<number>`count(*) filter (where ${asyncJobsTable.updatedAt} >= ${since24h})::int`,
          oldestCreatedAt: sql<Date | null>`min(${asyncJobsTable.createdAt})`,
        })
        .from(asyncJobsTable)
        .groupBy(asyncJobsTable.queue, asyncJobsTable.status);
      const failedByMaxQuery = await tx
        .select({
          queue: asyncJobsTable.queue,
          maxAttempts: asyncJobsTable.maxAttempts,
          // Grouped alongside maxAttempts so the terminal-vs-exhausted split
          // below (mirroring deriveDisplayStatus) can tell them apart without
          // a second query.
          attempts: asyncJobsTable.attempts,
          total: sql<number>`count(*)::int`,
        })
        .from(asyncJobsTable)
        .where(eq(asyncJobsTable.status, "failed"))
        .groupBy(asyncJobsTable.queue, asyncJobsTable.maxAttempts, asyncJobsTable.attempts);
      return [talliesQuery, failedByMaxQuery] as const;
    },
    { isolationLevel: "repeatable read" },
  );

  // Every registered queue appears even with zero rows — a queue absent from the
  // page reads as "fine" when it may simply never have run.
  const queues = new Set<string>([...registeredQueues(), ...tallies.map((t) => t.queue)]);

  const out: QueueHealth[] = [];
  for (const queue of [...queues].sort()) {
    const rows = tallies.filter((t) => t.queue === queue);
    const of = (status: RawJobStatus) => rows.find((r) => r.status === status);

    let abandonedNoRetry = 0;
    for (const group of failedByMax.filter((f) => f.queue === queue)) {
      const max = await effectiveMaxAttempts(queue, group.maxAttempts);
      // Same condition as deriveDisplayStatus, including the same guard: only
      // trust `attempts < max` when group.maxAttempts is non-zero (finalized
      // by the post-PR288 path, whose persisted ceiling is durable). A `0`
      // group is a pre-existing row from before that fix — migration 0094
      // does not backfill — so `max` here is a live-config guess that may not
      // match what was true when the row actually failed.
      if (max <= 1 || (group.maxAttempts > 0 && group.attempts < max)) abandonedNoRetry += group.total;
    }

    const pendingRow = of("pending");
    const oldestPending = pendingRow?.oldestCreatedAt ? new Date(pendingRow.oldestCreatedAt) : null;

    out.push({
      queue,
      lane: laneOfQueue(queue) ?? null,
      pending: pendingRow?.total ?? 0,
      processing: of("processing")?.total ?? 0,
      done: of("done")?.total ?? 0,
      failed: of("failed")?.total ?? 0,
      skipped: of("done")?.skipped ?? 0,
      abandonedNoRetry,
      done24h: of("done")?.last24h ?? 0,
      failed24h: of("failed")?.last24h ?? 0,
      oldestPendingAgeSeconds: oldestPending
        ? Math.max(0, Math.round((Date.now() - oldestPending.getTime()) / 1000))
        : null,
    });
  }
  return out;
}

// ─── Per-item page (C2a) ────────────────────────────────────────────────────

export interface QueueHealthJobRow {
  id: number;
  queue: string;
  status: RawJobStatus;
  displayStatus: DisplayStatus;
  skipReason: SanitizedSkipReason | null;
  attempts: number;
  effectiveMaxAttempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueHealthJobsPage {
  rows: QueueHealthJobRow[];
  total: number;
  page: number;
  limit: number;
  validStatuses: readonly string[];
  validDisplayStatuses: readonly string[];
}

/**
 * The paginated per-item half of the two-altitude contract.
 *
 * Bounded on purpose: the aggregate endpoint is polled continuously and must
 * never carry a 50,000-row backlog, so per-item detail lives here behind a
 * `limit` capped at 100. It returns **all four** raw statuses, not just
 * failures — restricting it to failures would leave `pending` and `processing`
 * items with no per-item state at all, which is the contract violation this
 * endpoint exists to avoid.
 */
export async function queueHealthJobs(
  opts: { queue?: string; status?: string; page?: number; limit?: number },
  dbInstance: Pick<typeof defaultDb, "select"> = defaultDb,
): Promise<QueueHealthJobsPage> {
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 50) || 50));
  const offset = (page - 1) * limit;

  const filters = [];
  if (opts.queue) filters.push(eq(asyncJobsTable.queue, opts.queue));
  if (opts.status && (RAW_JOB_STATUSES as readonly string[]).includes(opts.status)) {
    filters.push(eq(asyncJobsTable.status, opts.status as RawJobStatus));
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [rows, totals] = await Promise.all([
    dbInstance
      .select({
        id: asyncJobsTable.id,
        queue: asyncJobsTable.queue,
        status: asyncJobsTable.status,
        result: asyncJobsTable.result,
        attempts: asyncJobsTable.attempts,
        maxAttempts: asyncJobsTable.maxAttempts,
        lastError: asyncJobsTable.lastError,
        nextAttemptAt: asyncJobsTable.nextAttemptAt,
        createdAt: asyncJobsTable.createdAt,
        updatedAt: asyncJobsTable.updatedAt,
      })
      .from(asyncJobsTable)
      .where(where)
      // Active work (pending/processing) sorts ahead of terminal rows, THEN by
      // recency within each group. Without this, a queue with heavy terminal
      // volume can crowd every pending/processing row out of a bounded page —
      // the aggregate would report queued work while the drill-down shows
      // none of it, since both are the exact same work at different altitudes.
      .orderBy(sql`
        case when ${asyncJobsTable.status} in ('pending', 'processing') then 0 else 1 end,
        ${asyncJobsTable.updatedAt} desc,
        ${asyncJobsTable.id} desc
      `)
      .limit(limit)
      .offset(offset),
    dbInstance.select({ total: sql<number>`count(*)::int` }).from(asyncJobsTable).where(where),
  ]);

  // One config read per distinct queue in the page, not per row.
  const distinctQueues = [...new Set(rows.map((r) => r.queue))];
  const maxByQueue = new Map<string, number>();
  for (const q of distinctQueues) {
    maxByQueue.set(q, await effectiveMaxAttempts(q, 0));
  }

  return {
    rows: rows.map((r) => {
      const effectiveMax = r.maxAttempts > 0 ? r.maxAttempts : (maxByQueue.get(r.queue) ?? 5);
      const { displayStatus, skipReason } = deriveDisplayStatus(
        { status: r.status, result: r.result, attempts: r.attempts, maxAttempts: r.maxAttempts },
        effectiveMax,
      );
      return {
        id: r.id,
        queue: r.queue,
        status: r.status as RawJobStatus,
        displayStatus,
        skipReason,
        attempts: r.attempts,
        effectiveMaxAttempts: effectiveMax,
        // Truncated: this is an admin surface, and a provider stack trace in a
        // JSON response is both noise and a needless disclosure surface.
        lastError: r.lastError ? r.lastError.slice(0, 500) : null,
        nextAttemptAt: r.nextAttemptAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }),
    total: totals[0]?.total ?? 0,
    page,
    limit,
    validStatuses: RAW_JOB_STATUSES,
    validDisplayStatuses: DISPLAY_STATUSES,
  };
}

/** Whether a queue name is one this process has a handler registered for. */
export function isKnownQueue(queue: string): boolean {
  return registeredQueues().includes(queue);
}
