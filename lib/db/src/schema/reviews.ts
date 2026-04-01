import { pgTable, text, serial, timestamp, varchar, integer, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";

export const reviewStatusEnum = pgEnum("review_status", ["pending", "approved", "rejected"]);

export const pendingReviewsTable = pgTable("pending_reviews", {
  id: serial("id").primaryKey(),
  submittedText: text("submitted_text").notNull(),
  submittedById: varchar("submitted_by_id").references(() => usersTable.id),
  matchingFactId: integer("matching_fact_id").references(() => factsTable.id),
  matchingSimilarity: integer("matching_similarity").notNull().default(0),
  hashtags: jsonb("hashtags").$type<string[]>().default([]),
  status: reviewStatusEnum("status").notNull().default("pending"),
  reason: text("reason"),
  adminNote: text("admin_note"),
  reviewedById: varchar("reviewed_by_id").references(() => usersTable.id),
  approvedFactId: integer("approved_fact_id").references(() => factsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

export type PendingReview = typeof pendingReviewsTable.$inferSelect;
export type InsertPendingReview = typeof pendingReviewsTable.$inferInsert;
