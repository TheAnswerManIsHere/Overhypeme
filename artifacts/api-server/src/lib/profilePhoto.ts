/**
 * @purpose Makes one of a member's uploads their profile photo, the one setter of their picture (plan docs/plans/PLAN_PHOTO_IS_YOUR_PICTURE.md): the object is made public first, then in one transaction the Profile marker moves to it and the account's picture points at it, so the shown photo, the Profile-marked photo and the deletion-protected photo are always the same one.
 * @subsystem accounts-auth
 */
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

import { ObjectStorageService } from "./objectStorage";

/** The picture URL for an upload's object path. */
export function pictureUrlFor(objectPath: string): string {
  return `/api/storage${objectPath}`;
}

/**
 * Public first, then the database: a failed ACL change throws before anything
 * is saved, so no account ever points at a photo nobody else can see. The
 * caller has already checked the upload is live and the member's.
 */
export async function makeProfilePhoto(userId: string, objectPath: string): Promise<string> {
  await new ObjectStorageService().trySetObjectEntityAclPolicy(objectPath, { owner: userId, visibility: "public" });
  const url = pictureUrlFor(objectPath);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE upload_image_metadata
      SET is_profile = false
      WHERE user_id = ${userId} AND is_profile = true AND object_path <> ${objectPath}
    `);
    await tx.execute(sql`
      UPDATE upload_image_metadata
      SET is_profile = true, user_id = COALESCE(user_id, ${userId})
      WHERE object_path = ${objectPath}
    `);
    await tx.update(usersTable).set({ profileImageUrl: url }).where(eq(usersTable.id, userId));
  });
  return url;
}
