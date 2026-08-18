import { pgTable, serial, integer, text, varchar, timestamp, pgEnum, index, boolean, jsonb, numeric } from "drizzle-orm/pg-core";
import { factsTable } from "./facts";

export const videoJobStatusEnum = pgEnum("video_job_status", ["pending", "completed", "failed"]);

/**
 * Video generation jobs. Persisted on success/failure so we can show user
 * history, debug failures, and audit cost ledger entries.
 *
 * MBFO-4 expansion:
 *   - Split single `style_id` into `look_style_id` (Stage 1 / source still
 *     stylization) + `motion_preset_id` (Stage 2 / video engine prompt).
 *   - Added engine identity columns so we can audit which engine actually
 *     ran (defaults can change in admin_config; per-job record is the truth).
 *   - Added stylized-still object path so the auto-promote-on-cancel and
 *     "use-existing-ai-image" paths have something to point at.
 *   - Added per-stage cost columns for analytics. (The user_generation_costs
 *     ledger is still the source of truth; these are denormalized convenience.)
 */
export const videoJobsTable = pgTable("video_jobs", {
  id: serial("id").primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  /** Raw upload URL/path that the user supplied as the meme's source. */
  imageUrl: text("image_url").notNull(),
  /** Stylized still produced by Stage 1 (PuLID). Null when source mode bypasses PuLID. */
  stylizedStillObjectPath: text("stylized_still_object_path"),
  /** Final captioned MP4 URL/path. Null until Stage 2 completes successfully. */
  videoUrl: text("video_url"),
  /** Engine id (from engines table) that ran Stage 2. Recorded for audit; defaults can change in admin_config. */
  videoEngineId: varchar("video_engine_id", { length: 64 }),
  /** Engine id (from engines table) that ran Stage 1. Null when source mode bypassed PuLID. */
  imageEngineId: varchar("image_engine_id", { length: 64 }),
  /** Engine id (from engines table) for caption burn-in. Recorded once auto-subtitle runs. */
  subtitleEngineId: varchar("subtitle_engine_id", { length: 64 }),
  /** Final fal request id for Stage 2 (videoEngine). */
  falRequestId: text("fal_request_id"),
  /** Resolved motion prompt sent to the video engine. Includes engine-specific voiceover/dialogue cues. */
  motionPrompt: text("motion_prompt"),
  /** Look style applied during Stage 1. */
  lookStyleId: text("look_style_id"),
  /** Motion preset selected for Stage 2. */
  motionPresetId: text("motion_preset_id"),
  /** Engine mode (Normal/Fun/Custom for Grok; null/none for engines without mode UI). */
  engineMode: varchar("engine_mode", { length: 32 }),
  /** Custom-mode user-supplied prompt addition. Null for non-custom modes. */
  customModePrompt: text("custom_mode_prompt"),
  /** Source mode: "stylize-then-video" | "use-photo-as-is" | "use-existing-ai-image". */
  sourceMode: varchar("source_mode", { length: 32 }),
  /** Engine option snapshot: { lengthSeconds, resolution, aspectRatio } at job time. */
  optionsSnapshot: jsonb("options_snapshot"),
  /** Cost per stage in USD. Null when stage skipped or unknown. */
  stage1CostUsd: numeric("stage1_cost_usd", { precision: 10, scale: 6 }),
  stage2CostUsd: numeric("stage2_cost_usd", { precision: 10, scale: 6 }),
  stage3CostUsd: numeric("stage3_cost_usd", { precision: 10, scale: 6 }),
  status: videoJobStatusEnum("status").notNull().default("pending"),
  /** Failure detail, populated when status = "failed". */
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: text("error_message"),
  ipAddress: varchar("ip_address", { length: 45 }).notNull(),
  userId: text("user_id"),
  /**
   * What authorized this job, resolved at SUBMISSION time — never re-derived at
   * execution. Shape: `{ tier, isAdmin, decisions: {<featureKey>: boolean}, resolvedAt }`.
   *
   * NOT NULL with no default, deliberately: it is part of the row rather than a
   * sidecar, so it cannot be written separately or partially, and every
   * statically-typed insert site must supply it or fail to typecheck. (That
   * enumeration argument holds for `video_jobs` specifically because it has no
   * raw-SQL writers — verified — and does NOT generalize to tables that do.)
   *
   * A live writer must record its own request's decision. Neither a
   * migration-style "predates this plan" snapshot nor any other placeholder is
   * acceptable from a live writer.
   */
  authorizationSnapshot: jsonb("authorization_snapshot").notNull(),
  isPrivate: boolean("is_private").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set when the pipeline reaches stage1_review (the user-approval checkpoint). */
  checkpointAt: timestamp("checkpoint_at", { withTimezone: true }),
  /** Set when the user proceeds past the checkpoint. */
  proceededAt: timestamp("proceeded_at", { withTimezone: true }),
  /** Set on terminal success (videoUrl populated). */
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("video_jobs_fact_id_idx").on(table.factId),
  index("video_jobs_ip_address_idx").on(table.ipAddress),
  index("video_jobs_created_at_idx").on(table.createdAt),
  index("video_jobs_user_id_idx").on(table.userId),
]);

export type VideoJob = typeof videoJobsTable.$inferSelect;
export type InsertVideoJob = typeof videoJobsTable.$inferInsert;
