import { pgTable, serial, integer, bigint, varchar, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { isNotNull, isNull, sql } from "drizzle-orm";
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
  /** Who may see this once adult content exists (launch Phase 5, 0121): 'general' | 'adult'. Read by nothing yet. */
  audience: varchar("audience", { length: 10 }).notNull().default("general"),
  /**
   * The member's picture this row delivers (migration 0173, launch Phase 7
   * increment 2): unique, so a picture is delivered once; a picture whose credit
   * was returned can never get one (trigger). NULL on rows that predate it.
   */
  attemptId: bigint("attempt_id", { mode: "number" }),
  /** The gag and the look it drew (migration 0173). NULL on rows that predate them. */
  gagId: bigint("gag_id", { mode: "number" }),
  lookStyleId: varchar("look_style_id", { length: 64 }),
}, (table) => [
  uniqueIndex("UQ_uai_attempt").on(table.attemptId).where(isNotNull(table.attemptId)),
  check("user_ai_images_audience_check", sql`${table.audience} IN ('general','adult')`),
  index("IDX_uai_user_id").on(table.userId),
  index("IDX_uai_user_live").on(table.userId).where(isNull(table.deletedAt)),
  index("IDX_uai_purge_after").on(table.purgeAfter).where(isNotNull(table.purgeAfter)),
  index("IDX_uai_fact_id").on(table.factId),
  index("IDX_uai_storage_path").on(table.storagePath),
]);

export type UserAiImage = typeof userAiImagesTable.$inferSelect;
