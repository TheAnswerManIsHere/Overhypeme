import { pgTable, bigserial, bigint, integer, varchar, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * The prompt tuner, part 2 (plan `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed
 * Design* A and D; migration 0134).
 *
 * A VERSION is one engine family's complete set of global prompt wording
 * (`artifacts/api-server/src/lib/imagePrompt/recipe.ts`), saved once and never
 * edited: changing the wording saves a new version. A PROMOTION makes a
 * version live for its family; the newest promotion per family is the live
 * one, and a promotion of no version (null) restores the baseline, today's
 * wording. A family with no promotion uses the baseline.
 */
export const promptRecipeVersionsTable = pgTable("prompt_recipe_versions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** engines.family, e.g. "gpt-image-2-6". */
  engineFamily: varchar("engine_family", { length: 64 }).notNull(),
  /** 1, 2, 3… within the family. */
  number: integer("number").notNull(),
  /** Every piece's text at save time, keyed by piece. */
  pieces: jsonb("pieces").notNull(),
  /** What changed and why, in the saver's words. */
  note: text("note").notNull(),
  createdBy: varchar("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("UQ_prompt_recipe_versions_family_number").on(t.engineFamily, t.number),
]);

export const promptRecipePromotionsTable = pgTable("prompt_recipe_promotions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  engineFamily: varchar("engine_family", { length: 64 }).notNull(),
  /** The version made live; null restores the baseline. */
  versionId: bigint("version_id", { mode: "number" }).references(() => promptRecipeVersionsTable.id, { onDelete: "restrict" }),
  promotedBy: varchar("promoted_by").references(() => usersTable.id, { onDelete: "set null" }),
  promotedAt: timestamp("promoted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_prompt_recipe_promotions_family").on(t.engineFamily, t.id),
]);

export type PromptRecipeVersion = typeof promptRecipeVersionsTable.$inferSelect;
export type PromptRecipePromotion = typeof promptRecipePromotionsTable.$inferSelect;
