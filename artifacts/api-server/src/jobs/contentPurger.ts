/**
 * @purpose The content purger (launch Phase 5, plan "The purge job"): hourly, it removes from Overhype.me every photo, generated image and meme whose owner deleted it more than the restore window ago. Each row is claimed under its owner's lock and re-read, its storage objects deleted through preserve-before-change (the 7-day media backup keeps them, S15), then the row itself.
 * @subsystem studio
 */
import { db } from "@workspace/db";
import { memesTable, reactionsTable, uploadImageMetadataTable, userAiImagesTable } from "@workspace/db/schema";
import { and, asc, eq, getTableName, gt, inArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { aiImageIsOwnersOwn, purgeDue, type ContentTable } from "../lib/contentVisibility";
import { logger } from "../lib/logger";
import { ObjectStorageService } from "../lib/objectStorage";
import { memeObjectPaths } from "../lib/storageKeys";

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

/** One table's purge: its rows past their window, keyset-paged, each claimed and destroyed by `purgeOne`. */
async function purgeTable<K extends string | number>(
  spec: {
    table: ContentTable;
    /** The row's key column and the owner whose lock it is claimed under. */
    key: PgColumn;
    owner: PgColumn;
    /** Restricts the run to these keys (tests). */
    only: K[] | undefined;
    /** Deletes the row's storage objects and then the row, inside the claim. */
    destroy: (tx: Tx, key: K) => Promise<void>;
  },
  now: Date,
  counts: PurgeCounts,
): Promise<void> {
  const { table, key, owner } = spec;
  let after: K | null = null;
  for (;;) {
    const rows = (await db
      .select({ key, owner })
      .from(table)
      .where(and(
        purgeDue(table, now),
        after !== null ? gt(key, after) : undefined,
        spec.only ? inArray(key, spec.only) : undefined,
      ))
      .orderBy(asc(key))
      .limit(BATCH)) as Array<{ key: K; owner: string | null }>;
    if (rows.length === 0) return;
    for (const row of rows) {
      after = row.key;
      counts.selected++;
      const outcome = await purgeOne(
        row.owner,
        // Re-read under the lock: a restore since the selection wins.
        async (tx) => (await tx.select({ key }).from(table).where(and(eq(key, row.key), purgeDue(table))).for("update")).length > 0,
        (tx) => spec.destroy(tx, row.key),
        { table: getTableName(table), key: row.key },
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
  const photos = uploadImageMetadataTable;
  await purgeTable({
    table: photos, key: photos.objectPath, owner: photos.userId, only: scope.photoPaths,
    destroy: async (tx, objectPath: string) => {
      await storage.deleteObject(objectPath);
      await tx.delete(photos).where(eq(photos.objectPath, objectPath));
    },
  }, now, result.photos);

  const generated = userAiImagesTable;
  await purgeTable({
    table: generated, key: generated.id, owner: generated.userId, only: scope.generatedIds,
    destroy: async (tx, id: number) => {
      // The image is destroyed only when nothing else still serves it: no
      // fact gallery (a shared background is everyone's), and no other row
      // naming the same file.
      const [row] = await tx
        .select({
          storagePath: generated.storagePath,
          own: aiImageIsOwnersOwn(generated),
          // Spelled with the outer table's name: a single-table select renders
          // its columns unqualified, which inside this subquery would bind to `o`.
          others: sql<number>`(SELECT count(*)::int FROM user_ai_images o WHERE o.storage_path = user_ai_images.storage_path AND o.id <> user_ai_images.id)`,
        })
        .from(generated)
        .where(eq(generated.id, id));
      if (row && row.own && row.others === 0) await storage.deleteObject(row.storagePath);
      await tx.delete(generated).where(eq(generated.id, id));
    },
  }, now, result.generated);

  const memes = memesTable;
  await purgeTable({
    table: memes, key: memes.id, owner: memes.createdById, only: scope.memeIds,
    destroy: async (tx, id: number) => {
      const [row] = await tx.select({ slug: memes.permalinkSlug }).from(memes).where(eq(memes.id, id));
      // The meme's own file only, in every key form it can use: never the
      // photo it was made from (S14). A key it never used is absent, which
      // counts as deleted.
      if (row) await Promise.all(memeObjectPaths(row.slug).map((path) => storage.deleteObject(path)));
      await tx.delete(reactionsTable).where(and(eq(reactionsTable.targetType, "meme"), eq(reactionsTable.targetId, id)));
      await tx.delete(memes).where(eq(memes.id, id));
    },
  }, now, result.memes);
  const total = result.photos.selected + result.generated.selected + result.memes.selected;
  if (total > 0) logger.info(result, "[content-purger] run");
  return result;
}
