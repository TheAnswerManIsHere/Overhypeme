import { requireFeature } from "../lib/featureAccess";
import { Router, type IRouter, type Request, type Response } from "express";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { createHash } from "crypto";
import { Readable } from "stream";
import { customAlphabet } from "nanoid";
import { db } from "@workspace/db";
import { memesTable, factsTable, usersTable, lookStylesTable } from "@workspace/db/schema";
import { toggleHeart, getViewerReactionTargetIds } from "../lib/reactions";
import { eq, ne, desc, and, inArray, gt, count, sql, getTableColumns } from "drizzle-orm";
import {
  SaveMemeBody,
} from "../lib/validators/memeBuilder";
import { createMemeRecord, CreateMemeError } from "../lib/createMemeRecord";
import { z } from "zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { userOwnsAiReferenceImage } from "../lib/objectAccess";
import { getConfigInt } from "../lib/adminConfig";
import { renderPersonalized } from "../lib/renderCanonical";
import { memeKey } from "../lib/storageKeys";
import { renderStoredMeme } from "../lib/memeBake";
import { BudgetExceededError, BudgetGateError } from "../lib/budgetGate";
import { classifyAndDecide } from "../lib/moderation/nsfwClassifier";
import { quarantineImage } from "../lib/moderation/quarantine";
import { ModerationRejectedError, GENERIC_REJECT_MESSAGE } from "../lib/moderation/types";
import { principalFromRequest } from "../lib/featureAccess";
import { resolveMemeDecisions } from "../lib/createMemeRecord";
import { isAtLeastLegendary, deriveUserRole } from "../lib/userRole";
import { requireAdmin } from "./admin";
import { getUploadImageMetadata } from "./storage";
import { CACHE, setPublicCache, setPublicCors, checkConditional, setNoStore } from "../lib/cacheHeaders";
import { canViewMeme } from "../lib/memeVisibility";
import { deletionStamp, liveContent } from "../lib/contentVisibility";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts a human-readable error message from a generation failure.
 * fal.ai errors include a `body.detail` string that's more informative than the top-level message.
 */
function extractGenerationError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    // fal.ai ApiError: { message, body: { detail } }
    const detail = e["body"] && typeof e["body"] === "object"
      ? (e["body"] as Record<string, unknown>)["detail"]
      : undefined;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (typeof e["message"] === "string" && e["message"].trim()) return e["message"].trim();
  }
  return "Image generation failed. Please try again.";
}

function isNoFaceError(err: unknown): boolean {
  const msg = extractGenerationError(err).toLowerCase();
  return msg.includes("no face detected") || msg.includes("facexlib") || msg.includes("face detect");
}

// ─── Rate limiting & idempotency ──────────────────────────────────────────────
// The Phase-4 daily save cap is enforced by counting recent live memes for the
// authenticated user (timestamps-over-aggregates principle — no denormalised
// counter to drift). Caps come from admin_config so they can be tuned without
// a deploy.
const FREE_TIER_DAILY_SAVE_CAP_DEFAULT = 30;
const LEGENDARY_TIER_DAILY_SAVE_CAP_DEFAULT = 200;

/**
 * Idempotency map for /api/memes POSTs. Protects against double-clicks and
 * client-side network retries: a second POST from the same user with the
 * same canonicalised input within `IDEM_WINDOW_MS` returns the meme created
 * by the first POST instead of inserting a duplicate row. The map is in-
 * process only — survives a single server instance, which is sufficient
 * because the user-perceived race is between two requests on the same TCP
 * socket pair.
 */
const IDEM_WINDOW_MS = 60_000;
const idempotencyMap = new Map<string, { memeId: number; permalinkSlug: string; expiresAt: number }>();

function pruneIdempotencyMap(now: number): void {
  for (const [key, entry] of idempotencyMap.entries()) {
    if (entry.expiresAt <= now) idempotencyMap.delete(key);
  }
}

/**
 * Recursively serialise a value with object keys sorted alphabetically at
 * every depth. JSON.stringify's array-of-strings replacer is the wrong tool
 * here — it filters keys at every depth, including nested ones we want to
 * keep — so we walk the structure ourselves.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

function computeIdemKey(userId: string, parsed: Record<string, unknown>): string {
  return createHash("sha256").update(`${userId}|${canonicalize(parsed)}`).digest("hex");
}

// ─── Validation ────────────────────────────────────────────────────────────────
// The full request schemas live in lib/validators/memeBuilder.ts so the three
// Phase-4 endpoints (preview/download/save) share one source of truth.

/**
 * Permalink slug generator. nanoid with the standard URL-safe alphabet
 * (`A-Za-z0-9_-`) at length 10 — collision probability for 1M memes is
 * roughly 1 in 2.3M (alphabet=64, length=10 → ~1.15e18 combos, birthday-paradox
 * approximation `n^2 / (2 * 64^10) ≈ 4e-7`). The unique constraint on
 * `permalink_slug` plus a 3-attempt retry loop is more than enough to absorb
 * the rare collision. Slugs are immutable once minted; soft-deleted memes
 * keep their slug forever (the row stays, the unique constraint blocks
 * reissue).
 */
const generateSlug = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 10);

// ─── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /memes
 *
 * Saves the meme recipe (fact + image source + text options) to the DB.
 * Does NOT generate or store any image — the PNG is rendered on demand by
 * GET /memes/:slug/image so we never pay for image storage.
 */
router.post("/memes", async (req: Request, res: Response) => {
  setNoStore(res);
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = SaveMemeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  // Validation, idempotency, daily-cap enforcement, slug allocation, the bake
  // and the row insert all live inside createMemeRecord, keeping this route a
  // thin delegate. (The photo was NSFW-classified when it was uploaded.)

  // Resolved here, at submission time, from the request's principal — which is
  // the only place "view as user" is visible. `createMemeRecord` applies these
  // rather than re-deriving them.
  const decisions = await resolveMemeDecisions(principalFromRequest(req));

  try {
    const result = await createMemeRecord({
      userId: req.user.id,
      factId: parsed.data.factId,
      imageSource: parsed.data.imageSource,
      textOptions: parsed.data.textOptions ?? null,
      framingTransform: parsed.data.framingTransform ?? null,
      aspectRatio: parsed.data.aspectRatio,
      isPublic: parsed.data.isPublic,
      name: parsed.data.name,
      pronouns: parsed.data.pronouns,
      decisions,
    });

    if (result.idempotent) {
      res.status(200).json({
        id: result.memeId,
        memeId: result.memeId,
        permalinkSlug: result.permalinkSlug,
        slug: result.permalinkSlug,
        permalinkUrl: result.permalinkUrl,
        imageUrl: result.imageUrl,
        idempotent: true,
      });
      return;
    }

    res.status(201).json({
      id: result.memeId,
      memeId: result.memeId,
      factId: result.factId,
      templateId: result.templateId,
      imageUrl: result.imageUrl,
      permalinkSlug: result.permalinkSlug,
      slug: result.permalinkSlug,
      permalinkUrl: result.permalinkUrl,
      createdAt: result.createdAt,
    });
  } catch (err) {
    if (err instanceof CreateMemeError) {
      if (err.status === 429 && typeof err.body["retryAfterSeconds"] === "number") {
        res.setHeader("Retry-After", String(err.body["retryAfterSeconds"]));
      }
      // Strip the auxiliary retryAfterSeconds field from the JSON body — keep
      // wire shape identical to the legacy inline handler.
      const body: Record<string, unknown> = { ...err.body };
      delete body["retryAfterSeconds"];
      res.status(err.status).json(body);
      return;
    }
    throw err;
  }
});

// GET /memes/:slug
router.get("/memes/:slug", async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).json({ error: "Slug required" }); return; }

  const [meme] = await db
    .select({ ...getTableColumns(memesTable), isLive: liveContent(memesTable) })
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);
  if (!meme) { res.status(404).json({ error: "Meme not found" }); return; }
  // Owner-only enforcement for private memes — 404 (not 403), and BEFORE the
  // not-live 410 below, so a non-owner cannot distinguish a private meme
  // (live or deleted) from one that never existed. See lib/memeVisibility.ts.
  if (!canViewMeme(meme, req)) { res.status(404).json({ error: "Meme not found" }); return; }
  if (!meme.isLive) { res.status(410).json({ error: "This meme has been removed by its creator.", deleted: true }); return; }
  // A private meme visible to its owner must never be cached publicly.
  if (!meme.isPublic) setNoStore(res);

  // Use frozen text if available (stored at creation time), otherwise fall back
  // to dynamic rendering for memes created before this column was added.
  let factText = meme.renderedFactText ?? null;
  let createdByName: string | null = null;

  if (!factText) {
    const [fact] = await db
      .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
      .from(factsTable)
      .where(and(eq(factsTable.id, meme.factId), eq(factsTable.isActive, true)))
      .limit(1);

    let creatorPronouns: string | null = null;
    if (meme.createdById) {
      const [user] = await db
        .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
        .from(usersTable)
        .where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true)))
        .limit(1);
      createdByName = user?.displayName ?? null;
      creatorPronouns = user?.pronouns ?? null;
    }

    const rawTemplate = fact?.text ?? fact?.canonicalText ?? "";
    factText = createdByName && rawTemplate
      ? renderPersonalized(rawTemplate, createdByName, creatorPronouns)
      : (fact?.canonicalText ?? fact?.text ?? "");
  } else if (meme.createdById) {
    const [user] = await db
      .select({ displayName: usersTable.displayName })
      .from(usersTable)
      .where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true)))
      .limit(1);
    createdByName = user?.displayName ?? null;
  }

  const viewerId = (req as AuthenticatedRequest).isAuthenticated?.() ? (req as AuthenticatedRequest).user.id : undefined;
  const viewerHasHearted = viewerId
    ? (await getViewerReactionTargetIds(viewerId, "meme", "heart", [meme.id])).has(meme.id)
    : false;

  res.json({
    id: meme.id,
    factId: meme.factId,
    templateId: meme.templateId,
    imageUrl: meme.imageUrl,
    permalinkSlug: meme.permalinkSlug,
    permalinkUrl: `/m/${meme.permalinkSlug}`,
    isPublic: meme.isPublic,
    factText,
    createdAt: meme.createdAt.toISOString(),
    createdById: meme.createdById ?? null,
    createdByName,
    originalWidth: meme.originalWidth ?? null,
    originalHeight: meme.originalHeight ?? null,
    uploadFileSizeBytes: meme.uploadFileSizeBytes ?? null,
    heartCount: meme.heartCount ?? 0,
    viewerHasHearted,
    isNsfw: meme.isNsfw ?? false,
    imageTransform: meme.imageTransform ?? null,
    imageSource: meme.imageSource ?? null,
  });
});

// GET /facts/:factId/memes?visibility=community|my-public|my-private|public|mine
router.get("/facts/:factId/memes", async (req: Request, res: Response) => {
  const factId = parseInt((req.params["factId"] ?? "") as string);
  if (isNaN(factId)) { res.status(400).json({ error: "Invalid factId" }); return; }

  const rawVisibility = req.query["visibility"] as string | undefined;
  type Visibility = "community" | "my-public" | "my-private" | "mine" | "public";
  const VALID: Visibility[] = ["community", "my-public", "my-private", "mine", "public"];
  const visibility: Visibility = (VALID.includes(rawVisibility as Visibility) ? rawVisibility : "community") as Visibility;

  const rawSort = req.query["sort"] as string | undefined;
  const sort: "top" | "new" = rawSort === "new" ? "new" : "top";

  // auth-gated visibility modes
  const requiresAuth = visibility === "mine" || visibility === "my-public" || visibility === "my-private";
  if (requiresAuth && !req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const [fact] = await db
    .select({ id: factsTable.id, parentId: factsTable.parentId })
    .from(factsTable)
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true)))
    .limit(1);

  let factIds: number[] = [factId];
  if (fact && fact.parentId === null) {
    const variants = await db
      .select({ id: factsTable.id })
      .from(factsTable)
      .where(and(eq(factsTable.parentId, factId), eq(factsTable.isActive, true)));
    factIds = [factId, ...variants.map(v => v.id)];
  }

  const factFilter = factIds.length === 1
    ? eq(memesTable.factId, factIds[0]!)
    : inArray(memesTable.factId, factIds);

  const userId = req.user?.id;
  const visibilityFilter =
    visibility === "community"
      ? and(
          factFilter,
          eq(memesTable.isPublic, true),
          liveContent(memesTable),
          userId ? ne(memesTable.createdById, userId) : undefined,
        )
    : visibility === "my-public"
      ? and(factFilter, eq(memesTable.createdById, userId!), eq(memesTable.isPublic, true), liveContent(memesTable))
    : visibility === "my-private"
      ? and(factFilter, eq(memesTable.createdById, userId!), eq(memesTable.isPublic, false), liveContent(memesTable))
    : visibility === "mine"
      ? and(factFilter, eq(memesTable.createdById, userId!), liveContent(memesTable))
      : and(factFilter, eq(memesTable.isPublic, true), liveContent(memesTable));

  const maxMemes = await getConfigInt("max_memes_per_fact", 40);
  const orderBy = sort === "new"
    ? [desc(memesTable.createdAt)]
    : [desc(memesTable.heartCount), desc(memesTable.createdAt)];
  const memes = await db
    .select()
    .from(memesTable)
    .where(visibilityFilter)
    .orderBy(...orderBy)
    .limit(maxMemes);

  const heartedIds = userId
    ? await getViewerReactionTargetIds(userId, "meme", "heart", memes.map((m) => m.id))
    : new Set<number>();

  res.json({
    memes: memes.map(m => ({
      id: m.id,
      factId: m.factId,
      templateId: m.templateId,
      imageUrl: m.imageUrl,
      permalinkSlug: m.permalinkSlug,
      isPublic: m.isPublic,
      createdById: m.createdById,
      createdAt: m.createdAt.toISOString(),
      aspectRatio: m.aspectRatio ?? "landscape",
      originalWidth: m.originalWidth ?? null,
      originalHeight: m.originalHeight ?? null,
      uploadFileSizeBytes: m.uploadFileSizeBytes ?? null,
      heartCount: m.heartCount ?? 0,
      viewerHasHearted: heartedIds.has(m.id),
    })),
  });
});

// POST /memes/:id/heart — toggle heart reaction on a meme
router.post("/memes/:id/heart", async (req: AuthenticatedRequest, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const memeId = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(memeId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [exists] = await db.select({ id: memesTable.id })
    .from(memesTable)
    .where(and(eq(memesTable.id, memeId), liveContent(memesTable)))
    .limit(1);
  if (!exists) { res.status(404).json({ error: "Meme not found" }); return; }

  const result = await toggleHeart(req.user.id, "meme", memeId);
  res.json(result);
});

/**
 * GET /memes/:slug/image
 *
 * Renders the meme PNG on demand from the stored recipe.
 * Returns a long-lived Cache-Control header so browsers and any CDN in front
 * of the app cache the result — only the first request per slug triggers a
 * render; subsequent requests are served from cache at zero CPU/storage cost.
 *
 * Backwards-compatible: memes created before the recipe-based architecture
 * (imageSource === null) are served from GCS as before.
 */
/**
 * GET /memes/ai-user/image — serve a user-owned reference AI image by storage path.
 * Requires auth and ownership (row must exist in user_ai_images for this user).
 * IMPORTANT: must be registered before /memes/:slug/image to avoid wildcard capture.
 */
router.get("/memes/ai-user/image", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const storagePath = String(req.query["storagePath"] ?? "").trim();
  if (!storagePath || !storagePath.startsWith("/objects/")) {
    res.status(400).json({ error: "Invalid storagePath" }); return;
  }

  // Verify ownership — the shared AI-reference ownership check
  // (see lib/objectAccess.ts).
  if (!(await userOwnsAiReferenceImage(req.user.id, storagePath))) {
    res.status(403).json({ error: "Image not found or not owned by you" }); return;
  }

  try {
    const normalized = objectStorageService.normalizeObjectEntityPath(storagePath);
    const objectFile = await objectStorageService.getObjectEntityFile(normalized);
    const response = await objectStorageService.downloadObject(objectFile, 3600);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    response.headers.forEach((value: string, key: string) => {
      if (key.toLowerCase() !== "content-type" && key.toLowerCase() !== "cache-control") res.setHeader(key, value);
    });
    res.status(200);
    if (response.body) {
      const { Readable } = await import("stream");
      const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    req.log.error({ err, storagePath }, "Failed to serve user AI reference image");
    res.status(404).json({ error: "Image not found" });
  }
});

router.get("/memes/:slug/image", async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).end(); return; }

  const [meme] = await db
    .select({ ...getTableColumns(memesTable), isLive: liveContent(memesTable) })
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);
  if (!meme || !canViewMeme(meme, req)) { res.status(404).end(); return; }
  // A meme that is not live is refused at the byte path like one that never
  // existed (plan S17), to everyone but its creator, who sees it in Recently
  // deleted; its file stays in storage until the purge.
  if (!meme.isLive && (!meme.createdById || meme.createdById !== req.user?.id)) { res.status(404).end(); return; }
  // Private and deleted meme images must be no-store (never publicly/edge cacheable).
  const memeIsPrivate = !meme.isPublic || !meme.isLive;

  // ── The meme's file (plan S16) ───────────────────────────────────
  // A meme is baked to a file at save; a legacy meme was stored as one before
  // recipes existed. Either way the file is the meme and is served as is,
  // whatever has happened to its photo since. Stored files are write-once, so
  // one ETag per slug is exact, and a revalidation needs no storage read.
  if (!meme.imageSource || meme.bakedAt) {
    const etag = `"meme-${slug}"`;
    if (checkConditional(req, res, etag)) return;
    // A baked meme has one key; a legacy one may sit under any of the older forms.
    const candidates = meme.bakedAt
      ? [`/objects/${memeKey(slug, "jpg")}`]
      : [`/objects/${memeKey(slug, "jpg")}`, `/objects/${memeKey(slug, "png")}`, `/objects/memes/${slug}.jpg`, `/objects/memes/${slug}.png`];
    for (const objectPath of candidates) {
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath).catch(() => null);
      if (!objectFile) continue;
      const response = await objectStorageService.downloadObject(objectFile, 86400);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (memeIsPrivate) {
        setNoStore(res);
      } else {
        setPublicCache(res, CACHE.MEME_IMAGE, etag);
        setPublicCors(res);
      }
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
      return;
    }
    if (!meme.imageSource) {
      res.status(404).end();
      return;
    }
    req.log.warn({ slug }, "a baked meme's file is missing; serving the live render");
  }

  // ── A recipe meme not baked yet, or whose file is missing ────────
  // Rendered live, as every recipe meme was before baking (lib/memeBake.ts,
  // backfillMemeBakes, bakes the unbaked ones at boot).
  try {
    const imageBuffer = await renderStoredMeme(meme);
    const bytesHash = createHash("sha256").update(imageBuffer).digest("hex").slice(0, 16);
    const etag = `"meme-live-${slug}-${bytesHash}"`;
    if (checkConditional(req, res, etag)) return;
    res.setHeader("Content-Type", "image/jpeg");
    if (memeIsPrivate) {
      setNoStore(res);
    } else {
      setPublicCors(res);
      setPublicCache(res, CACHE.MEME_IMAGE, etag);
    }
    res.setHeader("Content-Length", imageBuffer.length);
    res.status(200).send(imageBuffer);
  } catch (err) {
    req.log.error({ err, slug }, "Meme render failed");
    res.status(502).end();
  }
});

// DELETE /memes/:slug — delete a meme (creator only). It stays restorable
// from Recently deleted for the restore window; the content purger removes
// its row and its file after that (plan S2, jobs/contentPurger.ts). Its photo
// is untouched (S14).
router.delete("/memes/:slug", async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: "Authentication required" }); return; }
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).json({ error: "Slug required" }); return; }

  const [meme] = await db
    .select({ id: memesTable.id, createdById: memesTable.createdById, deletedAt: memesTable.deletedAt })
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);

  if (!meme) { res.status(404).json({ error: "Meme not found" }); return; }
  if (meme.createdById !== req.user.id) { res.status(403).json({ error: "You can only delete your own memes" }); return; }
  if (meme.deletedAt) { res.status(410).json({ error: "Meme already deleted" }); return; }

  const stamp = await deletionStamp();
  await db
    .update(memesTable)
    .set(stamp)
    .where(and(eq(memesTable.id, meme.id), liveContent(memesTable)));

  res.json({ success: true, purgeAfter: stamp.purgeAfter.toISOString() });
});

// POST /memes/:slug/restore — undo the creator's delete inside the restore window.
router.post("/memes/:slug/restore", async (req: Request, res: Response) => {
  if (!req.user) { res.status(401).json({ error: "Authentication required" }); return; }
  const slug = req.params["slug"] as string;

  const [restored] = await db
    .update(memesTable)
    .set({ deletedAt: null, purgeAfter: null })
    .where(and(
      eq(memesTable.permalinkSlug, slug),
      eq(memesTable.createdById, req.user.id),
      sql`${memesTable.deletedAt} IS NOT NULL`,
      gt(memesTable.purgeAfter, new Date()),
    ))
    .returning({ id: memesTable.id });
  if (!restored) { res.status(404).json({ error: "Nothing to restore" }); return; }
  res.json({ success: true });
});

export default router;
