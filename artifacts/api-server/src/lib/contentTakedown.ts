/**
 * @purpose An admin's takedown of a member's meme or photo (image-surface audit R9, Issue #875): the content leaves every surface at once, its owner cannot restore it, and the content purger removes it from storage on its next hourly run. Quarantined content (a moderation-scan match, held as evidence) is never taken down here: it is already off every surface and must not be purged. Each takedown is recorded as an admin action.
 * @subsystem studio
 */
import { db } from "@workspace/db";
import { adminActionsTable, memesTable, uploadImageMetadataTable, usersTable } from "@workspace/db/schema";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { AdminAction } from "@workspace/api-zod";

import { restorable } from "./contentVisibility";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TakedownKind = "meme" | "photo";

export type TakedownResult =
  | { status: "ok"; ownerId: string | null; factId: number | null; wasProfile: boolean }
  | { status: "not_found" };

/**
 * Live, or deleted and still restorable: what an admin can take down. A row
 * already past its window is the purger's, and a pre-window tombstone
 * (`purge_after` null) is not touched.
 */
function takeable(table: typeof memesTable | typeof uploadImageMetadataTable, now: Date) {
  return or(isNull(table.deletedAt), restorable(table, now));
}

export async function takeDownContent(
  item: { kind: TakedownKind; key: string },
  adminId: string,
  reason: string,
  now = new Date(),
): Promise<TakedownResult> {
  const ended = { deletedAt: sql`coalesce(deleted_at, ${now.toISOString()}::timestamptz)`, purgeAfter: now };

  return db.transaction(async (tx): Promise<TakedownResult> => {
    const result = await takeDown(tx);
    if (result.status === "ok") {
      // The record commits with the takedown. A photo belongs to no fact, so its
      // row names neither a fact nor a review; the detail says what it was.
      await tx.insert(adminActionsTable).values({
        factId: result.factId,
        actorId: adminId,
        action: "content_takedown" satisfies AdminAction,
        detail: { kind: item.kind, key: item.key, ownerId: result.ownerId, reason, wasProfile: result.wasProfile },
      });
    }
    return result;
  });

  async function takeDown(tx: Tx): Promise<TakedownResult> {
    if (item.kind === "meme") {
      const m = memesTable;
      const [row] = await tx
        .update(m)
        .set(ended)
        .where(and(eq(m.permalinkSlug, item.key), ne(m.status, "quarantined"), takeable(m, now)))
        .returning({ ownerId: m.createdById, factId: m.factId });
      return row ? { status: "ok", ownerId: row.ownerId, factId: row.factId, wasProfile: false } : { status: "not_found" };
    }

    const t = uploadImageMetadataTable;
    const [row] = await tx
      .update(t)
      .set({ ...ended, isProfile: false })
      .where(and(eq(t.objectPath, item.key), isNull(t.arachnidMatchType), takeable(t, now)))
      .returning({ ownerId: t.userId, factId: t.factId });
    if (!row) return { status: "not_found" };
    // Its derivatives go with it.
    await tx
      .update(t)
      .set(ended)
      .where(and(eq(t.sourceObjectPath, item.key), isNull(t.arachnidMatchType), takeable(t, now)));
    // The photo on show as the member's face: the account shows no picture until they choose another.
    const cleared = row.ownerId
      ? await tx
        .update(usersTable)
        .set({ profileImageUrl: null })
        .where(and(eq(usersTable.id, row.ownerId), sql`${usersTable.profileImageUrl} LIKE ${"%" + item.key}`))
        .returning({ id: usersTable.id })
      : [];
    return { status: "ok", ownerId: row.ownerId, factId: row.factId, wasProfile: cleared.length > 0 };
  }
}
