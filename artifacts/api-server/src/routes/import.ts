import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { and, inArray } from "drizzle-orm";
import { requireApiKey } from "../middlewares/apiKeyAuth";
import { normalizeFactTemplateForPendingReview } from "../lib/normalizeFactTemplateForStorage";
import { createTriageReview } from "../lib/moderationStaging";
import { UNRESOLVED_SUBMISSION_STAGE_VALUES } from "@workspace/api-zod";

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

type FailedItem = {
  index: number;
  errors: { field: string; message: string }[];
};

// POST /admin/import/facts
// Accepts a JSON array of ImportFactItem objects (or { facts: [...] }) and bulk-inserts them.
// Supports ?dryRun=true to validate without writing.
router.post("/admin/import/facts", requireApiKey, async (req: Request, res: Response) => {
  const dryRun = req.query["dryRun"] === "true" || req.query["dryRun"] === "1";

  const body = req.body as unknown;

  if (
    !Array.isArray(body) &&
    (typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as Record<string, unknown>).facts))
  ) {
    res.status(400).json({
      error:
        "Request body must be a JSON array of fact objects, or an object with a `facts` array property.",
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

  const validItems: { index: number; text: string; hashtags: string[] }[] = [];
  const failed: FailedItem[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const parsed = ImportFactItemSchema.safeParse(rawItems[i]);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "root",
        message: issue.message,
      }));
      failed.push({ index: i, errors });
      continue;
    }
    // Route bulk rows through the SAME normalizer user submissions use
    // (normalizeFactTemplateForPendingReview), so an imported fact normalizes
    // identically to a manually-submitted one. Storage-derived fields
    // (canonicalText/splitTokenIndex/hasPronouns) are NOT computed here — the
    // review→staging→approval pipeline derives them at its proper stage.
    const normalized = normalizeFactTemplateForPendingReview(parsed.data.text);
    if (!normalized.valid) {
      failed.push({
        index: i,
        errors: [
          { field: "text", message: `Template grammar validation failed: ${normalized.grammarResult.error}` },
        ],
      });
      continue;
    }
    validItems.push({ index: i, text: normalized.text, hashtags: parsed.data.hashtags });
  }

  if (dryRun) {
    res.json({ dryRun: true, wouldQueue: validItems.length, failed });
    return;
  }

  let queued = 0;
  let skipped = 0;

  // Dedup by exact text against BOTH existing facts AND existing UNRESOLVED
  // reviews, so bulk import can't flood the triage queue with duplicates.
  // (facts.text has no unique constraint, so ON CONFLICT would not fire.)
  const textsToCheck = validItems.map((v) => v.text);
  const [existingFactRows, existingReviewRows] = textsToCheck.length
    ? await Promise.all([
        db.select({ text: factsTable.text }).from(factsTable).where(inArray(factsTable.text, textsToCheck)),
        db
          .select({ text: pendingReviewsTable.submittedText })
          .from(pendingReviewsTable)
          .where(
            and(
              inArray(pendingReviewsTable.submittedText, textsToCheck),
              inArray(pendingReviewsTable.workflowStage, [...UNRESOLVED_SUBMISSION_STAGE_VALUES]),
            ),
          ),
      ])
    : [[], []];
  const seen = new Set<string>([
    ...existingFactRows.map((r) => r.text),
    ...existingReviewRows.map((r) => r.text),
  ]);

  // The API-key endpoint has no req.user — these are SYSTEM imports
  // (submittedById = null, the same nullable-submitter shape refresh reviews use:
  // no user to notify, no activity-feed entry). Each row becomes a Stage-1 triage
  // review, NOT an active fact — bulk import loads the moderation queue, it does
  // not publish. Enrichment/embeddings/hashtag-upsert are deferred to the pipeline.
  await db.transaction(async (tx) => {
    for (const item of validItems) {
      if (seen.has(item.text)) { skipped++; continue; }
      seen.add(item.text);
      await createTriageReview(tx, {
        submittedText: item.text,
        submittedById: null,
        hashtags: item.hashtags,
      });
      queued++;
    }
  });

  res.status(201).json({ queued, skipped, failed });
});

export default router;
