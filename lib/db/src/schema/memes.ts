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
  createdById: varchar("created_by_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Meme = typeof memesTable.$inferSelect;
