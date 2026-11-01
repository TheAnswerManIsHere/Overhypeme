/**
 * @purpose Test helper: records an upload as owned by a user (its upload_image_metadata row), which saving a meme from it now requires (#804).
 * @subsystem meme-studio
 */
import { db } from "@workspace/db";
import { uploadImageMetadataTable } from "@workspace/db/schema";

export async function ownUpload(userId: string, objectPath: string): Promise<string> {
  await db
    .insert(uploadImageMetadataTable)
    .values({ objectPath, userId, width: 1200, height: 800, fileSizeBytes: 1000 })
    .onConflictDoNothing();
  return objectPath;
}
