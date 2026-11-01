/**
 * @purpose The read-authorization gates for storage objects: withdrawnObject keeps the bytes of content its owner deleted from everyone but that owner (plan S17), userCanReadObject layers the legacy upload-owner fallback and ACL heal over the object ACL, and userOwnsAiReferenceImage gates AI reference images by their live user_ai_images row.
 * @subsystem security
 */
import type { Request } from "express";
import type { File } from "@google-cloud/storage";
import { db } from "@workspace/db";
import { memesTable, uploadImageMetadataTable, userAiImagesTable } from "@workspace/db/schema";
import { sql, and, eq } from "drizzle-orm";
import type { ObjectStorageService } from "./objectStorage";
import { ObjectPermission } from "./objectAcl";
import { liveContent } from "./contentVisibility";

/** `memes/{hash2}/{slug}.{ext}`, the key `memeKey` gives a meme's file. */
const MEME_FILE_PATH = /^\/objects\/memes\/[^/]+\/([^/]+)\.(?:jpg|png)$/;

/**
 * Whether `objectPath` is the file of content that is not live — an upload, a
 * generated image or a meme its owner deleted (plan S17) — and if so, whose.
 * Its bytes stay in storage until the content purger removes them. Meanwhile
 * they are served to no one but that owner, who sees them in Recently deleted
 * to choose what to restore, and never into a shared cache. A path no content
 * row names is not withdrawn: this gate refuses only what the live rule hides.
 *
 * Returns null when the object is not withdrawn, else `{ ownerId }`.
 */
export async function withdrawnObject(objectPath: string): Promise<{ ownerId: string | null } | null> {
  const memeSlug = MEME_FILE_PATH.exec(objectPath)?.[1];
  const [upload, aiImage, meme] = await Promise.all([
    db
      .select({ isLive: liveContent(uploadImageMetadataTable), ownerId: uploadImageMetadataTable.userId })
      .from(uploadImageMetadataTable)
      .where(eq(uploadImageMetadataTable.objectPath, objectPath))
      .limit(1),
    // One stored image can be named by several rows (a mirror per request);
    // it is withdrawn only when none of them is live.
    db
      .select({
        anyLive: sql<boolean>`bool_or(${liveContent(userAiImagesTable)})`.mapWith(Boolean),
        ownerId: sql<string | null>`min(${userAiImagesTable.userId})`,
      })
      .from(userAiImagesTable)
      .where(eq(userAiImagesTable.storagePath, objectPath))
      .having(sql`count(*) > 0`),
    memeSlug
      ? db
          .select({ isLive: liveContent(memesTable), ownerId: memesTable.createdById })
          .from(memesTable)
          .where(eq(memesTable.permalinkSlug, memeSlug))
          .limit(1)
      : Promise.resolve([] as Array<{ isLive: boolean; ownerId: string | null }>),
  ]);
  if (upload[0] && !upload[0].isLive) return { ownerId: upload[0].ownerId };
  if (aiImage[0] && !aiImage[0].anyLive) return { ownerId: aiImage[0].ownerId };
  if (meme[0] && !meme[0].isLive) return { ownerId: meme[0].ownerId };
  return null;
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
