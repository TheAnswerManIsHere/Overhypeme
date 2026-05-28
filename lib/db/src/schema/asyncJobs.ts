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
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("async_jobs_pending_idx").on(t.queue, t.nextAttemptAt).where(sql`status = 'pending'`),
    index("async_jobs_status_created_idx").on(t.queue, t.status, t.createdAt.desc()),
    // Dedupe: at most one non-terminal job per (queue, dedupe_key).
    uniqueIndex("async_jobs_dedupe_idx")
      .on(t.queue, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND status IN ('pending', 'processing')`),
  ],
);

export type AsyncJobRow = typeof asyncJobsTable.$inferSelect;
export type InsertAsyncJobRow = typeof asyncJobsTable.$inferInsert;

/**
 * Status lifecycle:
 *   pending  → ready to be claimed by the next worker tick (nextAttemptAt due)
 *   processing → currently being executed by a worker (stuck-row recovery on boot)
 *   done       → handler returned ok (terminal; eligible for retention purge)
 *   failed     → handler exhausted maxAttempts retries (terminal)
 */
export type AsyncJobStatus = "pending" | "processing" | "done" | "failed";
