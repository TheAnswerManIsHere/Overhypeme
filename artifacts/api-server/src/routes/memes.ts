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
import { getRandomStockPhoto } from "../lib/pexelsClient";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "assets/meme-templates");

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

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
    // objectPath from POST /storage/uploads/request-url — must start with /objects/
    uploadKey: z.string().regex(/^\/objects\//).max(500),
  }),
]);

const CreateMemeBody = z.object({
  factId: z.number().int().positive(),
  imageSource: ImageSourceSchema,
  textOptions: TextOptionsSchema,
});

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

// GET /memes/templates/:id/preview — serve static template background PNG
router.get("/memes/templates/:id/preview", (req: Request, res: Response) => {
  const id = req.params["id"] as string;
  const template = MEME_TEMPLATES.find(t => t.id === id);
  if (!template) { res.status(404).end(); return; }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(TEMPLATES_DIR, template.assetPath));
});

/**
 * GET /memes/stock-photo?gender=man|woman|person
 *
 * Returns a random royalty-free portrait photo from Pexels for the given
 * gender hint. Proxied server-side to keep the API key out of the browser.
 * Requires authentication (prevents abuse of the API quota).
 */
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
 * POST /memes — generate image server-side, upload to GCS, save to DB.
 *
 * imageSource determines the background:
 *   { type: "template", templateId }   — gradient template PNG (free)
 *   { type: "stock", photoUrl, ... }   — Pexels photo URL (free)
 *   { type: "upload", uploadKey }      — user-uploaded image from GCS (premium)
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

  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text, canonicalText: factsTable.canonicalText })
    .from(factsTable)
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true)))
    .limit(1);
  if (!fact) {
    res.status(404).json({ error: "Fact not found" });
    return;
  }

  // ── Resolve background source ────────────────────────────────────
  let background: BackgroundSource;
  let templateIdForDb: string;
  let imageSourceForDb: typeof imageSource;

  if (imageSource.type === "template") {
    const validTemplate = MEME_TEMPLATES.find(t => t.id === imageSource.templateId);
    if (!validTemplate) {
      res.status(400).json({ error: "Invalid template ID" });
      return;
    }
    background = { type: "template", templateId: imageSource.templateId };
    templateIdForDb = imageSource.templateId;
    imageSourceForDb = imageSource;

  } else if (imageSource.type === "stock") {
    background = { type: "image", imageData: imageSource.photoUrl };
    templateIdForDb = "photo_stock";
    imageSourceForDb = imageSource;

  } else {
    // upload — premium only
    const [userRow] = await db
      .select({ membershipTier: usersTable.membershipTier })
      .from(usersTable)
      .where(eq(usersTable.id, req.user.id))
      .limit(1);

    if (userRow?.membershipTier !== "premium") {
      res.status(403).json({ error: "Custom photo upload is a Premium feature" });
      return;
    }

    try {
      const objectFile = await objectStorageService.getObjectEntityFile(imageSource.uploadKey);
      const downloadResponse = await objectStorageService.downloadObject(objectFile);
      const arrayBuffer = await downloadResponse.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuffer);
      background = { type: "image", imageData: imageBuffer };
    } catch {
      res.status(404).json({ error: "Uploaded image not found or expired" });
      return;
    }
    templateIdForDb = "photo_upload";
    imageSourceForDb = imageSource;
  }

  // ── Generate unique slug ─────────────────────────────────────────
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

  // ── Render + upload ──────────────────────────────────────────────
  const imageBuffer = await generateMemeBuffer(
    background,
    fact.canonicalText ?? fact.text,
    textOptions,
  );

  const subPath = `memes/${slug}.png`;
  await objectStorageService.uploadObjectBuffer({
    subPath,
    buffer: imageBuffer,
    contentType: "image/png",
  });

  const imageUrl = `/api/memes/${slug}/image`;

  // ── Persist ──────────────────────────────────────────────────────
  const [meme] = await db
    .insert(memesTable)
    .values({
      factId,
      templateId: templateIdForDb,
      imageUrl,
      permalinkSlug: slug,
      textOptions: textOptions ?? null,
      imageSource: imageSourceForDb,
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
  if (meme.createdById) {
    const [user] = await db
      .select({ displayName: usersTable.displayName })
      .from(usersTable)
      .where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true)))
      .limit(1);
    createdByName = user?.displayName ?? null;
  }

  res.json({
    id: meme.id,
    factId: meme.factId,
    templateId: meme.templateId,
    imageUrl: meme.imageUrl,
    permalinkSlug: meme.permalinkSlug,
    factText: fact?.canonicalText ?? fact?.text ?? "",
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

// GET /memes/:slug/image — publicly serve meme image
router.get("/memes/:slug/image", async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).end(); return; }

  const [meme] = await db
    .select({ imageUrl: memesTable.imageUrl })
    .from(memesTable)
    .where(eq(memesTable.permalinkSlug, slug))
    .limit(1);
  if (!meme) { res.status(404).end(); return; }

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
});

export default router;
