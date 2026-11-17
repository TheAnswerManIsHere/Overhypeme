import { pgTable, varchar, integer, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Shared async-jobs queue (Phase 2A).
 *
 * Generalization of the original `email_outbox`: a single durable queue that
 * any feature can enqueue work into. Each row carries a `queue` discriminator
 * (e.g. "email", "enrichment", "preview") + a free-form `payload` jsonb, and
 * the polling worker dispatches by `queue` to a registered handler. The
 * `external_id` column is reserved for queues that submit to an external
 * service and poll for completion (e.g. a future "fal_video" queue).
 *
 * Renamed from `email_outbox` in migration 0063 with a backfill that moves
 * the email-specific columns (to/subject/text/html/kind) into `payload`.
 */
export const asyncJobsTable = pgTable(
  "async_jobs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    queue: varchar("queue", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    externalId: varchar("external_id", { length: 255 }),
    result: jsonb("result"),
    dedupeKey: varchar("dedupe_key", { length: 255 }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    // 0 = no per-job override; use async_job_<queue>_max_attempts.
    maxAttempts: integer("max_attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    // Lease (Issue #1000, migration 0148). Stamped at claim; renewed while the
    // holder lives; every finish and fenced effect presents lease_token.
    claimOwner: varchar("claim_owner", { length: 64 }),
    leaseToken: varchar("lease_token", { length: 64 }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Recovery protocol the claiming handler declared for its queue (null: none).
    claimRecoveryProtocol: integer("claim_recovery_protocol"),
    // Non-null only once the row has been taken back from a stopped holder of a
    // recovery-declaring queue: the minimum protocol a claimer must declare.
    // Sticky until the job finishes.
    recoveryProtocol: integer("recovery_protocol"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("async_jobs_pending_idx").on(t.queue, t.nextAttemptAt).where(sql`status = 'pending'`),
    index("async_jobs_status_created_idx").on(t.queue, t.status, t.createdAt.desc()),
    // Dedupe: at most one non-terminal job per (queue, dedupe_key).
    uniqueIndex("async_jobs_dedupe_idx")
      .on(t.queue, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND status IN ('pending', 'processing', 'recovering')`),
    index("async_jobs_recovering_idx").on(t.queue, t.nextAttemptAt).where(sql`status = 'recovering'`),
    index("async_jobs_lease_idx").on(t.leaseExpiresAt).where(sql`status = 'processing'`),
  ],
);

export type AsyncJobRow = typeof asyncJobsTable.$inferSelect;
export type InsertAsyncJobRow = typeof asyncJobsTable.$inferInsert;

/**
 * Status lifecycle:
 *   pending    → ready to be claimed by the next worker tick (nextAttemptAt due)
 *   recovering → taken back from a stopped holder; claimable only by a handler
 *                declaring at least `recovery_protocol` for its queue. Stays
 *                recovering through retry, deferral and reclaim until it finishes.
 *   processing → held by a worker under a lease (reclaimed once the lease lapses)
 *   done       → handler returned ok (terminal; eligible for retention purge)
 *   failed     → handler exhausted maxAttempts retries (terminal)
 */
export type AsyncJobStatus = "pending" | "recovering" | "processing" | "done" | "failed";

/** Statuses that are still in flight: dedupe, polling and "is it running" all read these. */
export const IN_FLIGHT_JOB_STATUSES = ["pending", "recovering", "processing"] as const satisfies readonly AsyncJobStatus[];
