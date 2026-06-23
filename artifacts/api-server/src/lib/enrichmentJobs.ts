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
import { pendingReviewsTable, factsTable, type AsyncJobRow } from "@workspace/db/schema";
import {
  validateEnrichment,
  computeBaselineChangedPaths,
  type FactEnrichment,
  type EnrichmentOverrides,
} from "@workspace/api-zod";
import { enrichFact, materializeEnrichment } from "./factEnrichment";
import { recordOverrideHistory } from "./enrichmentOverrideHistory";
import { renderCanonical } from "./renderCanonical";
import {
  advanceReviewForStagingFactEnrichment,
  isStagingPrepActive,
} from "./moderationStaging";
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
  // context (same shape the approve-variant path uses), plus the override layers
  // so re-classification stays STICKY: a fresh AI baseline is computed but the
  // manual overrides (and the moderator visual override) are preserved.
  const [factRow] = await db
    .select({
      text: factsTable.text,
      parentId: factsTable.parentId,
      enrichment: factsTable.enrichment,
      enrichmentAiDerived: factsTable.enrichmentAiDerived,
      enrichmentOverrides: factsTable.enrichmentOverrides,
    })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!factRow) {
    return { ok: false, error: `fact ${factId} not found` };
  }

  // COST GUARD: if this fact is a staging fact whose review has left
  // prep_pending (e.g. the moderator rejected it while a retry was queued),
  // skip all model calls. Treated as a successful no-op so the job retires.
  if (!(await isStagingPrepActive(factId))) {
    return { ok: true };
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

  let freshAiDerived: FactEnrichment;
  try {
    freshAiDerived = await deps.classify({
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

  // STICKY re-enrich: keep the existing overrides untouched (never refresh their
  // `overriddenFrom` — that is what lets us detect a baseline change), preserve
  // the moderator visual override, and rematerialize against the fresh baseline.
  const overrides = (factRow.enrichmentOverrides ?? {}) as EnrichmentOverrides;
  const priorAiDerived = (factRow.enrichmentAiDerived ?? null) as FactEnrichment | null;
  const visualPromptStrategyOverride = (factRow.enrichment as
    | { visualPromptStrategyOverride?: FactEnrichment["visualPromptStrategyOverride"] }
    | null
    | undefined)?.visualPromptStrategyOverride;

  // Audit only the not-changed → changed transitions (no per-re-enrich spam).
  const before = priorAiDerived ? computeBaselineChangedPaths(priorAiDerived, overrides) : [];
  const after = computeBaselineChangedPaths(freshAiDerived, overrides);
  const newlyChanged = after.filter((p) => !before.includes(p));

  const { columns } = materializeEnrichment({
    aiDerived: freshAiDerived,
    overrides,
    visualPromptStrategyOverride,
  });

  await db
    .update(factsTable)
    .set({ ...columns, enrichmentStatus: "ok" })
    .where(eq(factsTable.id, factId));

  if (newlyChanged.length > 0) {
    await recordOverrideHistory(
      newlyChanged.map((path) => ({
        factId,
        path,
        action: "baseline_reenriched" as const,
        oldValue: overrides[path]?.overriddenFrom ?? null,
        newValue: (freshAiDerived as Record<string, unknown>)[path.slice(1)] ?? null,
        aiGenerationId: freshAiDerived.aiGenerationId ?? null,
      })),
    );
  }

  // Advance a linked staging review prep_pending → production_review. No-op for
  // live-fact re-enrich (no linked review).
  await advanceReviewForStagingFactEnrichment({ factId, outcome: "success" });

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
  // Terminal failure (retries exhausted) for a fact-backed enrichment job marks
  // the linked staging review prep_failed so the moderator can retry or reject.
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const { factId } = (row.payload ?? {}) as EnrichmentJobPayload;
    if (typeof factId === "number") {
      await advanceReviewForStagingFactEnrichment({ factId, outcome: "terminal_failed" });
    }
  },
};

/** Register the enrichment queue with the shared async-jobs worker. */
export function registerEnrichmentJobHandlers(): void {
  registerJobHandler("enrichment", enrichmentJobHandler);
}

// Exported for callers (the routes file consumes the registerer + this helper).
export { loadPendingReviewEnrichment };
