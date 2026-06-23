import { pgTable, text, serial, integer, varchar, timestamp, jsonb, boolean, index, numeric, check } from "drizzle-orm/pg-core";
import { isNull, sql } from "drizzle-orm";
import { factsTable } from "./facts";
import { usersTable } from "./auth";

export const memesTable = pgTable("memes", {
  id: serial("id").primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  templateId: varchar("template_id", { length: 50 }).notNull(),
  imageUrl: text("image_url").notNull(),
  permalinkSlug: varchar("permalink_slug", { length: 16 }).notNull().unique(),
  textOptions: jsonb("text_options"),
  /** Populated for photo-based memes; null means gradient template background. */
  imageSource: jsonb("image_source"),
  /**
   * User-specified background framing/pan transform for photo-backed meme
   * crops. Shape: `{ offsetX: number, offsetY: number }`. Persisted so
   * server-side renders, exports, and cached previews honor the creator's
   * chosen framing.
   */
  framingTransform: jsonb("framing_transform"),
  /** Whether this meme is visible in the public gallery. Non-legendary users always get true; legendary can set false. */
  isPublic: boolean("is_public").notNull().default(true),
  /** Flagged true if the uploaded image longest edge is below LOW_RES_THRESHOLD_PX (default 1500px). */
  isLowRes: boolean("is_low_res").notNull().default(false),
  /** Width in pixels of the processed/stored image (null for non-upload sources). */
  originalWidth: integer("original_width"),
  /** Height in pixels of the processed/stored image (null for non-upload sources). */
  originalHeight: integer("original_height"),
  /** File size in bytes of the processed/stored JPEG (null for non-upload sources). */
  uploadFileSizeBytes: integer("upload_file_size_bytes"),
  createdById: varchar("created_by_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Soft-delete tombstone. NULL = live; non-NULL = deleted by creator. Row is kept for referential integrity. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /** Aspect ratio of the meme canvas: "landscape" (16:9), "square" (1:1), or "portrait" (9:16). */
  aspectRatio: varchar("aspect_ratio", { length: 20 }).notNull().default("landscape"),
  /** Fact text as rendered at creation time (frozen — preserves the creator's name/pronouns forever). */
  renderedFactText: text("rendered_fact_text"),
  /** Precomputed count of heart reactions on this meme. Maintained by the reactions write path. */
  heartCount: integer("heart_count").notNull().default(0),
  /** Moderation lifecycle: `live` (visible), `quarantined` (held back by automated checks), `rejected` (creation blocked). */
  status: varchar("status", { length: 20 }).notNull().default("live"),
  /** Free-form reason populated when status flips to `quarantined` (audit aid only). */
  quarantineReason: text("quarantine_reason"),
  /** Probability (0..1) returned by the NSFW classifier on the rendered output. */
  nsfwClassifierScore: numeric("nsfw_classifier_score", { precision: 6, scale: 4 }),
  /** Set when classifier score >= threshold AND user has nsfw_mode_enabled=true (accept-and-tag path). */
  isNsfw: boolean("is_nsfw").notNull().default(false),
  /**
   * Phase-3 analytics discriminant. Null = raw photo or stock or template.
   * 'pulid' = built from a PuLID-stylized image (face matched).
   * 'pulid_fallback_text' = PuLID was requested but no face was detected and the
   * builder fell through to the standard text-to-image generator.
   */
  imageTransform: varchar("image_transform", { length: 24 }),
  /**
   * Discriminator for the meme's primary artifact. "image" for the original
   * static-image meme; "video" for MBFO-4 video memes. The engine that
   * generated the video lives in `video_jobs` (joined via video_job_id) —
   * never referenced by name on the meme row, so engine swaps are pure config.
   */
  artifactType: varchar("artifact_type", { length: 10 }).notNull().default("image"),
  /** R2 / object-storage path to the final captioned MP4. Null for image memes. */
  videoObjectPath: text("video_object_path"),
  /** FK to the video job that produced this meme. Null for image memes. */
  videoJobId: integer("video_job_id"),
  /** Look style applied to the source still (image-mode AI styling or video Stage 1 PuLID). Null when the meme used a raw photo or stock. */
  lookStyleId: varchar("look_style_id", { length: 64 }),
  /** Motion preset selected for video memes. Null for image memes. */
  motionPresetId: varchar("motion_preset_id", { length: 64 }),
}, (table) => [
  index("IDX_memes_deleted_at").on(table.deletedAt).where(isNull(table.deletedAt)),
  index("IDX_memes_heart_count").on(table.heartCount),
  index("IDX_memes_status").on(table.status),
  index("IDX_memes_artifact_type").on(table.artifactType),
  check(
    "memes_image_transform_chk",
    sql`${table.imageTransform} IS NULL OR ${table.imageTransform} IN ('pulid','pulid_fallback_text')`,
  ),
]);

export type Meme = typeof memesTable.$inferSelect;

/** Metadata for user-uploaded images stored in object storage. */
export const uploadImageMetadataTable = pgTable("upload_image_metadata", {
  objectPath: text("object_path").primaryKey(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  isLowRes: boolean("is_low_res").notNull().default(false),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** Arachnid Shield classification (e.g. `csam`, `harmful-abusive-material`, `no-known-match`). */
  arachnidClassification: varchar("arachnid_classification", { length: 40 }),
  /** Match precision: `exact`, `near`, or null when no match. */
  arachnidMatchType: varchar("arachnid_match_type", { length: 10 }),
  /** SHA-1 base32 hash of the bytes Arachnid scanned. */
  arachnidSha1Base32: varchar("arachnid_sha1_base32", { length: 40 }),
  /** SHA-256 hex of the bytes Arachnid scanned. Doubles as a dedupe key for re-scans. */
  arachnidSha256Hex: varchar("arachnid_sha256_hex", { length: 64 }),
  /** When the Arachnid scan completed. NULL on rows uploaded before moderation shipped. */
  arachnidScannedAt: timestamp("arachnid_scanned_at", { withTimezone: true }),
  /** True when the user opted into nsfw mode and the classifier flagged the upload. */
  isNsfw: boolean("is_nsfw").notNull().default(false),
  /**
   * Task #507: when true, this upload is the user's current profile photo.
   * Enforced one-per-user via a partial unique index on (user_id) WHERE is_profile.
   * Set by POST /users/me/profile-image (which also updates users.profileImageUrl).
   */
  isProfile: boolean("is_profile").notNull().default(false),
  /**
   * Phase-3 lineage: 'pulid' for PuLID-stylized derivatives, 'pulid_fallback_text'
   * for derivatives produced when PuLID detected no face and fell through to the
   * standard text-to-image generator. NULL for raw user uploads.
   */
  transform: varchar("transform", { length: 24 }),
  /** For derivatives: the upload row this was generated from. NULL for raw uploads. */
  sourceObjectPath: text("source_object_path"),
  /** For derivatives: the fact this styling was tuned for. NULL for raw uploads. */
  factId: integer("fact_id"),
  /** For derivatives: stable hash of (model, params, prompt). Used as dedup key. */
  transformParamsHash: varchar("transform_params_hash", { length: 64 }),
  /**
   * Phase 2 — cached SourceImageAnalysis blob. Keyed by `arachnidSha256Hex`
   * (the natural per-byte hash already populated by the moderation scan).
   * Populated lazily by `analyzeSourceImage` on first call; invalidated
   * implicitly when `sourceImageAnalysisVersion` no longer matches
   * `SOURCE_IMAGE_ANALYZER_VERSION` from `@workspace/api-zod`.
   */
  sourceImageAnalysis: jsonb("source_image_analysis"),
  /** Analyzer version that produced `sourceImageAnalysis`. NULL when unanalyzed. */
  sourceImageAnalysisVersion: varchar("source_image_analysis_version", { length: 16 }),
}, (t) => [
  index("IDX_uim_user_id").on(t.userId),
  index("IDX_uim_arachnid_sha256").on(t.arachnidSha256Hex),
  index("IDX_uim_user_transform_fact").on(t.userId, t.transform, t.factId),
  index("IDX_uim_pulid_dedup")
    .on(t.userId, t.factId, t.sourceObjectPath, t.transformParamsHash)
    .where(sql`${t.transform} = 'pulid'`),
  check(
    "uim_transform_chk",
    sql`${t.transform} IS NULL OR ${t.transform} IN ('pulid','pulid_fallback_text')`,
  ),
  // Self-FK source_object_path → object_path and fact_id → facts.id are
  // declared in the migration SQL only (drizzle's TS-side self-FK helper is
  // brittle and is not required for runtime queries).
]);

export type UploadImageMetadata = typeof uploadImageMetadataTable.$inferSelect;
export type InsertUploadImageMetadata = typeof uploadImageMetadataTable.$inferInsert;
