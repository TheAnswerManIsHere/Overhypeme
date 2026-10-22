import { requireFeature } from "../lib/featureAccess";
import { Router, type IRouter, type Request, type Response } from "express";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { createHash } from "crypto";
import { Readable } from "stream";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { customAlphabet } from "nanoid";
import { db } from "@workspace/db";
import { memesTable, factsTable, usersTable, userFactPreferencesTable, affiliateClicksTable, lookStylesTable } from "@workspace/db/schema";
import { toggleHeart, getViewerReactionTargetIds } from "../lib/reactions";
import { eq, ne, desc, and, inArray, isNull, gt, count, sql } from "drizzle-orm";
import {
  SaveMemeBody,
} from "../lib/validators/memeBuilder";
import { createMemeRecord, CreateMemeError } from "../lib/createMemeRecord";
import { z } from "zod";
import {
  generateMemeBuffer,
  MEME_TEMPLATES,
  type BackgroundSource,
} from "../lib/memeGenerator";
import { ObjectStorageService } from "../lib/objectStorage";
import { userOwnsAiReferenceImage } from "../lib/objectAccess";
import { getConfigInt } from "../lib/adminConfig";
import { getRandomStockPhoto, getPhotoById } from "../lib/pexelsClient";
import { renderPersonalized } from "../lib/renderCanonical";
import { resolveStoredMemeCaption } from "../lib/memeComposite";
import { memeKey } from "../lib/storageKeys";
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
import { getSiteBaseUrl } from "../lib/siteUrl";
import { buildZazzleUrl } from "../lib/zazzle";
import type { MemeAspectRatio } from "@workspace/api-zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In production the build script copies src/assets → dist/assets and all
// bundled code shares a single __dirname (dist/). When running directly from
// source via tsx, __dirname is src/routes/, so we must walk up to src/assets/.
const TEMPLATES_DIR = (() => {
  const candidates = [
    path.resolve(__dirname, "assets/meme-templates"),        // built layout
    path.resolve(__dirname, "..", "assets/meme-templates"),  // src/routes → src/assets
  ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch { /* try next */ }
  }
  return candidates[0]!;
})();

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
 * Bump this whenever the meme rendering pipeline (memeGenerator.ts,
 * font registration, photo source resolution, default text styling,
 * etc.) changes its output for the same inputs. The value is folded
 * into the served-image ETag so previously-cached browser/CDN entries
 * cannot be perpetuated via 304 after a render-pipeline change.
 *
 * v2 — 2026-05: switched stock photos to large2x source; default text
 * style (Anton/Impact, uppercase, outline, centered); reduced photo
 * overlay; high-quality canvas resampling.
 * v3 — 2026-05: fixed JPEG encode quality bug — `OUTPUT_JPEG_QUALITY`
 * was being passed as 0.9 to a 0-100 integer API, producing tiny ~22KB
 * files with chunky 8×8 block artifacts on every photo meme. Now 90.
 * v4 — 2026-08: the split caption halves stored in `text_options` are the RAW
 * fact template, and the renderer draws them in preference to the
 * personalised `factText` — so every split-caption meme baked a literal
 * `{NAME}` into the image. The halves are now personalised alongside the fact
 * text, which changes the output for every already-saved split-caption meme.
 */
const MEME_RENDER_VERSION = 4;

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

// ─── Pexels photo URL cache ────────────────────────────────────────────────────
// Avoids re-hitting the Pexels API on every view of a stock-photo meme.
// Cache entries expire after 15 minutes; the fallback URL stored in the DB
// recipe is used if re-fetch fails.

const PHOTO_URL_CACHE_TTL = 15 * 60 * 1000;
const photoUrlCache = new Map<number, { url: string; fetchedAt: number }>();

async function resolveStockPhotoUrl(
  pexelsPhotoId: number,
  fallbackUrl: string | undefined,
): Promise<string> {
  const cached = photoUrlCache.get(pexelsPhotoId);
  if (cached && Date.now() - cached.fetchedAt < PHOTO_URL_CACHE_TTL) {
    return cached.url;
  }
  try {
    const photo = await getPhotoById(pexelsPhotoId);
    photoUrlCache.set(pexelsPhotoId, { url: photo.photoUrl, fetchedAt: Date.now() });
    return photo.photoUrl;
  } catch {
    // Fall back to the URL stored at generation time. The Phase-4 stock
    // schema makes photoUrl optional (the universal builder stores only the
    // pexelsPhotoId), so when both Pexels lookup and fallback are absent the
    // caller gets an empty string and the canvas loader will throw — that's
    // surfaced as a 502 to the user.
    return fallbackUrl ?? "";
  }
}

// ─── Validation ────────────────────────────────────────────────────────────────
// The full request schemas live in lib/validators/memeBuilder.ts so the three
// Phase-4 endpoints (preview/download/save) share one source of truth. The
// stored-shape narrowing on the meme row's jsonb column reuses the same union.

import { ImageSourceSchema as StoredImageSourceSchema } from "../lib/validators/memeBuilder";
type StoredImageSource = z.infer<typeof StoredImageSourceSchema>;

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

// GET /memes/templates
router.get("/memes/templates", (_req: Request, res: Response) => {
  setNoStore(res);
  res.json({
    templates: MEME_TEMPLATES.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      previewColors: t.previewColors,
      previewImageUrl: `/api/memes/templates/${t.id}/preview`,
    })),
  });
});

// GET /memes/templates/:id/preview?aspectRatio=landscape|square|portrait
router.get("/memes/templates/:id/preview", (req: Request, res: Response) => {
  const id = req.params["id"] as string;
  const template = MEME_TEMPLATES.find(t => t.id === id);
  if (!template) { res.status(404).end(); return; }

  const aspectParam = String(req.query["aspectRatio"] ?? "landscape");
  const aspect = (["landscape", "square", "portrait"].includes(aspectParam)
    ? aspectParam
    : "landscape") as "landscape" | "square" | "portrait";

  const etag = `"template-${id}-${aspect}"`;
  if (checkConditional(req, res, etag)) return;

  setPublicCors(res);
  res.setHeader("Content-Type", "image/png");
  setPublicCache(res, CACHE.MEME_TEMPLATE, etag);
  res.sendFile(path.join(TEMPLATES_DIR, aspect, template.assetPath));
});

// GET /memes/stock-photo?gender=man|woman|person
router.get("/memes/stock-photo", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const genderParam = req.query["gender"];
  const gender = (["man", "woman", "person"].includes(genderParam as string)
    ? genderParam
    : "person") as "man" | "woman" | "person";

  try {
    const photo = await getRandomStockPhoto(gender);
    res.json(photo);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch stock photo";
    req.log.error({ err }, "Stock photo fetch failed");
    res.status(502).json({ error: message });
  }
});

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

  // Source-specific validation: catch unknown template IDs before the shared
  // creator does anything expensive. The remainder of validation, idempotency,
  // daily-cap enforcement, NSFW classification, slug allocation, and the row
  // insert all live inside createMemeRecord, keeping this route a thin
  // delegate.
  if (parsed.data.imageSource.type === "template") {
    const templateSrc = parsed.data.imageSource;
    const valid = MEME_TEMPLATES.find(t => t.id === templateSrc.templateId);
    if (!valid) {
      res.status(400).json({ error: "Invalid template ID" });
      return;
    }
  }

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
      previewImageBase64: parsed.data.previewImageBase64,
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
    .select()
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);
  if (!meme) { res.status(404).json({ error: "Meme not found" }); return; }
  // Owner-only enforcement for private memes — 404 (not 403), and BEFORE the
  // deletedAt 410 below, so a non-owner cannot distinguish a private meme
  // (live or deleted) from one that never existed. See lib/memeVisibility.ts.
  if (!canViewMeme(meme, req)) { res.status(404).json({ error: "Meme not found" }); return; }
  if (meme.deletedAt) { res.status(410).json({ error: "This meme has been removed by its creator.", deleted: true }); return; }
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
          isNull(memesTable.deletedAt),
          userId ? ne(memesTable.createdById, userId) : undefined,
        )
    : visibility === "my-public"
      ? and(factFilter, eq(memesTable.createdById, userId!), eq(memesTable.isPublic, true), isNull(memesTable.deletedAt))
    : visibility === "my-private"
      ? and(factFilter, eq(memesTable.createdById, userId!), eq(memesTable.isPublic, false), isNull(memesTable.deletedAt))
    : visibility === "mine"
      ? and(factFilter, eq(memesTable.createdById, userId!), isNull(memesTable.deletedAt))
      : and(factFilter, eq(memesTable.isPublic, true), isNull(memesTable.deletedAt));

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
    .where(and(eq(memesTable.id, memeId), isNull(memesTable.deletedAt)))
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
    .select()
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);
  if (!meme) { res.status(404).end(); return; }
  // Owner-only enforcement, BEFORE the deletedAt 410, so a non-owner can't
  // distinguish a private meme (live or deleted) from a nonexistent one.
  if (!canViewMeme(meme, req)) { res.status(404).end(); return; }
  if (meme.deletedAt) { res.status(410).end(); return; }
  // Private meme images must be no-store (never publicly/edge cacheable).
  const memeIsPrivate = !meme.isPublic;

  // ── Legacy path: memes stored before recipe-based rendering ─────
  if (!meme.imageSource) {
    // Try hash-prefixed keys first (new format), then legacy flat paths (pre-migration)
    const candidates = [
      `/objects/${memeKey(slug, "jpg")}`,
      `/objects/${memeKey(slug, "png")}`,
      `/objects/memes/${slug}.jpg`,
      `/objects/memes/${slug}.png`,
    ];
    let served = false;
    for (const objectPath of candidates) {
      try {
        const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
        const etag = `"legacy-${slug}"`;
        if (checkConditional(req, res, etag)) return;
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
        served = true;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!served) res.status(404).end();
    return;
  }

  // ── Recipe-based rendering ───────────────────────────────────────
  const [fact, creator] = await Promise.all([
    db
      .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
      .from(factsTable)
      .where(eq(factsTable.id, meme.factId))
      .limit(1)
      .then(rows => rows[0]),
    meme.createdById
      ? db
          .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
          .from(usersTable)
          .where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true)))
          .limit(1)
          .then(rows => rows[0])
      : Promise.resolve(undefined),
  ]);

  const { factText, textOptions } = resolveStoredMemeCaption(fact, creator, meme.textOptions);
  const source = meme.imageSource as StoredImageSource;

  let background: BackgroundSource;

  try {
    if (source.type === "template") {
      background = { type: "template", templateId: source.templateId };

    } else if (source.type === "stock") {
      const photoUrl = await resolveStockPhotoUrl(source.pexelsPhotoId, source.photoUrl);
      background = { type: "image", imageData: photoUrl };

    } else if (source.type === "upload") {
      // Identity is always resolved → upload before storage, so by this point
      // the only remaining variant is the persisted "upload" shape.
      const objectFile = await objectStorageService.getObjectEntityFile(source.uploadKey);
      const downloadResponse = await objectStorageService.downloadObject(objectFile);
      const imageBuffer = Buffer.from(await downloadResponse.arrayBuffer());
      background = { type: "image", imageData: imageBuffer };
    } else {
      throw new Error(`Unsupported stored image source type: ${(source as { type: string }).type}`);
    }

    const imageBuffer = await generateMemeBuffer(background, factText, textOptions, (meme.aspectRatio as MemeAspectRatio | null) ?? "landscape", meme.framingTransform ?? undefined);

    // Content-aware ETag: includes a render-pipeline version (bump
    // MEME_RENDER_VERSION whenever the generator output changes for the
    // same inputs), the meme's createdAt (memes are immutable post-save —
    // no updatedAt column on the schema), and a SHA-256 of the rendered
    // bytes. This guarantees previously-cached low-res or stale renders
    // cannot be perpetuated via 304 — when any pipeline change ships,
    // every client revalidation reads fresh bytes.
    const bytesHash = createHash("sha256").update(imageBuffer).digest("hex").slice(0, 16);
    const createdAtMs = meme.createdAt instanceof Date ? meme.createdAt.getTime() : Date.now();
    const etag = `"meme-v${MEME_RENDER_VERSION}-${slug}-${createdAtMs}-${bytesHash}"`;
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

/**
 * POST /memes/:slug/zazzle-export
 *
 * Renders the meme image, stores it in object storage with a public ACL, and
 * returns a stable URL that Zazzle's servers can fetch directly from GCS.
 * No authentication required.
 */
router.post("/memes/:slug/zazzle-export", async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).end(); return; }

  const [meme] = await db
    .select()
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);
  if (!meme) { res.status(404).end(); return; }
  // Owner/admin only, BEFORE deletedAt, so a non-owner can't distinguish a
  // private meme (live or deleted) from a nonexistent one.
  if (!canViewMeme(meme, req)) { res.status(404).end(); return; }
  if (meme.deletedAt) { res.status(410).end(); return; }

  try {
    let imageBuffer: Buffer;

    if (!meme.imageSource) {
      // Legacy pre-rendered meme — fetch from object storage
      const candidates = [
        `/objects/${memeKey(slug, "jpg")}`,
        `/objects/${memeKey(slug, "png")}`,
        `/objects/memes/${slug}.jpg`,
        `/objects/memes/${slug}.png`,
      ];
      let fetched = false;
      for (const objectPath of candidates) {
        try {
          const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
          const response = await objectStorageService.downloadObject(objectFile);
          imageBuffer = Buffer.from(await response.arrayBuffer());
          fetched = true;
          break;
        } catch { /* try next */ }
      }
      if (!fetched) { res.status(404).end(); return; }
    } else {
      // Recipe-based meme — render on the fly
      const [fact, creator] = await Promise.all([
        db
          .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
          .from(factsTable)
          .where(eq(factsTable.id, meme.factId))
          .limit(1)
          .then(rows => rows[0]),
        meme.createdById
          ? db
              .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
              .from(usersTable)
              .where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true)))
              .limit(1)
              .then(rows => rows[0])
          : Promise.resolve(undefined),
      ]);

      const { factText, textOptions } = resolveStoredMemeCaption(fact, creator, meme.textOptions);
      const source = meme.imageSource as StoredImageSource;

      let background: BackgroundSource;
      if (source.type === "template") {
        background = { type: "template", templateId: source.templateId };
      } else if (source.type === "stock") {
        const photoUrl = await resolveStockPhotoUrl(source.pexelsPhotoId, source.photoUrl);
        background = { type: "image", imageData: photoUrl };
      } else if (source.type === "upload") {
        const objectFile = await objectStorageService.getObjectEntityFile(source.uploadKey);
        const downloadResponse = await objectStorageService.downloadObject(objectFile);
        const buf = Buffer.from(await downloadResponse.arrayBuffer());
        background = { type: "image", imageData: buf };
      } else {
        throw new Error(`Unsupported stored image source type: ${(source as { type: string }).type}`);
      }

      imageBuffer = await generateMemeBuffer(background, factText, textOptions, (meme.aspectRatio as MemeAspectRatio | null) ?? "landscape", meme.framingTransform ?? undefined);
    }

    // Store in object storage with a public ACL so Zazzle can fetch it directly
    // Render-versioned path (round 3, PR #398): /api/storage/objects/* is
    // edge-cached for 24h (CACHE.PUBLIC_OBJECT, routes/storage.ts) same as the
    // meme image itself, but this write OVERWRITES a fixed slug-keyed path —
    // so a customer re-exporting the same meme after a render-pipeline fix
    // could still hand Zazzle a URL an edge PoP already has cached from the
    // pre-fix bytes. Folding MEME_RENDER_VERSION into the path means a
    // content-changing fix always produces a URL nothing has cached yet,
    // without needing the og-router Worker (which doesn't intercept this
    // route) or a Cache-Control/ETag scheme this endpoint doesn't have.
    const subPath = `meme-exports/${slug}-v${MEME_RENDER_VERSION}.jpg`;
    await objectStorageService.uploadObjectBuffer({ subPath, buffer: imageBuffer!, contentType: "image/jpeg" });
    await objectStorageService.trySetObjectEntityAclPolicy(`/objects/${subPath}`, {
      owner: "system",
      visibility: "public",
    });

    const url = `${getSiteBaseUrl()}/api/storage/objects/${subPath}`;
    res.json({ url });
  } catch (err) {
    req.log.error({ err, slug }, "Zazzle export failed");
    res.status(502).json({ error: "Export failed" });
  }
});

/**
 * GET /memes/:slug/zazzle-redirect
 *
 * Renders + exports the meme to public object storage, then issues a 302
 * redirect to the Zazzle product-creator URL with the image pre-loaded.
 * Using GET + redirect means the browser treats it as a normal link navigation
 * so there are no popup-blocker issues on Safari / iOS.
 */
router.get("/memes/:slug/zazzle-redirect", async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).end(); return; }
  const returnUrl = typeof req.query["returnUrl"] === "string" ? req.query["returnUrl"] : undefined;
  const preview = req.query["preview"] === "true";
  // ?source=meme-page|wear-page|fact-detail|... — attribution for the
  // admin Affiliate page. Free-form, capped at 64 chars to match the schema.
  const sourceRaw = typeof req.query["source"] === "string" ? req.query["source"].trim() : "";
  const source = sourceRaw && sourceRaw.length <= 64 ? sourceRaw : null;

  const [meme] = await db
    .select()
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);
  if (!meme) { res.status(404).end(); return; }
  // Private memes: only the owner/admin may mint a public Zazzle URL — and the
  // check runs BEFORE deletedAt so a non-owner can't distinguish a deleted
  // private meme from a nonexistent one.
  if (!canViewMeme(meme, req)) { res.status(404).end(); return; }
  if (meme.deletedAt) { res.status(410).end(); return; }

  // Record the affiliate click before doing the (potentially-slow) image
  // export. We deliberately don't log on `?preview=true` — admin debug
  // previews shouldn't pollute the stats. Failures are swallowed so a
  // logging hiccup never blocks the user from getting to Zazzle.
  if (!preview) {
    try {
      const userIdFromReq = (req as { user?: { id?: string } }).user?.id;
      await db.insert(affiliateClicksTable).values({
        userId: typeof userIdFromReq === "string" ? userIdFromReq : null,
        sourceType: "meme",
        sourceId: String(meme.id),
        destination: "zazzle",
        source,
      });
    } catch (err) {
      req.log.warn({ err, slug, source }, "Failed to log affiliate click for zazzle-redirect");
    }
  }

  try {
    let imageBuffer: Buffer;

    if (!meme.imageSource) {
      const candidates = [
        `/objects/${memeKey(slug, "jpg")}`,
        `/objects/${memeKey(slug, "png")}`,
        `/objects/memes/${slug}.jpg`,
        `/objects/memes/${slug}.png`,
      ];
      let fetched = false;
      for (const objectPath of candidates) {
        try {
          const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
          const response = await objectStorageService.downloadObject(objectFile);
          imageBuffer = Buffer.from(await response.arrayBuffer());
          fetched = true;
          break;
        } catch { /* try next */ }
      }
      if (!fetched) {
        const url = await buildZazzleUrl({ returnUrl });
        if (preview) { res.json({ url }); } else { res.redirect(302, url); }
        return;
      }
    } else {
      const [fact, creator] = await Promise.all([
        db
          .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
          .from(factsTable)
          .where(eq(factsTable.id, meme.factId))
          .limit(1)
          .then(rows => rows[0]),
        meme.createdById
          ? db
              .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
              .from(usersTable)
              .where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true)))
              .limit(1)
              .then(rows => rows[0])
          : Promise.resolve(undefined),
      ]);

      const { factText, textOptions } = resolveStoredMemeCaption(fact, creator, meme.textOptions);
      const source = meme.imageSource as StoredImageSource;

      let background: BackgroundSource;
      if (source.type === "template") {
        background = { type: "template", templateId: source.templateId };
      } else if (source.type === "stock") {
        const photoUrl = await resolveStockPhotoUrl(source.pexelsPhotoId, source.photoUrl);
        background = { type: "image", imageData: photoUrl };
      } else if (source.type === "upload") {
        const objectFile = await objectStorageService.getObjectEntityFile(source.uploadKey);
        const downloadResponse = await objectStorageService.downloadObject(objectFile);
        const buf = Buffer.from(await downloadResponse.arrayBuffer());
        background = { type: "image", imageData: buf };
      } else {
        throw new Error(`Unsupported stored image source type: ${(source as { type: string }).type}`);
      }

      imageBuffer = await generateMemeBuffer(background, factText, textOptions, (meme.aspectRatio as MemeAspectRatio | null) ?? "landscape", meme.framingTransform ?? undefined);
    }

    // Render-versioned path (round 3, PR #398): /api/storage/objects/* is
    // edge-cached for 24h (CACHE.PUBLIC_OBJECT, routes/storage.ts) same as the
    // meme image itself, but this write OVERWRITES a fixed slug-keyed path —
    // so a customer re-exporting the same meme after a render-pipeline fix
    // could still hand Zazzle a URL an edge PoP already has cached from the
    // pre-fix bytes. Folding MEME_RENDER_VERSION into the path means a
    // content-changing fix always produces a URL nothing has cached yet,
    // without needing the og-router Worker (which doesn't intercept this
    // route) or a Cache-Control/ETag scheme this endpoint doesn't have.
    const subPath = `meme-exports/${slug}-v${MEME_RENDER_VERSION}.jpg`;
    await objectStorageService.uploadObjectBuffer({ subPath, buffer: imageBuffer!, contentType: "image/jpeg" });
    await objectStorageService.trySetObjectEntityAclPolicy(`/objects/${subPath}`, {
      owner: "system",
      visibility: "public",
    });

    const publicImageUrl = `${getSiteBaseUrl()}/api/storage/objects/${subPath}`;
    const imageName = subPath.split("/").pop() ?? `${slug}.jpg`;
    const url = await buildZazzleUrl({ imageUrl: publicImageUrl, imageName, returnUrl });
    if (preview) { res.json({ url }); } else { res.redirect(302, url); }
  } catch (err) {
    req.log.error({ err, slug }, "Zazzle redirect export failed — falling back to base URL");
    const url = await buildZazzleUrl({ returnUrl });
    if (preview) { res.json({ url }); } else { res.redirect(302, url); }
  }
});

/**
 * GET /memes/:slug/zazzle-redirect-raw
 *
 * Admin-only diagnostic sibling of /zazzle-redirect that skips the
 * regenerate-and-republish-to-meme-exports scaffolding entirely. Hands Zazzle
 * the meme's normal public image URL (the one the site already serves to
 * browsers) so we can compare side-by-side whether the heavyweight export
 * step is actually necessary for Zazzle's image fetcher.
 *
 * Affiliate clicks from this endpoint are tagged with `source =
 * "zazzle-raw-test"` so they don't muddy the regular flow's stats and the two
 * variants stay distinguishable on the admin Affiliate page.
 */
router.get("/memes/:slug/zazzle-redirect-raw", requireAdmin, async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).end(); return; }
  const returnUrl = typeof req.query["returnUrl"] === "string" ? req.query["returnUrl"] : undefined;
  const preview = req.query["preview"] === "true";

  const [meme] = await db
    .select()
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);
  if (!meme) { res.status(404).end(); return; }
  if (meme.deletedAt) { res.status(410).end(); return; }

  // Don't log on ?preview=true — admin debug previews shouldn't pollute stats.
  // Failures are swallowed so a logging hiccup never blocks the redirect.
  if (!preview) {
    try {
      const userIdFromReq = (req as { user?: { id?: string } }).user?.id;
      await db.insert(affiliateClicksTable).values({
        userId: typeof userIdFromReq === "string" ? userIdFromReq : null,
        sourceType: "meme",
        sourceId: String(meme.id),
        destination: "zazzle",
        source: "zazzle-raw-test",
      });
    } catch (err) {
      req.log.warn({ err, slug }, "Failed to log affiliate click for zazzle-redirect-raw");
    }
  }

  try {
    const publicImageUrl = `${getSiteBaseUrl()}/api/memes/${slug}/image`;
    const imageName = `${slug}.jpg`;
    const url = await buildZazzleUrl({ imageUrl: publicImageUrl, imageName, returnUrl });
    if (preview) { res.json({ url }); } else { res.redirect(302, url); }
  } catch (err) {
    req.log.error({ err, slug }, "Zazzle raw redirect failed — falling back to base URL");
    const url = await buildZazzleUrl({ returnUrl });
    if (preview) { res.json({ url }); } else { res.redirect(302, url); }
  }
});

// ─── AI Meme endpoints ─────────────────────────────────────────────────────────

/**
 * GET /facts/:factId/ai-meme-preference — get user's AI meme image index preference
 */
router.get("/facts/:factId/ai-meme-preference", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.json({ aiMemeImageIndex: 0 }); return; }
  const factId = parseInt(String(req.params["factId"] ?? ""), 10);
  if (isNaN(factId)) { res.status(400).json({ error: "Invalid factId" }); return; }
  const [pref] = await db
    .select({ aiMemeImageIndex: userFactPreferencesTable.aiMemeImageIndex })
    .from(userFactPreferencesTable)
    .where(and(eq(userFactPreferencesTable.userId, req.user.id), eq(userFactPreferencesTable.factId, factId)))
    .limit(1);
  res.json({ aiMemeImageIndex: pref?.aiMemeImageIndex ?? 0 });
});

/**
 * PUT /facts/:factId/ai-meme-preference — save user's AI meme image index preference
 */
router.put("/facts/:factId/ai-meme-preference", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const factId = parseInt(String(req.params["factId"] ?? ""), 10);
  if (isNaN(factId)) { res.status(400).json({ error: "Invalid factId" }); return; }
  const aiMemeImageIndex = parseInt(String((req.body as Record<string, unknown>)["aiMemeImageIndex"] ?? "0"), 10);
  if (isNaN(aiMemeImageIndex) || aiMemeImageIndex < 0 || aiMemeImageIndex > 2) {
    res.status(400).json({ error: "Invalid aiMemeImageIndex (must be 0, 1, or 2)" });
    return;
  }
  await db
    .insert(userFactPreferencesTable)
    .values({ userId: req.user.id, factId, aiMemeImageIndex })
    .onConflictDoUpdate({
      target: [userFactPreferencesTable.userId, userFactPreferencesTable.factId],
      set: { aiMemeImageIndex, updatedAt: new Date() },
    });
  res.json({ success: true, aiMemeImageIndex });
});

// DELETE /memes/:slug — soft-delete a meme (creator only)
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

  await db
    .update(memesTable)
    .set({ deletedAt: new Date() })
    .where(eq(memesTable.id, meme.id));

  res.json({ success: true });
});

export default router;
