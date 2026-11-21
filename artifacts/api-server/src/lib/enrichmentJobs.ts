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

import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  pendingReviewsTable,
  factsTable,
  factTaxonomyRunsTable,
  usersTable,
  type AsyncJobRow,
  type FactTaxonomyRunOrigin,
  type FactTaxonomyRunOutcome,
} from "@workspace/db/schema";
import { validateEnrichment, type FactEnrichment } from "@workspace/api-zod";
import { enrichFact, taxonomyColumns } from "./factEnrichment";
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
/** The origins a job can carry; the legacy ones are 0159's, "unrecorded" a pre-2.1b job's. */
const REQUESTED_ORIGINS = ["provisional_approval", "rerun"] as const;
type RequestedOrigin = (typeof REQUESTED_ORIGINS)[number];

type EnrichmentJobPayload = {
  reviewId?: number;
  factId?: number;
  /** Why the fact's run was asked for; absent on a job queued before 2.1b. */
  origin?: RequestedOrigin;
  /** The admin who asked for a Re-run. */
  requestedBy?: string | null;
};

/** Who asked for a fact's taxonomy run, recorded on its history row. */
export interface TaxonomyRunRequest {
  origin: FactTaxonomyRunOrigin;
  requestedBy: string | null;
}

const UNRECORDED_REQUEST: TaxonomyRunRequest = { origin: "unrecorded", requestedBy: null };

/** The enqueue payload for a fact's taxonomy run. */
export function factEnrichmentPayload(
  factId: number,
  origin: RequestedOrigin,
  requestedBy: string | null = null,
): EnrichmentJobPayload {
  return { factId, origin, requestedBy };
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
  // Load the submitted text so we can classify it.
  const [reviewRow] = await db
    .select({ submittedText: pendingReviewsTable.submittedText })
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
  request: TaxonomyRunRequest = UNRECORDED_REQUEST,
): Promise<HandlerResult> {
  // Every classifier call leaves one history row (plan item 16, 2B): written in
  // the same transaction as the result it describes, failures included.
  // The requester is resolved at the write, not trusted from the payload: an
  // admin whose account was deleted while the run was queued or classifying is
  // recorded as nobody, so attribution can never refuse the row and roll back a
  // paid result (Codex 4651288296). No lock on the user: a deletion committing
  // in the instant between this lookup and the foreign-key check costs one
  // retry, which then finds nobody (PR #1141, round 1, Fable's tie-break).
  const requester = request.requestedBy === null
    ? null
    : sql<string | null>`(SELECT ${usersTable.id} FROM ${usersTable} WHERE ${usersTable.id} = ${request.requestedBy})`;
  const historyRow = (outcome: FactTaxonomyRunOutcome, output: FactEnrichment | null, error: string | null) => ({
    factId, outcome, origin: request.origin, requestedBy: requester, output, error,
  });
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
  // and touch nothing.
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
    await fencedTransaction(db, async (tx) => {
      await tx.update(factsTable).set({ enrichmentStatus: "failed" }).where(eq(factsTable.id, factId));
      await tx.insert(factTaxonomyRunsTable).values(historyRow("failed", null, msg));
    });
    return { ok: false, error: `classify: ${msg}` };
  }

  // The shape stored, and recorded even when the result is discarded.
  const stored = taxonomyColumns(freshAiDerived);

  // Transactional re-check before the write: the pre-classify guard can't cover
  // state that changed during the (slow) classifier call, so the result is
  // discarded if the fact left the eligible state or its text changed. The fact
  // row lock gives that re-check a consistent read against concurrent writers.
  // A discarded result is retired as a successful no-op.
  await fencedTransaction(db, async (tx) => {
    const [locked] = await tx
      .select({ id: factsTable.id, text: factsTable.text })
      .from(factsTable)
      .where(eq(factsTable.id, factId))
      .for("no key update") // the lock rule's strength (lib/reviewLocks.ts)
      .limit(1);
    if (!locked) return; // the fact is gone, and its history with it
    const recheck = await resolveGenericFactEnrichmentDecision(factId, tx);
    if (recheck.action === "skip") {
      logger.info(
        { factId, reason: recheck.reason },
        "[enrichment] generic fact result discarded at recheck (state changed mid-classify)",
      );
      await tx.insert(factTaxonomyRunsTable).values(
        historyRow("discarded", stored.enrichment, `The fact left the state a run is for while it ran (${recheck.reason}).`),
      );
      return;
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
      await tx.insert(factTaxonomyRunsTable).values(
        historyRow("discarded", stored.enrichment, "The fact's wording changed while it ran."),
      );
      return;
    }
    await tx
      .update(factsTable)
      .set({ ...stored, enrichmentStatus: "ok" })
      .where(eq(factsTable.id, factId));
    await tx.insert(factTaxonomyRunsTable).values(historyRow("ok", stored.enrichment, null));
    // The taxonomy never moves a review or starts idea writing: it is stored
    // data beside moderation (Issue #1018, increment 1.2c-ii).
  });
  return { ok: true };
}

export const enrichmentJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const { reviewId, factId, origin, requestedBy } = payload as EnrichmentJobPayload;
    if (typeof factId === "number") {
      const request: TaxonomyRunRequest = origin && (REQUESTED_ORIGINS as readonly string[]).includes(origin)
        ? { origin, requestedBy: typeof requestedBy === "string" ? requestedBy : null }
        : UNRECORDED_REQUEST;
      return runEnrichmentForFact(factId, { classify: enrichFact }, request);
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
