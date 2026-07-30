/**
 * Worker liveness telemetry: the write side of `worker_lane_heartbeats`.
 *
 * Phase 1 of the async-queue hardening plan. Nothing in the system records
 * whether the async-jobs worker is still ticking, so a dead lane is invisible
 * until someone notices work has stopped. This module is that record.
 *
 * It is deliberately small and deliberately separate from `asyncJobs.ts`: it
 * stores no job state, reads no payloads, and every function here is
 * best-effort. A failed heartbeat write must never fail a tick or a handler —
 * telemetry that can take down the thing it observes is worse than no
 * telemetry.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "@workspace/db";
import { workerLaneHeartbeatsTable } from "@workspace/db/schema";
import { getConfigInt } from "./adminConfig";
import { logger } from "./logger";

/**
 * This process's identity, minted **once at module load** and held for the life
 * of the process.
 *
 * It must be per-*process*, not per-deployment. Every alternative available in
 * this environment — `REPLIT_DEPLOYMENT_ID`, `REPLIT_GIT_COMMIT_SHA`, the
 * hostname — is shared by every instance of a deployment, and using one would
 * collapse the whole autoscaled fleet onto a single row per lane. That is
 * precisely the defect the `(instance_id, lane)` primary key exists to prevent:
 * N instances overwriting each other's writes, so a wedged worker hides behind
 * a healthy peer's heartbeat.
 *
 * A restart mints a new id. That is correct rather than unfortunate — a
 * restarted process *is* a different worker, its predecessor's rows stop
 * advancing, and the TTL prune removes them. It is never persisted, because
 * persisting it would let a crashed process's identity be reused by its
 * replacement and mask exactly the gap recovery needs to see.
 */
export const WORKER_INSTANCE_ID: string = randomUUID();

/**
 * A **capability** marker for the queue protocol this worker speaks — not a
 * release identifier.
 *
 * `1` = claims and processes jobs, finalizing on row id alone.
 * `2` (Phase 3a) = honors a lease fence on every finalize.
 *
 * Bumped **by hand** only when the protocol changes. Deriving it from a release
 * identifier would be wrong in both directions: every deploy changes the
 * release, so an equality check would classify fence-capable workers as stale
 * and refuse a Phase 3b enable forever, while an inequality check would admit
 * an unfenced worker as readily as a fenced one. The only question that matters
 * is *does this worker honor the fence*, which is a property of the code, not of
 * when it shipped — two different releases of the same phase must compare equal.
 */
export const WORKER_PROTOCOL_VERSION = 1;

const DEFAULT_HEARTBEAT_TTL_MINUTES = 15;

type HeartbeatDb = Pick<typeof defaultDb, "insert" | "update" | "delete" | "execute">;

/**
 * Every write here is wrapped: telemetry must not be able to fail a tick.
 * Failures log at warn, once per occurrence, and are otherwise swallowed.
 */
async function bestEffort(what: string, lane: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn({ err, lane, instanceId: WORKER_INSTANCE_ID }, `[workerHeartbeats] ${what} failed`);
  }
}

/**
 * Stamp `last_scheduled_at` — called when the lane's timer **fires**, before any
 * work, and **including on the re-entrancy early-return**.
 *
 * That last part is the whole point: this column is pure *scheduler* liveness.
 * If it were only written on ticks that actually ran, a lane whose every tick
 * is skipped because the previous one is still running would look dead, when in
 * fact its timer is healthy and its handler is slow. Those need different
 * remediation, so they need different signals.
 */
export async function stampLaneScheduled(
  lane: string,
  dbInstance: HeartbeatDb = defaultDb,
): Promise<void> {
  const now = new Date();
  await bestEffort("stampLaneScheduled", lane, () =>
    dbInstance
      .insert(workerLaneHeartbeatsTable)
      .values({
        instanceId: WORKER_INSTANCE_ID,
        lane,
        workerProtocolVersion: WORKER_PROTOCOL_VERSION,
        lastScheduledAt: now,
      })
      .onConflictDoUpdate({
        target: [workerLaneHeartbeatsTable.instanceId, workerLaneHeartbeatsTable.lane],
        set: {
          // GREATEST, not a plain overwrite — same idiom as decrementInFlight's
          // floor below. This fires on EVERY timer tick unawaited, including
          // while a previous tick's own stamp call is still in flight (the
          // re-entrancy guard only gates `body()`, not this write), so two
          // calls for the same (instance, lane) can commit out of order under
          // pool contention. An unconditional SET would let the OLDER call's
          // commit, landing second, move this column backward — which, if it
          // crosses the 60s stale threshold, misreports an actively-scheduled
          // lane as stalled. GREATEST makes the write commutative: whichever
          // commits last, the stored value can only advance.
          lastScheduledAt: sql`GREATEST(${workerLaneHeartbeatsTable.lastScheduledAt}, ${now})`,
          workerProtocolVersion: WORKER_PROTOCOL_VERSION,
          updatedAt: now,
        },
      }),
  );
}

/**
 * Publish the in-flight count **as soon as the claim transaction commits, before
 * any handler is awaited**.
 *
 * The write moment is load-bearing, not incidental. A wedged tick never reaches
 * completion, so a completion-only write would leave this column at its previous
 * value — normally zero — and the `worker_lane_wedged` condition requires
 * `in_flight_count > 0`. Published only at completion, the wedge alert could
 * never fire in the one case it exists for.
 */
export async function publishInFlight(
  lane: string,
  count: number,
  dbInstance: HeartbeatDb = defaultDb,
): Promise<void> {
  await bestEffort("publishInFlight", lane, () =>
    dbInstance
      .insert(workerLaneHeartbeatsTable)
      .values({
        instanceId: WORKER_INSTANCE_ID,
        lane,
        workerProtocolVersion: WORKER_PROTOCOL_VERSION,
        inFlightCount: count,
      })
      .onConflictDoUpdate({
        target: [workerLaneHeartbeatsTable.instanceId, workerLaneHeartbeatsTable.lane],
        set: { inFlightCount: count, updatedAt: new Date() },
      }),
  );
}

/**
 * Decrement as each job leaves the in-flight set.
 *
 * `GREATEST(… - 1, 0)` rather than a plain decrement: a crash between publish
 * and decrement, or a row pruned mid-tick and re-inserted at 0, must not be able
 * to drive this negative and make the wedge predicate nonsense.
 */
export async function decrementInFlight(
  lane: string,
  dbInstance: HeartbeatDb = defaultDb,
): Promise<void> {
  await bestEffort("decrementInFlight", lane, () =>
    dbInstance
      .update(workerLaneHeartbeatsTable)
      .set({
        inFlightCount: sql`GREATEST(${workerLaneHeartbeatsTable.inFlightCount} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(
        sql`${workerLaneHeartbeatsTable.instanceId} = ${WORKER_INSTANCE_ID} AND ${workerLaneHeartbeatsTable.lane} = ${lane}`,
      ),
  );
}

/**
 * Stamp `last_tick_completed_at` and clear the in-flight count — the tick
 * finished, so by definition nothing it claimed is still running.
 *
 * Clearing rather than trusting the decrements is deliberate: it makes the
 * count self-correcting once per tick, so a lost decrement (a crashed handler, a
 * swallowed write) cannot leave a healthy lane looking permanently wedged.
 */
export async function stampTickCompleted(
  lane: string,
  dbInstance: HeartbeatDb = defaultDb,
): Promise<void> {
  await bestEffort("stampTickCompleted", lane, () =>
    dbInstance
      .insert(workerLaneHeartbeatsTable)
      .values({
        instanceId: WORKER_INSTANCE_ID,
        lane,
        workerProtocolVersion: WORKER_PROTOCOL_VERSION,
        lastTickCompletedAt: new Date(),
        inFlightCount: 0,
      })
      .onConflictDoUpdate({
        target: [workerLaneHeartbeatsTable.instanceId, workerLaneHeartbeatsTable.lane],
        set: { lastTickCompletedAt: new Date(), inFlightCount: 0, updatedAt: new Date() },
      }),
  );
}

/** Resolve the departed-instance TTL, clamped so a bad config value cannot disable pruning. */
export async function heartbeatTtlMinutes(): Promise<number> {
  const raw = await getConfigInt("instance_heartbeat_ttl_minutes", DEFAULT_HEARTBEAT_TTL_MINUTES);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_HEARTBEAT_TTL_MINUTES;
  return Math.min(raw, 1440);
}

/**
 * Delete rows whose instance has not written a heartbeat within the TTL.
 *
 * Without this, every autoscale scale-down leaves a row that never advances
 * again, and a lane would read as permanently stalled from the moment the fleet
 * first shrank — the health surface would be wrong within hours of shipping, and
 * wrong in the direction that trains an operator to ignore it.
 *
 * Returns the number of rows removed, for the caller to log.
 */
export async function pruneDepartedInstances(
  dbInstance: HeartbeatDb = defaultDb,
  ttlMinutes?: number,
): Promise<number> {
  const ttl = ttlMinutes ?? (await heartbeatTtlMinutes());
  const cutoff = new Date(Date.now() - ttl * 60_000);
  try {
    const removed = await dbInstance
      .delete(workerLaneHeartbeatsTable)
      .where(sql`${workerLaneHeartbeatsTable.lastScheduledAt} < ${cutoff}`)
      .returning({ instanceId: workerLaneHeartbeatsTable.instanceId });
    return removed.length;
  } catch (err) {
    logger.warn({ err }, "[workerHeartbeats] pruneDepartedInstances failed");
    return 0;
  }
}
