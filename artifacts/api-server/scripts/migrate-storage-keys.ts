/**
 * Migration: Add SHA-256 hash prefix to all storage keys for GCS distribution.
 *
 * Transforms all objects in .private/{folder}/ from flat keys to:
 *   ai-backgrounds/{hash2}/{factId}-{gender}-{uniqueKey}.{ext}
 *   memes/{hash2}/{slug}.{ext}
 *   uploads/{hash2}/{uuid}.{ext}
 *
 * Algorithm (storage-first):
 *   1. List all objects in each folder, skip already-hashed ones
 *   2. Copy each to the new key
 *   3. Update all DB rows referencing the old path
 *   4. Delete old objects
 *
 * Safe to re-run: already-migrated files (under {folder}/{2hexchars}/) are skipped.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run migrate:storage-keys
 */

import { db } from "@workspace/db";
import { factsTable, userAiImagesTable, memesTable, usersTable } from "@workspace/db/schema";
import { isNotNull, eq, like, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { objectStorageClient } from "../src/lib/objectStorage";
import { aiBackgroundKey, memeKey, uploadKey } from "../src/lib/storageKeys";
import type { AiMemeImages } from "../src/lib/aiMemePipeline";

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
  const parts = relPath.split("/");
  // relPath is relative to the folder (e.g. "ai-backgrounds/").
  // An already-migrated file looks like:  aa/32-female-0.png  (2 parts)
  // An un-migrated file looks like:       ai_meme_32_female_0.png  (1 part)
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

const AI_BG_STD_RE = /^ai_meme_(\d+)_(\w+?)_((?!ref_).+?)\.(\w+)$/;
const AI_BG_REF_RE = /^ai_meme_(\d+)_(\w+?)_ref_(.+?)\.(\w+)$/;

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

/** Parse uploads/{uuid}.{ext} or uploads/{uuid} */
function parseUploadFilename(filename: string): { uploadId: string; ext?: string } {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return { uploadId: filename };
  return { uploadId: filename.slice(0, dot), ext: filename.slice(dot + 1) };
}

// ─── GCS copy helper ──────────────────────────────────────────────────────────

async function copyFile(
  bucket: ReturnType<typeof objectStorageClient.bucket>,
  prefix: string,
  oldSubPath: string,
  newSubPath: string
): Promise<boolean> {
  const srcFile = bucket.file(`${prefix}${oldSubPath}`);
  const [exists] = await srcFile.exists();
  if (!exists) {
    console.warn(`  [warn] Source missing in storage: ${oldSubPath}`);
    return false;
  }
  const destFile = bucket.file(`${prefix}${newSubPath}`);
  const [destExists] = await destFile.exists();
  if (destExists) {
    console.log(`  [skip] Dest already exists: ${newSubPath}`);
    return true;
  }
  await srcFile.copy(destFile);
  return true;
}

async function deleteFile(
  bucket: ReturnType<typeof objectStorageClient.bucket>,
  prefix: string,
  subPath: string
): Promise<void> {
  const file = bucket.file(`${prefix}${subPath}`);
  const [exists] = await file.exists();
  if (exists) await file.delete();
}

// ─── Migrate ai-backgrounds/ ─────────────────────────────────────────────────

async function migrateAiBackgrounds(
  bucket: ReturnType<typeof objectStorageClient.bucket>,
  prefix: string
): Promise<{ copied: number; errors: number; oldToNew: Map<string, string> }> {
  const folder = "ai-backgrounds/";
  const [files] = await bucket.getFiles({ prefix: `${prefix}${folder}` });

  const toMigrate = files.filter(f => {
    const rel = f.name.slice(`${prefix}${folder}`.length);
    return rel && !isAlreadyMigrated(rel);
  });

  console.log(`\n[ai-backgrounds] ${toMigrate.length} files to migrate`);

  let copied = 0;
  let errors = 0;
  const oldToNew = new Map<string, string>(); // /objects/old → /objects/new

  for (const f of toMigrate) {
    const filename = f.name.split("/").pop()!;
    const parts = parseAiBgFilename(filename);
    if (!parts) {
      console.warn(`  [skip] Cannot parse ai-bg filename: ${filename}`);
      continue;
    }
    const newSubPath = aiBackgroundKey(parts.factId, parts.gender, parts.uniqueKey, parts.ext, parts.isRef);
    const oldSubPath = `${folder}${filename}`;
    console.log(`  ${oldSubPath} → ${newSubPath}`);

    const ok = await copyFile(bucket, prefix, oldSubPath, newSubPath);
    if (ok) {
      oldToNew.set(`/objects/${oldSubPath}`, `/objects/${newSubPath}`);
      copied++;
    } else {
      errors++;
    }
  }

  // ── DB updates ──────────────────────────────────────────────────────────────
  if (oldToNew.size > 0) {
    console.log(`\n[ai-backgrounds] Updating DB...`);
    await updateFactsAiMemeImages(oldToNew);
    await updateUserAiImages(oldToNew);
  }

  // ── Deletions ───────────────────────────────────────────────────────────────
  let deleted = 0;
  for (const [oldObjPath] of oldToNew) {
    const oldSubPath = oldObjPath.slice("/objects/".length);
    await deleteFile(bucket, prefix, oldSubPath);
    deleted++;
  }
  console.log(`[ai-backgrounds] done. copied=${copied} deleted=${deleted} errors=${errors}`);
  return { copied, errors, oldToNew };
}

async function updateFactsAiMemeImages(oldToNew: Map<string, string>): Promise<void> {
  const facts = await db
    .select({ id: factsTable.id, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(isNotNull(factsTable.aiMemeImages));

  let updated = 0;
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
      await db.update(factsTable).set({ aiMemeImages: newImages }).where(eq(factsTable.id, fact.id));
      console.log(`  facts row ${fact.id} updated`);
      updated++;
    }
  }
  console.log(`  facts: ${updated} rows updated`);
}

async function updateUserAiImages(oldToNew: Map<string, string>): Promise<void> {
  const rows = await db
    .select({ id: userAiImagesTable.id, storagePath: userAiImagesTable.storagePath })
    .from(userAiImagesTable)
    .where(like(userAiImagesTable.storagePath, "/objects/ai-backgrounds/%"));

  let updated = 0;
  for (const row of rows) {
    const newPath = oldToNew.get(row.storagePath);
    if (!newPath) continue;
    await db.update(userAiImagesTable).set({ storagePath: newPath }).where(eq(userAiImagesTable.id, row.id));
    console.log(`  user_ai_images row ${row.id}: ${row.storagePath} → ${newPath}`);
    updated++;
  }
  console.log(`  user_ai_images: ${updated} rows updated`);
}

// ─── Migrate memes/ ──────────────────────────────────────────────────────────

async function migrateMemes(
  bucket: ReturnType<typeof objectStorageClient.bucket>,
  prefix: string
): Promise<{ copied: number; errors: number }> {
  const folder = "memes/";
  const [files] = await bucket.getFiles({ prefix: `${prefix}${folder}` });

  const toMigrate = files.filter(f => {
    const rel = f.name.slice(`${prefix}${folder}`.length);
    return rel && !isAlreadyMigrated(rel);
  });

  console.log(`\n[memes] ${toMigrate.length} files to migrate`);

  let copied = 0;
  let errors = 0;
  const oldToNew = new Map<string, string>();

  for (const f of toMigrate) {
    const filename = f.name.split("/").pop()!;
    const dot = filename.lastIndexOf(".");
    const slug = dot !== -1 ? filename.slice(0, dot) : filename;
    const ext = dot !== -1 ? filename.slice(dot + 1) : "jpg";

    const newSubPath = memeKey(slug, ext);
    const oldSubPath = `${folder}${filename}`;
    console.log(`  ${oldSubPath} → ${newSubPath}`);

    const ok = await copyFile(bucket, prefix, oldSubPath, newSubPath);
    if (ok) {
      oldToNew.set(`/objects/${oldSubPath}`, `/objects/${newSubPath}`);
      copied++;
    } else {
      errors++;
    }
  }

  // Memes: no DB column stores the pre-rendered path directly —
  // it's derived from the slug at read time. The read path already has
  // fallback logic for both hash-prefixed and legacy paths, so no DB update needed.
  // (When imageSource is null, the server tries the hash-prefixed key first.)

  let deleted = 0;
  for (const [oldObjPath] of oldToNew) {
    const oldSubPath = oldObjPath.slice("/objects/".length);
    await deleteFile(bucket, prefix, oldSubPath);
    deleted++;
  }
  console.log(`[memes] done. copied=${copied} deleted=${deleted} errors=${errors}`);
  return { copied, errors };
}

// ─── Migrate uploads/ ────────────────────────────────────────────────────────

async function migrateUploads(
  bucket: ReturnType<typeof objectStorageClient.bucket>,
  prefix: string
): Promise<{ copied: number; errors: number }> {
  const folder = "uploads/";
  const [files] = await bucket.getFiles({ prefix: `${prefix}${folder}` });

  const toMigrate = files.filter(f => {
    const rel = f.name.slice(`${prefix}${folder}`.length);
    return rel && !isAlreadyMigrated(rel);
  });

  console.log(`\n[uploads] ${toMigrate.length} files to migrate`);

  let copied = 0;
  let errors = 0;
  const oldToNew = new Map<string, string>(); // /objects/old → /objects/new

  for (const f of toMigrate) {
    const filename = f.name.split("/").pop()!;
    const { uploadId, ext } = parseUploadFilename(filename);
    const newSubPath = uploadKey(uploadId, ext);
    const oldSubPath = `${folder}${filename}`;
    console.log(`  ${oldSubPath} → ${newSubPath}`);

    const ok = await copyFile(bucket, prefix, oldSubPath, newSubPath);
    if (ok) {
      oldToNew.set(`/objects/${oldSubPath}`, `/objects/${newSubPath}`);
      copied++;
    } else {
      errors++;
    }
  }

  if (oldToNew.size > 0) {
    console.log(`\n[uploads] Updating DB...`);
    await updateUploadImageMetadata(oldToNew);
    await updateMemesImageSource(oldToNew);
    await updateUsersProfileImageUrl(oldToNew);
  }

  let deleted = 0;
  for (const [oldObjPath] of oldToNew) {
    const oldSubPath = oldObjPath.slice("/objects/".length);
    await deleteFile(bucket, prefix, oldSubPath);
    deleted++;
  }
  console.log(`[uploads] done. copied=${copied} deleted=${deleted} errors=${errors}`);
  return { copied, errors };
}

async function updateUploadImageMetadata(oldToNew: Map<string, string>): Promise<void> {
  // object_path is the PK — must INSERT new row then DELETE old row
  for (const [oldPath, newPath] of oldToNew) {
    const rows = await db.execute(sql`
      SELECT object_path, width, height, is_low_res, file_size_bytes, user_id
      FROM upload_image_metadata
      WHERE object_path = ${oldPath}
    `);
    if (!rows.rows.length) continue;

    const row = rows.rows[0] as {
      object_path: string;
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
  }
}

async function updateMemesImageSource(oldToNew: Map<string, string>): Promise<void> {
  // memes.image_source is JSONB — find rows where uploadKey matches an old path
  const memes = await db
    .select({ id: memesTable.id, imageSource: memesTable.imageSource })
    .from(memesTable)
    .where(isNotNull(memesTable.imageSource));

  let updated = 0;
  for (const meme of memes) {
    const src = meme.imageSource as { type: string; uploadKey?: string } | null;
    if (!src || src.type !== "upload" || !src.uploadKey) continue;
    const newKey = oldToNew.get(src.uploadKey);
    if (!newKey) continue;
    const newSrc = { ...src, uploadKey: newKey };
    await db.update(memesTable).set({ imageSource: newSrc }).where(eq(memesTable.id, meme.id));
    console.log(`  memes row ${meme.id}: uploadKey ${src.uploadKey} → ${newKey}`);
    updated++;
  }
  console.log(`  memes: ${updated} rows updated`);
}

async function updateUsersProfileImageUrl(oldToNew: Map<string, string>): Promise<void> {
  // users.profile_image_url stores the API path: /api/storage/objects/uploads/...
  // Build a map from API-path format
  const apiOldToNew = new Map<string, string>();
  for (const [oldObjPath, newObjPath] of oldToNew) {
    // /objects/uploads/... → /api/storage/objects/uploads/...
    const apiOld = `/api/storage${oldObjPath}`;
    const apiNew = `/api/storage${newObjPath}`;
    apiOldToNew.set(apiOld, apiNew);
  }

  const users = await db
    .select({ id: usersTable.id, profileImageUrl: usersTable.profileImageUrl })
    .from(usersTable)
    .where(like(usersTable.profileImageUrl, "/api/storage/objects/uploads/%"));

  let updated = 0;
  for (const user of users) {
    if (!user.profileImageUrl) continue;
    const newUrl = apiOldToNew.get(user.profileImageUrl);
    if (!newUrl) continue;
    await db.update(usersTable).set({ profileImageUrl: newUrl }).where(eq(usersTable.id, user.id));
    console.log(`  users row ${user.id}: ${user.profileImageUrl} → ${newUrl}`);
    updated++;
  }
  console.log(`  users: ${updated} rows updated`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dir = getPrivateObjectDir();
  const { bucketName, objectName: prefixRaw } = parseObjectPath(dir);
  const prefix = prefixRaw.endsWith("/") ? prefixRaw : `${prefixRaw}/`;
  const bucket = objectStorageClient.bucket(bucketName);

  console.log(`[migrate-storage-keys] Bucket: ${bucketName}  Prefix: ${prefix}`);

  const bgResult = await migrateAiBackgrounds(bucket, prefix);
  const memesResult = await migrateMemes(bucket, prefix);
  const uploadsResult = await migrateUploads(bucket, prefix);

  const totalErrors = bgResult.errors + memesResult.errors + uploadsResult.errors;

  console.log("\n═══════════════════════════════════════════");
  console.log("[migrate-storage-keys] Summary");
  console.log(`  ai-backgrounds: copied=${bgResult.copied} errors=${bgResult.errors}`);
  console.log(`  memes:          copied=${memesResult.copied} errors=${memesResult.errors}`);
  console.log(`  uploads:        copied=${uploadsResult.copied} errors=${uploadsResult.errors}`);
  console.log(`  Total errors: ${totalErrors}`);
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
