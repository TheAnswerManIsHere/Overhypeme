import { pgTable, serial, integer, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";

/**
 * Tracks every AI-generated meme background image per user.
 * Used to enforce the paid storage limit (1000 images total per user,
 * combining both AI-generated images and uploaded photos).
 */
export const userAiImagesTable = pgTable("user_ai_images", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  gender: varchar("gender", { length: 10 }).notNull(),
  storagePath: text("storage_path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("IDX_uai_user_id").on(table.userId),
  index("IDX_uai_fact_id").on(table.factId),
]);

export type UserAiImage = typeof userAiImagesTable.$inferSelect;
