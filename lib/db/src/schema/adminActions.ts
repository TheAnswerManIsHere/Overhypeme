import { sql } from "drizzle-orm";
import { pgTable, serial, integer, varchar, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";
import { pendingReviewsTable } from "./reviews";

/**
 * One row per admin action on a fact or a review (plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md 1I and 3C): who, what, when, and enough detail
 * to read what changed. Phase 3's History tab reads it, newest first. A triage
 * action happens before a fact exists, so a row carries the review until a fact
 * does; History joins a fact's rows with its reviews'. Rows are never updated or
 * deleted by the app; a deleted fact, review or user leaves the row with that
 * reference nulled. The vocabulary of `action` is ADMIN_ACTION_VALUES
 * (@workspace/api-zod); the writer is recordAdminAction (api-server
 * lib/adminActions.ts).
 */
export const adminActionsTable = pgTable("admin_actions", {
  id: serial("id").primaryKey(),
  factId: integer("fact_id").references(() => factsTable.id, { onDelete: "set null" }),
  reviewId: integer("review_id").references(() => pendingReviewsTable.id, { onDelete: "set null" }),
  actorId: varchar("actor_id").references(() => usersTable.id, { onDelete: "set null" }),
  action: varchar("action", { length: 48 }).notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("admin_actions_fact_idx").on(table.factId, table.createdAt),
  index("admin_actions_review_idx").on(table.reviewId),
]);

export type AdminActionRow = typeof adminActionsTable.$inferSelect;
