/**
 * @purpose The one rule for whether a member's content is live (launch Phase 5, plan S2): a meme, an uploaded photo or a generated image is live when its owner has not deleted it. Every reader, the byte paths included, asks this module rather than spelling the test itself, so the second reason a thing is not live (its owner's account is being deleted, Increment 5) is added in one place.
 * @subsystem security
 */
import { and, gt, isNotNull, lt, sql, type SQL } from "drizzle-orm";
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
  // The gallery is `{ gender: [path, ...] }`; lax JSON path skips any other shape.
  // The row's columns may render unqualified inside this subquery; they still
  // bind to the outer row because `facts` has no `fact_id` or `storage_path`.
  return sql<boolean>`NOT EXISTS (
    SELECT 1 FROM facts f
    WHERE f.id = ${table.factId}
      AND jsonb_path_exists(f.ai_meme_images, '$.*[*] ? (@ == $p)', jsonb_build_object('p', ${table.storagePath}))
  )`.mapWith(Boolean);
}

const RESTORE_WINDOW_CONFIG_KEY = "content.restore_window_days";
const DEFAULT_RESTORE_WINDOW_DAYS = 30;

/** How long deleted content stays restorable, in days (`admin_config`, default 30). */
export async function restoreWindowDays(): Promise<number> {
  const days = await getConfigInt(RESTORE_WINDOW_CONFIG_KEY, DEFAULT_RESTORE_WINDOW_DAYS);
  return days >= 1 ? days : DEFAULT_RESTORE_WINDOW_DAYS;
}

/** A row its owner deleted that is still inside its restore window. */
export function restorable(table: ContentTable, now = new Date()): SQL | undefined {
  return and(isNotNull(table.deletedAt), gt(table.purgeAfter, now));
}

/** A deleted row whose restore window has passed: the content purger's to remove. Never a pre-window tombstone (`purge_after` null). */
export function purgeDue(table: ContentTable, now = new Date()): SQL | undefined {
  return and(isNotNull(table.deletedAt), isNotNull(table.purgeAfter), lt(table.purgeAfter, now));
}

/** How a request may be served a content row's bytes. */
export type ByteAccess = "serve" | "serve-uncached" | "refuse";

/**
 * Who is served the bytes of a content row (plan S17): a live row as usual;
 * a row that is not live to its owner only, never into a shared cache, so
 * Recently deleted can show what they would restore; to anyone else, refused
 * like a missing object. `null` (no content row names the bytes) is not this
 * rule's to refuse.
 */
export function byteAccess(row: { isLive: boolean; ownerId: string | null } | null, viewerId: string | undefined): ByteAccess {
  if (!row || row.isLive) return "serve";
  return row.ownerId && row.ownerId === viewerId ? "serve-uncached" : "refuse";
}

/** What a restore sets: live again, and no longer due for the purge. */
export const RESTORED = { deletedAt: null, purgeAfter: null } as const;

/** The two columns a delete sets: when it happened, and when the purge may destroy it. */
export async function deletionStamp(now = new Date()): Promise<{ deletedAt: Date; purgeAfter: Date }> {
  const days = await restoreWindowDays();
  return { deletedAt: now, purgeAfter: new Date(now.getTime() + days * 86_400_000) };
}
