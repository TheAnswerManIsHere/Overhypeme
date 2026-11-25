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
 * The object path of `aiImageId` when it is one of `userId`'s own live AI
 * pictures of this fact (launch Phase 7, increment 2): a `user_ai_images` row a
 * member's picture delivered (`attempt_id` set), owned by the caller, not
 * deleted, drawn for `factId`. Null otherwise: an example, another member's
 * picture, or a picture a fact's shared gallery serves never satisfies it.
 */
export async function ownedAiPicturePath(aiImageId: number, userId: string | null, factId: number): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ storagePath: userAiImagesTable.storagePath })
    .from(userAiImagesTable)
    .where(and(
      eq(userAiImagesTable.id, aiImageId),
      eq(userAiImagesTable.userId, userId),
      eq(userAiImagesTable.factId, factId),
      isNotNull(userAiImagesTable.attemptId),
      liveContent(userAiImagesTable),
    ))
    .limit(1);
  return row?.storagePath ?? null;
}

/** A saved meme's AI picture path, read for its stored recipe: the ownership check ran when the meme was saved. */
export async function aiPictureObjectPath(aiImageId: number): Promise<string | null> {
  const [row] = await db.select({ storagePath: userAiImagesTable.storagePath })
    .from(userAiImagesTable).where(eq(userAiImagesTable.id, aiImageId)).limit(1);
  return row?.storagePath ?? null;
}
