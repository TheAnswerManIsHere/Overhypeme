import type { Request } from "express";
import type { File } from "@google-cloud/storage";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
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
