/**
 * @purpose A submission's wording: edited only at triage, locked from acceptance on, and a submission past triage withdrawn when its wording needs replacing.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md, increment 3, section G (David,
 * 2026-11-14, Q5 and Q6): "If it's a new fact and it's in moderation, an admin
 * should be able to edit it before any enrichment happens. Once it's locked,
 * that's it. Locking should be the very first thing that happens as part of
 * step 1."
 *
 * - **The triage edit** changes `pending_reviews.submitted_text` while the
 *   review is at triage and has no staging fact. It is validated like a
 *   submission, recomputes the duplicate match, and records who edited it and
 *   the wording as submitted. It locks the review row, the same lock
 *   acceptance takes, so an edit and an acceptance never interleave: the
 *   accepted fact carries the edited wording, or the edit is refused.
 * - **The lock** is the database's: once the staging fact exists its text never
 *   changes (`facts_text_is_locked`, migration 0141).
 * - **Withdraw: wording needs replacing** ends a first-time submission past
 *   triage, up to production approval: the review is terminal, it leaves the
 *   pending queue and the submitter's pending count, and its staging fact can
 *   never go live (`facts_withdrawn_stays_inactive`). A prep result or a stale
 *   action arriving afterwards finds a resolved review and does nothing.
 */
import { eq, sql } from "drizzle-orm";
import { db, factsTable, pendingReviewsTable } from "@workspace/db";
import { canEditWording, canWithdraw, SUBMISSION_TEXT_MAX_CHARS, SUBMISSION_TEXT_MIN_CHARS, type ReviewWorkflowStage } from "@workspace/api-zod";
import { normalizeFactTemplateForPendingReview } from "./normalizeFactTemplateForStorage";
import { runDetector, storedDuplicateColumns, type DuplicateDetector } from "./duplicateVerdict";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class WordingError extends Error {
  constructor(
    readonly code: "REVIEW_NOT_FOUND" | "WORDING_LOCKED" | "WORDING_INVALID" | "NOT_WITHDRAWABLE",
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "WordingError";
  }
}


/** Lock a review row; the same lock acceptance (provisional approval) takes first. */
export async function lockReview(tx: Tx, reviewId: number) {
  const [review] = await tx.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).for("update").limit(1);
  return review ?? null;
}

/** Validate and normalise a proposed wording exactly as a submission is. */
export function normaliseWording(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < SUBMISSION_TEXT_MIN_CHARS || trimmed.length > SUBMISSION_TEXT_MAX_CHARS) {
    throw new WordingError("WORDING_INVALID", `The wording must be between ${SUBMISSION_TEXT_MIN_CHARS} and ${SUBMISSION_TEXT_MAX_CHARS} characters.`, 422);
  }
  const normalized = normalizeFactTemplateForPendingReview(trimmed);
  if (!normalized.valid) {
    throw new WordingError("WORDING_INVALID", `Template grammar validation failed: ${normalized.grammarResult.error}`, 422);
  }
  return normalized.text;
}

function assertAtTriage(review: { status: string; workflowStage: string; stagingFactId: number | null }): void {
  if (!canEditWording(review.workflowStage as ReviewWorkflowStage, review.status, review.stagingFactId != null)) {
    throw new WordingError(
      "WORDING_LOCKED",
      "The wording is locked: it can only be edited at triage, before the submission is accepted. Withdraw the submission and submit the corrected wording as a new fact.",
    );
  }
}

/**
 * Edit a submission's wording at triage. `duplicate` is the duplicate check of
 * the new wording (a throw is recorded as "unavailable"), computed before this runs (it may be a paid call, so
 * it runs outside the transaction); the review is re-checked under its lock.
 */
export async function editTriageWording(
  reviewId: number,
  rawText: string,
  adminId: string,
  duplicate: DuplicateDetector,
): Promise<typeof pendingReviewsTable.$inferSelect> {
  const text = normaliseWording(rawText);
  // A cheap pre-check, so a locked review spends nothing on the duplicate match.
  const [current] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).limit(1);
  if (!current) throw new WordingError("REVIEW_NOT_FOUND", "Review not found.", 404);
  assertAtTriage(current);
  if (text === current.submittedText) return current;
  const match = await runDetector(duplicate, text, reviewId);

  return db.transaction(async (tx) => {
    const review = await lockReview(tx, reviewId);
    if (!review) throw new WordingError("REVIEW_NOT_FOUND", "Review not found.", 404);
    assertAtTriage(review);
    const [updated] = await tx.update(pendingReviewsTable).set({
      submittedText: text,
      // The wording as submitted is kept once, at the first edit.
      submittedTextOriginal: review.submittedTextOriginal ?? review.submittedText,
      wordingEditedBy: adminId,
      wordingEditedAt: new Date(),
      // The new wording's duplicate verdict, replaced with the wording.
      ...storedDuplicateColumns(match),
    }).where(eq(pendingReviewsTable.id, reviewId)).returning();
    return updated!;
  });
}

/**
 * Withdraw a submission past triage because its wording needs
 * replacing. Terminal: the review leaves the queue and its staging fact can
 * never go live. The corrected wording is submitted as a new fact.
 */
export async function withdrawForWording(reviewId: number, adminId: string, note: string | null): Promise<typeof pendingReviewsTable.$inferSelect> {
  return db.transaction(async (tx) => {
    const review = await lockReview(tx, reviewId);
    if (!review) throw new WordingError("REVIEW_NOT_FOUND", "Review not found.", 404);
    if (!canWithdraw(review.workflowStage as ReviewWorkflowStage, review.status)) {
      throw new WordingError(
        "NOT_WITHDRAWABLE",
        "Withdraw applies from acceptance until production approval. At triage, edit the wording or reject the submission.",
      );
    }
    const now = new Date();
    const [updated] = await tx.update(pendingReviewsTable).set({
      status: "rejected",
      workflowStage: "production_rejected",
      withdrawnAt: now,
      withdrawnBy: adminId,
      reviewedById: adminId,
      reviewedAt: now,
      productionRejectedAt: now,
      productionRejectedById: adminId,
      productionRejectionNote: note?.trim() || "Withdrawn: wording needs replacing.",
    }).where(eq(pendingReviewsTable.id, reviewId)).returning();
    if (review.stagingFactId != null) {
      await tx.update(factsTable)
        .set({ wordingWithdrawnAt: now, isActive: false, enrichmentStatus: sql`CASE WHEN ${factsTable.enrichmentStatus} = 'pending' THEN NULL ELSE ${factsTable.enrichmentStatus} END` })
        .where(eq(factsTable.id, review.stagingFactId));
    }
    return updated!;
  });
}
