import { pgTable, text, serial, integer, varchar, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
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
});

export type Meme = typeof memesTable.$inferSelect;
