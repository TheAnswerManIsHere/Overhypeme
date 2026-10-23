/**
 * A deterministic photo background for tests that render a meme.
 *
 * The gradient templates were the suite's no-network background until Launch
 * Phase 4, removal 5 deleted them (#744). What replaces them is the path a
 * real meme takes: a JPEG in object storage, here the local storage double
 * (`lib/localObjectStorage.ts`) in a temporary directory, with an
 * `upload_image_metadata` row naming its owner, which is what the render
 * routes check before they compose an upload.
 *
 * Use it inside a `describe`, never at a file's top level: under
 * `--test-isolation=none` a shard runs every file in one process, so the
 * storage selection and the rows must be scoped to the suite that needs them
 * and undone after it (the lesson `localObjectStorage.test.ts` records).
 *
 *   const photos = photoBackgrounds();
 *   before(async () => { await photos.setUp(); key = await photos.seed(ownerId); });
 *   after(photos.tearDown);
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { db } from "@workspace/db";
import { uploadImageMetadataTable } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";

import { ObjectStorageService } from "../../lib/objectStorage.js";

const ENV_KEYS = ["STORAGE_BACKEND", "STORAGE_DOUBLE_DIR", "PRIVATE_OBJECT_DIR"] as const;

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

export function photoBackgrounds() {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const seededKeys: string[] = [];
  let root: string | null = null;

  return {
    /** Point object storage at a fresh local double for this suite. */
    setUp(): void {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "photo-background-"));
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      process.env.STORAGE_BACKEND = "local-double";
      process.env.STORAGE_DOUBLE_DIR = root;
      process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
    },

    /**
     * Store a JPEG in the double and record it as `ownerId`'s upload. Returns
     * the `/objects/...` key an `{ type: "upload", uploadKey }` source names.
     */
    async seed(ownerId: string | null, opts: { width?: number; height?: number; color?: string } = {}): Promise<string> {
      if (!root) throw new Error("photoBackgrounds: call setUp() in the suite's before() first");
      const width = opts.width ?? 800;
      const height = opts.height ?? 450;
      const buffer = solidJpeg(width, height, opts.color);
      const uploadKey = await new ObjectStorageService().uploadObjectBuffer({
        subPath: `uploads/t_photo_bg_${randomUUID()}.jpg`,
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
      seededKeys.push(uploadKey);
      return uploadKey;
    },

    /** Delete this suite's rows and files and restore the storage selection. */
    async tearDown(): Promise<void> {
      if (seededKeys.length > 0) {
        await db.delete(uploadImageMetadataTable).where(inArray(uploadImageMetadataTable.objectPath, seededKeys));
        seededKeys.length = 0;
      }
      for (const k of ENV_KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (root) fs.rmSync(root, { recursive: true, force: true });
      root = null;
    },
  };
}
