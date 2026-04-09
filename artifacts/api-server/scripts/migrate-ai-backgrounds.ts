/**
 * Migration: Move AI meme background images into the ai-backgrounds/ subfolder.
 *
 * Reads all facts with aiMemeImages stored at the root level (paths like
 * /objects/ai_meme_*), copies each file to ai-backgrounds/<filename>, updates
 * the database to reflect the new paths, and deletes the old root-level files.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run migrate:ai-backgrounds
 *
 * Safe to re-run: already-migrated paths (under ai-backgrounds/) are skipped.
 *
 * A fact is only updated in the DB if ALL its file copies succeed.
 * If any source file is missing in storage, the fact is counted as an error
 * and its DB record is left unchanged.
 */

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { isNotNull, eq } from "drizzle-orm";
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

/**
 * Given a stored path, return the new ai-backgrounds/-prefixed path if migration is needed.
 * Only matches strictly root-level paths: /objects/ai_meme_<rest> (no extra slashes in subPath).
 * Returns null if the path is already under ai-backgrounds/, not an ai_meme_ file, or nested.
 */
function computeNewPath(oldPath: string): string | null {
  if (!oldPath.startsWith("/objects/")) return null;
  const subPath = oldPath.slice("/objects/".length);

  if (subPath.startsWith("ai-backgrounds/")) return null;

  if (subPath.includes("/")) return null;

  if (!subPath.startsWith("ai_meme_")) return null;

  return `/objects/ai-backgrounds/${subPath}`;
}

/**
 * Copy a file within the same GCS bucket from one subPath to another.
 * Returns true if the copy succeeded, false if the source file was not found.
 * Throws on unexpected errors.
 */
async function copyFile(oldSubPath: string, newSubPath: string): Promise<boolean> {
  const dir = getPrivateObjectDir();
  const { bucketName, objectName: oldObjectName } = parseObjectPath(`${dir}${oldSubPath}`);
  const bucket = objectStorageClient.bucket(bucketName);
  const { objectName: newObjectName } = parseObjectPath(`${dir}${newSubPath}`);

  const srcFile = bucket.file(oldObjectName);
  const [exists] = await srcFile.exists();
  if (!exists) {
    return false;
  }

  await srcFile.copy(bucket.file(newObjectName));
  return true;
}

async function deleteFile(subPath: string): Promise<void> {
  const dir = getPrivateObjectDir();
  const { bucketName, objectName } = parseObjectPath(`${dir}${subPath}`);
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  const [exists] = await file.exists();
  if (exists) {
    await file.delete();
  }
}

async function main() {
  console.log("[migrate] Fetching facts with aiMemeImages...");

  const facts = await db
    .select({ id: factsTable.id, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(isNotNull(factsTable.aiMemeImages));

  console.log(`[migrate] Found ${facts.length} facts with aiMemeImages`);

  let migratedFacts = 0;
  let skippedFacts = 0;
  let errorFacts = 0;

  for (const fact of facts) {
    const images = fact.aiMemeImages as AiMemeImages | null;
    if (!images) continue;

    const genders: Array<keyof AiMemeImages> = ["male", "female", "neutral"];
    const pathsToMigrate: Array<{ oldPath: string; newPath: string }> = [];

    for (const gender of genders) {
      const paths = images[gender] ?? [];
      for (const oldPath of paths) {
        if (!oldPath) continue;
        const newPath = computeNewPath(oldPath);
        if (newPath) {
          pathsToMigrate.push({ oldPath, newPath });
        }
      }
    }

    if (pathsToMigrate.length === 0) {
      skippedFacts++;
      continue;
    }

    console.log(`[migrate] Fact ${fact.id}: migrating ${pathsToMigrate.length} file(s)`);

    try {
      const successfullyCopied: Array<{ oldPath: string; newPath: string }> = [];
      let anyMissing = false;

      for (const { oldPath, newPath } of pathsToMigrate) {
        const oldSubPath = oldPath.slice("/objects/".length);
        const newSubPath = newPath.slice("/objects/".length);
        console.log(`  copy: /objects/${oldSubPath} -> /objects/${newSubPath}`);
        const ok = await copyFile(oldSubPath, newSubPath);
        if (ok) {
          successfullyCopied.push({ oldPath, newPath });
        } else {
          console.warn(`  [warn] Source missing in storage: /objects/${oldSubPath} — skipping DB update for fact ${fact.id}`);
          anyMissing = true;
        }
      }

      if (anyMissing) {
        console.error(`[migrate] Fact ${fact.id}: one or more source files were missing — DB record NOT updated`);
        errorFacts++;
        continue;
      }

      const copiedOldPaths = new Set(successfullyCopied.map(c => c.oldPath));
      const copiedNewByOld = new Map(successfullyCopied.map(c => [c.oldPath, c.newPath]));

      const newImages: AiMemeImages = {
        male: images.male?.map(p => copiedNewByOld.get(p) ?? p) ?? [],
        female: images.female?.map(p => copiedNewByOld.get(p) ?? p) ?? [],
        neutral: images.neutral?.map(p => copiedNewByOld.get(p) ?? p) ?? [],
      };

      await db
        .update(factsTable)
        .set({ aiMemeImages: newImages })
        .where(eq(factsTable.id, fact.id));

      for (const { oldPath } of successfullyCopied) {
        const oldSubPath = oldPath.slice("/objects/".length);
        console.log(`  delete: /objects/${oldSubPath}`);
        await deleteFile(oldSubPath);
      }

      migratedFacts++;
    } catch (err) {
      console.error(`[migrate] Error migrating fact ${fact.id}:`, err);
      errorFacts++;
    }
  }

  console.log(`\n[migrate] Done.`);
  console.log(`  Migrated: ${migratedFacts} facts`);
  console.log(`  Skipped (already migrated): ${skippedFacts} facts`);
  console.log(`  Errors: ${errorFacts} facts`);

  if (errorFacts > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
