import { pgTable, varchar, integer, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

/**
 * Worker liveness telemetry, one row per **`(instance_id, lane)`**.
 *
 * Nothing in the system records whether the async-jobs worker is still ticking.
 * This table is that record — and it is keyed by instance as well as lane
 * because `.replit` sets `deploymentTarget = "autoscale"` and
 * `index.ts` starts the worker in **every** instance with no leader election.
 * One row per lane would let N instances overwrite each other's writes, so a
 * wedged worker could hide behind a healthy peer.
 *
 * It is operational telemetry, never job state: `async_jobs` remains the single
 * source of truth for queued work.
 */
export const workerLaneHeartbeatsTable = pgTable(
  "worker_lane_heartbeats",
  {
    /**
     * A **process-start UUID**, minted once at module load and held for the life
     * of the process (see `WORKER_INSTANCE_ID`).
     *
     * Deliberately NOT a release identifier: `REPLIT_DEPLOYMENT_ID`, the git
     * SHA and the hostname are all shared by every instance of a deployment, so
     * any of them would collapse the fleet onto one row per lane — exactly the
     * defect this composite key exists to prevent.
     *
     * A restart mints a new id, which is correct: a restarted process is a
     * different worker, and its predecessor's rows stop advancing and are
     * pruned by the TTL sweep.
     */
    instanceId: varchar("instance_id", { length: 64 }).notNull(),
    /** One of the five scheduling lanes: fast | render | bulk | pexels | ai_meme_backfill. */
    lane: varchar("lane", { length: 32 }).notNull(),
    /**
     * A **capability** marker, not a release identifier — see
     * `WORKER_PROTOCOL_VERSION`. Phase 1 writes 1; Phase 3a bumps it to 2,
     * meaning "this worker honors the lease fence on every finalize".
     *
     * It powers the Phase 3b block-only interlock, which can *refuse* an unsafe
     * reclaim enable but never enable one: absence proves nothing, because a
     * wedged instance stops heartbeating while remaining able to finalize.
     */
    workerProtocolVersion: integer("worker_protocol_version").notNull(),
    /**
     * Written when the lane's timer **fires**, before any work — including on
     * the `if (ticking) return` re-entrancy early-return. Pure scheduler
     * liveness, unaffected by how long a handler takes.
     */
    lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }).notNull().defaultNow(),
    /** Written when a tick finishes. A wedged tick never reaches this. */
    lastTickCompletedAt: timestamp("last_tick_completed_at", { withTimezone: true }),
    /**
     * How many jobs this instance's lane currently holds.
     *
     * Published **as soon as the claim commits, before any handler is awaited**,
     * decremented as each job leaves the in-flight set, and cleared on
     * completion or shutdown. The write moment is load-bearing rather than
     * incidental: a wedged tick never reaches completion, so a completion-only
     * write would leave this at its previous value (normally zero) and the
     * wedged-lane condition — which requires `in_flight_count > 0` — could
     * never fire in the one case it exists for.
     */
    inFlightCount: integer("in_flight_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.instanceId, t.lane] }),
    // The prune sweep and every liveness query filter on this.
    index("worker_lane_heartbeats_last_scheduled_idx").on(t.lastScheduledAt),
  ],
);

export type WorkerLaneHeartbeat = typeof workerLaneHeartbeatsTable.$inferSelect;
export type InsertWorkerLaneHeartbeat = typeof workerLaneHeartbeatsTable.$inferInsert;
