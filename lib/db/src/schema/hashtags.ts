import { pgTable, text, serial, integer, varchar, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { factsTable } from "./facts";

export const hashtagsTable = pgTable("hashtags", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  factCount: integer("fact_count").notNull().default(0),
});

export const factHashtagsTable = pgTable("fact_hashtags", {
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  hashtagId: integer("hashtag_id").notNull().references(() => hashtagsTable.id, { onDelete: "cascade" }),
}, (t) => [unique().on(t.factId, t.hashtagId)]);

export const insertHashtagSchema = createInsertSchema(hashtagsTable).omit({ id: true, factCount: true });
export type InsertHashtag = z.infer<typeof insertHashtagSchema>;
export type Hashtag = typeof hashtagsTable.$inferSelect;
export type FactHashtag = typeof factHashtagsTable.$inferSelect;
