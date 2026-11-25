/**
 * @purpose The one answer to "may this account build an image from this upload" (and, for an AI picture, "from this picture of theirs"): the upload's metadata row must exist, be live, and belong to the account. Used wherever the server reads a user-named upload into an image it makes, the render routes and saving a meme, so no route can pull bytes the caller does not own.
 * @subsystem meme-studio
 */
import { db } from "@workspace/db";
import { uploadImageMetadataTable, userAiImagesTable } from "@workspace/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";

import { liveContent } from "./contentVisibility";

/**
 * True when `uploadKey` (the `/objects/<subPath>` form) has a metadata row
 * owned by `userId` and live. Rows with no `user_id` (system-generated) never
 * match: they are not a user's to reference. A photo its owner deleted is not
 * theirs to build with until they restore it (plan S2).
 */
export async function userOwnsUpload(uploadKey: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({ userId: uploadImageMetadataTable.userId })
    .from(uploadImageMetadataTable)
    .where(and(eq(uploadImageMetadataTable.objectPath, uploadKey), liveContent(uploadImageMetadataTable)))
    .limit(1);
  return !!row && row.userId === userId;
}

/**
 * True when `aiImageId` is one of `userId`'s own live AI pictures of this fact
 * (launch Phase 7, increment 2): a `user_ai_images` row a member's picture
 * delivered (`attempt_id` set), owned by the caller, not deleted, drawn for
 * `factId`. An example, another member's picture, or a picture a fact's shared
 * gallery serves can never satisfy it.
 */
export async function userOwnsAiPicture(aiImageId: number, userId: string | null, factId: number): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({ id: userAiImagesTable.id })
    .from(userAiImagesTable)
    .where(and(
      eq(userAiImagesTable.id, aiImageId),
      eq(userAiImagesTable.userId, userId),
      eq(userAiImagesTable.factId, factId),
      isNotNull(userAiImagesTable.attemptId),
      liveContent(userAiImagesTable),
    ))
    .limit(1);
  return !!row;
}

/** The object path of an AI picture, for a caller that has already checked it is the requester's own (or a saved meme's recipe). */
export async function aiPictureObjectPath(aiImageId: number): Promise<string | null> {
  const [row] = await db.select({ storagePath: userAiImagesTable.storagePath })
    .from(userAiImagesTable).where(eq(userAiImagesTable.id, aiImageId)).limit(1);
  return row?.storagePath ?? null;
}
