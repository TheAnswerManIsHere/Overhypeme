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
  type AsyncJobRow,
} from "@workspace/db/schema";
import { validateEnrichment, type FactEnrichment } from "@workspace/api-zod";
import { enrichFact, materializeFromBaseline } from "./factEnrichment";
import { assertJobOwnership, fencedTransaction } from "./jobFence";
import { renderCanonical } from "./renderCanonical";
import { resolveGenericFactEnrichmentDecision } from "./moderationStaging";
import {
  RESUMES_FROM_CHECKPOINTS,
  registerJobHandler,
  type JobHandler,
  type HandlerResult,
} from "./asyncJobs";
import { logger } from "./logger";

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
  // Load the fact text (a fact is classified from its own text only) and the
  // prior run's output, whose character list the classifier carries forward.
  // The stored taxonomy is read-only AI output: a run replaces it whole (plan
  // PLAN_FACT_LIFECYCLE_REBUILD.md, 2A). The fact's gags live in fact_gags and
  // are untouched.
  const [factRow] = await db
    .select({
      text: factsTable.text,
      enrichmentAiDerived: factsTable.enrichmentAiDerived,
    })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!factRow) {
    return { ok: false, error: `fact ${factId} not found` };
  }

  // GENERIC-JOB GUARD (cost + isolation): run only for a live fact or a
  // first-time staging cycle past triage. Skips are retired as successful no-ops
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

  // Transactional RE-check before the write (mirrors the candidate job's
  // phase 3): the pre-classify guard can't cover state that changed DURING the
  // LLM call — most importantly a send-back committing mid-classify, which
  // must freeze facts.* for its refresh cycle. The fact row lock serializes
  // with sendFactBackToReview (which locks the fact first), so the recheck
  // either sees the new candidate (→ discard this stale result) or the
  // send-back waits and seeds its candidate from the freshly-written active.
  const wrote = await fencedTransaction(db, async (tx) => {
    const [locked] = await tx
      .select({ id: factsTable.id, text: factsTable.text })
      .from(factsTable)
      .where(eq(factsTable.id, factId))
      .for("no key update") // the lock rule's strength (lib/reviewLocks.ts)
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
    const { columns } = materializeFromBaseline(freshAiDerived);
    await tx
      .update(factsTable)
      .set({ ...columns, enrichmentStatus: "ok" })
      .where(eq(factsTable.id, factId));
    // The taxonomy never moves a review or starts idea writing: it is stored
    // data beside moderation (Issue #1018, increment 1.2c-ii).
    return true;
  });
  if (!wrote) return { ok: true }; // retired as a successful no-op — the new owner (e.g. a refresh cycle) has the fact
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
  // Terminal failure (retries exhausted): the taxonomy is recorded as failed
  // and blocks nothing; a review carries on without it.
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const { factId } = (row.payload ?? {}) as EnrichmentJobPayload;
    if (typeof factId === "number") {
      await db.update(factsTable).set({ enrichmentStatus: "failed" })
        .where(and(eq(factsTable.id, factId), eq(factsTable.enrichmentStatus, "pending")));
    }
  },
};

/** Register the enrichment queue with the shared async-jobs worker. */
export function registerEnrichmentJobHandlers(): void {
  // Execution limit (Issue #1000): two classifier calls, each up to 3 tries of 120 s (about 12 min), then database work, plus margin.
  registerJobHandler("enrichment", enrichmentJobHandler, { executionLimitMs: 20 * 60_000, ...RESUMES_FROM_CHECKPOINTS });
}

// Exported for callers (the routes file consumes the registerer + this helper).
export { loadPendingReviewEnrichment };
