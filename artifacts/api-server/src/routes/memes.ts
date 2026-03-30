import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { memesTable, factsTable, usersTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";

const router: IRouter = Router();

function generateSlug(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

const TEMPLATES = [
  {
    id: "action",
    name: "Action Hero",
    description: "High-contrast dark blue gradient — pure action movie energy",
    previewColors: ["#0a0e2e", "#1a237e", "#283593"],
  },
  {
    id: "fire",
    name: "On Fire",
    description: "Blazing orange-red gradient for the most intense facts",
    previewColors: ["#bf360c", "#e64a19", "#ff6d00"],
  },
  {
    id: "night",
    name: "Night Ops",
    description: "Tactical dark background with subtle green accent",
    previewColors: ["#0a0a0a", "#1b2420", "#263238"],
  },
  {
    id: "gold",
    name: "Legendary",
    description: "Golden gradient for facts of mythical proportions",
    previewColors: ["#4a2c00", "#f57f17", "#ffd54f"],
  },
  {
    id: "cinema",
    name: "Cinematic",
    description: "Classic sepia-toned cinematic style",
    previewColors: ["#2d1e00", "#5d4037", "#8d6e63"],
  },
];

const CreateMemeBody = z.object({
  factId: z.number().int().positive(),
  templateId: z.string().min(1).max(50),
  objectPath: z.string().min(1),
  textOptions: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    fontSize: z.number().int().optional(),
    color: z.string().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
  }).optional(),
});

// GET /memes/templates
router.get("/memes/templates", (_req: Request, res: Response) => {
  res.json({ templates: TEMPLATES });
});

// GET /memes/:slug
router.get("/memes/:slug", async (req: Request, res: Response) => {
  const slug = req.params["slug"] as string;
  if (!slug) { res.status(400).json({ error: "Slug required" }); return; }

  const [meme] = await db.select().from(memesTable).where(eq(memesTable.permalinkSlug, slug)).limit(1);
  if (!meme) { res.status(404).json({ error: "Meme not found" }); return; }

  const [fact] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, meme.factId)).limit(1);
  let createdByName: string | null = null;
  if (meme.createdById) {
    const [user] = await db.select({ firstName: usersTable.firstName }).from(usersTable).where(eq(usersTable.id, meme.createdById)).limit(1);
    createdByName = user?.firstName ?? null;
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

// POST /memes
router.post("/memes", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = CreateMemeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() }); return; }

  const { factId, templateId, objectPath, textOptions } = parsed.data;

  const [fact] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  const validTemplate = TEMPLATES.find(t => t.id === templateId);
  if (!validTemplate) { res.status(400).json({ error: "Invalid template ID" }); return; }

  const imageUrl = `/api/storage${objectPath}`;
  let slug = generateSlug();
  let attempts = 0;
  while (attempts < 5) {
    const [existing] = await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.permalinkSlug, slug)).limit(1);
    if (!existing) break;
    slug = generateSlug();
    attempts++;
  }

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

export default router;
