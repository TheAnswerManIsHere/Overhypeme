import { pgTable, integer, varchar, timestamp, unique } from "drizzle-orm/pg-core";
import { factsTable } from "./facts";
import { usersTable } from "./auth";

export const ratingsTable = pgTable("ratings", {
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  rating: varchar("rating", { length: 10 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.factId, t.userId)]);

export type Rating = typeof ratingsTable.$inferSelect;
