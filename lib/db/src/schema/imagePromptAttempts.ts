import {
  pgTable, bigserial, integer, varchar, text, jsonb, timestamp, index,
} from "drizzle-orm/pg-core";
import { factsTable } from "./facts";
import { usersTable } from "./auth";

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
  /** NULL until image_prompt_generation handler succeeds. */
  visualPlan: jsonb("visual_plan"),
  /** NULL until image_prompt_generation handler succeeds. */
  compiledPrompt: jsonb("compiled_prompt"),
  /** NULL until image_prompt_generation handler succeeds. */
  subjectFactCompatibility: jsonb("subject_fact_compatibility"),
  /** Non-null on failure. */
  error: text("error"),
  /** Populated by the image_generation handler when fal returns. */
  generatedImageObjectPath: text("generated_image_object_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_ipa_fact_id").on(t.factId),
  index("IDX_ipa_user_id").on(t.userId),
  index("IDX_ipa_created_at").on(t.createdAt.desc()),
  index("IDX_ipa_subject_render_mode").on(t.subjectRenderMode),
  // Partial indexes for request_id / render_job_id are declared in the
  // migration SQL only — drizzle-kit's partial-index detection is brittle.
]);

export type ImagePromptAttempt = typeof imagePromptAttemptsTable.$inferSelect;
export type InsertImagePromptAttempt = typeof imagePromptAttemptsTable.$inferInsert;
