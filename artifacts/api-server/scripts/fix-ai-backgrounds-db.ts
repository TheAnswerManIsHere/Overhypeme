/**
 * Fix AI background DB paths after storage migration.
 *
 * State: Files are already at .private/ai-backgrounds/{hash2}/{factId}-{gender}-{uniqueKey}.{ext}
 *        but the facts.ai_meme_images DB column still contains old root-level paths like
 *        /objects/ai_meme_33_male_0.png
 *
 * This script:
 *  1. Reads all facts with old-format ai_meme_images paths
 *  2. For each path, parses the factId/gender/uniqueKey/ext
 *  3. Computes the new canonical path via aiBackgroundKey()
 *  4. Verifies the file exists in GCS (skip if missing — don't break the record)
 *  5. Updates the DB row
 *
 * Safe to re-run: already-correct paths (starting with /objects/ai-backgrounds/) are skipped.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run fix:ai-backgrounds-db
 */

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { isNotNull, eq } from "drizzle-orm";
import { installStdioGuard } from "../src/lib/stdioGuard";
import { objectStorageClient } from "../src/lib/objectStorage";
import { aiBackgroundKey } from "../src/lib/storageKeys";
import type { AiMemeImages } from "../src/lib/aiMemePipeline";

// Task #402 / #404: absorb EIO/EPIPE on stdout/stderr so a torn-down pipe
// (e.g. workflow restart while this long-running fix-up is mid-flight)
// does not crash the process. Must run before any console.* call.
installStdioGuard();

const AI_BG_REF_RE = /^ai_meme_(\d+)_(\w+?)_ref_(.+?)\.(\w+)$/;
const AI_BG_STD_RE = /^ai_meme_(\d+)_(\w+?)_((?!ref_).+?)\.(\w+)$/;

interface ParsedPath {
  factId: number;
  gender: string;
  uniqueKey: string;
  ext: string;
  isRef: boolean;
}

function parseOldFilename(filename: string): ParsedPath | null {
  let m = AI_BG_REF_RE.exec(filename);
  if (m) {
    return { factId: parseInt(m[1], 10), gender: m[2], uniqueKey: m[3], ext: m[4], isRef: true };
  }
  m = AI_BG_STD_RE.exec(filename);
  if (m) {
    return { factId: parseInt(m[1], 10), gender: m[2], uniqueKey: m[3], ext: m[4], isRef: false };
  }
  return null;
}

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

async function fileExists(subPath: string): Promise<boolean> {
  const dir = getPrivateObjectDir();
  const fullPath = `${dir}${subPath}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const bucket = objectStorageClient.bucket(bucketName);
  const [exists] = await bucket.file(objectName).exists();
  return exists;
}

async function main() {
  console.log("[fix-ai-backgrounds-db] Loading facts with ai_meme_images...");

  const facts = await db
    .select({ id: factsTable.id, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(isNotNull(factsTable.aiMemeImages));

  console.log(`[fix-ai-backgrounds-db] Found ${facts.length} facts with aiMemeImages\n`);

  let factsUpdated = 0;
  let pathsFixed = 0;
  let pathsSkipped = 0;
  let pathsMissing = 0;
  let pathsErrors = 0;

  for (const fact of facts) {
    const images = fact.aiMemeImages as AiMemeImages | null;
    if (!images) continue;

    const newImages: AiMemeImages = { male: [], female: [], neutral: [] };
    let changed = false;

    for (const gender of ["male", "female", "neutral"] as const) {
      for (const oldDbPath of images[gender] ?? []) {
        if (!oldDbPath) { newImages[gender].push(oldDbPath); continue; }

        // Already in new format?
        if (oldDbPath.startsWith("/objects/ai-backgrounds/")) {
          newImages[gender].push(oldDbPath);
          pathsSkipped++;
          continue;
        }

        // Not an ai_meme path — leave as-is
        if (!oldDbPath.startsWith("/objects/ai_meme_")) {
          newImages[gender].push(oldDbPath);
          pathsSkipped++;
          continue;
        }

        const filename = oldDbPath.slice("/objects/".length);
        const parsed = parseOldFilename(filename);

        if (!parsed) {
          console.warn(`  [fact ${fact.id}/${gender}] Cannot parse filename: ${filename} — leaving as-is`);
          newImages[gender].push(oldDbPath);
          pathsErrors++;
          continue;
        }

        const newSubPath = aiBackgroundKey(parsed.factId, parsed.gender, parsed.uniqueKey, parsed.ext, parsed.isRef);
        const newDbPath = `/objects/${newSubPath}`;

        // Verify the file actually exists in GCS before pointing the DB at it
        const exists = await fileExists(newSubPath);
        if (!exists) {
          console.warn(`  [fact ${fact.id}/${gender}] File not found in GCS: ${newSubPath} — leaving old path`);
          newImages[gender].push(oldDbPath);
          pathsMissing++;
          continue;
        }

        console.log(`  [fact ${fact.id}/${gender}] ${oldDbPath} → ${newDbPath}`);
        newImages[gender].push(newDbPath);
        changed = true;
        pathsFixed++;
      }
    }

    if (changed) {
      await db
        .update(factsTable)
        .set({ aiMemeImages: newImages })
        .where(eq(factsTable.id, fact.id));
      factsUpdated++;
    }
  }

  console.log("\n─────────────────────────────────────────");
  console.log("[fix-ai-backgrounds-db] Done.");
  console.log(`  Facts updated : ${factsUpdated}`);
  console.log(`  Paths fixed   : ${pathsFixed}`);
  console.log(`  Paths skipped : ${pathsSkipped} (already correct)`);
  console.log(`  Paths missing : ${pathsMissing} (file not in GCS)`);
  console.log(`  Parse errors  : ${pathsErrors}`);

  if (pathsMissing > 0 || pathsErrors > 0) {
    console.warn("\n[fix-ai-backgrounds-db] WARNING: some paths could not be fixed — review above");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("[fix-ai-backgrounds-db] Fatal error:", err);
  process.exit(1);
});
