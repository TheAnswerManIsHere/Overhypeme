import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "@workspace/db";
import { memesTable, factsTable, usersTable } from "@workspace/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { z } from "zod";
import { generateMemeBuffer, MEME_TEMPLATES } from "../lib/memeGenerator";
import { ObjectStorageService } from "../lib/objectStorage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "assets/meme-templates");

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const CreateMemeBody = z.object({
  factId: z.number().int().positive(),
  templateId: z.string().min(1).max(50),
  textOptions: z.object({
    fontSize: z.number().int().min(14).max(48).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    verticalPosition: z.enum(["top", "middle", "bottom"]).optional(),
  }).optional(),
});

function generateSlug(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

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

// GET /memes/:slug
router.get("/memes/:slug", async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).json({ error: "Slug required" }); return; }

  const [meme] = await db.select().from(memesTable).where(eq(memesTable.permalinkSlug, slug)).limit(1);
  if (!meme) { res.status(404).json({ error: "Meme not found" }); return; }

  const [fact] = await db.select({ text: factsTable.text }).from(factsTable).where(and(eq(factsTable.id, meme.factId), eq(factsTable.isActive, true))).limit(1);
  let createdByName: string | null = null;
  if (meme.createdById) {
    const [user] = await db.select({ displayName: usersTable.displayName }).from(usersTable).where(and(eq(usersTable.id, meme.createdById), eq(usersTable.isActive, true))).limit(1);
    createdByName = user?.displayName ?? null;
  }

  res.json({
    id: meme.id,
    factId: meme.factId,
    templateId: meme.templateId,
    imageUrl: meme.imageUrl,
    permalinkSlug: meme.permalinkSlug,
    factText: fact?.text ?? "",
    createdAt: meme.createdAt.toISOString(),
    createdByName,
  });
});

// POST /memes — generates image server-side, uploads to GCS, saves to DB
router.post("/memes", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }

  const parsed = CreateMemeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() }); return; }

  const { factId, templateId, textOptions } = parsed.data;

  const [fact] = await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable).where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true))).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  const validTemplate = MEME_TEMPLATES.find(t => t.id === templateId);
  if (!validTemplate) { res.status(400).json({ error: "Invalid template ID" }); return; }

  let slug = generateSlug();
  for (let i = 0; i < 5; i++) {
    const [existing] = await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.permalinkSlug, slug)).limit(1);
    if (!existing) break;
    slug = generateSlug();
  }

  const imageBuffer = await generateMemeBuffer(templateId, fact.text, textOptions);

  const subPath = `memes/${slug}.png`;
  await objectStorageService.uploadObjectBuffer({
    subPath,
    buffer: imageBuffer,
    contentType: "image/png",
  });

  const imageUrl = `/api/memes/${slug}/image`;

  const [meme] = await db.insert(memesTable).values({
    factId,
    templateId,
    imageUrl,
    permalinkSlug: slug,
    textOptions: textOptions ?? null,
    createdById: req.user.id,
  }).returning();

  res.status(201).json({
    id: meme.id,
    factId: meme.factId,
    templateId: meme.templateId,
    imageUrl: meme.imageUrl,
    permalinkSlug: meme.permalinkSlug,
    createdAt: meme.createdAt.toISOString(),
  });
});

// GET /facts/:factId/memes
router.get("/facts/:factId/memes", async (req: Request, res: Response) => {
  const factId = parseInt((req.params["factId"] ?? "") as string);
  if (isNaN(factId)) { res.status(400).json({ error: "Invalid factId" }); return; }

  const memes = await db.select().from(memesTable).where(eq(memesTable.factId, factId)).orderBy(desc(memesTable.createdAt)).limit(20);

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

// GET /memes/:slug/image — publicly serve meme image (verifies slug exists in DB)
router.get("/memes/:slug/image", async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).end(); return; }

  const [meme] = await db.select({ imageUrl: memesTable.imageUrl }).from(memesTable).where(eq(memesTable.permalinkSlug, slug)).limit(1);
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
