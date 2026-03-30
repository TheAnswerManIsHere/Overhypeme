import { pgTable, serial, text, integer, varchar, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { factsTable } from "./facts";
import { usersTable } from "./auth";

export const externalLinksTable = pgTable("external_links", {
  id: serial("id").primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  title: text("title"),
  platform: varchar("platform", { length: 50 }),
  addedById: varchar("added_by_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertExternalLinkSchema = createInsertSchema(externalLinksTable).omit({ id: true, createdAt: true });
export type InsertExternalLink = z.infer<typeof insertExternalLinkSchema>;
export type ExternalLink = typeof externalLinksTable.$inferSelect;
