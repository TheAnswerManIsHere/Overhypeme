/**
 * @purpose Provisional approval's prep: create the staging fact, move the review to Reading with its reading run, and start the taxonomy run beside it.
 * @subsystem moderation
 *
 * Two phases (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1B; Issue #1018, increment
 * 1.2c-ii):
 *
 *   1. prepareFirstTimeStagingPrep(tx, …) — in the caller's transaction:
 *      create-or-reuse the staging fact, mark the taxonomy "pending", move the
 *      review to Reading and start its reading run (readingJobs.ts), so a
 *      review never waits at Reading with no run behind it.
 *
 *   2. ensureFirstTimeStagingPrepJobs(factId) — after commit: ENSURE the
 *      durable taxonomy job exists (create if missing, dedupe if present). The
 *      taxonomy is stored data beside moderation: it never moves the review and
 *      never blocks a step, so a failed enqueue is only recorded as failed.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable, type AsyncJobStatus } from "@workspace/db/schema";
import { enqueueJob } from "./asyncJobs";
import { ensureStagingFact, type StagingReviewRow } from "./moderationStaging";
import { startReading } from "./readingJobs";
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
}

/**
 * Phase 1 (in the caller's transaction, which holds the review's lock).
 * Create-or-reuse the staging fact, mark the taxonomy "pending", move the
 * review to Reading and start its reading run.
 */
export async function prepareFirstTimeStagingPrep(
  tx: DbLike,
  args: {
    review: StagingReviewRow;
    reviewedById?: string | null;
    adminNote?: string | null;
  },
): Promise<{ factId: number }> {
  const { factId } = await ensureStagingFact(args.review, tx);
  await tx.update(factsTable).set({ enrichmentStatus: "pending" }).where(eq(factsTable.id, factId));
  await tx
    .update(pendingReviewsTable)
    .set({
      workflowStage: "reading",
      stagingFactId: factId,
      ...(args.reviewedById != null ? { reviewedById: args.reviewedById } : {}),
      ...(args.adminNote != null ? { adminNote: args.adminNote } : {}),
    })
    .where(eq(pendingReviewsTable.id, args.review.id));
  await startReading(tx, { factId, reviewId: args.review.id, requestedBy: args.reviewedById ?? null });
  return { factId };
}

/**
 * Phase 2 (after commit). ENSURE the durable taxonomy job exists and heal its
 * status projection. An enqueue failure is recorded as "failed" rather than a
 * fake "pending" with no job behind it; it blocks nothing. Safe to call
 * repeatedly — `enqueueJob` dedupes on the in-flight job.
 */
export async function ensureFirstTimeStagingPrepJobs(factId: number): Promise<PrepDispatchResult> {
  // The taxonomy: heal the projection to "pending" and ensure the durable job.
  // On a hard enqueue failure, record "failed" instead of a fake "pending".
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
    logger.error({ err, factId }, "[staging-prep] taxonomy enqueue failed; marking status failed");
    await db.update(factsTable).set({ enrichmentStatus: "failed" }).where(eq(factsTable.id, factId)).catch(() => {});
    enrichment = { status: "failed", inserted: false };
  }

  return { factId, enrichment };
}
