import { pgTable, serial, text, integer, varchar, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { factsTable } from "./facts";
import { usersTable } from "./auth";

export const commentsTable = pgTable("comments", {
  id: serial("id").primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  authorId: varchar("author_id").references(() => usersTable.id),
  text: text("text").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  flagged: boolean("flagged").notNull().default(false),
  flagReason: text("flag_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCommentSchema = createInsertSchema(commentsTable).omit({ id: true, status: true, flagged: true, flagReason: true, createdAt: true });
export type InsertComment = z.infer<typeof insertCommentSchema>;
export type Comment = typeof commentsTable.$inferSelect;
