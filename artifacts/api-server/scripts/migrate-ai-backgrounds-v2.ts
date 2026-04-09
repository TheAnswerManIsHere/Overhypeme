/**
 * Migration v2: Move ALL root-level AI meme background images into ai-backgrounds/ subfolder.
 *
 * The original migration only handled factsTable.aiMemeImages.
 * This version also covers user_ai_images.storage_path.
 *
 * Strategy (storage-first):
 *   1. List every root-level ai_meme_* file in the bucket.
 *   2. Copy each to ai-backgrounds/<filename>.
 *   3. Update facts.ai_meme_images JSONB where any path matches old root paths.
 *   4. Update user_ai_images.storage_path where any path matches old root paths.
 *   5. Delete old root-level files.
 *
 * Safe to re-run: already-migrated files (in ai-backgrounds/) are skipped.
 */

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { userAiImagesTable } from "@workspace/db/schema";
import { isNotNull, eq, like } from "drizzle-orm";
import { objectStorageClient } from "../src/lib/objectStorage";
import type { AiMemeImages } from "../src/lib/aiMemePipeline";

function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) throw new Error("PRIVATE_OBJECT_DIR not set");
  return dir.endsWith("/") ? dir : `${dir}/`;
}

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

function computeNewPath(oldPath: string): string | null {
  if (!oldPath.startsWith("/objects/")) return null;
  const subPath = oldPath.slice("/objects/".length);
  if (subPath.startsWith("ai-backgrounds/")) return null;
  if (subPath.includes("/")) return null;
  if (!subPath.startsWith("ai_meme_")) return null;
  return `/objects/ai-backgrounds/${subPath}`;
}

async function main() {
  const dir = getPrivateObjectDir();
  const { bucketName, objectName: prefixRaw } = parseObjectPath(dir);
  const prefix = prefixRaw.endsWith("/") ? prefixRaw : `${prefixRaw}/`;
  const bucket = objectStorageClient.bucket(bucketName);

  console.log(`[migrate-v2] Scanning storage: gs://${bucketName}/${prefix}`);

  const [allFiles] = await bucket.getFiles({ prefix });

  const rootAiMemeFiles = allFiles.filter(f => {
    const rel = f.name.slice(prefix.length);
    return rel.startsWith("ai_meme_") && !rel.includes("/");
  });

  console.log(`[migrate-v2] Found ${rootAiMemeFiles.length} root-level ai_meme_* files to migrate`);

  if (rootAiMemeFiles.length === 0) {
    console.log("[migrate-v2] Nothing to do.");
    return;
  }

  const successfullyCopied: Array<{ oldSubPath: string; newSubPath: string }> = [];

  for (const srcFile of rootAiMemeFiles) {
    const rel = srcFile.name.slice(prefix.length);
    const newSubPath = `ai-backgrounds/${rel}`;
    const newObjectName = `${prefix}${newSubPath}`;

    console.log(`  copy: ${rel} -> ${newSubPath}`);
    try {
      await srcFile.copy(bucket.file(newObjectName));
      successfullyCopied.push({ oldSubPath: rel, newSubPath });
    } catch (err) {
      console.error(`  [error] Failed to copy ${rel}:`, err);
    }
  }

  console.log(`\n[migrate-v2] Copied ${successfullyCopied.length}/${rootAiMemeFiles.length} files`);

  if (successfullyCopied.length === 0) {
    console.error("[migrate-v2] No files were copied — aborting DB updates");
    process.exit(1);
  }

  const oldToNew = new Map(
    successfullyCopied.map(({ oldSubPath, newSubPath }) => [
      `/objects/${oldSubPath}`,
      `/objects/${newSubPath}`,
    ])
  );

  // ── 1. Update facts.ai_meme_images ─────────────────────────────────────────
  console.log("\n[migrate-v2] Updating facts.ai_meme_images...");

  const facts = await db
    .select({ id: factsTable.id, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(isNotNull(factsTable.aiMemeImages));

  let factsUpdated = 0;
  for (const fact of facts) {
    const images = fact.aiMemeImages as AiMemeImages | null;
    if (!images) continue;

    const genders: Array<keyof AiMemeImages> = ["male", "female", "neutral"];
    let changed = false;
    const newImages: AiMemeImages = { male: [], female: [], neutral: [] };

    for (const gender of genders) {
      newImages[gender] = (images[gender] ?? []).map(p => {
        const mapped = oldToNew.get(p);
        if (mapped) { changed = true; return mapped; }
        return p;
      });
    }

    if (changed) {
      await db.update(factsTable).set({ aiMemeImages: newImages }).where(eq(factsTable.id, fact.id));
      console.log(`  updated fact ${fact.id}`);
      factsUpdated++;
    }
  }

  console.log(`[migrate-v2] Updated ${factsUpdated} fact records`);

  // ── 2. Update user_ai_images.storage_path ───────────────────────────────────
  console.log("\n[migrate-v2] Updating user_ai_images.storage_path...");

  const userImages = await db
    .select({ id: userAiImagesTable.id, storagePath: userAiImagesTable.storagePath })
    .from(userAiImagesTable)
    .where(like(userAiImagesTable.storagePath, "/objects/ai_meme_%"));

  let userImagesUpdated = 0;
  for (const row of userImages) {
    const newPath = oldToNew.get(row.storagePath);
    if (!newPath) continue;

    await db
      .update(userAiImagesTable)
      .set({ storagePath: newPath })
      .where(eq(userAiImagesTable.id, row.id));

    console.log(`  updated user_ai_images row ${row.id}: ${row.storagePath} -> ${newPath}`);
    userImagesUpdated++;
  }

  console.log(`[migrate-v2] Updated ${userImagesUpdated} user_ai_images records`);

  // ── 3. Delete old root-level files ──────────────────────────────────────────
  console.log("\n[migrate-v2] Deleting old root-level files...");

  let deleted = 0;
  let deleteErrors = 0;
  for (const { oldSubPath } of successfullyCopied) {
    const oldObjectName = `${prefix}${oldSubPath}`;
    try {
      await bucket.file(oldObjectName).delete();
      deleted++;
    } catch (err) {
      console.error(`  [error] Failed to delete ${oldSubPath}:`, err);
      deleteErrors++;
    }
  }

  console.log(`[migrate-v2] Deleted ${deleted} files (${deleteErrors} errors)`);

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n[migrate-v2] Done.");
  console.log(`  Files copied:             ${successfullyCopied.length}`);
  console.log(`  Files deleted:            ${deleted}`);
  console.log(`  Facts DB rows updated:    ${factsUpdated}`);
  console.log(`  UserAiImages rows updated: ${userImagesUpdated}`);

  if (deleteErrors > 0) {
    console.warn(`[migrate-v2] WARNING: ${deleteErrors} files could not be deleted`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("[migrate-v2] Fatal error:", err);
  process.exit(1);
});
