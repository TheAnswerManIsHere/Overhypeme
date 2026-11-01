/**
 * @purpose My content's data layer (launch Phase 5, plan S2/S18): one page at a time of a member's live photos, generated images and memes, their Recently deleted list, and the delete and restore of a photo or a generated image. Deleting stamps `deleted_at` and `purge_after`; nothing in storage changes until the content purger (`jobs/contentPurger.ts`) runs after the restore window.
 * @subsystem studio
 */
import { db } from "@workspace/db";
import { memesTable, uploadImageMetadataTable, userAiImagesTable } from "@workspace/db/schema";
import { and, desc, eq, gt, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";

import { aiImageIsOwnersOwn, deletionStamp, liveContent } from "./contentVisibility";

/** A page and where the next one starts; `nextCursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** An id cursor: the last id served, for lists ordered newest id first. */
function parseIdCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const id = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A photo is never listed when a moderation scan matched it, live or deleted. */
const uploadNotQuarantined = isNull(uploadImageMetadataTable.arachnidMatchType);

// ── Photos ─────────────────────────────────────────────────────────

export interface UploadRow {
  objectPath: string;
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
  createdAt: string;
  transform: string | null;
  sourceObjectPath: string | null;
  factId: number | null;
  transformParamsHash: string | null;
  isProfile: boolean;
}

/** The uploads cursor: the last row's sort key (profile first, then newest, then path). */
function encodeUploadCursor(isProfile: boolean, createdAt: string, objectPath: string): string {
  return Buffer.from(JSON.stringify([isProfile, createdAt, objectPath])).toString("base64url");
}

function decodeUploadCursor(cursor: string | undefined): [boolean, string, string] | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) && parsed.length === 3 &&
      typeof parsed[0] === "boolean" && typeof parsed[1] === "string" && typeof parsed[2] === "string" &&
      !Number.isNaN(Date.parse(parsed[1]))
    ) {
      return parsed as [boolean, string, string];
    }
  } catch { /* an unreadable cursor reads as the first page */ }
  return null;
}

/**
 * A page of the member's live photos: raw uploads by default (`transform`
 * 'raw'), every row with 'all', optionally one fact's. The profile photo comes
 * first, then newest first. Also the live count, for the picker's total.
 */
export async function listUploadsPage(
  userId: string,
  opts: { transform: "raw" | "all"; factId: number | null; cursor?: string; limit: number },
): Promise<Page<UploadRow> & { total: number }> {
  const t = uploadImageMetadataTable;
  const scope = and(
    eq(t.userId, userId),
    liveContent(t),
    uploadNotQuarantined,
    opts.transform === "raw" ? isNull(t.transform) : undefined,
    opts.factId !== null ? eq(t.factId, opts.factId) : undefined,
  );
  const after = decodeUploadCursor(opts.cursor);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        objectPath: t.objectPath,
        width: t.width,
        height: t.height,
        isLowRes: t.isLowRes,
        fileSizeBytes: t.fileSizeBytes,
        createdAt: t.createdAt,
        // Full precision, so the cursor never skips or repeats a row.
        createdAtKey: sql<string>`${t.createdAt}::text`,
        transform: t.transform,
        sourceObjectPath: t.sourceObjectPath,
        factId: t.factId,
        transformParamsHash: t.transformParamsHash,
        isProfile: t.isProfile,
      })
      .from(t)
      .where(and(
        scope,
        after
          ? sql`(${t.isProfile}, ${t.createdAt}, ${t.objectPath}) < (${after[0]}, ${after[1]}::timestamptz, ${after[2]})`
          : undefined,
      ))
      .orderBy(desc(t.isProfile), desc(t.createdAt), desc(t.objectPath))
      .limit(opts.limit + 1),
    db.select({ total: sql<number>`count(*)::int` }).from(t).where(scope),
  ]);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ createdAtKey: _key, createdAt, ...r }) => ({ ...r, createdAt: createdAt.toISOString() })),
    nextCursor: rows.length > opts.limit && last ? encodeUploadCursor(last.isProfile, last.createdAtKey, last.objectPath) : null,
    total,
  };
}

export type ContentChangeResult = "ok" | "not_found" | "profile_photo";

/**
 * Deletes one of the member's photos: it leaves the picker, the builder and
 * the storage byte path at once and waits in Recently deleted for the restore
 * window. Its derivatives (the retired styling's copies of it) go with it and
 * come back with it. The current profile photo is refused: it is on show as
 * the member's face, and a profile with a deleted photo would show nothing.
 * Memes made from the photo are untouched (plan S14, S16).
 */
export async function deleteUpload(userId: string, objectPath: string): Promise<ContentChangeResult> {
  const t = uploadImageMetadataTable;
  const [row] = await db
    .select({ isProfile: t.isProfile })
    .from(t)
    .where(and(eq(t.objectPath, objectPath), eq(t.userId, userId), liveContent(t), uploadNotQuarantined))
    .limit(1);
  if (!row) return "not_found";
  if (row.isProfile) return "profile_photo";
  const stamp = await deletionStamp();
  await db
    .update(t)
    .set(stamp)
    .where(and(
      eq(t.userId, userId),
      liveContent(t),
      sql`(${t.objectPath} = ${objectPath} OR ${t.sourceObjectPath} = ${objectPath})`,
    ));
  return "ok";
}

/** Restores a deleted photo, and the derivatives deleted with it, inside the window. */
export async function restoreUpload(userId: string, objectPath: string): Promise<ContentChangeResult> {
  const t = uploadImageMetadataTable;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(t)
      .set({ deletedAt: null, purgeAfter: null })
      .where(and(
        eq(t.objectPath, objectPath),
        eq(t.userId, userId),
        isNotNull(t.deletedAt),
        gt(t.purgeAfter, new Date()),
      ))
      .returning({ objectPath: t.objectPath });
    if (!row) return "not_found";
    // Its derivatives, deleted with it, come back with it.
    await tx
      .update(t)
      .set({ deletedAt: null, purgeAfter: null })
      .where(and(eq(t.userId, userId), eq(t.sourceObjectPath, objectPath), isNotNull(t.deletedAt), gt(t.purgeAfter, new Date())));
    return "ok";
  });
}

// ── Generated images ───────────────────────────────────────────────

export interface AiImageRow {
  id: number;
  factId: number;
  gender: string;
  storagePath: string;
  imageType: string;
  createdAt: string;
}

/**
 * A page of the member's own live generated images of one type (newest
 * first), optionally one fact's. A fact background the pipeline filed under
 * them is everyone's, so it is not listed (`aiImageIsOwnersOwn`).
 */
export async function listAiImagesPage(
  userId: string,
  opts: { imageType: string; factId: number | null; cursor?: string; limit: number },
): Promise<Page<AiImageRow>> {
  const t = userAiImagesTable;
  const afterId = parseIdCursor(opts.cursor);
  const rows = await db
    .select({
      id: t.id, factId: t.factId, gender: t.gender, storagePath: t.storagePath,
      imageType: t.imageType, createdAt: t.createdAt,
    })
    .from(t)
    .where(and(
      eq(t.userId, userId),
      eq(t.imageType, opts.imageType),
      liveContent(t),
      aiImageIsOwnersOwn(t),
      opts.factId !== null ? eq(t.factId, opts.factId) : undefined,
      afterId !== null ? lt(t.id, afterId) : undefined,
    ))
    .orderBy(desc(t.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return {
    items: page.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    nextCursor: rows.length > opts.limit ? String(page[page.length - 1]!.id) : null,
  };
}

/** Deletes one of the member's own generated images (never a shared fact background). */
export async function deleteAiImage(userId: string, id: number): Promise<ContentChangeResult> {
  const t = userAiImagesTable;
  const stamp = await deletionStamp();
  const [row] = await db
    .update(t)
    .set(stamp)
    .where(and(eq(t.id, id), eq(t.userId, userId), liveContent(t), aiImageIsOwnersOwn(t)))
    .returning({ id: t.id });
  return row ? "ok" : "not_found";
}

/** Restores a deleted generated image inside the window. */
export async function restoreAiImage(userId: string, id: number): Promise<ContentChangeResult> {
  const t = userAiImagesTable;
  const [row] = await db
    .update(t)
    .set({ deletedAt: null, purgeAfter: null })
    .where(and(eq(t.id, id), eq(t.userId, userId), isNotNull(t.deletedAt), gt(t.purgeAfter, new Date())))
    .returning({ id: t.id });
  return row ? "ok" : "not_found";
}

// ── Memes ──────────────────────────────────────────────────────────

/** A page of the member's live memes, newest first. Quarantined memes are never listed. */
export async function listMemesPage(userId: string, opts: { cursor?: string; limit: number }) {
  const t = memesTable;
  const afterId = parseIdCursor(opts.cursor);
  const rows = await db
    .select({
      id: t.id,
      factId: t.factId,
      templateId: t.templateId,
      imageUrl: t.imageUrl,
      permalinkSlug: t.permalinkSlug,
      isPublic: t.isPublic,
      createdAt: t.createdAt,
      originalWidth: t.originalWidth,
      originalHeight: t.originalHeight,
      uploadFileSizeBytes: t.uploadFileSizeBytes,
      heartCount: t.heartCount,
    })
    .from(t)
    .where(and(
      eq(t.createdById, userId),
      liveContent(t),
      ne(t.status, "quarantined"),
      afterId !== null ? lt(t.id, afterId) : undefined,
    ))
    .orderBy(desc(t.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return {
    items: page,
    nextCursor: rows.length > opts.limit ? String(page[page.length - 1]!.id) : null,
  };
}

// ── Recently deleted ───────────────────────────────────────────────

export type DeletedItem =
  | { kind: "photo"; key: string; objectPath: string; deletedAt: string; purgeAfter: string }
  | { kind: "generated"; key: string; id: number; storagePath: string; deletedAt: string; purgeAfter: string }
  | { kind: "meme"; key: string; slug: string; deletedAt: string; purgeAfter: string };

/** The most items Recently deleted shows; older ones are still restorable by their key. */
export const RECENTLY_DELETED_LIMIT = 200;

/**
 * Everything the member deleted that is still restorable, newest deletion
 * first. A row deleted before the restore window existed (`purge_after` null:
 * the content retired in launch Phase 4) is not theirs to restore and is not
 * listed; nor is quarantined content, nor a photo's derivatives (they restore
 * with the photo).
 */
export async function listRecentlyDeleted(userId: string): Promise<{ items: DeletedItem[]; truncated: boolean }> {
  const now = new Date();
  const u = uploadImageMetadataTable;
  const a = userAiImagesTable;
  const m = memesTable;
  const [photos, generated, memes] = await Promise.all([
    db
      .select({ objectPath: u.objectPath, deletedAt: u.deletedAt, purgeAfter: u.purgeAfter })
      .from(u)
      .where(and(eq(u.userId, userId), isNotNull(u.deletedAt), gt(u.purgeAfter, now), isNull(u.transform), uploadNotQuarantined))
      .orderBy(desc(u.deletedAt))
      .limit(RECENTLY_DELETED_LIMIT + 1),
    db
      .select({ id: a.id, storagePath: a.storagePath, deletedAt: a.deletedAt, purgeAfter: a.purgeAfter })
      .from(a)
      .where(and(eq(a.userId, userId), isNotNull(a.deletedAt), gt(a.purgeAfter, now), aiImageIsOwnersOwn(a)))
      .orderBy(desc(a.deletedAt))
      .limit(RECENTLY_DELETED_LIMIT + 1),
    db
      .select({ slug: m.permalinkSlug, deletedAt: m.deletedAt, purgeAfter: m.purgeAfter })
      .from(m)
      .where(and(eq(m.createdById, userId), isNotNull(m.deletedAt), gt(m.purgeAfter, now), ne(m.status, "quarantined")))
      .orderBy(desc(m.deletedAt))
      .limit(RECENTLY_DELETED_LIMIT + 1),
  ]);
  const iso = (d: Date | null) => (d ?? now).toISOString();
  const all: DeletedItem[] = [
    ...photos.map((r) => ({ kind: "photo" as const, key: r.objectPath, objectPath: r.objectPath, deletedAt: iso(r.deletedAt), purgeAfter: iso(r.purgeAfter) })),
    ...generated.map((r) => ({ kind: "generated" as const, key: String(r.id), id: r.id, storagePath: r.storagePath, deletedAt: iso(r.deletedAt), purgeAfter: iso(r.purgeAfter) })),
    ...memes.map((r) => ({ kind: "meme" as const, key: r.slug, slug: r.slug, deletedAt: iso(r.deletedAt), purgeAfter: iso(r.purgeAfter) })),
  ].sort((x, y) => y.deletedAt.localeCompare(x.deletedAt));
  return { items: all.slice(0, RECENTLY_DELETED_LIMIT), truncated: all.length > RECENTLY_DELETED_LIMIT };
}
