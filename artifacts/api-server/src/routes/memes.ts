import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "@workspace/db";
import { memesTable, factsTable, usersTable, userFactPreferencesTable } from "@workspace/db/schema";
import { eq, ne, desc, and, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  generateMemeBuffer,
  MEME_TEMPLATES,
  type BackgroundSource,
} from "../lib/memeGenerator";
import { ObjectStorageService } from "../lib/objectStorage";
import { getConfigInt, getConfigString } from "../lib/adminConfig";
import { getRandomStockPhoto, getPhotoById } from "../lib/pexelsClient";
import { renderPersonalized } from "../lib/renderCanonical";
import { compositeAiMeme } from "../lib/aiMemeCompositor";
import { generateAiMemeBackgrounds, generateAiMemeBackgroundFromReference, isUserAtImageLimit, buildFalInputPreview } from "../lib/aiMemePipeline";
import type { AiMemeImages } from "../lib/aiMemePipeline";
import { requirePremium } from "../middlewares/premiumMiddleware";
import { requireAdmin } from "./admin";
import { getUploadImageMetadata } from "./storage";
import { CACHE, setPublicCache, setPublicCors, checkConditional, setNoStore } from "../lib/cacheHeaders";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "assets/meme-templates");

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

// ─── Rate limiting ─────────────────────────────────────────────────────────────
// Simple in-memory limiter — sufficient for a single Replit instance.
// If the app ever scales horizontally, swap this for a Redis-backed solution.

const FREE_LIMIT_PER_HOUR = 10;
const PREMIUM_LIMIT_PER_HOUR = 100;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string, isPremium: boolean): { allowed: boolean; resetAt: number } {
  const limit = isPremium ? PREMIUM_LIMIT_PER_HOUR : FREE_LIMIT_PER_HOUR;
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || entry.resetAt <= now) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + 3_600_000 });
    return { allowed: true, resetAt: now + 3_600_000 };
  }
  if (entry.count >= limit) {
    return { allowed: false, resetAt: entry.resetAt };
  }
  entry.count++;
  return { allowed: true, resetAt: entry.resetAt };
}

// ─── Pexels photo URL cache ────────────────────────────────────────────────────
// Avoids re-hitting the Pexels API on every view of a stock-photo meme.
// Cache entries expire after 15 minutes; the fallback URL stored in the DB
// recipe is used if re-fetch fails.

const PHOTO_URL_CACHE_TTL = 15 * 60 * 1000;
const photoUrlCache = new Map<number, { url: string; fetchedAt: number }>();

async function resolveStockPhotoUrl(
  pexelsPhotoId: number,
  fallbackUrl: string,
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
    // Fall back to the URL stored at generation time
    return fallbackUrl;
  }
}

// ─── Validation ────────────────────────────────────────────────────────────────

const TextOptionsSchema = z.object({
  fontSize: z.number().int().min(14).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  verticalPosition: z.enum(["top", "middle", "bottom"]).optional(),
  topText: z.string().max(500).optional(),
  bottomText: z.string().max(500).optional(),
  fontFamily: z.string().max(50).optional(),
  outlineColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  textEffect: z.enum(["shadow", "outline", "none"]).optional(),
  outlineWidth: z.number().min(0).max(20).optional(),
  allCaps: z.boolean().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
}).optional();

const ImageSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("template"),
    templateId: z.string().min(1).max(50),
  }),
  z.object({
    type: z.literal("stock"),
    photoUrl: z.string().url().max(2000),
    pexelsPhotoId: z.number().int().positive(),
    photographerName: z.string().max(200),
  }),
  z.object({
    type: z.literal("upload"),
    uploadKey: z.string().regex(/^\/objects\//).max(500),
  }),
]);

const CreateMemeBody = z.object({
  factId: z.number().int().positive(),
  imageSource: ImageSourceSchema,
  textOptions: TextOptionsSchema,
  previewImageBase64: z.string().max(700_000).optional(),
  isPublic: z.boolean().optional(),
  aspectRatio: z.enum(["landscape", "square", "portrait"]).optional(),
});

// Stored imageSource shape from the DB (jsonb — we cast and validate manually)
type StoredImageSource = z.infer<typeof ImageSourceSchema>;

function generateSlug(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

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

// GET /memes/templates/:id/preview
router.get("/memes/templates/:id/preview", (req: Request, res: Response) => {
  const id = req.params["id"] as string;
  const template = MEME_TEMPLATES.find(t => t.id === id);
  if (!template) { res.status(404).end(); return; }

  const etag = `"template-${id}"`;
  if (checkConditional(req, res, etag)) return;

  setPublicCors(res);
  res.setHeader("Content-Type", "image/png");
  setPublicCache(res, CACHE.MEME_TEMPLATE, etag);
  res.sendFile(path.join(TEMPLATES_DIR, template.assetPath));
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

  const parsed = CreateMemeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { factId, imageSource, textOptions, previewImageBase64, isPublic: isPublicReq, aspectRatio: aspectRatioReq } = parsed.data;

  // ── Membership check ────────────────────────────────────────────
  const [userRow] = await db
    .select({ membershipTier: usersTable.membershipTier })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id))
    .limit(1);
  const isPremium = userRow?.membershipTier === "premium";

  // Free users always get public memes; premium users can choose
  const isPublic = isPremium ? (isPublicReq ?? true) : true;

  // ── Rate limit ───────────────────────────────────────────────────
  const rl = checkRateLimit(req.user.id, isPremium);
  if (!rl.allowed) {
    const retrySec = Math.ceil((rl.resetAt - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retrySec));
    res.status(429).json({
      error: `Meme generation limit reached. Try again in ${Math.ceil(retrySec / 60)} min.`,
    });
    return;
  }

  // ── Source-specific validation ───────────────────────────────────
  if (imageSource.type === "template") {
    const valid = MEME_TEMPLATES.find(t => t.id === imageSource.templateId);
    if (!valid) {
      res.status(400).json({ error: "Invalid template ID" });
      return;
    }
  }

  if (imageSource.type === "upload" && !isPremium) {
    res.status(403).json({ error: "Custom photo upload is a Legendary feature" });
    return;
  }

  // ── Look up fact ─────────────────────────────────────────────────
  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text, canonicalText: factsTable.canonicalText })
    .from(factsTable)
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true)))
    .limit(1);
  if (!fact) {
    res.status(404).json({ error: "Fact not found" });
    return;
  }

  // ── Unique slug ──────────────────────────────────────────────────
  let slug = generateSlug();
  for (let i = 0; i < 5; i++) {
    const [existing] = await db
      .select({ id: memesTable.id })
      .from(memesTable)
      .where(eq(memesTable.permalinkSlug, slug))
      .limit(1);
    if (!existing) break;
    slug = generateSlug();
  }

  // ── Persist ──────────────────────────────────────────────────────
  const templateIdForDb =
    imageSource.type === "template" ? imageSource.templateId :
    imageSource.type === "stock"    ? "photo_stock" :
    "photo_upload";

  // If the client sent a pre-rendered canvas image, store it directly so
  // the saved meme is pixel-for-pixel identical to the preview.
  let storedImageSource: z.infer<typeof ImageSourceSchema> | null = imageSource;
  if (previewImageBase64) {
    try {
      const imgBuffer = Buffer.from(previewImageBase64, "base64");
      await objectStorageService.uploadObjectBuffer({
        subPath: `memes/${slug}.png`,
        buffer: imgBuffer,
        contentType: "image/jpeg",
      });
      // Setting imageSource to null triggers the legacy serving path which
      // reads the pre-rendered file from object storage.
      storedImageSource = null;
    } catch (uploadErr) {
      req.log.warn({ uploadErr }, "Preview image upload failed — falling back to server-side render");
    }
  }

  const uploadMeta = imageSource.type === "upload"
    ? await getUploadImageMetadata(imageSource.uploadKey)
    : null;

  const [meme] = await db
    .insert(memesTable)
    .values({
      factId,
      templateId: templateIdForDb,
      imageUrl: `/api/memes/${slug}/image`,
      permalinkSlug: slug,
      textOptions: textOptions ?? null,
      imageSource: storedImageSource,
      isPublic,
      isLowRes: uploadMeta?.isLowRes ?? false,
      originalWidth: uploadMeta?.width ?? null,
      originalHeight: uploadMeta?.height ?? null,
      uploadFileSizeBytes: uploadMeta?.fileSizeBytes ?? null,
      createdById: req.user.id,
      aspectRatio: aspectRatioReq ?? "landscape",
    })
    .returning();

  res.status(201).json({
    id: meme.id,
    factId: meme.factId,
    templateId: meme.templateId,
    imageUrl: meme.imageUrl,
    permalinkSlug: meme.permalinkSlug,
    createdAt: meme.createdAt.toISOString(),
  });
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
  if (meme.deletedAt) { res.status(410).json({ error: "This meme has been removed by its creator.", deleted: true }); return; }

  const [fact] = await db
    .select({ text: factsTable.text, canonicalText: factsTable.canonicalText })
    .from(factsTable)
    .where(and(eq(factsTable.id, meme.factId), eq(factsTable.isActive, true)))
    .limit(1);

  let createdByName: string | null = null;
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
  const factText = createdByName && rawTemplate
    ? renderPersonalized(rawTemplate, createdByName, creatorPronouns)
    : (fact?.canonicalText ?? fact?.text ?? "");

  res.json({
    id: meme.id,
    factId: meme.factId,
    templateId: meme.templateId,
    imageUrl: meme.imageUrl,
    permalinkSlug: meme.permalinkSlug,
    factText,
    createdAt: meme.createdAt.toISOString(),
    createdByName,
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
  const memes = await db
    .select()
    .from(memesTable)
    .where(visibilityFilter)
    .orderBy(desc(memesTable.createdAt))
    .limit(maxMemes);

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
    })),
  });
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

  // Verify ownership
  const ownership = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM user_ai_images
    WHERE user_id = ${req.user.id} AND storage_path = ${storagePath} AND image_type = 'reference'
  `);
  if (parseInt(ownership.rows[0]?.count ?? "0", 10) === 0) {
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
  if (meme.deletedAt) { res.status(410).end(); return; }

  // ── Legacy path: memes stored before recipe-based rendering ─────
  if (!meme.imageSource) {
    const objectPath = `/objects/memes/${slug}.png`;
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
      const etag = `"legacy-${slug}"`;
      if (checkConditional(req, res, etag)) return;
      const response = await objectStorageService.downloadObject(objectFile, 86400);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      setPublicCache(res, CACHE.MEME_IMAGE, etag);
      setPublicCors(res);
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch {
      res.status(404).end();
    }
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

  const rawTemplate = fact?.text ?? fact?.canonicalText ?? "";
  const factText = creator?.displayName && rawTemplate
    ? renderPersonalized(rawTemplate, creator.displayName, creator.pronouns)
    : (fact?.canonicalText ?? fact?.text ?? "");
  const source = meme.imageSource as StoredImageSource;
  const textOptions = (meme.textOptions ?? undefined) as Parameters<typeof generateMemeBuffer>[2];

  let background: BackgroundSource;

  try {
    if (source.type === "template") {
      background = { type: "template", templateId: source.templateId };

    } else if (source.type === "stock") {
      const photoUrl = await resolveStockPhotoUrl(source.pexelsPhotoId, source.photoUrl);
      background = { type: "image", imageData: photoUrl };

    } else {
      // upload — fetch buffer from GCS
      const objectFile = await objectStorageService.getObjectEntityFile(source.uploadKey);
      const downloadResponse = await objectStorageService.downloadObject(objectFile);
      const imageBuffer = Buffer.from(await downloadResponse.arrayBuffer());
      background = { type: "image", imageData: imageBuffer };
    }

    const imageBuffer = await generateMemeBuffer(background, factText, textOptions);

    const etag = `"meme-${slug}"`;
    if (checkConditional(req, res, etag)) return;

    setPublicCors(res);
    res.setHeader("Content-Type", "image/png");
    setPublicCache(res, CACHE.MEME_IMAGE, etag);
    res.setHeader("Content-Length", imageBuffer.length);
    res.status(200).send(imageBuffer);

  } catch (err) {
    req.log.error({ err, slug }, "Meme render failed");
    res.status(502).end();
  }
});

// ─── AI Meme endpoints ─────────────────────────────────────────────────────────

/**
 * GET /memes/ai/:factId/image
 *
 * Composites the AI meme on-the-fly:
 * - Loads the appropriate AI background from object storage
 * - Renders the personalized fact text as bold, all-caps white text with outline
 * - Streams back a JPEG
 *
 * Query params:
 *   userId     — user ID to personalize the fact text for
 *   gender     — "male" | "female" | "neutral" (defaults to "neutral")
 *   imageIndex — 0..2 (defaults to 0)
 *   raw        — if "true", streams the raw background PNG without text overlay (for thumbnails)
 */
router.get("/memes/ai/:factId/image", async (req: Request, res: Response) => {
  const factId = parseInt(String(req.params["factId"] ?? ""), 10);
  if (isNaN(factId)) { res.status(400).end(); return; }

  const gender = (["male", "female", "neutral"].includes(String(req.query["gender"] ?? ""))
    ? req.query["gender"]
    : "neutral") as "male" | "female" | "neutral";

  const imageIndex = Math.max(0, Math.min(999, parseInt(String(req.query["imageIndex"] ?? "0"), 10) || 0));
  const rawMode = req.query["raw"] === "true";

  try {
    const [fact] = await db
      .select({ text: factsTable.text, canonicalText: factsTable.canonicalText, aiMemeImages: factsTable.aiMemeImages, updatedAt: factsTable.updatedAt })
      .from(factsTable)
      .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true)))
      .limit(1);

    if (!fact) { res.status(404).end(); return; }

    const aiImages = fact.aiMemeImages as AiMemeImages | null;
    if (!aiImages || !aiImages[gender]?.[imageIndex]) {
      res.status(404).json({ error: "AI meme background not yet generated for this fact" });
      return;
    }

    const backgroundPath = aiImages[gender][imageIndex]!;

    if (rawMode) {
      // Serve the raw background PNG directly (used for gallery thumbnails)
      const objectStorageService = new ObjectStorageService();
      const normalizedPath = objectStorageService.normalizeObjectEntityPath(backgroundPath);
      const objectFile = await objectStorageService.getObjectEntityFile(normalizedPath);
      // ETag includes updatedAt so it invalidates automatically after regen overwrites the image
      const aiEtag = `"ai-bg-${factId}-${gender}-${imageIndex}-${fact.updatedAt.getTime()}"`;
      if (checkConditional(req, res, aiEtag)) return;
      const response = await objectStorageService.downloadObject(objectFile, 86400);
      res.setHeader("Content-Type", "image/png");
      setPublicCache(res, CACHE.MEME_TEMPLATE, aiEtag);
      setPublicCors(res);
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
      return;
    }

    // Personalize fact text for the user if userId provided
    let factText: string;
    const userId = String(req.query["userId"] ?? "").trim();
    if (userId) {
      const [user] = await db
        .select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
        .from(usersTable)
        .where(and(eq(usersTable.id, userId), eq(usersTable.isActive, true)))
        .limit(1);
      const rawTemplate = fact.text ?? fact.canonicalText ?? "";
      factText = user?.displayName && rawTemplate
        ? renderPersonalized(rawTemplate, user.displayName, user.pronouns)
        : (fact.canonicalText ?? fact.text ?? "");
    } else {
      factText = fact.canonicalText ?? fact.text ?? "";
    }

    const jpegBuffer = await compositeAiMeme(backgroundPath, factText);

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", CACHE.NO_STORE);
    res.setHeader("Content-Length", jpegBuffer.length);
    res.status(200).send(jpegBuffer);

  } catch (err) {
    req.log.error({ err, factId }, "AI meme compositing failed");
    res.status(502).end();
  }
});


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

// GET /memes/ai/:factId/prompts — return stored scene prompts + live admin config values for debugging (admin only)
// Query params: styleId (optional), isRef=1 (optional)
router.get("/memes/ai/:factId/prompts", requireAdmin, async (req: Request, res: Response) => {
  const factId = parseInt(String(req.params["factId"] ?? ""), 10);
  if (isNaN(factId)) { res.status(400).json({ error: "Invalid factId" }); return; }
  const [fact] = await db
    .select({ aiScenePrompts: factsTable.aiScenePrompts })
    .from(factsTable)
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true)))
    .limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  // Resolve style suffix from admin config — same getConfigString used by generation, cache is
  // busted immediately on admin save, so this always reflects the current saved value.
  const rawStyleId = String(req.query["styleId"] ?? "");
  const isRef = req.query["isRef"] === "1";
  let styleSuffix: string | null = null;
  if (rawStyleId && rawStyleId !== "none") {
    const { IMAGE_STYLE_MAP } = await import("../config/imageStyles.js");
    const styleDef = IMAGE_STYLE_MAP.get(rawStyleId);
    if (styleDef) {
      const defaultSuffix = isRef ? styleDef.promptSuffixReference : styleDef.promptSuffix;
      const configKey = isRef ? `style_suffix_ref_${rawStyleId}` : `style_suffix_${rawStyleId}`;
      styleSuffix = (await getConfigString(configKey, defaultSuffix)) || null;
    }
  }

  // Resolve reference frame prompt from admin config
  const DEFAULT_REF_FRAME =
    "Generate an image using the provided reference photo. The person's face, facial structure, skin tone, eye shape, hair, and all distinguishing features must be preserved with photorealistic accuracy and remain visually identical to the reference — this is the highest priority. Do not alter, stylize, or idealize the person's facial features in any way. The person should be placed into the scene as described. The scene and environment should be stylized as described, but the person's face and likeness must remain untouched by any stylization. No text, words, or letters anywhere in the image.";
  const referenceFramePrompt = (await getConfigString("ai_reference_frame_prompt", DEFAULT_REF_FRAME)) || DEFAULT_REF_FRAME;

  // Build a preview of the full fal.ai call — reads all config values, returns model + input object
  // without actually invoking fal.ai. Accept optional modelOverride and paramsOverride as query params.
  const modelOverrideQ = String(req.query["modelOverride"] ?? "").trim() || undefined;
  let paramsOverrideQ: Record<string, string> | undefined;
  try {
    const raw = req.query["paramsOverride"];
    if (raw && typeof raw === "string") {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        paramsOverrideQ = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string" || typeof v === "number")
            .map(([k, v]) => [k, String(v)])
        );
      }
    }
  } catch { /* ignore malformed paramsOverride */ }

  // Compute the finalPrompt for the preview — mirror generateAiMemeBackgrounds logic:
  // genderKey defaults to "neutral" if not provided (abstract facts generate 1 image)
  const genderKey = (["male", "female", "neutral"].includes(String(req.query["gender"] ?? "")) ?
    String(req.query["gender"]) : "neutral") as "male" | "female" | "neutral";
  const storedPrompts = fact.aiScenePrompts as Record<string, string> | null | undefined;
  const sceneBase = storedPrompts?.[genderKey] ?? "(scene prompt will be generated on first run)";
  const promptWithSuffix = styleSuffix ? `${sceneBase.trim()} ${styleSuffix}` : sceneBase;
  const previewPrompt = isRef ? `${referenceFramePrompt} ${promptWithSuffix}` : promptWithSuffix;

  let falCallPreview: { model: string; input: Record<string, unknown> } | null = null;
  try {
    falCallPreview = await buildFalInputPreview(previewPrompt, {
      modelOverride: modelOverrideQ,
      isReference: isRef,
      paramsOverride: paramsOverrideQ,
    });
  } catch { /* non-fatal — omit from response */ }

  res.json({
    prompts: fact.aiScenePrompts ?? null,
    styleSuffix,
    referenceFramePrompt,
    falCallPreview,
  });
});

// POST /memes/ai/:factId/regenerate-scene-prompts — admin force-refreshes stored scene prompts for a fact
router.post("/memes/ai/:factId/regenerate-scene-prompts", requireAdmin, async (req: Request, res: Response) => {
  const factId = parseInt(String(req.params["factId"] ?? ""), 10);
  if (isNaN(factId)) { res.status(400).json({ error: "Invalid factId" }); return; }
  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true)))
    .limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }
  const { generateScenePrompts } = await import("../lib/aiMemePipeline.js");
  const prompts = await generateScenePrompts(fact.text);
  await db.update(factsTable).set({ aiScenePrompts: prompts }).where(eq(factsTable.id, factId));
  res.json({ success: true, prompts });
});

// POST /memes/ai/:factId/generate — premium user triggers AI image generation for a fact
router.post("/memes/ai/:factId/generate", requirePremium, async (req: Request, res: Response) => {
  const factId = parseInt(String(req.params["factId"] ?? ""), 10);
  if (isNaN(factId)) { res.status(400).json({ error: "Invalid factId" }); return; }

  const body = req.body as Record<string, unknown>;
  const scope = body["scope"] === "abstract" ? "abstract" : "gendered";

  // Optional reference image path for reference-based generation.
  // If the caller provides *any* referenceImagePath value, validate strictly — no silent fallback.
  const rawRefPath = body["referenceImagePath"];
  if (rawRefPath !== undefined && rawRefPath !== null) {
    if (typeof rawRefPath !== "string" || !rawRefPath.startsWith("/objects/")) {
      res.status(400).json({ error: "Invalid referenceImagePath: must be a string starting with /objects/." });
      return;
    }
  }
  const referenceImagePath = typeof rawRefPath === "string" ? rawRefPath : null;

  // targetGender for reference mode (which gender slot to generate for)
  const rawGender = body["targetGender"];
  // In reference mode, targetGender is required and must be a valid value
  if (rawRefPath !== undefined && rawRefPath !== null) {
    if (rawGender !== "male" && rawGender !== "female" && rawGender !== "neutral") {
      res.status(400).json({ error: "targetGender is required and must be 'male', 'female', or 'neutral' when using referenceImagePath." });
      return;
    }
  }
  const targetGender: "male" | "female" | "neutral" =
    rawGender === "male" ? "male" :
    rawGender === "female" ? "female" : "neutral";

  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text, parentId: factsTable.parentId, aiScenePrompts: factsTable.aiScenePrompts, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true)))
    .limit(1);

  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }
  if (fact.parentId !== null) { res.status(400).json({ error: "AI meme generation only supported on root facts" }); return; }

  // Check storage limit before firing pipeline
  if (req.user?.id && await isUserAtImageLimit(req.user.id)) {
    res.status(429).json({
      error: "You have reached your image storage limit. Delete some of your existing AI backgrounds or uploaded images to generate new ones.",
      limitExceeded: true,
    });
    return;
  }

  const existingPrompts = fact.aiScenePrompts as import("../lib/aiMemePipeline").AiScenePrompts | undefined;
  const existingImages = fact.aiMemeImages as AiMemeImages | undefined;

  // Resolve optional style suffix from styleId
  const rawStyleId = body["styleId"];
  let styleSuffix: string | undefined;
  if (typeof rawStyleId === "string" && rawStyleId !== "none") {
    const { IMAGE_STYLE_MAP } = await import("../config/imageStyles.js");
    const styleDef = IMAGE_STYLE_MAP.get(rawStyleId);
    if (styleDef) {
      const defaultSuffix = referenceImagePath ? styleDef.promptSuffixReference : styleDef.promptSuffix;
      const configKey = referenceImagePath ? `style_suffix_ref_${rawStyleId}` : `style_suffix_${rawStyleId}`;
      styleSuffix = (await getConfigString(configKey, defaultSuffix)) || undefined;
    }
  }

  // Admin-only: allow model override for testing different fal.ai models
  const rawModelOverride = body["modelOverride"];
  const modelOverride =
    req.user?.role === "admin" && typeof rawModelOverride === "string" && rawModelOverride.trim()
      ? rawModelOverride.trim()
      : undefined;

  // Admin-only: per-request parameter overrides (e.g. guidance_scale, num_inference_steps)
  const rawParamsOverride = body["paramsOverride"];
  const paramsOverride: Record<string, string> | undefined =
    req.user?.role === "admin" &&
    rawParamsOverride !== null &&
    typeof rawParamsOverride === "object" &&
    !Array.isArray(rawParamsOverride)
      ? Object.fromEntries(
          Object.entries(rawParamsOverride as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string" || typeof v === "number")
            .map(([k, v]) => [k, String(v)])
        )
      : undefined;

  if (referenceImagePath) {
    // Reference-based: validate path belongs to this user's uploads BEFORE reading storage.
    // This enforces both authorization (no IDOR) and the "uploaded photos only" source requirement.
    const uploadCheck = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM upload_image_metadata
      WHERE object_path = ${referenceImagePath}
        AND user_id = ${req.user?.id ?? ""}
    `);
    const uploadCount = parseInt(uploadCheck.rows[0]?.count ?? "0", 10);
    if (uploadCount === 0) {
      res.status(403).json({ error: "Reference image not found in your uploads." });
      return;
    }

    let referenceBuffer: Buffer;
    try {
      const file = await objectStorageService.getObjectEntityFile(referenceImagePath);
      const [content] = await file.download();
      referenceBuffer = content;
    } catch {
      res.status(400).json({ error: "Could not read reference image from storage." });
      return;
    }
    try {
      await generateAiMemeBackgroundFromReference(fact.id, fact.text, referenceBuffer, targetGender, {
        existingPrompts,
        userId: req.user?.id,
        styleSuffix,
        modelOverride,
        paramsOverride,
      });
    } catch (err) {
      res.status(500).json({ error: extractGenerationError(err) });
      return;
    }
  } else {
    try {
      await generateAiMemeBackgrounds(fact.id, fact.text, {
        scope,
        existingPrompts,
        existingImages,
        userId: req.user?.id,
        styleSuffix,
        modelOverride,
        paramsOverride,
      });
    } catch (err) {
      res.status(500).json({ error: extractGenerationError(err) });
      return;
    }
  }

  res.json({ success: true });
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

// DELETE /memes/ai/:factId/image — hard-delete an AI background image slot (owner only)
// Query params: gender (male|female|neutral), imageIndex (0-based)
router.delete("/memes/ai/:factId/image", requirePremium, async (req: Request, res: Response) => {
  const factId = parseInt(String(req.params["factId"] ?? ""), 10);
  if (isNaN(factId)) { res.status(400).json({ error: "Invalid factId" }); return; }

  const gender = String(req.query["gender"] ?? "") as "male" | "female" | "neutral";
  if (!["male", "female", "neutral"].includes(gender)) {
    res.status(400).json({ error: "gender must be male, female, or neutral" }); return;
  }
  const imageIndex = parseInt(String(req.query["imageIndex"] ?? ""), 10);
  if (isNaN(imageIndex) || imageIndex < 0) {
    res.status(400).json({ error: "imageIndex must be a non-negative integer" }); return;
  }

  const [fact] = await db
    .select({ id: factsTable.id, aiMemeImages: factsTable.aiMemeImages })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);

  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  const images = (fact.aiMemeImages ?? {}) as AiMemeImages;
  const genderImages: string[] = Array.isArray(images[gender]) ? [...images[gender]] : [];
  const storagePath = genderImages[imageIndex];

  if (!storagePath) { res.status(404).json({ error: "Image slot not found" }); return; }

  // Ownership check: only the user who generated this image can delete it
  const ownerRows = await db.execute(sql`
    SELECT id FROM user_ai_images
    WHERE user_id = ${req.user!.id} AND storage_path = ${storagePath}
    LIMIT 1
  `);
  if (!ownerRows.rows.length) {
    res.status(403).json({ error: "You do not own this AI background image" }); return;
  }

  // Hard-delete from storage FIRST — if this fails, do not touch DB (strict hard-delete)
  try {
    await objectStorageService.deleteObject(storagePath);
  } catch (e) {
    console.error("[DELETE /memes/ai/:factId/image] Storage delete failed:", e);
    res.status(500).json({ error: "Failed to delete image from storage. Please try again." }); return;
  }

  // Null out the slot to preserve array indices of remaining images
  genderImages[imageIndex] = "";
  const updatedImages: AiMemeImages = { ...images, [gender]: genderImages };
  await db
    .update(factsTable)
    .set({ aiMemeImages: updatedImages })
    .where(eq(factsTable.id, factId));

  // Remove from user tracking table
  await db.execute(sql`
    DELETE FROM user_ai_images WHERE id = (
      SELECT id FROM user_ai_images WHERE user_id = ${req.user!.id} AND storage_path = ${storagePath} LIMIT 1
    )
  `);

  res.json({ success: true });
});

export default router;
