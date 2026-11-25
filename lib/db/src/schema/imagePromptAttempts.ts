import {
  pgTable, bigserial, integer, varchar, text, jsonb, timestamp, index, smallint, bigint,
} from "drizzle-orm/pg-core";
import { factsTable } from "./facts";
import { usersTable } from "./auth";
import { pendingReviewsTable } from "./reviews";
import { promptRecipeVersionsTable } from "./promptRecipes";

/**
 * Phase 2 — per-attempt image prompt generation metadata.
 *
 * Each row captures one render-time prompt-generation attempt: the inputs
 * (source-image analysis, identity policy, render controls), the snapshotted
 * fact enrichment, the engine-neutral visualPlan, the engine-specific
 * compiledPrompt, the subject/fact compatibility rating, and (when the
 * chained image_generation job completes) the path of the generated image.
 *
 * Lifecycle:
 *   1. `/memes/ai/:factId/generate-v2` inserts a row with `render_job_id`
 *      populated and `visual_plan` / `compiled_prompt` NULL.
 *   2. `image_prompt_generation` handler fills `visual_plan` +
 *      `compiled_prompt` + `subject_fact_compatibility` on success
 *      (or `error` on failure).
 *   3. `image_generation` handler (chained) fills
 *      `generated_image_object_path` once fal returns.
 *   4. The client polls `/memes/ai/renders/:render_job_id` which reads this
 *      row to surface status.
 *
 * See migration 0065.
 */
export const imagePromptAttemptsTable = pgTable("image_prompt_attempts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  requestId: varchar("request_id", { length: 128 }),
  /** Parent client-poll handle (UUID). Set by /generate-v2 before enqueueing the prompt job. */
  renderJobId: varchar("render_job_id", { length: 64 }),
  /** "i2i" | "t2i" — derived from `subjectRenderMode`. */
  generationMode: varchar("generation_mode", { length: 8 }).notNull(),
  /** "human_identity_i2i" | "nonhuman_subject_i2i" | "t2i_fallback". */
  subjectRenderMode: varchar("subject_render_mode", { length: 32 }).notNull(),
  /** Non-null when the user explicitly overrode the analyzer's suggestion. */
  userSelectedSubjectRenderMode: varchar("user_selected_subject_render_mode", { length: 32 }),
  /** Populated when t2i_fallback was chosen despite a usable subject. */
  fallbackReason: text("fallback_reason"),
  targetEngine: varchar("target_engine", { length: 32 }).notNull(),
  sourceImageAnalysis: jsonb("source_image_analysis").notNull(),
  /** Denormalized for fast cache lookup against upload_image_metadata.arachnid_sha256_hex. */
  sourceImageSha256: varchar("source_image_sha256", { length: 64 }),
  identityPolicy: jsonb("identity_policy").notNull(),
  renderControls: jsonb("render_controls").notNull(),
  factEnrichmentSnapshot: jsonb("fact_enrichment_snapshot").notNull(),
  archetypeStrategyVersion: varchar("archetype_strategy_version", { length: 16 }).notNull(),
  /**
   * RENDERED fact text (subject/pronoun tokens resolved) the generator was
   * given. Frozen at insert time so a render is reproducible and never re-runs
   * the {NAME}/{SUBJ} template. NULL on rows created before migration 0070 —
   * the job handler renders those on the fly or fails with a clear legacy error.
   */
  renderedFactText: text("rendered_fact_text"),
  /** NULL until image_prompt_generation handler succeeds. */
  visualPlan: jsonb("visual_plan"),
  /** NULL until image_prompt_generation handler succeeds. */
  compiledPrompt: jsonb("compiled_prompt"),
  /** NULL until image_prompt_generation handler succeeds. */
  subjectFactCompatibility: jsonb("subject_fact_compatibility"),
  /** Non-null on failure — the safe, human-readable operational message. */
  error: text("error"),
  /**
   * Typed failure code for a DETERMINISTIC (terminal) prompt-generation
   * failure (§12) — e.g. `invalid_persisted_enrichment`, `style_snapshot_invalid`,
   * `required_budget_overflow`. NULL for a success or a transient/legacy failure
   * that carries only `error`. The poll payload returns this ALONGSIDE `error`
   * so the UI classifies by code instead of parsing a "code: message" string.
   * Both `error` and `error_code` are cleared when a later attempt succeeds.
   */
  errorCode: varchar("error_code", { length: 64 }),
  /** Populated by the image_generation handler when fal returns. */
  generatedImageObjectPath: text("generated_image_object_path"),
  // ── Moderation render-scenario metadata (migration 0076) ──────────────────
  // Non-null ONLY on moderation test-render attempts (the durable, server-side
  // source of truth for the Step-2 visual-review scenario grid). User-facing
  // render attempts leave all of these NULL. Presentation state (status, stale,
  // latest-for-scenario) is DERIVED at read time — never persisted — so it
  // can't drift from the current enrichment/config (see factRenderScenarios.ts).
  /** Links the attempt to the moderation review whose Step-2 grid owns it. */
  reviewId: integer("review_id").references(() => pendingReviewsTable.id, { onDelete: "set null" }),
  /** Scenario this attempt fulfils, e.g. "generic_t2i" | "i2i_male_default" | … (ScenarioKey). */
  reviewRenderScenarioKey: varchar("review_render_scenario_key", { length: 40 }),
  /** sha256 hex of the canonical render-affecting inputs — drives idempotency + staleness. */
  reviewRenderInputHash: varchar("review_render_input_hash", { length: 64 }),
  /** Version of the default reference asset used (for i2i scenarios), for stale detection. */
  reviewReferenceAssetVersion: varchar("review_reference_asset_version", { length: 32 }),
  /** Reference identity class used: "male" | "female" | "nonhuman_animal" (a pet). */
  reviewReferenceIdentityType: varchar("review_reference_identity_type", { length: 32 }),
  /** Groups the scenarios auto-enqueued in one default batch (debugging/audit). */
  reviewRenderBatchId: varchar("review_render_batch_id", { length: 64 }),
  // The eval harness's eight columns (migration 0081) were dropped by 0170.
  // ── Engine attribution (migration 0123, launch Phase 8) ───────────────────
  /**
   * The image engine that draws (or drew) this attempt, resolved once at
   * construction and never derived from today's configuration. Null only on a
   * row written by a release older than 0123 after it ran; such a release
   * routed by mode alone (see `legacyImageEngineIdForGenerationMode`). A
   * contract migration makes it NOT NULL once 0123's release is published.
   */
  actualImageEngineId: varchar("actual_image_engine_id", { length: 64 }),
  /**
   * The prompt recipe version this attempt compiles with (the prompt tuner;
   * migration 0134), chosen when it was queued so a later promotion never
   * changes queued work. Null is the baseline, today's wording.
   */
  recipeVersionId: bigint("recipe_version_id", { mode: "number" }).references(() => promptRecipeVersionsTable.id, { onDelete: "restrict" }),
  /** The endpoint settings the request builder chose (purpose, size, aspect), as sent. */
  requestSettings: jsonb("request_settings"),
  /**
   * The photoreal fallback (migration 0146; plan PLAN_NB_FALLBACK.md): set when
   * the routed engine refused this attempt on content grounds and it was
   * redrawn on the fallback engine. Written before the fallback runs and never
   * cleared, so it keeps the routed engine and the refusal after
   * `actual_image_engine_id` names the engine that drew the picture. Null when
   * the attempt never fell back.
   */
  engineFallback: jsonb("engine_fallback").$type<EngineFallbackRecord>(),
  /**
   * The gag this attempt drew (migration 0139). Null on every attempt made
   * before gags had their own table; those drew the fact's only gag, whose
   * content is in `fact_enrichment_snapshot`. The snapshot stays the exact
   * content rendered either way. A plain value, no foreign key: fact_gags
   * already points back here for its example, so a key both ways would make
   * the pair impossible to insert in either order. It can name a gag that no
   * longer exists: rejecting a submission deletes its gags and keeps its
   * fact (PLAN_FACT_LIFECYCLE_REBUILD.md 1D), and those attempts are reached
   * by no screen, since renders are listed and picked only through a gag.
   */
  gagId: bigint("gag_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_ipa_fact_id").on(t.factId),
  index("IDX_ipa_user_id").on(t.userId),
  index("IDX_ipa_created_at").on(t.createdAt.desc()),
  index("IDX_ipa_subject_render_mode").on(t.subjectRenderMode),
  // Latest-attempt-per-scenario lookup for the moderation Step-2 grid.
  index("IDX_ipa_review_scenario_created").on(t.reviewId, t.reviewRenderScenarioKey, t.createdAt.desc()),
  // Idempotency lookup (has this exact input already been rendered for this review?).
  index("IDX_ipa_review_input_hash").on(t.reviewId, t.reviewRenderInputHash),
  // Latest attempt per gag and scenario (the per-gag render grid).
  index("IDX_ipa_gag_scenario_created").on(t.gagId, t.reviewRenderScenarioKey, t.createdAt.desc()),
  // Partial indexes for request_id / render_job_id (and the moderation-only
  // `WHERE review_id IS NOT NULL` partial) are declared in the migration SQL
  // only — drizzle-kit's partial-index detection is brittle.
]);

/**
 * `image_prompt_attempts.engine_fallback` (migration 0146). `preparing`: the
 * routed engine's refusal is recorded and the fallback prompt is being built;
 * `switched`: the attempt now draws on the fallback engine. No state returns
 * to the routed engine.
 */
export interface EngineFallbackRecord {
  state: "preparing" | "switched";
  routedEngineId: string;
  routedRecipeVersionId: number | null;
  refusedGenerationRequestId: number | null;
  refusedVendorRequestId: string | null;
  /** fal's own reason for the refusal. */
  reason: string;
  fallbackEngineId: string;
  fallbackRecipeVersionId: number | null;
  /** True when the attempt was queued before fallbacks were frozen at queue time, so they were resolved at the handover. */
  resolvedAtHandover: boolean;
  /** ISO time the refusal was recorded. */
  at: string;
}

export type ImagePromptAttempt = typeof imagePromptAttemptsTable.$inferSelect;
export type InsertImagePromptAttempt = typeof imagePromptAttemptsTable.$inferInsert;
