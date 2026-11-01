/**
 * @purpose The content purger (launch Phase 5, plan "The purge job"): hourly, it removes from Overhype.me every photo, generated image and meme whose owner deleted it more than the restore window ago. Each row is claimed under its owner's lock and re-read, its storage objects deleted through preserve-before-change (the 7-day media backup keeps them, S15), then the row itself.
 * @subsystem studio
 */
import { db } from "@workspace/db";
import { memesTable, reactionsTable, uploadImageMetadataTable, userAiImagesTable } from "@workspace/db/schema";
import { and, asc, eq, gt, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";

import { aiImageIsOwnersOwn } from "../lib/contentVisibility";
import { logger } from "../lib/logger";
import { ObjectStorageService } from "../lib/objectStorage";
import { memeKey } from "../lib/storageKeys";

const BATCH = 50;

export interface PurgeCounts {
  /** Rows past their window when the run looked. */
  selected: number;
  /** Rows removed, with their objects. */
  purged: number;
  /** Rows restored, or claimed by another run, between selection and claim. */
  skipped: number;
  /** Rows whose objects could not be deleted (a media-backup refusal, say); left for the next run. */
  failed: number;
}

export interface ContentPurgeResult {
  photos: PurgeCounts;
  generated: PurgeCounts;
  memes: PurgeCounts;
}

/** `ids` restricts the run to those rows; tests use it, since every file in a shard shares one database. */
export interface PurgeScope {
  photoPaths?: string[];
  generatedIds?: number[];
  memeIds?: number[];
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const zero = (): PurgeCounts => ({ selected: 0, purged: 0, skipped: 0, failed: 0 });

/**
 * Takes the owner's content lock for the rest of the transaction, so a purge
 * and anything else that changes the owner's content in bulk (Increment 5's
 * account deletion) never interleave. Per-owner locks are `hashtext` keys,
 * not registry numbers (`lib/advisoryLockKeys.ts`).
 */
async function lockOwner(tx: Tx, ownerId: string | null): Promise<void> {
  if (ownerId) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`content-owner:${ownerId}`}))`);
}

/**
 * Runs one claim: in a transaction, under the owner's lock, re-reads the row
 * (it must still be deleted and past its window: a restore in between wins),
 * deletes its objects, then the row. Returns what happened.
 */
async function purgeOne(
  ownerId: string | null,
  claim: (tx: Tx) => Promise<boolean>,
  destroy: (tx: Tx) => Promise<void>,
  label: Record<string, unknown>,
): Promise<"purged" | "skipped" | "failed"> {
  try {
    return await db.transaction(async (tx) => {
      await lockOwner(tx, ownerId);
      if (!(await claim(tx))) return "skipped" as const;
      await destroy(tx);
      return "purged" as const;
    });
  } catch (err) {
    logger.warn({ err, ...label }, "[content-purger] could not purge; left for the next run");
    return "failed";
  }
}

async function purgePhotos(storage: ObjectStorageService, now: Date, scope: PurgeScope, counts: PurgeCounts): Promise<void> {
  const t = uploadImageMetadataTable;
  let after = "";
  for (;;) {
    const rows = await db
      .select({ objectPath: t.objectPath, userId: t.userId })
      .from(t)
      .where(and(
        isNotNull(t.deletedAt), isNotNull(t.purgeAfter), lt(t.purgeAfter, now),
        gt(t.objectPath, after),
        scope.photoPaths ? inArray(t.objectPath, scope.photoPaths) : undefined,
      ))
      .orderBy(asc(t.objectPath))
      .limit(BATCH);
    if (rows.length === 0) return;
    for (const row of rows) {
      after = row.objectPath;
      counts.selected++;
      const outcome = await purgeOne(
        row.userId,
        async (tx) => {
          const [still] = await tx
            .select({ objectPath: t.objectPath })
            .from(t)
            .where(and(eq(t.objectPath, row.objectPath), isNotNull(t.deletedAt), lt(t.purgeAfter, new Date())))
            .for("update");
          return !!still;
        },
        async (tx) => {
          await storage.deleteObject(row.objectPath);
          await tx.delete(t).where(eq(t.objectPath, row.objectPath));
        },
        { objectPath: row.objectPath },
      );
      counts[outcome]++;
    }
  }
}

async function purgeGenerated(storage: ObjectStorageService, now: Date, scope: PurgeScope, counts: PurgeCounts): Promise<void> {
  const t = userAiImagesTable;
  let afterId = 0;
  for (;;) {
    const rows = await db
      .select({ id: t.id, userId: t.userId, storagePath: t.storagePath })
      .from(t)
      .where(and(
        isNotNull(t.deletedAt), isNotNull(t.purgeAfter), lt(t.purgeAfter, now),
        gt(t.id, afterId),
        scope.generatedIds ? inArray(t.id, scope.generatedIds) : undefined,
      ))
      .orderBy(asc(t.id))
      .limit(BATCH);
    if (rows.length === 0) return;
    for (const row of rows) {
      afterId = row.id;
      counts.selected++;
      const outcome = await purgeOne(
        row.userId,
        async (tx) => {
          const [still] = await tx
            .select({ id: t.id })
            .from(t)
            .where(and(eq(t.id, row.id), isNotNull(t.deletedAt), lt(t.purgeAfter, new Date())))
            .for("update");
          return !!still;
        },
        async (tx) => {
          // The image is destroyed only when nothing else still serves it: no
          // fact gallery (a shared background is everyone's), and no other
          // row naming the same file.
          const [ownOnly] = await tx
            .select({ own: aiImageIsOwnersOwn(t) })
            .from(t)
            .where(eq(t.id, row.id));
          const [{ others }] = await tx
            .select({ others: sql<number>`count(*)::int` })
            .from(t)
            .where(and(eq(t.storagePath, row.storagePath), ne(t.id, row.id)));
          if (ownOnly?.own && others === 0) await storage.deleteObject(row.storagePath);
          await tx.delete(t).where(eq(t.id, row.id));
        },
        { generatedId: row.id },
      );
      counts[outcome]++;
    }
  }
}

/** Every key a meme's file can sit under: the baked key, and the older forms a legacy meme used. */
function memeFilePaths(slug: string): string[] {
  return [
    `/objects/${memeKey(slug, "jpg")}`,
    `/objects/${memeKey(slug, "png")}`,
    `/objects/memes/${slug}.jpg`,
    `/objects/memes/${slug}.png`,
  ];
}

async function purgeMemes(storage: ObjectStorageService, now: Date, scope: PurgeScope, counts: PurgeCounts): Promise<void> {
  const t = memesTable;
  let afterId = 0;
  for (;;) {
    const rows = await db
      .select({ id: t.id, createdById: t.createdById, slug: t.permalinkSlug })
      .from(t)
      .where(and(
        isNotNull(t.deletedAt), isNotNull(t.purgeAfter), lt(t.purgeAfter, now),
        gt(t.id, afterId),
        scope.memeIds ? inArray(t.id, scope.memeIds) : undefined,
      ))
      .orderBy(asc(t.id))
      .limit(BATCH);
    if (rows.length === 0) return;
    for (const row of rows) {
      afterId = row.id;
      counts.selected++;
      const outcome = await purgeOne(
        row.createdById,
        async (tx) => {
          const [still] = await tx
            .select({ id: t.id })
            .from(t)
            .where(and(eq(t.id, row.id), isNotNull(t.deletedAt), lt(t.purgeAfter, new Date())))
            .for("update");
          return !!still;
        },
        async (tx) => {
          // The meme's own file only: never the photo it was made from (S14).
          // A key a meme never used is absent, which counts as deleted.
          for (const path of memeFilePaths(row.slug)) await storage.deleteObject(path);
          await tx.delete(reactionsTable).where(and(eq(reactionsTable.targetType, "meme"), eq(reactionsTable.targetId, row.id)));
          await tx.delete(t).where(eq(t.id, row.id));
        },
        { memeId: row.id },
      );
      counts[outcome]++;
    }
  }
}

/**
 * One pass over all three tables. Rows with `purge_after` null — deleted
 * before the restore window existed, the content launch Phase 4 retired —
 * are never selected. Idempotent: an object already gone counts as deleted,
 * and a row already purged is not there to select.
 */
export async function runContentPurger(scope: PurgeScope = {}, now = new Date()): Promise<ContentPurgeResult> {
  const storage = new ObjectStorageService();
  const result: ContentPurgeResult = { photos: zero(), generated: zero(), memes: zero() };
  await purgePhotos(storage, now, scope, result.photos);
  await purgeGenerated(storage, now, scope, result.generated);
  await purgeMemes(storage, now, scope, result.memes);
  const total = result.photos.selected + result.generated.selected + result.memes.selected;
  if (total > 0) logger.info(result, "[content-purger] run");
  return result;
}
