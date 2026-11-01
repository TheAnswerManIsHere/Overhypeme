/**
 * @purpose Test helper: a photo a user owns, as saving a meme needs it — its upload_image_metadata row naming the owner (#804) and, when storage is pointed at the local double (`photoBackgrounds().setUp()`), the JPEG itself, since a meme is rendered from the photo's bytes at save (plan S16).
 * @subsystem tooling
 */
import { db } from "@workspace/db";
import { uploadImageMetadataTable } from "@workspace/db/schema";

import { ObjectStorageService } from "../../lib/objectStorage.js";
import { solidJpeg } from "./photoBackground.js";

export async function ownUpload(userId: string, objectPath: string): Promise<string> {
  const bytes = solidJpeg(1200, 800);
  if (process.env.STORAGE_BACKEND === "local-double") {
    try {
      await new ObjectStorageService().uploadObjectBuffer({
        subPath: objectPath.replace(/^\/objects\//, ""),
        buffer: bytes,
        contentType: "image/jpeg",
      });
    } catch (err) {
      if ((err as { code?: unknown }).code !== 412) throw err; // already stored
    }
  }
  await db
    .insert(uploadImageMetadataTable)
    .values({ objectPath, userId, width: 1200, height: 800, fileSizeBytes: bytes.length })
    .onConflictDoNothing();
  return objectPath;
}
