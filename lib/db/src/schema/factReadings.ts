import { pgTable, serial, integer, varchar, jsonb, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";
import { pendingReviewsTable } from "./reviews";

/**
 * One row per reading run on a fact (migration 0155; plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md, 1B): reference research from the fact, with
 * web lookup, then a draft humor note written from that research. Every run is
 * kept: a later run adds a row and never replaces the one an approved note was
 * written from (`facts.humor_note_reading_id`).
 *
 * `status`: "pending" (queued or running), "ok" (research and draft stored;
 * an empty reference list is a result), "failed" (the queue gave up; the
 * Reading step offers "Try again"). Written by the `fact_reading` job
 * (api-server lib/readingJobs.ts) and its enqueuer only.
 */
export const factReadingsTable = pgTable("fact_readings", {
  id: serial("id").primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  /** The review the run was made for; null for a run on a live fact. */
  reviewId: integer("review_id").references(() => pendingReviewsTable.id, { onDelete: "set null" }),
  status: varchar("status", { length: 16 }).notNull().$type<"pending" | "ok" | "failed">(),
  /** FactReadingResearch (@workspace/api-zod): the references found, each with its meaning, picture implication and sources. */
  research: jsonb("research"),
  /** The draft humor note written from the research. */
  draftNote: text("draft_note"),
  /** Why the run failed, for the moderator ("Try again"). */
  error: text("error"),
  /** Model, prompt version and timing of the run. */
  provenance: jsonb("provenance"),
  requestedBy: varchar("requested_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("fact_readings_fact_idx").on(table.factId, table.createdAt),
]);

export type FactReadingRow = typeof factReadingsTable.$inferSelect;
