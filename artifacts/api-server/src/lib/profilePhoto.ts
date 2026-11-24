/**
 * @purpose Makes one of a member's uploads their profile photo, the one setter of their picture (plan docs/plans/PLAN_PHOTO_IS_YOUR_PICTURE.md): every selection locks the account row, so a member's own choice and the Google default never interleave; the object is made public, then the Profile marker moves to it and the account's picture points at it, so the shown photo, the Profile-marked photo and the deletion-protected photo are always the same one.
 * @subsystem accounts-auth
 */
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

import { ObjectStorageService } from "./objectStorage";
import { profilePictureUrl } from "./profilePicture";

/** The picture URL for an upload's object path. */
export function pictureUrlFor(objectPath: string): string {
  return `/api/storage${objectPath}`;
}

/**
 * The account row is locked first, so two selections for one member run one
 * after the other and the later one sees the earlier one's result. With
 * `onlyIfNone` (the Google default, plan Q13), a member who has a photo by
 * then keeps it: the default upload is discarded and null is returned.
 *
 * Public before the writes: a failed ACL change throws and the transaction
 * rolls back, so no account ever points at a photo nobody else can see. The
 * caller has already checked the upload is live and the member's.
 */
export async function makeProfilePhoto(userId: string, objectPath: string): Promise<string>;
export async function makeProfilePhoto(userId: string, objectPath: string, opts: { onlyIfNone: true }): Promise<string | null>;
export async function makeProfilePhoto(
  userId: string,
  objectPath: string,
  opts: { onlyIfNone?: boolean } = {},
): Promise<string | null> {
  const url = pictureUrlFor(objectPath);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ profileImageUrl: usersTable.profileImageUrl })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .for("update");
    if (opts.onlyIfNone && profilePictureUrl(current?.profileImageUrl)) {
      // The member chose a photo while the default was being fetched: theirs
      // wins, and the default never reaches their library.
      await tx.execute(sql`
        UPDATE upload_image_metadata
        SET deleted_at = now(), purge_after = now()
        WHERE object_path = ${objectPath} AND user_id = ${userId} AND is_profile = false
      `);
      return null;
    }
    await new ObjectStorageService().trySetObjectEntityAclPolicy(objectPath, { owner: userId, visibility: "public" });
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
    return url;
  });
}
