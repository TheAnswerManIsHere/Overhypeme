import { pgTable, serial, varchar, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Curated hero examples, once shown on the meme builder wizard's Step 1.
 *
 * NO READER: the wizard's Step 1 (choose image or video) and the route that
 * served this table went with video in launch Phase 4 (migration 0103 deleted
 * the video rows). The table is a removal-11 orphan candidate (#744).
 *
 * Soft-delete is implemented as `active = false` — never hard-delete rows,
 * so analytics joins against past selections remain valid.
 */
export const heroExamplesTable = pgTable("hero_examples", {
  id: serial("id").primaryKey(),
  /** "image" or "video". Constrained at the DB level via CHECK in the migration. */
  artifactType: varchar("artifact_type", { length: 8 }).notNull(),
  /** Public R2 (or CDN) URL of the asset. MP4 for video; JPG/PNG/WebP for image. */
  assetUrl: text("asset_url").notNull(),
  /** Optional poster image for video cards. Null for image rows. */
  posterUrl: text("poster_url"),
  /** Short caption shown beneath the asset, e.g. "Image meme — Classic format". */
  captionLabel: text("caption_label").notNull().default(""),
  /** Lower sort_order first when listing; the client randomizes on top of this. */
  sortOrder: integer("sort_order").notNull().default(0),
  /** Soft-delete flag. Excluded rows stay in the table for analytics. */
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_hero_examples_type_active_sort")
    .on(table.artifactType, table.active, table.sortOrder),
]);

export type HeroExample = typeof heroExamplesTable.$inferSelect;
export type InsertHeroExample = typeof heroExamplesTable.$inferInsert;

export const HERO_EXAMPLE_ARTIFACT_TYPES = ["image", "video"] as const;
export type HeroExampleArtifactType = (typeof HERO_EXAMPLE_ARTIFACT_TYPES)[number];
