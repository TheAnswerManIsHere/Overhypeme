import { pgTable, varchar, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Visual aesthetic presets ("look") applied to a still image — either at
 * PuLID stylization time (for AI images) or to the source still that feeds
 * a video engine (so the resulting video inherits the look).
 *
 * Shared between image and video flows: the image flow's "AI styling" picker
 * and the video flow's look-style picker draw from the same table. The
 * client-side `aiStylePresets.ts` was previously the source of truth for the
 * id/label pair; it now becomes a thin compile-time fallback while the runtime
 * fetches the live list via the API.
 *
 * Look styles are PURELY visual — no motion direction, no camera movement.
 * Motion lives in `motion_presets`.
 */
export const lookStylesTable = pgTable("look_styles", {
  id: varchar("id", { length: 64 }).primaryKey(),
  label: varchar("label", { length: 128 }).notNull(),
  description: text("description").notNull().default(""),
  /**
   * Suffix appended to a base text-to-image prompt to enforce the look.
   * Used by both PuLID (with reference image) and standalone generation.
   * Mirrors `IMAGE_STYLES[*].promptSuffix` from the legacy server config.
   */
  promptSuffix: text("prompt_suffix").notNull().default(""),
  /**
   * Suffix appended when stylizing an existing reference image (i.e. PuLID's
   * reference-conditioned path). Subtly different wording from `promptSuffix`
   * to match how each model interprets "reimagine this" vs. "render".
   * Mirrors `IMAGE_STYLES[*].promptSuffixReference`.
   */
  promptSuffixReference: text("prompt_suffix_reference").notNull().default(""),
  /** Object-storage path to a small preview image illustrating the look. Null while a style is awaiting content. */
  previewImagePath: text("preview_image_path"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LookStyle = typeof lookStylesTable.$inferSelect;
export type InsertLookStyle = typeof lookStylesTable.$inferInsert;
