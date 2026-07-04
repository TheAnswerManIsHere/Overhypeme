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

import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  pendingReviewsTable,
  factsTable,
  factEnrichmentVersionsTable,
  type AsyncJobRow,
} from "@workspace/db/schema";
import {
  validateEnrichment,
  computeBaselineChangedPaths,
  type FactEnrichment,
  type EnrichmentOverrides,
} from "@workspace/api-zod";
import { enrichFact, materializeEnrichment } from "./factEnrichment";
import { recordOverrideHistory } from "./enrichmentOverrideHistory";
import { hashFactText } from "./enrichmentVersioning";
import { currentProcessingSignatureFromConfig } from "./processingSignature";
import { enqueueVisualConceptsForReview } from "./visualConceptJobs";
import { renderCanonical } from "./renderCanonical";
import {
  advanceReviewForStagingFactEnrichment,
  resolveGenericFactEnrichmentDecision,
} from "./moderationStaging";
import {
  enqueueJob,
  registerJobHandler,
  type JobHandler,
  type HandlerResult,
} from "./asyncJobs";
import { logger } from "./logger";

// Queue name owned by reviewRenderScenarios.ts (kept as a literal, same as
// moderationStaging.ts, to avoid importing that heavy orchestration module).
const REVIEW_RENDER_PREPARE_QUEUE = "review_render_scenarios_prepare";

// ─── Payload shapes ─────────────────────────────────────────────────────────

// The enrichment job classifies either a pending review (submission flow +
// admin re-run) or a live fact (admin re-run on the Facts page). Exactly one of
// reviewId / factId is set.
interface EnrichmentJobPayload {
  reviewId?: number;
  factId?: number;
  // Present ⇒ this is a stale-fact REFRESH candidate run: classify into the
  // fact_enrichment_versions candidate row, NEVER facts.* (which stays the
  // live/active enrichment the public reads until the candidate is promoted).
  versionId?: number;
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

  // GENERIC-JOB GUARD (cost + isolation): run only for a live fact or an
  // in-prep first-time staging cycle. Skips are retired as successful no-ops
  // and touch NOTHING — in particular `refresh_candidate_in_review`, where a
  // stale generic job writing facts.* would corrupt an in-flight refresh whose
  // enrichment lives in the candidate VERSION row.
  const decision = await resolveGenericFactEnrichmentDecision(factId);
  if (decision.action === "skip") {
    logger.info({ factId, reason: decision.reason }, "[enrichment] generic fact job skipped");
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

  // Capture the processing signature BEFORE the (slow) classify call. It is
  // stamped onto facts.last_processed_signature only for FIRST-TIME staging
  // prep (decided under the fact lock below) — so a brand-new fact approved
  // today reads fresh (not stale-for-reprocess). A direct LIVE re-enrich never
  // stamps: an existing live fact only becomes "fresh" via the versioned
  // refresh (send-back → promote), keeping refresh-first intact.
  const signature = await currentProcessingSignatureFromConfig();

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

  // Transactional RE-check before the write (mirrors the candidate job's
  // phase 3): the pre-classify guard can't cover state that changed DURING the
  // LLM call — most importantly a send-back committing mid-classify, which
  // must freeze facts.* for its refresh cycle. The fact row lock serializes
  // with sendFactBackToReview (which locks the fact first), so the recheck
  // either sees the new candidate (→ discard this stale result) or the
  // send-back waits and seeds its candidate from the freshly-written active.
  const wrote = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: factsTable.id })
      .from(factsTable)
      .where(eq(factsTable.id, factId))
      .for("update")
      .limit(1);
    if (!locked) return false;
    const recheck = await resolveGenericFactEnrichmentDecision(factId, tx);
    if (recheck.action === "skip") {
      logger.info(
        { factId, reason: recheck.reason },
        "[enrichment] generic fact result discarded at recheck (state changed mid-classify)",
      );
      return false;
    }
    // Stamp the signature ONLY for first-time staging prep (never live_fact —
    // that's refresh-first). Use the RECHECK's mode (observed under the lock),
    // with the pre-classify signature VALUE captured above.
    const stampSignature = recheck.mode === "first_time_staging";
    await tx
      .update(factsTable)
      .set({
        ...columns,
        enrichmentStatus: "ok",
        ...(stampSignature ? { lastProcessedSignature: signature } : {}),
      })
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
        tx,
      );
    }
    return true;
  });
  if (!wrote) return { ok: true }; // retired as a successful no-op — the new owner (e.g. a refresh cycle) has the fact

  // Advance a linked staging review prep_pending → production_review. No-op for
  // live-fact re-enrich (no linked review) and refused for refresh cycles.
  await advanceReviewForStagingFactEnrichment({ factId, outcome: "success" });

  return { ok: true };
}

/**
 * Classify a stale-fact REFRESH candidate into its `fact_enrichment_versions`
 * row (never `facts.*`). Two-phase, so the fact stays live and editable and the
 * refresh can be rejected mid-flight without a lock held across the LLM call:
 *
 *   1. cheap preflight (no locks) — candidate still `candidate`, its exact
 *      source review still `prep_pending`; else retire as a successful no-op;
 *   2. LLM classification;
 *   3. transactional recheck under row locks — re-validate the candidate + its
 *      exact review are still current, then write the candidate row and advance
 *      that exact review prep_pending → production_review.
 */
export async function runEnrichmentForCandidateVersion(
  versionId: number,
  deps: FactEnrichmentDeps = { classify: enrichFact },
): Promise<HandlerResult> {
  // ── Phase 1: cheap preflight ──
  const [v0] = await db
    .select({
      factId: factEnrichmentVersionsTable.factId,
      status: factEnrichmentVersionsTable.status,
      sourceReviewId: factEnrichmentVersionsTable.sourceReviewId,
      overrides: factEnrichmentVersionsTable.enrichmentOverrides,
      visualOverride: factEnrichmentVersionsTable.visualOverride,
    })
    .from(factEnrichmentVersionsTable)
    .where(eq(factEnrichmentVersionsTable.id, versionId))
    .limit(1);
  if (!v0 || v0.status !== "candidate" || v0.sourceReviewId == null) return { ok: true }; // gone/rejected/superseded → no-op
  const [rev0] = await db
    .select({ stage: pendingReviewsTable.workflowStage })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, v0.sourceReviewId))
    .limit(1);
  if (rev0?.stage !== "prep_pending") return { ok: true }; // cycle resolved → no-op

  const [factRow] = await db
    .select({ text: factsTable.text, parentId: factsTable.parentId })
    .from(factsTable)
    .where(eq(factsTable.id, v0.factId))
    .limit(1);
  if (!factRow) return { ok: false, error: `fact ${v0.factId} not found for candidate ${versionId}` };
  let parentText: string | null = null;
  if (factRow.parentId != null) {
    const [parent] = await db
      .select({ text: factsTable.text })
      .from(factsTable)
      .where(eq(factsTable.id, factRow.parentId))
      .limit(1);
    parentText = parent?.text ?? null;
  }
  const factTextHash = hashFactText(factRow.text);

  // Capture the processing signature the candidate is being classified UNDER,
  // BEFORE the (slow) LLM call — so a "Mark major update" landing mid-classify
  // stamps the revision in effect when the model work began, not after.
  const signature = await currentProcessingSignatureFromConfig();

  // ── Phase 2: LLM classification (no locks held) ──
  let freshAiDerived: FactEnrichment;
  try {
    freshAiDerived = await deps.classify({
      factText: renderCanonical(factRow.text),
      status: factRow.parentId != null ? "variant" : "new_fact",
      parentText: parentText != null ? renderCanonical(parentText) : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Reflect failure on the live fact's pill; leave the cycle prep_pending so
    // the job retries. Terminal exhaustion → onAbandon marks the cycle failed.
    await db.update(factsTable).set({ enrichmentStatus: "failed" }).where(eq(factsTable.id, v0.factId));
    return { ok: false, error: `classify: ${msg}` };
  }

  const overrides = (v0.overrides ?? {}) as EnrichmentOverrides;
  const visualPromptStrategyOverride = (v0.visualOverride ?? undefined) as
    | FactEnrichment["visualPromptStrategyOverride"]
    | undefined;
  const { columns } = materializeEnrichment({ aiDerived: freshAiDerived, overrides, visualPromptStrategyOverride });

  // ── Phase 3: transactional recheck + write ──
  const { advancedReviewId } = await db.transaction(async (tx): Promise<{ advancedReviewId: number | null }> => {
    const [v1] = await tx
      .select({ status: factEnrichmentVersionsTable.status, sourceReviewId: factEnrichmentVersionsTable.sourceReviewId })
      .from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, versionId))
      .for("update")
      .limit(1);
    if (!v1 || v1.status !== "candidate" || v1.sourceReviewId == null) return { advancedReviewId: null }; // rejected/superseded mid-run → no-op
    const [rev1] = await tx
      .select({ stage: pendingReviewsTable.workflowStage })
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, v1.sourceReviewId))
      .for("update")
      .limit(1);
    if (rev1?.stage !== "prep_pending") return { advancedReviewId: null }; // cycle advanced/resolved mid-run → no-op

    await tx
      .update(factEnrichmentVersionsTable)
      .set({
        enrichment: columns.enrichment,
        enrichmentAiDerived: columns.enrichmentAiDerived,
        enrichmentOverrides: columns.enrichmentOverrides,
        visualOverride: visualPromptStrategyOverride ?? null,
        factTextHash,
        // Captured before classify (above). Promote copies this onto
        // facts.last_processed_signature (permissive: candidate's classify-time
        // signature, not a fresh one).
        signature,
      })
      .where(eq(factEnrichmentVersionsTable.id, versionId));
    // Advance THIS exact cycle (deterministic — not the fact-only re-discovery helper).
    await tx
      .update(pendingReviewsTable)
      .set({ workflowStage: "production_review" })
      .where(eq(pendingReviewsTable.id, v1.sourceReviewId));
    // Clear the live fact's "working" pill; facts.* enrichment itself is untouched.
    await tx.update(factsTable).set({ enrichmentStatus: "ok" }).where(eq(factsTable.id, v0.factId));
    return { advancedReviewId: v1.sourceReviewId };
  });

  // Refresh cycles get the SAME Step-2 default render prep a first-time cycle
  // gets on this transition (see advanceReviewForStagingFactEnrichment) — the
  // grid renders the CANDIDATE via the review-cycle resolver. Best-effort +
  // deduped; a failure here must not fail the (already-committed) enrichment.
  if (advancedReviewId != null) {
    try {
      await enqueueJob({
        queue: REVIEW_RENDER_PREPARE_QUEUE,
        payload: { reviewId: advancedReviewId },
        dedupeKey: `review_render_prep:${advancedReviewId}`,
      });
    } catch (err) {
      logger.error(
        { err, reviewId: advancedReviewId, versionId },
        "[refresh] failed to enqueue review render prepare (enrichment kept)",
      );
    }

    // Slice 2A: a refresh cycle gets the SAME candidate Visual-concept draft a
    // first-time cycle gets on this transition (see
    // advanceReviewForStagingFactEnrichment). Review-aware via candidateVersionId
    // so concepts reflect the CANDIDATE's enrichment, not the active fact's.
    // Best-effort + non-blocking — a failure here must not fail the enrichment.
    try {
      await enqueueVisualConceptsForReview({
        reviewId: advancedReviewId,
        factId: v0.factId,
        candidateVersionId: versionId,
      });
    } catch (err) {
      logger.error(
        { err, reviewId: advancedReviewId, versionId },
        "[refresh] failed to enqueue visual concepts (enrichment kept)",
      );
    }
  }
  return { ok: true };
}

export const enrichmentJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const { reviewId, factId, versionId } = payload as EnrichmentJobPayload;
    if (typeof versionId === "number") {
      return runEnrichmentForCandidateVersion(versionId);
    }
    if (typeof factId === "number") {
      return runEnrichmentForFact(factId);
    }
    if (typeof reviewId === "number") {
      return runEnrichmentForReview(reviewId);
    }
    return { ok: false, error: "enrichmentJob payload missing reviewId/factId/versionId" };
  },
  // Terminal failure (retries exhausted): mark the linked cycle prep_failed so
  // the moderator can retry or reject. Fact-backed staging jobs use the
  // fact-only helper; refresh-candidate jobs advance their exact review.
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const { factId, versionId } = (row.payload ?? {}) as EnrichmentJobPayload;
    if (typeof versionId === "number") {
      const [v] = await db
        .select({
          factId: factEnrichmentVersionsTable.factId,
          status: factEnrichmentVersionsTable.status,
          sourceReviewId: factEnrichmentVersionsTable.sourceReviewId,
        })
        .from(factEnrichmentVersionsTable)
        .where(eq(factEnrichmentVersionsTable.id, versionId))
        .limit(1);
      // Stale-abandon guard (mirrors advanceReviewForStagingFactEnrichment):
      // only a still-in-flight cycle may be marked failed. If the moderator
      // already resolved it (rejected mid-retries), rewriting the review to
      // prep_failed — or flipping the LIVE fact's pill to failed — would
      // corrupt a settled state.
      if (v?.sourceReviewId != null && v.status === "candidate") {
        const advanced = await db
          .update(pendingReviewsTable)
          .set({ workflowStage: "prep_failed" })
          .where(and(
            eq(pendingReviewsTable.id, v.sourceReviewId),
            eq(pendingReviewsTable.workflowStage, "prep_pending"),
          ))
          .returning({ id: pendingReviewsTable.id });
        if (advanced.length > 0) {
          await db.update(factsTable).set({ enrichmentStatus: "failed" }).where(eq(factsTable.id, v.factId));
        }
      }
      return;
    }
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
