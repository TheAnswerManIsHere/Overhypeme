import { pgTable, bigserial, text, varchar, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Stored files still to delete (migration 0173; plan PLAN_RENDER_HISTORY.md D6
 * and D7). Written in the same transaction as the database delete that leaves
 * a file unreferenced, so the row and the obligation to remove its file commit
 * together; removed after the commit, at once and then by the hourly sweep
 * (api-server lib/storedFileDeletions.ts). One open row per path.
 */
export const storedFileDeletionsTable = pgTable("stored_file_deletions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** An object path as the store names it, e.g. `/objects/ai-bg-v2/5/9-1.png`. */
  path: text("path").notNull(),
  /** Why it is to go, e.g. `rejected_submission_purge`. */
  reason: varchar("reason", { length: 48 }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  /** Set once the file is gone (or was already missing). */
  doneAt: timestamp("done_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("UQ_stored_file_deletions_open_path").on(t.path).where(sql`done_at IS NULL`),
  index("IDX_stored_file_deletions_outstanding").on(t.createdAt).where(sql`done_at IS NULL`),
]);

export type StoredFileDeletion = typeof storedFileDeletionsTable.$inferSelect;
