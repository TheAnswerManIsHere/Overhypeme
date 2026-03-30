import { pgTable, serial, varchar, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const affiliateDestinationEnum = pgEnum("affiliate_destination", ["zazzle", "cafepress"]);
export const affiliateSourceTypeEnum = pgEnum("affiliate_source_type", ["fact", "meme"]);

export const affiliateClicksTable = pgTable("affiliate_clicks", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").references(() => usersTable.id),
  sourceType: affiliateSourceTypeEnum("source_type").notNull(),
  sourceId: varchar("source_id").notNull(),
  destination: affiliateDestinationEnum("destination").notNull(),
  clickedAt: timestamp("clicked_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AffiliateClick = typeof affiliateClicksTable.$inferSelect;
export type InsertAffiliateClick = typeof affiliateClicksTable.$inferInsert;
