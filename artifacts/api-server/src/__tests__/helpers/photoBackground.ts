/**
 * A deterministic photo background for tests that render a meme.
 *
 * The gradient templates were the suite's no-network background until Launch
 * Phase 4, removal 5 deleted them (#744). What replaces them is the path a
 * real meme takes: a JPEG in object storage, here the local storage double
 * (`lib/localObjectStorage.ts`) in a per-process temporary directory, with an
 * `upload_image_metadata` row naming its owner, which is what the render
 * routes check before they compose an upload.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { db } from "@workspace/db";
import { uploadImageMetadataTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import { ObjectStorageService } from "../../lib/objectStorage.js";

const SUBPATH_PREFIX = "uploads/t_photo_bg_";

/** A solid-colour JPEG with a lighter block in the middle, so crops differ. */
export function solidJpeg(width = 800, height = 450, color = "#336699"): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(width * 0.4, height * 0.4, width * 0.2, height * 0.2);
  return canvas.toBuffer("image/jpeg", 90);
}

/**
 * Point this process's object storage at a fresh local double. Idempotent; the
 * storage client reads these variables on every call, so setting them before
 * the first storage operation is enough.
 */
export function useLocalStorageDouble(): void {
  if (process.env.STORAGE_BACKEND === "local-double" && process.env.STORAGE_DOUBLE_DIR) return;
  process.env.STORAGE_BACKEND = "local-double";
  process.env.STORAGE_DOUBLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "overhype-storage-double-"));
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
}

/**
 * Store a JPEG in the double and record it as `ownerId`'s upload. Returns the
 * `/objects/...` key an `{ type: "upload", uploadKey }` image source names.
 */
export async function seedPhotoBackground(
  ownerId: string | null,
  opts: { width?: number; height?: number; color?: string } = {},
): Promise<string> {
  useLocalStorageDouble();
  const width = opts.width ?? 800;
  const height = opts.height ?? 450;
  const buffer = solidJpeg(width, height, opts.color);
  const uploadKey = await new ObjectStorageService().uploadObjectBuffer({
    subPath: `${SUBPATH_PREFIX}${randomUUID()}.jpg`,
    buffer,
    contentType: "image/jpeg",
  });
  await db.insert(uploadImageMetadataTable).values({
    objectPath: uploadKey,
    width,
    height,
    fileSizeBytes: buffer.length,
    userId: ownerId,
  });
  return uploadKey;
}

/** Delete every metadata row this helper wrote; the double's files die with the temp dir. */
export async function cleanupPhotoBackgrounds(): Promise<void> {
  await db
    .delete(uploadImageMetadataTable)
    .where(like(uploadImageMetadataTable.objectPath, `/objects/${SUBPATH_PREFIX}%`));
}
