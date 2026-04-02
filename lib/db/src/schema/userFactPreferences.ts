import { pgTable, serial, integer, varchar, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";

export const userFactPreferencesTable = pgTable("user_fact_preferences", {
  id:         serial("id").primaryKey(),
  userId:     varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  factId:     integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  imageIndex: integer("image_index").notNull().default(0),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("ufp_user_fact_unique").on(table.userId, table.factId),
  index("ufp_user_id_idx").on(table.userId),
]);

export type UserFactPreference = typeof userFactPreferencesTable.$inferSelect;
