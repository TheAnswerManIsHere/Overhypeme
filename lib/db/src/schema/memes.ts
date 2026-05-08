import { pgTable, text, serial, integer, varchar, timestamp, jsonb, boolean, index, numeric } from "drizzle-orm/pg-core";
import { isNull } from "drizzle-orm";
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
  /** User-specified background framing/pan transform for photo-backed meme crops. */
  imageTransform: jsonb("image_transform"),
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
}, (table) => [
  index("IDX_memes_deleted_at").on(table.deletedAt).where(isNull(table.deletedAt)),
  index("IDX_memes_heart_count").on(table.heartCount),
  index("IDX_memes_status").on(table.status),
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
}, (t) => [
  index("IDX_uim_user_id").on(t.userId),
  index("IDX_uim_arachnid_sha256").on(t.arachnidSha256Hex),
]);

export type UploadImageMetadata = typeof uploadImageMetadataTable.$inferSelect;
export type InsertUploadImageMetadata = typeof uploadImageMetadataTable.$inferInsert;
