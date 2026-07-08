import type { Request } from "express";
import type { File } from "@google-cloud/storage";
import { db } from "@workspace/db";
import { userAiImagesTable } from "@workspace/db/schema";
import { sql, and, eq } from "drizzle-orm";
import type { ObjectStorageService } from "./objectStorage";
import { ObjectPermission } from "./objectAcl";

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
