/**
 * @purpose The one rule for whether a member's content is live (launch Phase 5, plan S2): a meme, an uploaded photo or a generated image is live when its owner has not deleted it. Every reader, the byte paths included, asks this module rather than spelling the test itself, so the second reason a thing is not live (its owner's account is being deleted, Increment 5) is added in one place.
 * @subsystem security
 */
import { sql, type SQL } from "drizzle-orm";
import { memesTable, uploadImageMetadataTable, userAiImagesTable } from "@workspace/db/schema";

import { getConfigInt } from "./adminConfig";

/** The three tables that hold a member's own content. */
export type ContentTable = typeof memesTable | typeof uploadImageMetadataTable | typeof userAiImagesTable;

/**
 * The live test for one content table, as a boolean SQL expression over its
 * columns: usable in a WHERE, and as a selected column (`isLive`) where a
 * route must tell "removed" from "never existed".
 *
 * A row is live when `deleted_at` is null. Increment 5 adds "and its owner has
 * no active deletion request" here, and nowhere else.
 */
export function liveContent(table: ContentTable): SQL<boolean> {
  return sql<boolean>`(${table.deletedAt} IS NULL)`.mapWith(Boolean);
}

/**
 * A generated image is the account's own only when no fact's gallery serves
 * it. The image pipeline files every fact background it makes under the
 * account that asked for it (`mirrorToLegacyStorage`), and that background
 * belongs to every member of the fact: My content never lists, deletes or
 * purges it as one person's (PR #811's build report).
 */
export function aiImageIsOwnersOwn(table: typeof userAiImagesTable = userAiImagesTable): SQL<boolean> {
  return sql<boolean>`NOT EXISTS (
    SELECT 1 FROM facts f,
      jsonb_each(CASE WHEN jsonb_typeof(f.ai_meme_images) = 'object' THEN f.ai_meme_images ELSE '{}'::jsonb END) g,
      jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.value) = 'array' THEN g.value ELSE '[]'::jsonb END) p
    WHERE f.id = ${table.factId} AND p = ${table.storagePath}
  )`.mapWith(Boolean);
}

export const RESTORE_WINDOW_CONFIG_KEY = "content.restore_window_days";
export const DEFAULT_RESTORE_WINDOW_DAYS = 30;

/** How long deleted content stays restorable, in days (`admin_config`, default 30). */
export async function restoreWindowDays(): Promise<number> {
  const days = await getConfigInt(RESTORE_WINDOW_CONFIG_KEY, DEFAULT_RESTORE_WINDOW_DAYS);
  return days >= 1 ? days : DEFAULT_RESTORE_WINDOW_DAYS;
}

/** The two columns a delete sets: when it happened, and when the purge may destroy it. */
export async function deletionStamp(now = new Date()): Promise<{ deletedAt: Date; purgeAfter: Date }> {
  const days = await restoreWindowDays();
  return { deletedAt: now, purgeAfter: new Date(now.getTime() + days * 86_400_000) };
}
