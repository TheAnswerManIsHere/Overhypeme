/**
 * @purpose The read-authorization gates for storage objects: contentRowOfObject names the content row whose bytes a path is, for byteAccess (plan S17), userCanReadObject layers the legacy upload-owner fallback and ACL heal over the object ACL, and userOwnsAiReferenceImage gates AI reference images by their live user_ai_images row.
 * @subsystem security
 */
import type { Request } from "express";
import type { File } from "@google-cloud/storage";
import { db } from "@workspace/db";
import { memesTable, uploadImageMetadataTable, userAiImagesTable } from "@workspace/db/schema";
import { sql, and, eq } from "drizzle-orm";
import type { ObjectStorageService } from "./objectStorage";
import { ObjectPermission } from "./objectAcl";
import { aiImageIsOwnersOwn, liveContent } from "./contentVisibility";
import { memeSlugOfObjectPath } from "./storageKeys";

/**
 * The content row whose bytes `objectPath` is, as the live rule sees it:
 * `{ isLive, ownerId }`, or null when no meme, upload or generated image names
 * it. One statement on the object-serving path. A file several generated-image
 * rows name (a mirror per request) is live while any of them is, and a fact
 * gallery's background always is.
 */
export async function contentRowOfObject(objectPath: string): Promise<{ isLive: boolean; ownerId: string | null } | null> {
  const memeSlug = memeSlugOfObjectPath(objectPath);
  const result = memeSlug
    ? await db
        .select({ isLive: liveContent(memesTable), ownerId: memesTable.createdById })
        .from(memesTable)
        .where(eq(memesTable.permalinkSlug, memeSlug))
        .limit(1)
    : await db.execute<{ is_live: boolean; owner_id: string | null }>(sql`
        SELECT ${liveContent(uploadImageMetadataTable)} AS is_live, ${uploadImageMetadataTable.userId} AS owner_id
        FROM ${uploadImageMetadataTable} WHERE ${uploadImageMetadataTable.objectPath} = ${objectPath}
        UNION ALL
        -- A fact gallery's background is everyone's: live whatever happens to
        -- the account it was filed under (PR #815's build report).
        SELECT bool_or(${liveContent(userAiImagesTable)} OR NOT ${aiImageIsOwnersOwn(userAiImagesTable)}), min(${userAiImagesTable.userId})
        FROM ${userAiImagesTable} WHERE ${userAiImagesTable.storagePath} = ${objectPath}
        HAVING count(*) > 0
        LIMIT 1
      `).then((r) => r.rows.map((x) => ({ isLive: Boolean(x.is_live), ownerId: x.owner_id })));
  return result[0] ?? null;
}

/**
 * Canonical READ-authorization for a private storage object — the single
 * source of truth for "may this request read this object?".
 *
 * Shared by the object-serving route (`GET /storage/objects`) and any other
 * path that streams or re-hosts private object bytes. In particular the video
 * generator re-uploads a caller-supplied object to fal's public CDN; without
 * this gate a caller could pass another user's `storagePath` and have the
 * server fetch + expose their private image (IDOR).
 *
 * Decision:
 *   1. The object's own ACL (`canAccessObjectEntity`) — public or owner/allowed.
 *   2. Legacy fallback for uploads recorded before ACLs were written: if the
 *      authenticated user owns the `upload_image_metadata` row for this
 *      `/objects/uploads/...` path, grant access and retroactively heal the ACL
 *      so future reads hit the fast path.
 *
 * @param objectPath the canonical `/objects/{subPath}` path (already normalized
 *                    via `normalizeObjectEntityPath`).
 */
export async function userCanReadObject(
  svc: ObjectStorageService,
  objectFile: File,
  objectPath: string,
  req: Request,
): Promise<boolean> {
  const canAccess = await svc.canAccessObjectEntity({
    userId: req.user?.id,
    objectFile,
    requestedPermission: ObjectPermission.READ,
  });
  if (canAccess) return true;

  const userId = req.user?.id;
  if (userId && objectPath.startsWith("/objects/uploads/")) {
    const ownerCheck = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM upload_image_metadata
      WHERE object_path = ${objectPath}
        AND user_id = ${userId}
    `);
    const owned = parseInt(ownerCheck.rows[0]?.count ?? "0", 10) > 0;
    if (owned) {
      // Heal the missing ACL so subsequent reads skip this fallback.
      svc
        .trySetObjectEntityAclPolicy(objectPath, { owner: userId, visibility: "private" })
        .catch(() => { /* non-critical */ });
      return true;
    }
  }

  return false;
}

/**
 * Ownership check for a user's AI **reference** image, keyed on the
 * `user_ai_images` table — the authorization the `GET /memes/ai-user/image`
 * serving route enforces.
 *
 * This is a SEPARATE decision from `userCanReadObject`: reference images are
 * stored with a *public* object ACL, so `canAccessObjectEntity` would grant
 * everyone read. The real gate is ownership of the `user_ai_images` row. Any
 * path that serves or re-hosts an AI reference image (the serving route and the
 * video generator) MUST use this, not the object ACL.
 */
export async function userOwnsAiReferenceImage(userId: string, storagePath: string): Promise<boolean> {
  const rows = await db
    .select({ id: userAiImagesTable.id })
    .from(userAiImagesTable)
    .where(
      and(
        eq(userAiImagesTable.userId, userId),
        eq(userAiImagesTable.storagePath, storagePath),
        eq(userAiImagesTable.imageType, "reference"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
