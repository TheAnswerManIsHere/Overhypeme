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
 *   - approved: what users get, with three approved examples, one per subject
 *     kind (male, female, pet), in `fact_gag_examples` (migration 0143, plan
 *     docs/plans/PLAN_GAG_EXAMPLES.md). A gag approved before example sets is
 *     grandfathered (`approved_before_example_sets`) and stays offered with
 *     fewer (David, 2026-11-15, Q11).
 *   - pending: content saved and not yet approved, with its example picks as
 *     pending rows in `fact_gag_examples`. Inside a refresh review it also
 *     carries that review's removal; picks and removals apply only when the
 *     refresh is promoted (`pending_review_id` names the review).
 *
 * `approved_example_attempt_id` and `pending_example_attempt_id` are recovery
 * snapshots of the selections 0143 copied: nothing reads or writes them, and a
 * later migration drops them.
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
  /** Recovery snapshot only (migration 0143): neither read nor written. */
  approvedExampleAttemptId: bigint("approved_example_attempt_id", { mode: "number" })
    .references((): AnyPgColumn => imagePromptAttemptsTable.id),
  /** Set only by migration 0139: an approved version carried over with no example on record. */
  approvedCarriedOver: boolean("approved_carried_over").notNull().default(false),
  /**
   * Approved before example sets (migration 0143): offered with fewer than
   * three approved examples until it first completes a set (Q11).
   */
  approvedBeforeExampleSets: boolean("approved_before_example_sets").notNull().default(false),
  approvedBy: varchar("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),

  /** A saved change not yet approved; null when there is none. */
  pendingContent: jsonb("pending_content"),
  /** The refresh review that owns the pending operations below; null outside a refresh. */
  pendingReviewId: integer("pending_review_id").references(() => pendingReviewsTable.id, { onDelete: "set null" }),
  /** Recovery snapshot only (migration 0143): neither read nor written. */
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
    "fact_gags_approved_scene_nonempty",
    sql`${t.approvedContent} IS NULL OR COALESCE(jsonb_typeof(${t.approvedContent} -> 'coreSceneOverride') = 'string' AND (${t.approvedContent} ->> 'coreSceneOverride') ~ '\\S', false)`,
  ),
  check(
    "fact_gags_pending_scene_nonempty",
    sql`${t.pendingContent} IS NULL OR COALESCE(jsonb_typeof(${t.pendingContent} -> 'coreSceneOverride') = 'string' AND (${t.pendingContent} ->> 'coreSceneOverride') ~ '\\S', false)`,
  ),
  check(
    "fact_gags_pending_ops_owned",
    sql`NOT ${t.pendingRemove} OR ${t.pendingReviewId} IS NOT NULL`,
  ),
]);

/** A subject kind a gag is shown with: one committed reference photo each. */
export const GAG_EXAMPLE_KINDS = ["male", "female", "pet"] as const;
export type GagExampleKind = (typeof GAG_EXAMPLE_KINDS)[number];

/**
 * A gag's examples (migration 0143): one moderator-approved test render per
 * subject kind, per stage. "approved" rows belong to the approved version;
 * "pending" rows are picks for the pending content. The set rule spans both
 * tables, so it is a deferred constraint trigger (`enforce_gag_example_set`),
 * declared in the migration only: approved content needs all three approved
 * kinds unless the gag is grandfathered, and a pending row needs pending
 * content.
 */
export const factGagExamplesTable = pgTable("fact_gag_examples", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  gagId: bigint("gag_id", { mode: "number" }).notNull().references(() => factGagsTable.id, { onDelete: "cascade" }),
  subjectKind: varchar("subject_kind", { length: 16 }).notNull().$type<GagExampleKind>(),
  stage: varchar("stage", { length: 16 }).notNull().$type<"approved" | "pending">(),
  attemptId: bigint("attempt_id", { mode: "number" }).notNull().references((): AnyPgColumn => imagePromptAttemptsTable.id),
  approvedBy: varchar("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("UQ_fact_gag_examples_gag_kind_stage").on(t.gagId, t.subjectKind, t.stage),
  index("IDX_fact_gag_examples_attempt").on(t.attemptId),
  // Written in the form Postgres prints after a dump and restore, so a restored
  // database compares equal to a built one (the image_provenance precedent).
  check("fact_gag_examples_kind", sql`((subject_kind)::text = ANY (ARRAY[('male'::character varying)::text, ('female'::character varying)::text, ('pet'::character varying)::text]))`),
  check("fact_gag_examples_stage", sql`((stage)::text = ANY (ARRAY[('approved'::character varying)::text, ('pending'::character varying)::text]))`),
]);

export type FactGagExample = typeof factGagExamplesTable.$inferSelect;

export type FactGag = typeof factGagsTable.$inferSelect;
export type InsertFactGag = typeof factGagsTable.$inferInsert;

/**
 * The fold's archive (migration 0147, plan docs/plans/PLAN_GAG_DIRECT_RENDER.md,
 * E): one row per gag version the fold converted, holding the content before
 * and after, so a conversion can be reversed. Append-only; `gag_id` and
 * `fact_id` are records with no foreign key (as comparison_panels.gag_id).
 */
export const factGagFoldArchiveTable = pgTable(
  "fact_gag_fold_archive",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gagId: bigint("gag_id", { mode: "number" }).notNull(),
    factId: integer("fact_id").notNull(),
    stage: varchar("stage", { length: 16 }).notNull().$type<"approved" | "pending">(),
    originalContent: jsonb("original_content").notNull(),
    foldedContent: jsonb("folded_content").notNull(),
    moved: jsonb("moved").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
  },
  (t) => [
    index("IDX_fact_gag_fold_archive_gag").on(t.gagId, t.stage),
    check("fact_gag_fold_archive_stage", sql`(${t.stage})::text = ANY ((ARRAY['approved'::character varying, 'pending'::character varying])::text[])`),
  ],
);

export type FactGagFoldArchive = typeof factGagFoldArchiveTable.$inferSelect;
