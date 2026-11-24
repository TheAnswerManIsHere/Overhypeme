/**
 * @purpose Makes one of a member's uploads their profile photo, or removes it, the only two writers of a member's picture besides an admin takedown (plans docs/plans/PLAN_PHOTO_IS_YOUR_PICTURE.md and PLAN_AVATAR_TAKEDOWN_AND_REMOVE.md): every picture write takes the owner's content lock, then the account row, then the upload rows, so a member's own choice, a removal, the Google default and a takedown never interleave; the Profile marker and the account's picture always name the same photo.
 * @subsystem accounts-auth
 */
import { db } from "@workspace/db";
import { uploadImageMetadataTable, usersTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

import { ObjectStorageService } from "./objectStorage";
import { profilePictureUrl } from "./profilePicture";
import { liveContent, lockOwnerContent } from "./contentVisibility";

/** The picture URL for an upload's object path. */
export function pictureUrlFor(objectPath: string): string {
  return `/api/storage${objectPath}`;
}

/** The upload is not (or no longer) a live photo of this member: a takedown or a deletion won the race. */
export class PhotoNotAvailableError extends Error {
  constructor() { super("photo_not_available"); }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The picture-write lock order: the owner's content lock, then their account row. */
async function lockPictureOwner(tx: Tx, userId: string) {
  await lockOwnerContent(tx, userId);
  const [row] = await tx
    .select({ profileImageUrl: usersTable.profileImageUrl, noAutoPicture: usersTable.noAutoPicture })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .for("update");
  return row;
}

/**
 * The owner's content lock is taken first, the same lock the content purger,
 * the account purge and a photo takedown take before anything else; then the
 * account row, so two picture writes for one member run one after the other
 * and the later one sees the earlier one's result.
 *
 * Under that lock the upload is checked again: it must still be live and the
 * member's, so a photo taken down after the caller looked cannot be put back
 * (throws PhotoNotAvailableError).
 *
 * With `onlyIfNone` (the Google default, plan Q13), the default loses when
 * the member has a photo by then, or has turned automatic pictures off by
 * removing theirs or having it taken down (Q16, Q17): the default upload is
 * discarded and null is returned.
 *
 * Public before the writes: a failed ACL change throws and the transaction
 * rolls back, so no account ever points at a photo nobody else can see.
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
    const current = await lockPictureOwner(tx, userId);
    if (opts.onlyIfNone && (profilePictureUrl(current?.profileImageUrl) || current?.noAutoPicture)) {
      // The member chose a photo, or chose to have none, while the default was
      // being fetched: theirs wins, and the default never reaches their library.
      await tx.execute(sql`
        UPDATE upload_image_metadata
        SET deleted_at = now(), purge_after = now()
        WHERE object_path = ${objectPath} AND user_id = ${userId} AND is_profile = false
      `);
      return null;
    }
    const live = await tx.execute(sql`
      SELECT 1 FROM upload_image_metadata
      WHERE object_path = ${objectPath} AND user_id = ${userId} AND ${liveContent(uploadImageMetadataTable)}
      LIMIT 1
    `);
    if (live.rows.length === 0) throw new PhotoNotAvailableError();
    await new ObjectStorageService().trySetObjectEntityAclPolicy(objectPath, { owner: userId, visibility: "public" });
    await tx.execute(sql`
      UPDATE upload_image_metadata
      SET is_profile = false
      WHERE user_id = ${userId} AND is_profile = true AND object_path <> ${objectPath}
    `);
    await tx.execute(sql`
      UPDATE upload_image_metadata
      SET is_profile = true
      WHERE object_path = ${objectPath}
    `);
    await tx.update(usersTable).set({ profileImageUrl: url }).where(eq(usersTable.id, userId));
    return url;
  });
}

/**
 * "Remove my picture" (plan PLAN_AVATAR_TAKEDOWN_AND_REMOVE.md, Q17): the
 * member goes back to their initial, their photos stay in their library (the
 * one that was their picture loses only its Profile marker, and with it its
 * protection from deletion), and Google's picture is never copied in again.
 * Idempotent: removing with no picture still turns the default off.
 */
export async function removeProfilePhoto(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPictureOwner(tx, userId);
    await tx.execute(sql`
      UPDATE upload_image_metadata SET is_profile = false
      WHERE user_id = ${userId} AND is_profile = true
    `);
    await tx.update(usersTable).set({ profileImageUrl: null, noAutoPicture: true }).where(eq(usersTable.id, userId));
  });
}
