/**
 * @purpose The one lock rule for a submission's rows: the review, then its staging fact, then that fact's gags.
 * @subsystem moderation
 *
 * Every transaction that changes a submission takes its row locks in this
 * order, and no other:
 *
 *   1. the review row (`pending_reviews`), when the change concerns a review;
 *   2. the review's staging fact row (`facts`);
 *   3. that fact's gag rows (`fact_gags`), in slot order, as gagStore does.
 *
 * A transaction may skip a level it does not touch, never go back up one.
 * Review and fact rows are locked FOR NO KEY UPDATE: no transition changes a
 * key, and that strength does not conflict with the KEY SHARE locks a
 * foreign-key check takes when another transaction inserts a row pointing at
 * them (an admin-action record, a render attempt, a gag, a reading run). So
 * those inserts never queue behind a transition, and a transition never waits
 * on one. Two transitions on one review serialise on the review row; the
 * second re-reads the stage under the lock and, when it moved, is refused with
 * REVIEW_MOVED_CODE ("this review moved on"), never a deadlock or a server
 * error.
 *
 * Background work that writes only the fact (the taxonomy run, the gag ideas
 * job, the live-fact picture mirror) starts at level 2. Work that reads the
 * review to decide whether to write (the reading job) takes level 1 first.
 */
import { eq } from "drizzle-orm";
import type { Response } from "express";
import { factsTable, pendingReviewsTable } from "@workspace/db";
import { REVIEW_MOVED_CODE, type ReviewWorkflowStage } from "@workspace/api-zod";
import type { Executor } from "./visualConceptOwner";

/** Level 1: lock a review row and return it as it stands under the lock. */
export async function lockReview(tx: Executor, reviewId: number) {
  const [review] = await tx.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).for("no key update").limit(1);
  return review ?? null;
}

/** Level 2: lock a fact row. Call after the review's lock when there is a review. */
export async function lockFactRow(tx: Executor, factId: number): Promise<{ id: number; isActive: boolean } | null> {
  const [fact] = await tx
    .select({ id: factsTable.id, isActive: factsTable.isActive })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .for("no key update")
    .limit(1);
  return fact ?? null;
}

/** A transition found its review somewhere other than the step it acts on. */
export class ReviewMovedError extends Error {
  readonly code = REVIEW_MOVED_CODE;
  constructor(readonly stage: string, readonly status: string) {
    super(`This review moved on (it is now ${stage}, ${status}). Reload it and try again.`);
    this.name = "ReviewMovedError";
  }
}

/**
 * Level 1 for a transition: lock the review and check it is where the
 * transition acts (`allowed`, one of the moderationWorkflow guards). Returns
 * the locked row, or null when there is no such review; throws
 * ReviewMovedError when it is somewhere else.
 */
export async function lockReviewAt(
  tx: Executor,
  reviewId: number,
  allowed: (stage: ReviewWorkflowStage, status: string) => boolean,
) {
  const review = await lockReview(tx, reviewId);
  if (review && !allowed(review.workflowStage as ReviewWorkflowStage, review.status)) {
    throw new ReviewMovedError(review.workflowStage, review.status);
  }
  return review;
}

/** The response body every route sends for a ReviewMovedError. */
export function reviewMovedBody(err: ReviewMovedError): { error: string; code: typeof REVIEW_MOVED_CODE; workflowStage: string } {
  return { error: err.message, code: REVIEW_MOVED_CODE, workflowStage: err.stage };
}

/** Answer a route's ReviewMovedError with the one 409; false for any other error (the caller rethrows). */
export function sendIfReviewMoved(err: unknown, res: Response): boolean {
  if (!(err instanceof ReviewMovedError)) return false;
  res.status(409).json(reviewMovedBody(err));
  return true;
}
