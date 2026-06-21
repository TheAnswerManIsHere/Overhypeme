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
  isActive: boolean("is_active").notNull().default(true),
  canonicalText: text("canonical_text"),
  /**
   * Token-boundary index where the rendered fact splits into top/bottom captions.
   * Nullable until a separate session adds the gpt-4o-mini population step at fact creation;
   * renderer falls back to the legacy midpoint heuristic when null.
   */
  splitTokenIndex: integer("split_token_index"),
  /** LLM-extracted Pexels image IDs per gender variant. Populated by factImagePipeline. */
  pexelsImages: jsonb("pexels_images"),
  /** LLM-generated scene prompts for AI meme backgrounds (3 gender variants). */
  aiScenePrompts: jsonb("ai_scene_prompts"),
  /** Object storage paths for generated AI meme background images (9 total: 3 genders × 3 each). */
  aiMemeImages: jsonb("ai_meme_images"),
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
  embedding: vector("embedding", { dimensions: 384 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("facts_wilson_score_idx").on(table.wilsonScore.desc()),
  index("facts_parent_id_idx").on(table.parentId),
  index("facts_primary_archetype_idx").on(table.primaryArchetype),
  index("facts_adult_suitability_idx").on(table.adultSuitability),
]);

export const insertFactSchema = createInsertSchema(factsTable).omit({ id: true, upvotes: true, downvotes: true, score: true, wilsonScore: true, commentCount: true, shareCount: true, createdAt: true, updatedAt: true });
export type InsertFact = z.infer<typeof insertFactSchema>;
export type Fact = typeof factsTable.$inferSelect;
