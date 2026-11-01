/**
 * @purpose A meme is a file from the moment it is saved (launch Phase 5, plan S16): the server renders the recipe once with the meme renderer and stores the JPEG at `memeKey(slug)`, so the meme no longer depends on its source photo; this module renders a recipe, bakes one meme, and backfills every recipe meme saved before baking existed.
 * @subsystem studio
 */
import { db } from "@workspace/db";
import { factsTable, memesTable, usersTable, type Meme } from "@workspace/db/schema";
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { z } from "zod";
import type { MemeAspectRatio } from "@workspace/api-zod";

import { logger } from "./logger";
import { errorCode } from "./mediaBackup/preserve";
import { generateMemeBuffer } from "./memeGenerator";
import { resolveBackground, resolveStoredMemeCaption } from "./memeComposite";
import { ObjectStorageService } from "./objectStorage";
import { memeKey } from "./storageKeys";
import type { ImageSourceSchema } from "./validators/memeBuilder";

type StoredImageSource = z.infer<typeof ImageSourceSchema>;

/** What a recipe render needs: the fact, the identity the caption is personalised with, and the stored recipe. */
export interface MemeRecipe {
  fact: { text: string | null; canonicalText: string | null } | undefined;
  /** The identity in the caption; undefined renders the fact canonically. */
  creator: { displayName: string | null; pronouns: string | null } | undefined;
  textOptions: unknown;
  imageSource: StoredImageSource;
  aspectRatio: MemeAspectRatio | null;
  framingTransform: { offsetX: number; offsetY: number } | null | undefined;
}

/** Renders a recipe to the JPEG the meme is, resolving its photo through the composer's source table. Throws when the photo cannot be read. */
export async function renderMemeRecipe(recipe: MemeRecipe): Promise<Buffer> {
  const { factText, textOptions } = resolveStoredMemeCaption(recipe.fact, recipe.creator, recipe.textOptions);
  return generateMemeBuffer(
    await resolveBackground(recipe.imageSource, {}),
    factText,
    textOptions,
    recipe.aspectRatio ?? "landscape",
    recipe.framingTransform ?? undefined,
  );
}

/** Stores a meme's JPEG. A file already there is the meme's file (write-once storage refuses a second), so it counts as stored. */
export async function storeMemeFile(slug: string, bytes: Buffer, storage = new ObjectStorageService()): Promise<void> {
  try {
    await storage.uploadObjectBuffer({ subPath: memeKey(slug, "jpg"), buffer: bytes, contentType: "image/jpeg" });
  } catch (err) {
    if (errorCode(err) === 412) return;
    throw err;
  }
}

/** The recipe of a stored meme row, personalised with its creator as they are now (what the live render drew). */
async function recipeOf(meme: Meme): Promise<MemeRecipe> {
  const [fact, creator] = await Promise.all([
    db
      .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
      .from(factsTable)
      .where(eq(factsTable.id, meme.factId))
      .limit(1)
      .then((rows) => rows[0]),
    meme.createdById
      ? db
          .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
          .from(usersTable)
          .where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true)))
          .limit(1)
          .then((rows) => rows[0])
      : Promise.resolve(undefined),
  ]);
  return {
    fact,
    creator,
    textOptions: meme.textOptions,
    imageSource: meme.imageSource as StoredImageSource,
    aspectRatio: (meme.aspectRatio as MemeAspectRatio | null) ?? null,
    framingTransform: meme.framingTransform as MemeRecipe["framingTransform"],
  };
}

/** Renders a stored recipe meme as it reads today, without storing it: the fallback for a meme not yet baked. */
export async function renderStoredMeme(meme: Meme): Promise<Buffer> {
  return renderMemeRecipe(await recipeOf(meme));
}

const BACKFILL_BATCH = 50;

export interface BackfillCounts {
  selected: number;
  baked: number;
  failed: number;
}

/**
 * Bakes every recipe meme saved before baking existed (S16): a row with a
 * recipe, no `baked_at`, not deleted and not quarantined. Idempotent: a baked
 * row is never selected again, and a file already stored counts as baked.
 * A meme whose source photo is gone is counted as failed and left for the
 * next run; it keeps serving through the live render until then, as before.
 */
/** `ids` restricts the run to those rows; tests use it, since every file in a shard shares one database. */
export async function backfillMemeBakes(opts: { ids?: number[] } = {}): Promise<BackfillCounts> {
  const counts: BackfillCounts = { selected: 0, baked: 0, failed: 0 };
  const storage = new ObjectStorageService();
  let afterId = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(memesTable)
      .where(
        and(
          isNotNull(memesTable.imageSource),
          isNull(memesTable.bakedAt),
          isNull(memesTable.deletedAt),
          ne(memesTable.status, "quarantined"),
          // Paging by id keeps a row that failed from being selected again in this run.
          gt(memesTable.id, afterId),
          opts.ids ? inArray(memesTable.id, opts.ids) : undefined,
        ),
      )
      .orderBy(asc(memesTable.id))
      .limit(BACKFILL_BATCH);
    if (rows.length === 0) break;
    for (const meme of rows) {
      afterId = meme.id;
      counts.selected++;
      try {
        // A file already stored (another instance, or a run that stopped before
        // setting baked_at) is the meme's file: record it without re-rendering.
        const stored = await storage.getObjectEntityFile(`/objects/${memeKey(meme.permalinkSlug, "jpg")}`).then(() => true, () => false);
        if (!stored) await storeMemeFile(meme.permalinkSlug, await renderStoredMeme(meme), storage);
        await db
          .update(memesTable)
          .set({ bakedAt: new Date() })
          .where(and(eq(memesTable.id, meme.id), isNull(memesTable.bakedAt)));
        counts.baked++;
      } catch (err) {
        counts.failed++;
        logger.warn({ err, slug: meme.permalinkSlug }, "[meme-bake] could not bake a recipe meme; it keeps the live render");
      }
    }
  }
  return counts;
}

