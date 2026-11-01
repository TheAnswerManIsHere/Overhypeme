/**
 * @purpose The one answer to "may this account build an image from this upload": the upload's metadata row must exist and belong to the account. Used wherever the server reads a user-named upload into an image it makes, the render routes and saving a meme, so no route can pull bytes the caller does not own.
 * @subsystem meme-studio
 */
import { db } from "@workspace/db";
import { uploadImageMetadataTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

/**
 * True when `uploadKey` (the `/objects/<subPath>` form) has a metadata row
 * owned by `userId`. Rows with no `user_id` (system-generated) never match:
 * they are not a user's to reference.
 */
export async function userOwnsUpload(uploadKey: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({ userId: uploadImageMetadataTable.userId })
    .from(uploadImageMetadataTable)
    .where(eq(uploadImageMetadataTable.objectPath, uploadKey))
    .limit(1);
  return !!row && row.userId === userId;
}
