import { pgTable, text, serial, integer, varchar, timestamp, jsonb, boolean, index } from "drizzle-orm/pg-core";
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
  /** Whether this meme is visible in the public gallery. Free users always get true; premium can set false. */
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
}, (table) => [
  index("IDX_memes_deleted_at").on(table.deletedAt).where(isNull(table.deletedAt)),
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
}, (t) => [
  index("IDX_uim_user_id").on(t.userId),
]);

export type UploadImageMetadata = typeof uploadImageMetadataTable.$inferSelect;
export type InsertUploadImageMetadata = typeof uploadImageMetadataTable.$inferInsert;
