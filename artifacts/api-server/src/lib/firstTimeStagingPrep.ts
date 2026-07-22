/**
 * Shared first-time staging prep lifecycle (Plan v4 §F).
 *
 * The single primitive for "(re)start text-derived prep for a first-time
 * staging fact", used by BOTH provisional approval and the staging branch of
 * the approved-fact-text edit — so stage transitions, statuses, enqueue order,
 * and recovery can never drift between the two.
 *
 * Two phases, deliberately split so the transactional state change and the
 * (non-transactional) durable-job dispatch don't hold a DB lock across the
 * enqueue:
 *
 *   1. prepareFirstTimeStagingPrep(tx, …) — in the caller's transaction:
 *      create-or-reuse the staging fact, mark enrichment "pending", move the
 *      review back to prep_pending. Does NOT write fact text — the caller owns
 *      that (a text edit writes the new wording + clears the signature in the
 *      same tx; provisional approval seeds the submitted text via ensureStagingFact).
 *
 *   2. ensureFirstTimeStagingPrepJobs(factId) — after commit: ENSURE the durable
 *      enrichment + Pexels jobs exist (create if missing, dedupe if present) and
 *      heal the status projections. Idempotent, so it is also the recovery path
 *      for a stranded "pending" projection with no job behind it.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable, type AsyncJobStatus } from "@workspace/db/schema";
import { enqueueJob } from "./asyncJobs";
import { enqueueFactPexels } from "./factPexelsJobs";
import { ensureStagingFact, type StagingReviewRow } from "./moderationStaging";
import { logger } from "./logger";

type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PrepQueueDispatch {
  status: AsyncJobStatus;
  /** true = a fresh job was created; false = an existing non-terminal job was reused. */
  inserted: boolean;
}

export interface PrepDispatchResult {
  factId: number;
  enrichment: PrepQueueDispatch;
  pexels: PrepQueueDispatch;
}

/**
 * Phase 1 (in the caller's transaction). Create-or-reuse the staging fact, mark
 * enrichment prep "pending" for immediate UI feedback, and move the review to
 * prep_pending. `submittedText` is only used when the staging fact does not yet
 * exist (first provisional approval); a staging text edit passes the already-
 * existing `stagingFactId` and writes the new wording itself before calling this.
 */
export async function prepareFirstTimeStagingPrep(
  tx: DbLike,
  args: {
    review: StagingReviewRow;
    parentFactId: number | null;
    reviewedById?: string | null;
    adminNote?: string | null;
  },
): Promise<{ factId: number }> {
  const { factId } = await ensureStagingFact(args.review, args.parentFactId, tx);
  await tx.update(factsTable).set({ enrichmentStatus: "pending" }).where(eq(factsTable.id, factId));
  await tx
    .update(pendingReviewsTable)
    .set({
      workflowStage: "prep_pending",
      stagingFactId: factId,
      ...(args.reviewedById != null ? { reviewedById: args.reviewedById } : {}),
      ...(args.adminNote != null ? { adminNote: args.adminNote } : {}),
    })
    .where(eq(pendingReviewsTable.id, args.review.id));
  return { factId };
}

/**
 * Phase 2 (after commit). ENSURE the durable enrichment + Pexels jobs exist and
 * heal the status projections. Enrichment is workflow-gating, so an enqueue
 * failure marks the projection "failed" (visible + retryable) rather than
 * leaving a fake "pending" with no job behind it. Safe to call repeatedly —
 * `enqueueJob`/`enqueueFactPexels` dedupe on the in-flight job.
 */
export async function ensureFirstTimeStagingPrepJobs(factId: number): Promise<PrepDispatchResult> {
  // Enrichment (workflow-gating): heal the projection to "pending" and ensure
  // the durable job. On a hard enqueue failure, surface "failed" so the
  // moderation UI shows a retryable state instead of a permanent fake-pending.
  let enrichment: PrepQueueDispatch;
  try {
    await db.update(factsTable).set({ enrichmentStatus: "pending" }).where(eq(factsTable.id, factId));
    const res = await enqueueJob({
      queue: "enrichment",
      payload: { factId },
      dedupeKey: `enrichment:fact:${factId}`,
    });
    enrichment = { status: res.status, inserted: res.inserted };
  } catch (err) {
    logger.error({ err, factId }, "[staging-prep] enrichment enqueue failed; marking status failed (retryable)");
    await db.update(factsTable).set({ enrichmentStatus: "failed" }).where(eq(factsTable.id, factId)).catch(() => {});
    enrichment = { status: "failed", inserted: false };
  }

  // Pexels (best-effort seeding): same visible-failure contract, but never
  // gates approval.
  let pexels: PrepQueueDispatch;
  try {
    const res = await enqueueFactPexels(factId);
    pexels = { status: res.status, inserted: res.inserted };
  } catch (err) {
    logger.error({ err, factId }, "[staging-prep] pexels enqueue failed; marking status failed (retryable)");
    await db.update(factsTable).set({ pexelsStatus: "failed" }).where(eq(factsTable.id, factId)).catch(() => {});
    pexels = { status: "failed", inserted: false };
  }

  return { factId, enrichment, pexels };
}
