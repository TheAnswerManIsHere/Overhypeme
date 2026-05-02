/**
 * Migration: Add SHA-256 hash prefix to all storage keys for GCS distribution.
 *
 * Transforms all objects in .private/{folder}/ from flat keys to:
 *   ai-backgrounds/{hash2}/{factId}-{gender}-{uniqueKey}.{ext}
 *   memes/{hash2}/{slug}.{ext}
 *   uploads/{hash2}/{uuid}.{ext}
 *
 * Algorithm (storage-first, folder-level gating):
 *   1. List all objects in each folder, skip already-hashed ones
 *   2. Copy EVERY file in the folder — accumulate errors, never abort early
 *   3. Only if ALL copies in the folder succeeded:
 *        a. Update all DB rows referencing old paths
 *        b. Delete old objects
 *   4. Emit a full summary at the end; exit 1 if any errors occurred
 *
 * Safe to re-run: already-migrated files (under {folder}/{2hexchars}/) are skipped.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run migrate:storage-keys
 */

// Install stdio guard so EIO/EPIPE on stdout/stderr (e.g. piped to `head`,
// terminal disconnect, container log-pipe overrun) cannot crash the script.
// CLI scripts intentionally keep using console.* for human-readable output.
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { db } from "@workspace/db";
import { factsTable, userAiImagesTable, memesTable, usersTable, videoJobsTable } from "@workspace/db/schema";
import { isNotNull, eq, like } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { installStdioGuard } from "../src/lib/stdioGuard";
import { objectStorageClient } from "../src/lib/objectStorage";
import { aiBackgroundKey, memeKey, uploadKey } from "../src/lib/storageKeys";
import type { AiMemeImages } from "../src/lib/aiMemePipeline";

// Task #402 / #404: absorb EIO/EPIPE on stdout/stderr so a torn-down pipe
// (e.g. workflow restart while this long-running migration is mid-flight)
// does not crash the process. Must run before any console.* call.
installStdioGuard();

// ─── Storage helpers ─────────────────────────────────────────────────────────

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

const HEX2_RE = /^[0-9a-f]{2}$/;

/** Returns true if this file is already under a {folder}/{hash2}/ prefix. */
function isAlreadyMigrated(relPath: string): boolean {
  // relPath is relative to the folder prefix (e.g. "ai-backgrounds/")
  // Migrated: "aa/32-female-0.png"  (first component is exactly 2 hex chars)
  // Not yet:  "ai_meme_32_female_0.png"
  const parts = relPath.split("/");
  return parts.length >= 2 && HEX2_RE.test(parts[0]);
}

// ─── Filename parsing ─────────────────────────────────────────────────────────

interface AiBgParts {
  factId: number;
  gender: string;
  uniqueKey: string;
  ext: string;
  isRef: boolean;
}

const AI_BG_REF_RE = /^ai_meme_(\d+)_(\w+?)_ref_(.+?)\.(\w+)$/;
const AI_BG_STD_RE = /^ai_meme_(\d+)_(\w+?)_((?!ref_).+?)\.(\w+)$/;

function parseAiBgFilename(filename: string): AiBgParts | null {
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

function parseUploadFilename(filename: string): { uploadId: string; ext?: string } {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return { uploadId: filename };
  return { uploadId: filename.slice(0, dot), ext: filename.slice(dot + 1) };
}

// ─── GCS helpers ─────────────────────────────────────────────────────────────

type GCSBucket = ReturnType<typeof objectStorageClient.bucket>;

async function copyFile(
  bucket: GCSBucket,
  prefix: string,
  oldSubPath: string,
  newSubPath: string
): Promise<"copied" | "skipped" | "missing" | "error"> {
  try {
    const srcFile = bucket.file(`${prefix}${oldSubPath}`);
    const [srcExists] = await srcFile.exists();
    if (!srcExists) {
      console.warn(`  [warn] Source missing: ${oldSubPath}`);
      return "missing";
    }
    const destFile = bucket.file(`${prefix}${newSubPath}`);
    const [destExists] = await destFile.exists();
    if (destExists) {
      console.log(`  [skip] Dest already exists: ${newSubPath}`);
      return "skipped";
    }
    await srcFile.copy(destFile);
    return "copied";
  } catch (err) {
    console.error(`  [error] Copy failed ${oldSubPath} → ${newSubPath}:`, err);
    return "error";
  }
}

async function deleteFile(
  bucket: GCSBucket,
  prefix: string,
  subPath: string
): Promise<boolean> {
  try {
    const file = bucket.file(`${prefix}${subPath}`);
    const [exists] = await file.exists();
    if (exists) await file.delete();
    return true;
  } catch (err) {
    console.error(`  [error] Delete failed ${subPath}:`, err);
    return false;
  }
}

// ─── Folder migration runner ──────────────────────────────────────────────────

interface FolderResult {
  toMigrate: number;
  copied: number;
  skipped: number;
  copyErrors: number;
  dbErrors: number;
  deleteErrors: number;
  allCopiesSucceeded: boolean;
}

interface MappingResult {
  mappings: Array<{ oldSubPath: string; newSubPath: string }>;
  parseErrors: number;
}

/**
 * Generic folder migration:
 *   - Collect all un-migrated files
 *   - Attempt every copy (never abort early)
 *   - Only if ALL copies AND parse succeeded: run dbUpdater, then delete old files
 */
async function migrateFolder(
  bucket: GCSBucket,
  prefix: string,
  folder: string,
  buildMappings: (files: string[]) => MappingResult,
  dbUpdater: (oldToNew: Map<string, string>) => Promise<number>,
): Promise<FolderResult> {
  const fullPrefix = `${prefix}${folder}/`;
  const [allFiles] = await bucket.getFiles({ prefix: fullPrefix });

  const unmigrated = allFiles.filter(f => {
    const rel = f.name.slice(fullPrefix.length);
    return rel && !isAlreadyMigrated(rel);
  });

  const filenames = unmigrated.map(f => f.name.split("/").pop()!);
  console.log(`\n[${folder}] ${unmigrated.length} files to migrate`);

  const { mappings, parseErrors } = buildMappings(filenames);

  // ── Phase 1: Copy every file, accumulate errors ────────────────────────────
  let copied = 0;
  let skipped = 0;
  let copyErrors = parseErrors; // parse failures count as copy errors to block subsequent phases
  const successMap = new Map<string, string>(); // /objects/old → /objects/new

  for (const { oldSubPath, newSubPath } of mappings) {
    console.log(`  ${oldSubPath} → ${newSubPath}`);
    const result = await copyFile(bucket, prefix, oldSubPath, newSubPath);
    if (result === "copied") {
      successMap.set(`/objects/${oldSubPath}`, `/objects/${newSubPath}`);
      copied++;
    } else if (result === "skipped") {
      // Dest already exists — treat as success for gating purposes
      successMap.set(`/objects/${oldSubPath}`, `/objects/${newSubPath}`);
      skipped++;
    } else {
      copyErrors++;
    }
  }

  const allCopiesSucceeded = copyErrors === 0;

  if (!allCopiesSucceeded) {
    console.error(`[${folder}] ${copyErrors} copy error(s) — skipping DB updates and deletions`);
    return { toMigrate: unmigrated.length, copied, skipped, copyErrors, dbErrors: 0, deleteErrors: 0, allCopiesSucceeded };
  }

  // ── Phase 2: DB updates (only if ALL copies succeeded) ────────────────────
  let dbErrors = 0;
  if (successMap.size > 0) {
    console.log(`\n[${folder}] Updating DB...`);
    try {
      const updated = await dbUpdater(successMap);
      console.log(`[${folder}] DB: ${updated} row(s) updated`);
    } catch (err) {
      console.error(`[${folder}] DB update error:`, err);
      dbErrors++;
    }
  }

  // ── Phase 3: Delete old files (only if DB updates succeeded) ────────────────
  let deleteErrors = 0;
  if (dbErrors > 0) {
    console.error(`[${folder}] DB error(s) occurred — skipping deletion to preserve data integrity`);
  } else {
    console.log(`\n[${folder}] Deleting old files...`);
    for (const [oldObjPath] of successMap) {
      const oldSubPath = oldObjPath.slice("/objects/".length);
      const ok = await deleteFile(bucket, prefix, oldSubPath);
      if (!ok) deleteErrors++;
    }
  }

  const totalHandled = copied + skipped;
  console.log(`[${folder}] done. handled=${totalHandled} (copied=${copied} skipped=${skipped}) dbErrors=${dbErrors} deleteErrors=${deleteErrors}`);
  return { toMigrate: unmigrated.length, copied, skipped, copyErrors, dbErrors, deleteErrors, allCopiesSucceeded };
}

// ─── DB updaters ─────────────────────────────────────────────────────────────

async function dbUpdateAiBackgrounds(oldToNew: Map<string, string>): Promise<number> {
  let updated = 0;

  // facts.ai_meme_images (JSONB)
  const facts = await db
    .select({ id: factsTable.id, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(isNotNull(factsTable.aiMemeImages));

  for (const fact of facts) {
    const images = fact.aiMemeImages as AiMemeImages | null;
    if (!images) continue;
    let changed = false;
    const newImages: AiMemeImages = { male: [], female: [], neutral: [] };
    for (const g of ["male", "female", "neutral"] as const) {
      newImages[g] = (images[g] ?? []).map(p => {
        const mapped = oldToNew.get(p);
        if (mapped) { changed = true; return mapped; }
        return p;
      });
    }
    if (changed) {
      try {
        await db.update(factsTable).set({ aiMemeImages: newImages }).where(eq(factsTable.id, fact.id));
        console.log(`  facts row ${fact.id} updated`);
        updated++;
      } catch (err) {
        console.error(`  [error] facts row ${fact.id}:`, err);
        throw err;
      }
    }
  }

  // user_ai_images.storage_path
  const uaiRows = await db
    .select({ id: userAiImagesTable.id, storagePath: userAiImagesTable.storagePath })
    .from(userAiImagesTable)
    .where(like(userAiImagesTable.storagePath, "/objects/ai-backgrounds/%"));

  for (const row of uaiRows) {
    const newPath = oldToNew.get(row.storagePath);
    if (!newPath) continue;
    try {
      await db.update(userAiImagesTable).set({ storagePath: newPath }).where(eq(userAiImagesTable.id, row.id));
      console.log(`  user_ai_images row ${row.id}: ${row.storagePath} → ${newPath}`);
      updated++;
    } catch (err) {
      console.error(`  [error] user_ai_images row ${row.id}:`, err);
      throw err;
    }
  }

  return updated;
}

async function dbUpdateMemes(_oldToNew: Map<string, string>): Promise<number> {
  // Pre-rendered meme paths are derived from the slug at read time (not stored).
  // The read path already has hash-prefix + legacy fallback — no DB updates needed.
  return 0;
}

async function dbUpdateUploads(oldToNew: Map<string, string>): Promise<number> {
  let updated = 0;

  // upload_image_metadata: PK = object_path → must INSERT then DELETE
  for (const [oldPath, newPath] of oldToNew) {
    try {
      const rows = await db.execute(sql`
        SELECT object_path, width, height, is_low_res, file_size_bytes, user_id
        FROM upload_image_metadata
        WHERE object_path = ${oldPath}
      `);
      if (!rows.rows.length) continue;

      const row = rows.rows[0] as {
        width: number | null;
        height: number | null;
        is_low_res: boolean | null;
        file_size_bytes: number | null;
        user_id: string | null;
      };

      await db.execute(sql`
        INSERT INTO upload_image_metadata (object_path, width, height, is_low_res, file_size_bytes, user_id)
        VALUES (${newPath}, ${row.width}, ${row.height}, ${row.is_low_res}, ${row.file_size_bytes}, ${row.user_id})
        ON CONFLICT (object_path) DO NOTHING
      `);
      await db.execute(sql`DELETE FROM upload_image_metadata WHERE object_path = ${oldPath}`);
      console.log(`  upload_image_metadata: ${oldPath} → ${newPath}`);
      updated++;
    } catch (err) {
      console.error(`  [error] upload_image_metadata ${oldPath}:`, err);
      throw err;
    }
  }

  // memes.image_source JSONB uploadKey
  const memes = await db
    .select({ id: memesTable.id, imageSource: memesTable.imageSource })
    .from(memesTable)
    .where(isNotNull(memesTable.imageSource));

  for (const meme of memes) {
    const src = meme.imageSource as { type: string; uploadKey?: string } | null;
    if (!src || src.type !== "upload" || !src.uploadKey) continue;
    const newKey = oldToNew.get(src.uploadKey);
    if (!newKey) continue;
    try {
      await db.update(memesTable).set({ imageSource: { ...src, uploadKey: newKey } }).where(eq(memesTable.id, meme.id));
      console.log(`  memes row ${meme.id}: uploadKey ${src.uploadKey} → ${newKey}`);
      updated++;
    } catch (err) {
      console.error(`  [error] memes row ${meme.id}:`, err);
      throw err;
    }
  }

  // users.profile_image_url and video_jobs.image_url: stored as /api/storage/objects/uploads/...
  const apiOldToNew = new Map<string, string>();
  for (const [oldObjPath, newObjPath] of oldToNew) {
    apiOldToNew.set(`/api/storage${oldObjPath}`, `/api/storage${newObjPath}`);
  }

  const users = await db
    .select({ id: usersTable.id, profileImageUrl: usersTable.profileImageUrl })
    .from(usersTable)
    .where(like(usersTable.profileImageUrl, "/api/storage/objects/uploads/%"));

  for (const user of users) {
    if (!user.profileImageUrl) continue;
    const newUrl = apiOldToNew.get(user.profileImageUrl);
    if (!newUrl) continue;
    try {
      await db.update(usersTable).set({ profileImageUrl: newUrl }).where(eq(usersTable.id, user.id));
      console.log(`  users row ${user.id}: ${user.profileImageUrl} → ${newUrl}`);
      updated++;
    } catch (err) {
      console.error(`  [error] users row ${user.id}:`, err);
      throw err;
    }
  }

  // video_jobs.image_url: may reference /api/storage/objects/uploads/... for user-uploaded images
  const videoJobs = await db
    .select({ id: videoJobsTable.id, imageUrl: videoJobsTable.imageUrl })
    .from(videoJobsTable)
    .where(like(videoJobsTable.imageUrl, "/api/storage/objects/uploads/%"));

  for (const job of videoJobs) {
    const newUrl = apiOldToNew.get(job.imageUrl);
    if (!newUrl) continue;
    try {
      await db.update(videoJobsTable).set({ imageUrl: newUrl }).where(eq(videoJobsTable.id, job.id));
      console.log(`  video_jobs row ${job.id}: ${job.imageUrl} → ${newUrl}`);
      updated++;
    } catch (err) {
      console.error(`  [error] video_jobs row ${job.id}:`, err);
      throw err;
    }
  }

  return updated;
}

// ─── Mapping builders ─────────────────────────────────────────────────────────

function buildAiBgMappings(filenames: string[]): MappingResult {
  const mappings: Array<{ oldSubPath: string; newSubPath: string }> = [];
  let parseErrors = 0;
  for (const filename of filenames) {
    const parts = parseAiBgFilename(filename);
    if (!parts) {
      console.error(`  [error] Cannot parse ai-bg filename: ${filename}`);
      parseErrors++;
      continue;
    }
    mappings.push({
      oldSubPath: `ai-backgrounds/${filename}`,
      newSubPath: aiBackgroundKey(parts.factId, parts.gender, parts.uniqueKey, parts.ext, parts.isRef),
    });
  }
  return { mappings, parseErrors };
}

function buildMemesMappings(filenames: string[]): MappingResult {
  const mappings = filenames.map(filename => {
    const dot = filename.lastIndexOf(".");
    const slug = dot !== -1 ? filename.slice(0, dot) : filename;
    const ext = dot !== -1 ? filename.slice(dot + 1) : "jpg";
    return {
      oldSubPath: `memes/${filename}`,
      newSubPath: memeKey(slug, ext),
    };
  });
  return { mappings, parseErrors: 0 };
}

function buildUploadsMappings(filenames: string[]): MappingResult {
  const mappings = filenames.map(filename => {
    const { uploadId, ext } = parseUploadFilename(filename);
    return {
      oldSubPath: `uploads/${filename}`,
      newSubPath: uploadKey(uploadId, ext),
    };
  });
  return { mappings, parseErrors: 0 };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dir = getPrivateObjectDir();
  const { bucketName, objectName: prefixRaw } = parseObjectPath(dir);
  const prefix = prefixRaw.endsWith("/") ? prefixRaw : `${prefixRaw}/`;
  const bucket = objectStorageClient.bucket(bucketName);

  console.log(`[migrate-storage-keys] Bucket: ${bucketName}  Prefix: ${prefix}`);

  const bgResult = await migrateFolder(bucket, prefix, "ai-backgrounds", buildAiBgMappings, dbUpdateAiBackgrounds);
  const memesResult = await migrateFolder(bucket, prefix, "memes", buildMemesMappings, dbUpdateMemes);
  const uploadsResult = await migrateFolder(bucket, prefix, "uploads", buildUploadsMappings, dbUpdateUploads);

  const totalCopyErrors = bgResult.copyErrors + memesResult.copyErrors + uploadsResult.copyErrors;
  const totalDbErrors = bgResult.dbErrors + memesResult.dbErrors + uploadsResult.dbErrors;
  const totalDeleteErrors = bgResult.deleteErrors + memesResult.deleteErrors + uploadsResult.deleteErrors;
  const totalErrors = totalCopyErrors + totalDbErrors + totalDeleteErrors;

  console.log("\n═══════════════════════════════════════════");
  console.log("[migrate-storage-keys] Summary");
  console.log(`  ai-backgrounds: to_migrate=${bgResult.toMigrate} copied=${bgResult.copied} skipped=${bgResult.skipped} copyErr=${bgResult.copyErrors} dbErr=${bgResult.dbErrors} delErr=${bgResult.deleteErrors}`);
  console.log(`  memes:          to_migrate=${memesResult.toMigrate} copied=${memesResult.copied} skipped=${memesResult.skipped} copyErr=${memesResult.copyErrors} dbErr=${memesResult.dbErrors} delErr=${memesResult.deleteErrors}`);
  console.log(`  uploads:        to_migrate=${uploadsResult.toMigrate} copied=${uploadsResult.copied} skipped=${uploadsResult.skipped} copyErr=${uploadsResult.copyErrors} dbErr=${uploadsResult.dbErrors} delErr=${uploadsResult.deleteErrors}`);
  console.log(`  Total errors: ${totalErrors} (copy=${totalCopyErrors} db=${totalDbErrors} delete=${totalDeleteErrors})`);
  console.log("═══════════════════════════════════════════");

  if (totalErrors > 0) {
    console.error("[migrate-storage-keys] Completed with errors — review logs above");
    process.exit(1);
  } else {
    console.log("[migrate-storage-keys] All done, no errors.");
  }
}

main().catch(err => {
  console.error("[migrate-storage-keys] Fatal error:", err);
  process.exit(1);
});
