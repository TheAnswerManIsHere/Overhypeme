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
  hasPronouns: boolean("has_pronouns").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  canonicalText: text("canonical_text"),
  /** LLM-extracted Pexels image IDs per gender variant. Populated by factImagePipeline. */
  pexelsImages: jsonb("pexels_images"),
  embedding: vector("embedding", { dimensions: 384 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("facts_wilson_score_idx").on(table.wilsonScore),
  index("facts_parent_id_idx").on(table.parentId),
]);

export const insertFactSchema = createInsertSchema(factsTable).omit({ id: true, upvotes: true, downvotes: true, score: true, wilsonScore: true, commentCount: true, createdAt: true, updatedAt: true });
export type InsertFact = z.infer<typeof insertFactSchema>;
export type Fact = typeof factsTable.$inferSelect;
