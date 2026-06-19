/**
 * Enrichment async-job handler.
 *
 * One queue registered on the shared async-jobs worker (see lib/asyncJobs.ts):
 *
 *   "enrichment"  — classify-only: runs the taxonomy classifier (+ cultural
 *                   refs + semantic entities) and writes the enrichment blob to
 *                   the pending review OR the live fact.
 *
 * The handler updates `enrichment_status` on the target so the admin UI
 * surfaces accurate state. There is NO render-time visual-preview phase here:
 * the render-time visualPlan + Nano Banana compiler (surfaced by the
 * RuntimePromptPreview) is the single source of truth for the visual. The
 * async-jobs worker applies the standard retry + abandon flow on top of the
 * handler outcome.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { pendingReviewsTable, factsTable } from "@workspace/db/schema";
import {
  validateEnrichment,
  type FactEnrichment,
} from "@workspace/api-zod";
import { enrichFact, buildFactEnrichmentColumns } from "./factEnrichment";
import { renderCanonical } from "./renderCanonical";
import {
  registerJobHandler,
  type JobHandler,
  type HandlerResult,
} from "./asyncJobs";

// ─── Payload shapes ─────────────────────────────────────────────────────────

// The enrichment job classifies either a pending review (submission flow +
// admin re-run) or a live fact (admin re-run on the Facts page). Exactly one of
// reviewId / factId is set.
interface EnrichmentJobPayload {
  reviewId?: number;
  factId?: number;
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

/**
 * Re-classification regenerates the whole enrichment blob from the LLM, which
 * does NOT know about the moderator-authored `visualPromptStrategyOverride`
 * (Phase 2). Carry it forward verbatim (including its server-owned
 * updatedBy/updatedAt) so re-running AI never wipes a moderator's work.
 */
function withPreservedOverride(fresh: FactEnrichment, prior: unknown): FactEnrichment {
  const ov = (prior as { visualPromptStrategyOverride?: unknown } | null | undefined)?.visualPromptStrategyOverride;
  return ov ? ({ ...fresh, visualPromptStrategyOverride: ov } as FactEnrichment) : fresh;
}

// ─── "enrichment" handler — classify only ──────────────────────────────────

async function runEnrichmentForReview(reviewId: number): Promise<HandlerResult> {
  // Load the submitted text so we can classify (+ the prior enrichment so a
  // moderator's visual-strategy override survives re-classification).
  const [reviewRow] = await db
    .select({ submittedText: pendingReviewsTable.submittedText, enrichment: pendingReviewsTable.enrichment })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, reviewId))
    .limit(1);
  if (!reviewRow) {
    return { ok: false, error: `pending review ${reviewId} not found` };
  }

  // Render template tokens ({NAME}/{SUBJ}/…) to the canonical identity ("Alex",
  // they/them) before passing to the classifier. The LLM expects plain English,
  // not raw template syntax.
  const renderedText = renderCanonical(reviewRow.submittedText);

  let enrichment: FactEnrichment;
  try {
    enrichment = await enrichFact({ factText: renderedText, status: "new_fact" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(pendingReviewsTable)
      .set({ enrichmentStatus: "failed" })
      .where(eq(pendingReviewsTable.id, reviewId));
    return { ok: false, error: `classify: ${msg}` };
  }
  enrichment = withPreservedOverride(enrichment, reviewRow.enrichment);

  await db
    .update(pendingReviewsTable)
    .set({ enrichment, enrichmentStatus: "ok" })
    .where(eq(pendingReviewsTable.id, reviewId));

  return { ok: true };
}

/**
 * Dependency seam for runEnrichmentForFact: classification is a network call,
 * so tests inject a deterministic stub to exercise the classify-ok / classify-fail
 * branches.
 */
export interface FactEnrichmentDeps {
  classify: typeof enrichFact;
}

export async function runEnrichmentForFact(
  factId: number,
  deps: FactEnrichmentDeps = { classify: enrichFact },
): Promise<HandlerResult> {
  // Load the fact text + parentId so a variant is classified with its parent
  // context (same shape the approve-variant path uses).
  const [factRow] = await db
    .select({ text: factsTable.text, parentId: factsTable.parentId, enrichment: factsTable.enrichment })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!factRow) {
    return { ok: false, error: `fact ${factId} not found` };
  }

  let parentText: string | null = null;
  if (factRow.parentId != null) {
    const [parent] = await db
      .select({ text: factsTable.text })
      .from(factsTable)
      .where(eq(factsTable.id, factRow.parentId))
      .limit(1);
    parentText = parent?.text ?? null;
  }

  // Render template tokens ({NAME}/{SUBJ}/…) to the canonical identity ("Alex",
  // they/them) before passing to the classifier.
  const renderedFactText = renderCanonical(factRow.text);
  const renderedParentText = parentText != null ? renderCanonical(parentText) : null;

  let enrichment: FactEnrichment;
  try {
    enrichment = await deps.classify({
      factText: renderedFactText,
      status: factRow.parentId != null ? "variant" : "new_fact",
      parentText: renderedParentText,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(factsTable)
      .set({ enrichmentStatus: "failed" })
      .where(eq(factsTable.id, factId));
    return { ok: false, error: `classify: ${msg}` };
  }
  enrichment = withPreservedOverride(enrichment, factRow.enrichment);

  // Write the enrichment + re-sync the indexed projection columns.
  await db
    .update(factsTable)
    .set({ ...buildFactEnrichmentColumns(enrichment), enrichmentStatus: "ok" })
    .where(eq(factsTable.id, factId));

  return { ok: true };
}

export const enrichmentJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const { reviewId, factId } = payload as EnrichmentJobPayload;
    if (typeof factId === "number") {
      return runEnrichmentForFact(factId);
    }
    if (typeof reviewId === "number") {
      return runEnrichmentForReview(reviewId);
    }
    return { ok: false, error: "enrichmentJob payload missing reviewId/factId" };
  },
};

/** Register the enrichment queue with the shared async-jobs worker. */
export function registerEnrichmentJobHandlers(): void {
  registerJobHandler("enrichment", enrichmentJobHandler);
}

// Exported for callers (the routes file consumes the registerer + this helper).
export { loadPendingReviewEnrichment };
