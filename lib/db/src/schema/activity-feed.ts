import { pgTable, text, serial, timestamp, varchar, boolean, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const activityTypeEnum = pgEnum("activity_type", [
  "fact_submitted",
  "fact_approved",
  "duplicate_flagged",
  "review_submitted",
  "review_approved",
  "review_rejected",
  "comment_posted",
  "comment_approved",
  "comment_rejected",
  "vote_cast",
  "system_message",
]);

export const activityFeedTable = pgTable("activity_feed", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => usersTable.id),
  actionType: activityTypeEnum("action_type").notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ActivityFeedEntry = typeof activityFeedTable.$inferSelect;
export type InsertActivityFeedEntry = typeof activityFeedTable.$inferInsert;
