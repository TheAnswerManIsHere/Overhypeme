import { pgTable, text, serial, timestamp, varchar, integer, doublePrecision, customType, index, boolean, jsonb } from "drizzle-orm/pg-core";
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
  parentId: integer("parent_id"),
  useCase: varchar("use_case", { length: 50 }),
  upvotes: integer("upvotes").notNull().default(0),
  downvotes: integer("downvotes").notNull().default(0),
  score: integer("score").notNull().default(0),
  wilsonScore: doublePrecision("wilson_score").notNull().default(0),
  commentCount: integer("comment_count").notNull().default(0),
  shareCount: integer("share_count").notNull().default(0),
  hasPronouns: boolean("has_pronouns").notNull().default(false),
  // Facts are born INACTIVE (Phase 2 fact-lifecycle closure): the only transition
  // to active is the moderation activation chokepoint (activateFact, reached only
  // via approveForProduction after the full pipeline + a non-empty Visual Concept).
  // A DB CHECK constraint (facts_active_requires_concept) enforces the concept gate
  // even against raw SQL. Every insert that wants a live fact must say so explicitly
  // AND carry a valid concept.
  isActive: boolean("is_active").notNull().default(false),
  canonicalText: text("canonical_text"),
  /**
   * Token-boundary index where the rendered fact splits into top/bottom captions.
   * Nullable until a separate session adds the gpt-4o-mini population step at fact creation;
   * renderer falls back to the legacy midpoint heuristic when null.
   */
  splitTokenIndex: integer("split_token_index"),
  /** LLM-extracted Pexels image IDs per gender variant. Populated by factImagePipeline. */
  pexelsImages: jsonb("pexels_images"),
  /**
   * Image-prep lifecycle for the durable `fact_pexels` queue:
   * "pending" | "ok" | "failed". Set "pending" when the queue job is enqueued,
   * "ok" when photos land, "failed" only after the queue abandons (retries
   * exhausted) — so it stays distinct from "still running". Null on facts that
   * never ran image prep through the queue (legacy rows; live-fact edits that
   * fire-and-forget via runFactImagePipeline). Mirrors `enrichment_status`;
   * surfaced per-fact in the moderation prep UI.
   */
  pexelsStatus: varchar("pexels_status", { length: 16 }),
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
   * gen through the queue. Mirrors `pexels_status` / `enrichment_status`.
   */
  visualConceptStatus: varchar("visual_concept_status", { length: 16 }),
  /** LLM-generated scene prompts for AI meme backgrounds (3 gender variants). */
  aiScenePrompts: jsonb("ai_scene_prompts"),
  /** Object storage paths for generated AI meme background images (9 total: 3 genders × 3 each). */
  aiMemeImages: jsonb("ai_meme_images"),
  /**
   * AI-meme backfill lifecycle for the durable `fact_ai_meme_backfill` queue:
   * "pending" | "processing" | "ok" | "failed" | "skipped". Mirrors
   * `pexels_status` exactly, with two extra values this queue's crash-recovery
   * design needs: "processing" (set immediately before the paid pipeline call,
   * so a worker crash mid-run is distinguishable from a queued-but-not-started
   * job) and "skipped" (a terminal, non-error outcome — the fact was
   * deactivated before its handler ran). Null on facts that never ran AI-meme
   * generation through this queue (legacy rows; live-fact generation via
   * `memes.ts`/`pulidJobs.ts`, which don't use this queue).
   */
  aiMemeBackfillStatus: varchar("ai_meme_backfill_status", { length: 16 }),
  /**
   * Full visual-taxonomy enrichment blob (FactEnrichment from @workspace/api-zod).
   * Populated when a fact is approved from an enriched review, or via backfill.
   * Nullable until enriched. The four columns below are promoted, indexed
   * projections of this blob for search / related-fact surfacing.
   */
  enrichment: jsonb("enrichment"),
  /**
   * The immutable, pure AI baseline enrichment blob. `enrichment` above is the
   * MATERIALIZED EFFECTIVE blob (baseline + manual overrides + preserved visual
   * override) that runtime reads; this column preserves what the AI produced so
   * manual overrides can win, stick across re-enrich, and detect baseline drift.
   * Nullable: legacy/never-enriched rows. Backfilled = current `enrichment`.
   */
  enrichmentAiDerived: jsonb("enrichment_ai_derived"),
  /**
   * Path-keyed manual overrides: `{ "/primaryArchetype": ManualOverride, … }`
   * for the allowlisted overridable paths only. `{}` = no manual intervention.
   */
  enrichmentOverrides: jsonb("enrichment_overrides").notNull().default({}),
  /**
   * Denormalized "an active override's AI baseline has since changed" flag,
   * recomputed on every materialization, for cheap admin list filtering.
   */
  enrichmentBaselineChanged: boolean("enrichment_baseline_changed").notNull().default(false),
  /**
   * Classification lifecycle for the admin Facts editor: "pending" | "ok" | "failed".
   * Tracks the re-run-classification job only. Null on facts that were never
   * (re)classified in-place. Mirrors `pending_reviews.enrichment_status`.
   */
  enrichmentStatus: varchar("enrichment_status", { length: 16 }),
  primaryArchetype: varchar("primary_archetype", { length: 64 }),
  subtype: varchar("subtype", { length: 64 }),
  overhypeFit: varchar("overhype_fit", { length: 16 }),
  adultSuitability: varchar("adult_suitability", { length: 24 }),
  /**
   * The ProcessingSignature this fact's ACTIVE enrichment was last generated
   * under (engine revision + code-version constants). Stamped at first-time
   * production approval (via the first-time staging enrichment job) and when a
   * refresh candidate is PROMOTED — but NEVER on a direct live re-enrich (an
   * existing live fact only refreshes via send-back → promote). NULL = legacy
   * fact never processed under the versioned pipeline → reads as stale-for-
   * reprocess in Taxonomy Health.
   */
  lastProcessedSignature: jsonb("last_processed_signature"),
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
  index("facts_parent_id_idx").on(table.parentId),
  index("facts_primary_archetype_idx").on(table.primaryArchetype),
  index("facts_adult_suitability_idx").on(table.adultSuitability),
  // The partial `IDX_facts_eval_golden` (WHERE eval_golden) is migration-only —
  // drizzle-kit's partial-index detection is brittle (see imagePromptAttempts.ts).
]);

export const insertFactSchema = createInsertSchema(factsTable).omit({ id: true, upvotes: true, downvotes: true, score: true, wilsonScore: true, commentCount: true, shareCount: true, createdAt: true, updatedAt: true });
export type InsertFact = z.infer<typeof insertFactSchema>;
export type Fact = typeof factsTable.$inferSelect;
