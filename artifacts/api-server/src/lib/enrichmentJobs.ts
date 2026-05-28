/**
 * Enrichment + visual-preview async-job handlers (Phase 2A).
 *
 * Two queues registered on the shared async-jobs worker (see lib/asyncJobs.ts):
 *
 *   "enrichment"  — phase 1 (classify + cultural refs) then phase 2
 *                   (visual prompt preview); writes the full blob to the
 *                   pending review.
 *   "preview"     — phase 2 only. Uses the stored taxonomy + cultural refs
 *                   from the target (pending review OR approved fact) and
 *                   merges the visualPromptPreview into the target.
 *
 * Both handlers update `enrichment_status` / `enrichment.previewStatus` on
 * the target so the admin UI surfaces accurate state. The async-jobs worker
 * applies the standard retry + abandon flow on top of the handler outcome.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { pendingReviewsTable, factsTable } from "@workspace/db/schema";
import {
  validateEnrichment,
  hasUsableVisualPreview,
  type FactEnrichment,
  type VisualPromptPreview,
} from "@workspace/api-zod";
import { enrichFact } from "./factEnrichment";
import { generateVisualPreview } from "./promptStrategy";
import {
  registerJobHandler,
  type JobHandler,
  type HandlerResult,
} from "./asyncJobs";
import { logger } from "./logger";

// ─── Payload shapes ─────────────────────────────────────────────────────────

interface EnrichmentJobPayload {
  reviewId: number;
}

interface PreviewJobPayload {
  targetType: "pending_review" | "fact";
  targetId: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadPendingReviewEnrichment(reviewId: number): Promise<FactEnrichment | null> {
  const [row] = await db
    .select({ enrichment: pendingReviewsTable.enrichment, submittedText: pendingReviewsTable.submittedText })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, reviewId))
    .limit(1);
  if (!row) return null;
  const validated = validateEnrichment(row.enrichment);
  return validated.ok ? validated.data : null;
}

async function loadFactEnrichment(factId: number): Promise<{ enrichment: FactEnrichment; factText: string } | null> {
  const [row] = await db
    .select({ enrichment: factsTable.enrichment, text: factsTable.text })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!row) return null;
  const validated = validateEnrichment(row.enrichment);
  if (!validated.ok) return null;
  return { enrichment: validated.data, factText: row.text };
}

async function mergePreviewIntoPendingReview(
  reviewId: number,
  preview: VisualPromptPreview | null,
  status: "ok" | "failed",
): Promise<void> {
  // Re-read the latest enrichment so we don't clobber a concurrent admin edit.
  const [row] = await db
    .select({ enrichment: pendingReviewsTable.enrichment })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, reviewId))
    .limit(1);
  if (!row) return;
  const current = (row.enrichment ?? {}) as Record<string, unknown>;
  const merged = {
    ...current,
    ...(preview ? { visualPromptPreview: preview } : {}),
    previewStatus: status,
  };
  await db
    .update(pendingReviewsTable)
    .set({ enrichment: merged as unknown as FactEnrichment })
    .where(eq(pendingReviewsTable.id, reviewId));
}

async function mergePreviewIntoFact(
  factId: number,
  preview: VisualPromptPreview | null,
  status: "ok" | "failed",
): Promise<void> {
  const [row] = await db
    .select({ enrichment: factsTable.enrichment })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!row) return;
  const current = (row.enrichment ?? {}) as Record<string, unknown>;
  const merged = {
    ...current,
    ...(preview ? { visualPromptPreview: preview } : {}),
    previewStatus: status,
  };
  await db
    .update(factsTable)
    .set({ enrichment: merged as unknown as FactEnrichment })
    .where(eq(factsTable.id, factId));
}

// ─── "enrichment" handler — phase 1 then phase 2 ───────────────────────────

export const enrichmentJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const { reviewId } = payload as EnrichmentJobPayload;
    if (typeof reviewId !== "number") {
      return { ok: false, error: "enrichmentJob payload missing reviewId" };
    }
    // Load the submitted text so we can classify.
    const [reviewRow] = await db
      .select({ submittedText: pendingReviewsTable.submittedText })
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, reviewId))
      .limit(1);
    if (!reviewRow) {
      return { ok: false, error: `pending review ${reviewId} not found` };
    }

    // ── Phase 1: classify + cultural references ──
    let enrichment: FactEnrichment;
    try {
      enrichment = await enrichFact({ factText: reviewRow.submittedText, status: "new_fact" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(pendingReviewsTable)
        .set({ enrichmentStatus: "failed" })
        .where(eq(pendingReviewsTable.id, reviewId));
      return { ok: false, error: `phase 1 (classify): ${msg}` };
    }

    // Write phase 1 result so the admin UI sees progress even if phase 2 fails.
    await db
      .update(pendingReviewsTable)
      .set({ enrichment, enrichmentStatus: "ok" })
      .where(eq(pendingReviewsTable.id, reviewId));

    // ── Phase 2: visual prompt preview ──
    try {
      const preview = await generateVisualPreview({
        factText: reviewRow.submittedText,
        enrichment,
      });
      await mergePreviewIntoPendingReview(reviewId, preview, "ok");
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, reviewId }, "[enrichmentJob] phase 2 preview failed; phase 1 enrichment retained");
      await mergePreviewIntoPendingReview(reviewId, null, "failed");
      // Phase 2 failure is non-fatal — admin can hand-fill the preview or
      // regenerate it. Return ok so the job isn't retried indefinitely (a
      // chronic failure should be visible to the admin and fixed there).
      return { ok: true, result: { previewError: msg } };
    }
  },
};

// ─── "preview" handler — phase 2 only ──────────────────────────────────────

export const previewJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const { targetType, targetId } = payload as PreviewJobPayload;
    if (!targetType || typeof targetId !== "number") {
      return { ok: false, error: "previewJob payload missing targetType/targetId" };
    }

    let enrichment: FactEnrichment;
    let factText: string;
    if (targetType === "pending_review") {
      const [row] = await db
        .select({ enrichment: pendingReviewsTable.enrichment, submittedText: pendingReviewsTable.submittedText })
        .from(pendingReviewsTable)
        .where(eq(pendingReviewsTable.id, targetId))
        .limit(1);
      if (!row) return { ok: false, error: `pending review ${targetId} not found` };
      const validated = validateEnrichment(row.enrichment);
      if (!validated.ok) {
        return { ok: false, error: `cannot regenerate preview: stored enrichment is invalid (${validated.error})` };
      }
      enrichment = validated.data;
      factText = row.submittedText;
    } else {
      const loaded = await loadFactEnrichment(targetId);
      if (!loaded) return { ok: false, error: `fact ${targetId} not found or has no enrichment` };
      enrichment = loaded.enrichment;
      factText = loaded.factText;
    }

    try {
      const preview = await generateVisualPreview({ factText, enrichment });
      if (targetType === "pending_review") {
        await mergePreviewIntoPendingReview(targetId, preview, "ok");
      } else {
        await mergePreviewIntoFact(targetId, preview, "ok");
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (targetType === "pending_review") {
        await mergePreviewIntoPendingReview(targetId, null, "failed");
      } else {
        await mergePreviewIntoFact(targetId, null, "failed");
      }
      return { ok: false, error: `preview generation failed: ${msg}` };
    }
  },
};

/** Register both Phase 2A queues with the shared async-jobs worker. */
export function registerEnrichmentJobHandlers(): void {
  registerJobHandler("enrichment", enrichmentJobHandler);
  registerJobHandler("preview", previewJobHandler);
}

// Quiet the unused-import linter: the helpers below are exported for future
// callers (the routes file consumes the registerer + handlers).
export { hasUsableVisualPreview, loadPendingReviewEnrichment };
