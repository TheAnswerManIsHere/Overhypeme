import { sql } from "drizzle-orm";
import {
  pgTable, bigserial, integer, smallint, varchar, jsonb, boolean, timestamp, bigint, index, uniqueIndex, check, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { factsTable } from "./facts";
import { usersTable } from "./auth";
import { pendingReviewsTable } from "./reviews";
import { imagePromptAttemptsTable } from "./imagePromptAttempts";

/**
 * A fact's gags (migration 0139, plan docs/plans/PLAN_THREE_GAGS.md, approved
 * by David 2026-11-14). A gag is one way of making a fact's joke visible, with
 * its whole visual setup: the content is a complete visual-strategy override
 * object (`VisualPromptStrategyOverride` from @workspace/api-zod). A fact has
 * one to three, in slots 1–3, and every slot follows the same rules.
 *
 * This table is the ONLY home of a gag's content. `facts.enrichment` and the
 * refresh candidate rows no longer carry one; the render input is assembled
 * from a fact's classification and one gag version at the moment a render is
 * built (artifacts/api-server/src/lib/gags/resolver.ts).
 *
 * Two versions per gag:
 *   - approved: what users get, with the test render a moderator approved as
 *     its example. Only migration 0139 may write an approved version with no
 *     example (`approved_carried_over`, live facts that predate examples).
 *   - pending: content saved and not yet approved. Inside a refresh review it
 *     also carries that review's example pick or removal, which apply only
 *     when the refresh is promoted (`pending_review_id` names the review).
 *
 * The rule "a live fact has at least one non-removed gag with an approved
 * version" spans two tables, so it is a deferred constraint trigger
 * (`enforce_live_fact_has_approved_gag`), declared in the migration only.
 */
export const factGagsTable = pgTable("fact_gags", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  /** 1, 2 or 3. The available gag in the lowest slot is the default gag. */
  slot: smallint("slot").notNull(),

  /** The approved version's content; null until first approved. */
  approvedContent: jsonb("approved_content"),
  /** The test render approved as this gag's example. */
  approvedExampleAttemptId: bigint("approved_example_attempt_id", { mode: "number" })
    .references((): AnyPgColumn => imagePromptAttemptsTable.id),
  /** Set only by migration 0139: an approved version carried over with no example on record. */
  approvedCarriedOver: boolean("approved_carried_over").notNull().default(false),
  approvedBy: varchar("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),

  /** A saved change not yet approved; null when there is none. */
  pendingContent: jsonb("pending_content"),
  /** The refresh review that owns the pending operations below; null outside a refresh. */
  pendingReviewId: integer("pending_review_id").references(() => pendingReviewsTable.id, { onDelete: "set null" }),
  /** Inside a refresh: the render picked as the pending content's example, applied at promotion. */
  pendingExampleAttemptId: bigint("pending_example_attempt_id", { mode: "number" })
    .references((): AnyPgColumn => imagePromptAttemptsTable.id),
  /** Inside a refresh: removal requested, applied at promotion. */
  pendingRemove: boolean("pending_remove").notNull().default(false),
  pendingBy: varchar("pending_by").references(() => usersTable.id, { onDelete: "set null" }),
  pendingAt: timestamp("pending_at", { withTimezone: true }),

  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedBy: varchar("removed_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdBy: varchar("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_fact_gags_fact_id").on(t.factId),
  // At most one non-removed gag per fact and slot: with slots 1–3, a fourth cannot be stored.
  uniqueIndex("UQ_fact_gags_fact_slot_live").on(t.factId, t.slot).where(sql`${t.removedAt} IS NULL`),
  check("fact_gags_slot_range", sql`${t.slot} BETWEEN 1 AND 3`),
  check(
    "fact_gags_has_a_version",
    sql`${t.removedAt} IS NOT NULL OR ${t.approvedContent} IS NOT NULL OR ${t.pendingContent} IS NOT NULL`,
  ),
  check(
    "fact_gags_approved_has_example",
    sql`${t.approvedContent} IS NULL OR ${t.approvedExampleAttemptId} IS NOT NULL OR ${t.approvedCarriedOver}`,
  ),
  check(
    "fact_gags_approved_scene_nonempty",
    sql`${t.approvedContent} IS NULL OR COALESCE(jsonb_typeof(${t.approvedContent} -> 'coreSceneOverride') = 'string' AND (${t.approvedContent} ->> 'coreSceneOverride') ~ '\\S', false)`,
  ),
  check(
    "fact_gags_pending_scene_nonempty",
    sql`${t.pendingContent} IS NULL OR COALESCE(jsonb_typeof(${t.pendingContent} -> 'coreSceneOverride') = 'string' AND (${t.pendingContent} ->> 'coreSceneOverride') ~ '\\S', false)`,
  ),
  check(
    "fact_gags_pending_ops_owned",
    sql`(${t.pendingExampleAttemptId} IS NULL AND NOT ${t.pendingRemove}) OR ${t.pendingReviewId} IS NOT NULL`,
  ),
  check(
    "fact_gags_pending_example_has_content",
    sql`${t.pendingExampleAttemptId} IS NULL OR ${t.pendingContent} IS NOT NULL`,
  ),
]);

export type FactGag = typeof factGagsTable.$inferSelect;
export type InsertFactGag = typeof factGagsTable.$inferInsert;
