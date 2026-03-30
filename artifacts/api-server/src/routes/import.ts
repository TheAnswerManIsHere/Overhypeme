import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { factsTable, hashtagsTable, factHashtagsTable } from "@workspace/db/schema";
import { eq, sql, inArray } from "drizzle-orm";
import { requireApiKey } from "../middlewares/apiKeyAuth";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

const ImportFactItemSchema = z.object({
  text: z
    .string()
    .min(10, "text must be at least 10 characters")
    .max(1000, "text must be 1000 characters or fewer")
    .trim(),
  hashtags: z
    .array(
      z.string()
        .max(100, "each hashtag must be 100 characters or fewer")
        .regex(/^[a-zA-Z0-9_]+$/, "hashtag may only contain letters, numbers, and underscores")
    )
    .max(20, "no more than 20 hashtags per fact")
    .default([]),
});

type ImportFactItem = z.infer<typeof ImportFactItemSchema>;

type FailedItem = {
  index: number;
  errors: { field: string; message: string }[];
};

/**
 * Either a valid API key OR a logged-in admin session is accepted.
 * This lets both automated callers (LLM agents) and human admins use the endpoint.
 */
async function requireApiKeyOrAdmin(req: Request, res: Response, next: () => void): Promise<void> {
  const apiKey = process.env.ADMIN_API_KEY;
  const providedKey = req.headers["x-api-key"];
  const key = Array.isArray(providedKey) ? providedKey[0] : providedKey;

  if (apiKey && key === apiKey) {
    next();
    return;
  }

  requireAdmin(req, res, next);
}

async function upsertHashtag(name: string): Promise<number> {
  const normalised = name.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!normalised) throw new Error(`Invalid hashtag after normalisation: "${name}"`);

  let [ht] = await db.select({ id: hashtagsTable.id }).from(hashtagsTable).where(eq(hashtagsTable.name, normalised)).limit(1);
  if (!ht) {
    [ht] = await db.insert(hashtagsTable).values({ name: normalised }).returning({ id: hashtagsTable.id });
  }
  return ht.id;
}

router.post(
  "/admin/import/facts",
  requireApiKeyOrAdmin as Parameters<typeof router.post>[1],
  async (req: Request, res: Response) => {
    const dryRun = req.query["dryRun"] === "true" || req.query["dryRun"] === "1";

    const body = req.body as unknown;

    if (!Array.isArray(body) && (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).facts))) {
      res.status(400).json({
        error: "Request body must be a JSON array of fact objects, or an object with a `facts` array property.",
      });
      return;
    }

    const rawItems: unknown[] = Array.isArray(body)
      ? body
      : (body as { facts: unknown[] }).facts;

    if (rawItems.length === 0) {
      res.status(400).json({ error: "The facts array must not be empty" });
      return;
    }

    if (rawItems.length > 500) {
      res.status(400).json({ error: "Maximum 500 facts per request" });
      return;
    }

    const validItems: { index: number; data: ImportFactItem }[] = [];
    const failed: FailedItem[] = [];

    for (let i = 0; i < rawItems.length; i++) {
      const parsed = ImportFactItemSchema.safeParse(rawItems[i]);
      if (!parsed.success) {
        const errors = parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "root",
          message: issue.message,
        }));
        failed.push({ index: i, errors });
      } else {
        validItems.push({ index: i, data: parsed.data });
      }
    }

    if (dryRun) {
      res.json({
        dryRun: true,
        wouldCreate: validItems.length,
        failed,
      });
      return;
    }

    let created = 0;
    let skipped = 0;

    // Pre-fetch which texts already exist so we can skip them cleanly
    // (facts.text has no unique constraint, so onConflictDoNothing would not fire)
    const textsToInsert = validItems.map(({ data }) => data.text);
    const existingRows = textsToInsert.length
      ? await db
          .select({ text: factsTable.text })
          .from(factsTable)
          .where(inArray(factsTable.text, textsToInsert))
      : [];
    const existingTexts = new Set(existingRows.map((r) => r.text));

    await db.transaction(async (tx) => {
      for (const { data } of validItems) {
        if (existingTexts.has(data.text)) {
          skipped++;
          continue;
        }

        const [inserted] = await tx
          .insert(factsTable)
          .values({ text: data.text })
          .returning({ id: factsTable.id });

        if (!inserted) {
          skipped++;
          continue;
        }

        // Track so same text appearing multiple times in the payload is also skipped
        existingTexts.add(data.text);
        created++;

        for (const tag of data.hashtags) {
          const hashtagId = await upsertHashtag(tag);
          const [joined] = await tx
            .insert(factHashtagsTable)
            .values({ factId: inserted.id, hashtagId })
            .onConflictDoNothing()
            .returning();
          if (joined) {
            await tx
              .update(hashtagsTable)
              .set({ factCount: sql`${hashtagsTable.factCount} + 1` })
              .where(eq(hashtagsTable.id, hashtagId));
          }
        }
      }
    });

    res.status(201).json({ created, skipped, failed });
  }
);

export default router;
