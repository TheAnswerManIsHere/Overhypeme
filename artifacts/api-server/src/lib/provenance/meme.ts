/**
 * @purpose The finishing step for a composed meme (plan docs/plans/PLAN_IMAGE_TRACING.md, increment 2): draw the meme with its record id watermarked into its pixels, stamp the id into the file, and commit its record — chained to the record of the photo it was drawn on — before the bytes are stored or sent. Every meme image the product makes (the bake on save, the backfill bake, the live render of an unbaked meme, the builder's preview and download) goes through `finishMeme`.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, imageProvenanceTable, type ProvenanceKind } from "@workspace/db";
import { stableStringify } from "../factRenderScenarios";
import { finishImage, newProvenanceId, type FinishedImage, type ProvenanceActor } from "./records";
import { WATERMARK_SCHEME, WatermarkError } from "./watermark";

export type MemeProvenanceKind = Extract<ProvenanceKind, "meme_bake" | "meme_live" | "preview" | "download">;

export interface MemeProvenance {
  kind: MemeProvenanceKind;
  /** Who made it; a promise so its lookup can run while the meme is drawn. */
  actor: ProvenanceActor | Promise<ProvenanceActor>;
  factId: number | null;
  /** The saved meme this picture is, when it is one. */
  memeSlug?: string | null;
  /** Where the picture is stored, when it is stored. */
  objectPath?: string | null;
  /** The stored photo the meme was drawn on: its record becomes this one's source. */
  backgroundObjectPath?: string | null;
  /** What was drawn: the caption, the recipe, the identity it was personalised with. */
  snapshot: Record<string, unknown>;
  /**
   * Reuse the record of an earlier identical render instead of writing a new one (the live render of an unbaked
   * meme, served on every view). The earlier record is reused only when the new bytes hash the same.
   */
  reuseIdentical?: boolean;
}

/** What a meme's record keeps of what was drawn: the words, the identity, and how it was laid out. One shape for every traced path, so one recipe has one recipe key whichever route drew it. */
export function memeSnapshot(m: {
  caption: string;
  /** The caption exactly as drawn: its runs, each marked when it is drawn in the name's colour. */
  captionRuns: unknown;
  /** The fact's template the caption was personalised from, as it read when the meme was drawn. */
  factTemplate: string | null | undefined;
  textOptions: unknown;
  identity: { name: string | null; pronouns: string | null } | null;
  imageSource: unknown;
  aspectRatio: string | null | undefined;
  framingTransform: unknown;
}): Record<string, unknown> {
  return {
    caption: m.caption,
    captionRuns: m.captionRuns ?? null,
    factTemplate: m.factTemplate ?? null,
    textOptions: m.textOptions ?? null,
    identity: m.identity,
    imageSource: m.imageSource,
    aspectRatio: m.aspectRatio ?? "landscape",
    framingTransform: m.framingTransform ?? null,
  };
}

/** The stored photo a meme is drawn on: an upload's key, or (where the caller knows it) the profile photo an identity meme uses. */
export function backgroundPathOf(source: { type: string; uploadKey?: string }, profileImageObjectPath?: string | null): string | null {
  return source.type === "upload" ? source.uploadKey ?? null : profileImageObjectPath ?? null;
}

/** The latest record of the stored picture at `objectPath`, or null (a picture made before tracing began). */
export async function provenanceOfObject(objectPath: string | null | undefined): Promise<number | null> {
  if (!objectPath) return null;
  const [row] = await db
    .select({ id: imageProvenanceTable.id })
    .from(imageProvenanceTable)
    .where(eq(imageProvenanceTable.objectPath, objectPath))
    .orderBy(desc(imageProvenanceTable.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** The drawing itself failed (an unreadable photo, say), as distinct from the record failing to be written. */
export class MemeRenderError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MemeRenderError";
  }
}

async function draw(render: (id: number) => Promise<Buffer>, id: number): Promise<Buffer> {
  try {
    return await render(id);
  } catch (err) {
    if (err instanceof WatermarkError) throw err;
    throw new MemeRenderError(err);
  }
}

function recipeKey(snapshot: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex").slice(0, 32);
}

/**
 * Render a meme marked with its record id, then commit its record. `render` draws the meme with the id it is given
 * watermarked into it. Throws when the record cannot be written: the meme is then neither stored nor sent.
 */
export async function finishMeme(p: MemeProvenance, render: (watermarkId: number) => Promise<Buffer>): Promise<FinishedImage> {
  const key = recipeKey(p.snapshot);
  // The source record and the actor are looked up while the meme is drawn; the record waits for both.
  const lookups = Promise.all([provenanceOfObject(p.backgroundObjectPath), p.actor]);
  lookups.catch(() => undefined); // awaited below; a rejection here must not go unhandled while the drawing runs
  const finish = async (id: number, bytes: Buffer, commit = true) => {
    const [sourceProvenanceId, actor] = await lookups;
    return finishImage({ ...common, id, bytes, actor, sourceProvenanceId, commit });
  };
  const common = {
    kind: p.kind,
    stamp: true,
    stampEngine: null,
    watermarkScheme: WATERMARK_SCHEME,
    memeSlug: p.memeSlug ?? null,
    objectPath: p.objectPath ?? null,
    factId: p.factId,
    snapshot: { ...p.snapshot, recipeKey: key, backgroundObjectPath: p.backgroundObjectPath ?? null },
  };

  if (p.reuseIdentical && p.memeSlug) {
    const [prior] = await db
      .select({ id: imageProvenanceTable.id, sha256: imageProvenanceTable.sha256 })
      .from(imageProvenanceTable)
      .where(and(
        eq(imageProvenanceTable.memeSlug, p.memeSlug),
        eq(imageProvenanceTable.kind, p.kind),
        sql`${imageProvenanceTable.snapshot}->>'recipeKey' = ${key}`,
      ))
      .orderBy(desc(imageProvenanceTable.createdAt))
      .limit(1);
    if (prior) {
      const again = await finish(prior.id, await draw(render, prior.id), false);
      // Identical bytes are the same picture, already recorded; anything else is a new picture and gets its own record.
      if (again.sha256 === prior.sha256) return again;
    }
  }

  const id = newProvenanceId();
  return finish(id, await draw(render, id));
}
