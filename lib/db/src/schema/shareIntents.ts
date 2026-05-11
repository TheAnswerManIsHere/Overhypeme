import { pgTable, serial, varchar, integer, timestamp, index } from "drizzle-orm/pg-core";
import { memesTable } from "./memes";
import { usersTable } from "./auth";

/**
 * Phase-6 share-intent log. A row is inserted every time an authenticated
 * user clicks one of the share buttons in the meme share modal. The actual
 * share happens off-platform (the OS share sheet, a Twitter/X composer, the
 * user's mail client, the clipboard) and we cannot observe whether it was
 * completed — this table records *intent*, not confirmed shares. The Web
 * Share API in particular swallows which app the user picked; a row with
 * `platform = 'web_share'` only tells us the native flow was invoked.
 *
 * Insert-only; no soft-delete. Cascade on user/meme deletion so we never
 * orphan rows but keep references intact while the parents are live.
 */
export const shareIntentsTable = pgTable("share_intents", {
  id: serial("id").primaryKey(),
  memeId: integer("meme_id").notNull().references(() => memesTable.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /**
   * The button the user clicked. Constrained at the DB level (CHECK in the
   * migration) so values stay stable for downstream analytics.
   *   - 'twitter'    — Twitter/X intent URL opened in a new tab
   *   - 'web_share'  — navigator.share() invoked; target app unknown
   *   - 'copy_link'  — permalink written to clipboard
   *   - 'email'      — mailto: URL opened (desktop without Web Share API)
   */
  platform: varchar("platform", { length: 20 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_share_intents_meme_created").on(table.memeId, table.createdAt),
  index("idx_share_intents_user_platform_created").on(table.userId, table.platform, table.createdAt),
  index("idx_share_intents_platform_created").on(table.platform, table.createdAt),
]);

export type ShareIntent = typeof shareIntentsTable.$inferSelect;
export type InsertShareIntent = typeof shareIntentsTable.$inferInsert;

/** The set of valid `platform` values. Kept in sync with the SQL CHECK constraint. */
export const SHARE_INTENT_PLATFORMS = ["twitter", "web_share", "copy_link", "email"] as const;
export type ShareIntentPlatform = (typeof SHARE_INTENT_PLATFORMS)[number];
