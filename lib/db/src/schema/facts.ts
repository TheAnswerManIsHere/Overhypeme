import { sql } from "drizzle-orm";
import { pgTable, text, serial, timestamp, varchar, integer, doublePrecision, customType, index, boolean, jsonb, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";

const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    if (typeof value === "string") {
      return value.replace(/^\[|\]$/g, "").split(",").map(Number);
    }
    return value as unknown as number[];
  },
});

export const factsTable = pgTable("facts", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  submittedById: varchar("submitted_by_id").references(() => usersTable.id),
  /** When the submitter's account was purged and `submitted_by_id` nulled (launch Phase 5, 0117): "a former member", not "no submitter". */
  submitterDeletedAt: timestamp("submitter_deleted_at", { withTimezone: true }),
  upvotes: integer("upvotes").notNull().default(0),
  downvotes: integer("downvotes").notNull().default(0),
  score: integer("score").notNull().default(0),
  wilsonScore: doublePrecision("wilson_score").notNull().default(0),
  commentCount: integer("comment_count").notNull().default(0),
  shareCount: integer("share_count").notNull().default(0),
  hasPronouns: boolean("has_pronouns").notNull().default(false),
  // Facts are born INACTIVE (Phase 2 fact-lifecycle closure): the only transition
  // to active is the moderation activation chokepoint (activateFact, reached only
  // via approveForProduction after the full pipeline + an approved gag). A
  // deferred constraint trigger (enforce_live_fact_has_approved_gag, migration
  // 0139) enforces it even against raw SQL: a fact may be active only while it
  // has a non-removed gag with an approved version in fact_gags.
  isActive: boolean("is_active").notNull().default(false),
  /**
   * Whether this fact was ever approved for production, separate from
   * `is_active` (false for a staging fact and a deactivated fact alike). Set
   * once, at "Approve for production" (activateFact), and never cleared by a
   * deactivation; the Facts list and Reactivate read it (plan
   * PLAN_FACT_LIFECYCLE_REBUILD.md, Source-of-Truth Analysis). `approval_source`
   * is 'moderator' for an approval a person recorded, 'legacy' for one migration
   * 0152 established from older evidence, which records no approver.
   */
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedById: varchar("approved_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  approvalSource: varchar("approval_source", { length: 16 }).$type<"moderator" | "legacy">(),
  /** Who may see this once adult content exists (launch Phase 5, 0121): 'general' | 'adult'. Read by nothing yet. */
  audience: varchar("audience", { length: 10 }).notNull().default("general"),
  canonicalText: text("canonical_text"),
  /**
   * Token-boundary index where the rendered fact splits into top/bottom captions.
   * Nullable until a separate session adds the gpt-4o-mini population step at fact creation;
   * renderer falls back to the legacy midpoint heuristic when null.
   */
  splitTokenIndex: integer("split_token_index"),
  /**
   * Candidate Visual concepts (Slice 2A). The frontier planner auto-drafts 3
   * distinct "describe the picture" scenes during prep; the moderator picks /
   * edits / ignores one into `enrichment.visualPromptStrategyOverride.
   * coreSceneOverride`. TRANSIENT, latest-only prep metadata (regenerate
   * overwrites) — NOT provenance, a promoted artifact, or rollback history. The
   * blob (VisualConceptCandidatesBlob from @workspace/api-zod) carries the 3
   * candidates + per-candidate token validity + provenance + reviewId /
   * candidateVersionId / source / inputHash so the server can decide whether the
   * candidates are still CURRENT for the review. Null on facts that never ran
   * concept gen.
   */
  visualConceptCandidates: jsonb("visual_concept_candidates"),
  /**
   * Candidate Visual concept lifecycle for the moderation prep UI:
   * "pending" | "ok" | "failed". Set "pending" when the concept job is enqueued,
   * "ok" when candidates land, "failed" only after the queue abandons — so it
   * stays distinct from "still running". Null on facts that never ran concept
   * gen through the queue. Mirrors `enrichment_status`.
   */
  visualConceptStatus: varchar("visual_concept_status", { length: 16 }),
  /**
   * Which generation owns the candidate gags and their status (migration
   * 0140, plan PLAN_THREE_GAGS.md increment 2): 'review:<id>' for a review
   * cycle, 'live:<id>' for a Draft more gags request on a live fact. A
   * generation writes only while it holds this; opening a review takes it.
   * Null on facts no generation has claimed since the column was added, which
   * a review cycle's generation may write.
   */
  visualConceptOwner: varchar("visual_concept_owner", { length: 64 }),
  /**
   * The approved humor note (migration 0137, plan PLAN_GAG_GENERATOR.md): why
   * this fact is funny and what a picture must preserve, in plain prose that
   * names the subject "Alex". Written only by a moderator: approving the
   * reading's draft at the Reading step (edited or not), or correcting it on
   * the Gags step. The reading job writes only its draft, on its own run row
   * (fact_readings). Read by the gag writer on every later generation. Never
   * shown to end users. Null until a moderator approves one.
   */
  humorNote: text("humor_note"),
  /**
   * The reading run the approved note was written from (migration 0155): the
   * research shown beside the note is this run's, never a later re-run's
   * (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1B). Null for a note approved before
   * readings existed. No foreign key in drizzle's declaration to avoid an
   * import cycle; the migration declares it (ON DELETE SET NULL).
   */
  humorNoteReadingId: integer("humor_note_reading_id"),
  /** Who approved the humor note; null when the account is deleted. */
  humorNoteApprovedBy: varchar("humor_note_approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  humorNoteApprovedAt: timestamp("humor_note_approved_at", { withTimezone: true }),
  /** LLM-generated scene prompts for AI meme backgrounds (3 gender variants). */
  aiScenePrompts: jsonb("ai_scene_prompts"),
  /** Object storage paths for generated AI meme background images (9 total: 3 genders × 3 each). */
  aiMemeImages: jsonb("ai_meme_images"),
  /**
   * AI-meme backfill lifecycle for the durable `fact_ai_meme_backfill` queue:
   * "pending" | "processing" | "ok" | "failed" | "skipped". Mirrors
   * `enrichment_status`'s lifecycle, with two extra values this queue's crash-recovery
   * design needs: "processing" (set immediately before the paid pipeline call,
   * so a worker crash mid-run is distinguishable from a queued-but-not-started
   * job) and "skipped" (a terminal, non-error outcome — the fact was
   * deactivated before its handler ran). Null on facts that never ran AI-meme
   * generation through this queue (legacy rows; live-fact generation via
   * `memes.ts`/`pulidJobs.ts`, which don't use this queue).
   */
  aiMemeBackfillStatus: varchar("ai_meme_backfill_status", { length: 16 }),
  /**
   * The fact's stored AI taxonomy (FactEnrichment from @workspace/api-zod): the
   * latest stored run's output, read-only (plan PLAN_FACT_LIFECYCLE_REBUILD.md,
   * item 16). Every run is also kept in fact_taxonomy_runs. Nullable until a
   * run succeeds. (The four projection columns of this blob were dropped by
   * migration 0160.)
   */
  enrichment: jsonb("enrichment"),
  /**
   * The classifier's own output for the latest stored run. Since manual
   * overrides were removed (2.1a; columns dropped by 0160) it is written equal to
   * `enrichment`; it is still read as the prior character list for the next run.
   * Nullable: legacy/never-enriched rows.
   */
  enrichmentAiDerived: jsonb("enrichment_ai_derived"),
  /**
   * Classification lifecycle for the admin Facts editor: "pending" | "ok" | "failed".
   * Tracks the re-run-classification job only. Null on facts that were never
   * (re)classified in-place. Mirrors `pending_reviews.enrichment_status`.
   */
  enrichmentStatus: varchar("enrichment_status", { length: 16 }),
  /**
   * Eval harness (Slice 2B): part of the GOLDEN SET — a curated set of stable
   * active facts rendered by every eval run for regression comparison. Toggled
   * by admins on active facts only. `eval_golden_reason` records why it's a
   * good regression case.
   */
  evalGolden: boolean("eval_golden").notNull().default(false),
  evalGoldenReason: text("eval_golden_reason"),
  embedding: vector("embedding", { dimensions: 384 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("facts_wilson_score_idx").on(table.wilsonScore.desc()),
  check("facts_audience_check", sql`${table.audience} IN ('general','adult')`),
  check(
    "facts_approval_recorded_whole",
    // Equalities, not IN (...): PostgreSQL stores an IN list differently depending
    // on how the table was built, which the structure proof would read as drift.
    sql`(${table.approvalSource} IS NULL) = (${table.approvedAt} IS NULL) AND (${table.approvalSource} IS NULL OR ${table.approvalSource} = 'moderator' OR ${table.approvalSource} = 'legacy')`,
  ),
  // The partial `IDX_facts_eval_golden` (WHERE eval_golden) is migration-only —
  // drizzle-kit's partial-index detection is brittle (see imagePromptAttempts.ts).
  // The rule that a live fact has an approved gag spans facts and fact_gags, so
  // it is a deferred constraint trigger declared in migration 0139 only; it
  // replaced the facts_active_requires_concept CHECK, which read the gag from
  // the enrichment blob before gags moved to their own table.
  // One home for a gag (migration 0139): neither enrichment layer may carry one.
  check(
    "facts_enrichment_holds_no_gag",
    sql`NOT coalesce(${table.enrichment} ? 'visualPromptStrategyOverride', false) AND NOT coalesce(${table.enrichmentAiDerived} ? 'visualPromptStrategyOverride', false)`,
  ),
]);

export const insertFactSchema = createInsertSchema(factsTable).omit({ id: true, upvotes: true, downvotes: true, score: true, wilsonScore: true, commentCount: true, shareCount: true, createdAt: true, updatedAt: true });
export type InsertFact = z.infer<typeof insertFactSchema>;
export type Fact = typeof factsTable.$inferSelect;
