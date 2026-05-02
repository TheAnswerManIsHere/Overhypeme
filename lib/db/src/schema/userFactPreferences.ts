import { pgTable, serial, integer, varchar, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";

export const userFactPreferencesTable = pgTable("user_fact_preferences", {
  id:                serial("id").primaryKey(),
  userId:            varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  factId:            integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  imageIndex:        integer("image_index").notNull().default(0),
  aiMemeImageIndex:  integer("ai_meme_image_index").notNull().default(0),
  /** Set when this fact was surfaced as the home-page hero for the user.
   *  Used by the hero rotator to avoid showing the same fact twice in a row
   *  across visits for logged-in users. */
  lastSeenAsHeroAt:  timestamp("last_seen_as_hero_at", { withTimezone: true }),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("ufp_user_fact_unique").on(table.userId, table.factId),
  index("ufp_user_id_idx").on(table.userId),
  index("ufp_user_seen_hero_idx").on(table.userId, table.lastSeenAsHeroAt),
]);

export type UserFactPreference = typeof userFactPreferencesTable.$inferSelect;
