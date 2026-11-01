import { pgTable, serial, integer, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { isNotNull, isNull } from "drizzle-orm";
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
  imageType: varchar("image_type", { length: 20 }).notNull().default("generic"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Soft-delete by the owner (launch Phase 5, 0115). NULL = live. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /** When a deleted image is destroyed: `deleted_at` + the restore window. NULL while live. */
  purgeAfter: timestamp("purge_after", { withTimezone: true }),
}, (table) => [
  index("IDX_uai_user_id").on(table.userId),
  index("IDX_uai_user_live").on(table.userId).where(isNull(table.deletedAt)),
  index("IDX_uai_purge_after").on(table.purgeAfter).where(isNotNull(table.purgeAfter)),
  index("IDX_uai_fact_id").on(table.factId),
]);

export type UserAiImage = typeof userAiImagesTable.$inferSelect;
