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
import {
  pendingReviewsTable,
  factsTable,
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
import { currentProcessingSignatureFromConfig } from "./processingSignature";
import { assertJobOwnership, fencedTransaction, whileOwned } from "./jobFence";
import { renderCanonical } from "./renderCanonical";
import {
  advanceReviewForStagingFactEnrichment,
  resolveGenericFactEnrichmentDecision,
} from "./moderationStaging";
import {
  registerJobHandler,
  type JobHandler,
  type HandlerResult,
} from "./asyncJobs";
import { logger } from "./logger";
import { ownedFact, reviewConceptOwner } from "./visualConceptOwner";

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
    await assertJobOwnership(); // paid classifier call (Issue #1000)
    enrichment = await enrichFact({ factText: renderedText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await fencedTransaction(db, (tx) => tx
      .update(pendingReviewsTable)
      .set({ enrichmentStatus: "failed" })
      .where(eq(pendingReviewsTable.id, reviewId)));
    return { ok: false, error: `classify: ${msg}` };
  }

  await fencedTransaction(db, (tx) => tx
    .update(pendingReviewsTable)
    .set({ enrichment, enrichmentStatus: "ok" })
    .where(eq(pendingReviewsTable.id, reviewId)));

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
  // Load the fact text (a fact is classified from its own text only) plus the
  // override layers so re-classification stays STICKY: a
  // fresh AI baseline is computed but the manual overrides are preserved (the
  // fact's gags live in fact_gags and are untouched).
  const [factRow] = await db
    .select({
      text: factsTable.text,
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

  // Render template tokens ({NAME}/{SUBJ}/…) to the canonical identity ("Alex",
  // they/them) before passing to the classifier.
  const renderedFactText = renderCanonical(factRow.text);

  // Classifier-input fingerprint (Plan v4 §E). A fact is classified from its
  // own text only, so the identity is the fact's own raw text alone. If it changed
  // during the (slow) classify call (a staging edit re-worded the fact), the
  // result is stale and must be discarded, even though the edit-side guards
  // normally block an edit while this job is non-terminal. This is the
  // authoritative backstop.
  const classifiedInputKey = factRow.text;

  // Capture the processing signature BEFORE the (slow) classify call. It is
  // stamped onto facts.last_processed_signature only for FIRST-TIME staging
  // prep (decided under the fact lock below) — so a brand-new fact approved
  // today reads fresh (not stale-for-reprocess). A direct LIVE re-enrich never
  // stamps: an existing live fact only becomes "fresh" via the versioned
  // refresh (send-back → promote), keeping refresh-first intact.
  const signature = await currentProcessingSignatureFromConfig();

  let freshAiDerived: FactEnrichment;
  try {
    await assertJobOwnership(); // paid AI call: only while this run owns its job (Issue #1000)
    freshAiDerived = await deps.classify({
      factText: renderedFactText,
      priorCharacters: factRow.enrichmentAiDerived as FactEnrichment | null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await fencedTransaction(db, (tx) => tx
      .update(factsTable)
      .set({ enrichmentStatus: "failed" })
      .where(eq(factsTable.id, factId)));
    return { ok: false, error: `classify: ${msg}` };
  }

  // STICKY re-enrich: keep the existing overrides untouched (never refresh their
  // `overriddenFrom` — that is what lets us detect a baseline change) and
  // rematerialize against the fresh baseline. The overrides are re-read under
  // the row lock below, NOT taken from the pre-classify read, so a moderator
  // correction saved during the (slow) classifier call survives
  // (PLAN_BUBBLE_SPEAKERS.md, E). The fact's gags live in fact_gags and are not
  // touched by re-classification.
  const priorAiDerived = (factRow.enrichmentAiDerived ?? null) as FactEnrichment | null;

  // Transactional RE-check before the write (mirrors the candidate job's
  // phase 3): the pre-classify guard can't cover state that changed DURING the
  // LLM call — most importantly a send-back committing mid-classify, which
  // must freeze facts.* for its refresh cycle. The fact row lock serializes
  // with sendFactBackToReview (which locks the fact first), so the recheck
  // either sees the new candidate (→ discard this stale result) or the
  // send-back waits and seeds its candidate from the freshly-written active.
  const wrote = await fencedTransaction(db, async (tx) => {
    const [locked] = await tx
      .select({ id: factsTable.id, text: factsTable.text, enrichmentOverrides: factsTable.enrichmentOverrides })
      .from(factsTable)
      .where(eq(factsTable.id, factId))
      .for("update")
      .limit(1);
    if (!locked) return false;
    const overrides = (locked.enrichmentOverrides ?? {}) as EnrichmentOverrides;
    const recheck = await resolveGenericFactEnrichmentDecision(factId, tx);
    if (recheck.action === "skip") {
      logger.info(
        { factId, reason: recheck.reason },
        "[enrichment] generic fact result discarded at recheck (state changed mid-classify)",
      );
      return false;
    }

    // Full-input drift guard: re-derive the classifier input from the LOCKED
    // fact's own text and discard if it no longer matches what we classified.
    // A fresh job for the new wording is guaranteed by the edit that changed
    // it (a staging restart re-enqueues), so dropping this stale result never
    // loses coverage.
    if (locked.text !== classifiedInputKey) {
      logger.info(
        { factId },
        "[enrichment] generic fact result discarded at recheck (classifier input drifted mid-classify)",
      );
      return false;
    }
    // Stamp the signature ONLY for first-time staging prep (never live_fact —
    // that's refresh-first). Use the RECHECK's mode (observed under the lock),
    // with the pre-classify signature VALUE captured above.
    const stampSignature = recheck.mode === "first_time_staging";
    // Audit only the not-changed → changed transitions (no per-re-enrich spam).
    const before = priorAiDerived ? computeBaselineChangedPaths(priorAiDerived, overrides) : [];
    const after = computeBaselineChangedPaths(freshAiDerived, overrides);
    const newlyChanged = after.filter((p) => !before.includes(p));
    const { columns } = materializeEnrichment({ aiDerived: freshAiDerived, overrides });
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

  // Advance a linked staging review prep_pending → concept_review (Step 2). No-op
  // for live-fact re-enrich (no linked review) and refused for refresh cycles.
  await whileOwned(() => advanceReviewForStagingFactEnrichment({ factId, outcome: "success" }));

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
  // Terminal failure (retries exhausted): mark the linked cycle prep_failed so
  // the moderator can retry or reject.
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const { factId } = (row.payload ?? {}) as EnrichmentJobPayload;
    if (typeof factId === "number") {
      await advanceReviewForStagingFactEnrichment({ factId, outcome: "terminal_failed" });
    }
  },
};

/** Register the enrichment queue with the shared async-jobs worker. */
export function registerEnrichmentJobHandlers(): void {
  // Execution limit (Issue #1000): two classifier calls, each up to 3 tries of 120 s (about 12 min), then database work, plus margin.
  registerJobHandler("enrichment", enrichmentJobHandler, { executionLimitMs: 20 * 60_000 });
}

// Exported for callers (the routes file consumes the registerer + this helper).
export { loadPendingReviewEnrichment };
