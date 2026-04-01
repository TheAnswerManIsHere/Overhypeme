import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "@workspace/db";
import { memesTable, factsTable, usersTable } from "@workspace/db/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  generateMemeBuffer,
  MEME_TEMPLATES,
  type BackgroundSource,
} from "../lib/memeGenerator";
import { ObjectStorageService } from "../lib/objectStorage";
import { getRandomStockPhoto, getPhotoById } from "../lib/pexelsClient";
import { renderPersonalized } from "../lib/renderCanonical";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "assets/meme-templates");

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

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
  fontSize: z.number().int().min(14).max(48).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  verticalPosition: z.enum(["top", "middle", "bottom"]).optional(),
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
});

// Stored imageSource shape from the DB (jsonb — we cast and validate manually)
type StoredImageSource = z.infer<typeof ImageSourceSchema>;

function generateSlug(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// GET /memes/templates
router.get("/memes/templates", (_req: Request, res: Response) => {
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
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
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
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = CreateMemeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { factId, imageSource, textOptions } = parsed.data;

  // ── Membership check ────────────────────────────────────────────
  const [userRow] = await db
    .select({ membershipTier: usersTable.membershipTier })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id))
    .limit(1);
  const isPremium = userRow?.membershipTier === "premium";

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
    res.status(403).json({ error: "Custom photo upload is a Premium feature" });
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

  // ── Persist recipe only — no image generated or stored ──────────
  const templateIdForDb =
    imageSource.type === "template" ? imageSource.templateId :
    imageSource.type === "stock"    ? "photo_stock" :
    "photo_upload";

  const [meme] = await db
    .insert(memesTable)
    .values({
      factId,
      templateId: templateIdForDb,
      imageUrl: `/api/memes/${slug}/image`,
      permalinkSlug: slug,
      textOptions: textOptions ?? null,
      imageSource,
      createdById: req.user.id,
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

// GET /facts/:factId/memes
router.get("/facts/:factId/memes", async (req: Request, res: Response) => {
  const factId = parseInt((req.params["factId"] ?? "") as string);
  if (isNaN(factId)) { res.status(400).json({ error: "Invalid factId" }); return; }

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

  const memes = await db
    .select()
    .from(memesTable)
    .where(
      factIds.length === 1
        ? eq(memesTable.factId, factIds[0]!)
        : inArray(memesTable.factId, factIds),
    )
    .orderBy(desc(memesTable.createdAt))
    .limit(40);

  res.json({
    memes: memes.map(m => ({
      id: m.id,
      factId: m.factId,
      templateId: m.templateId,
      imageUrl: m.imageUrl,
      permalinkSlug: m.permalinkSlug,
      createdAt: m.createdAt.toISOString(),
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
router.get("/memes/:slug/image", async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).end(); return; }

  const [meme] = await db
    .select()
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);
  if (!meme) { res.status(404).end(); return; }

  // ── Legacy path: memes stored before recipe-based rendering ─────
  if (!meme.imageSource) {
    const objectPath = `/objects/memes/${slug}.png`;
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
      const response = await objectStorageService.downloadObject(objectFile, 86400);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
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

    // 7-day public cache — browsers and CDNs will serve this without hitting
    // the server again, so the render cost is paid only once per slug.
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
    res.setHeader("Content-Length", imageBuffer.length);
    res.status(200).send(imageBuffer);

  } catch (err) {
    req.log.error({ err, slug }, "Meme render failed");
    res.status(502).end();
  }
});

export default router;
