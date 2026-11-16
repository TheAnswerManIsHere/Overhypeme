/**
 * Re-enter an EXISTING inactive fact into moderation (Phase 2 fact-lifecycle
 * closure — the reactivation gap Codex round 7 found).
 *
 * Once `activateFact` became the sole is_active false→true writer and the
 * admin Active toggle stopped allowing direct reactivation (round 4,
 * David-confirmed: activation is moderation-only), there was no path back for
 * a deactivated fact at all — `sendFactBackToReview` is a REFRESH primitive
 * that requires the fact to already be active (it keeps the fact live
 * throughout, swapping in a reviewed candidate on approval). An inactive fact
 * has no live enrichment to protect, so this is the opposite shape: it
 * re-enters at `prep_pending`, exactly like a first-time staging fact (the
 * SAME primitive `POST /admin/reviews/:id/provisional-approve` uses), and
 * rides the unchanged enrichment → concept-review → production-review →
 * `activateFact` pipeline from there. The existing factId/history is reused —
 * this never creates a duplicate fact row.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { findUnresolvedReviewForStagingFact } from "./moderationStaging";
import { prepareFirstTimeStagingPrep, ensureFirstTimeStagingPrepJobs, type PrepDispatchResult } from "./firstTimeStagingPrep";
import { logger } from "./logger";
import { claimConceptsForReview } from "./visualConceptOwner";

export type ResubmitForModerationErrorCode =
  | "FACT_NOT_FOUND"
  | "ALREADY_ACTIVE"
  | "REVIEW_ALREADY_IN_PROGRESS"
  | "WORDING_WITHDRAWN";

/** Typed failure from `resubmitInactiveFactForModeration`; the caller maps codes to HTTP. */
export class ResubmitForModerationError extends Error {
  constructor(
    public readonly code: ResubmitForModerationErrorCode,
    message: string,
    /** For REVIEW_ALREADY_IN_PROGRESS: the in-flight review so the UI can link to it. */
    public readonly existing?: { reviewId: number },
  ) {
    super(message);
    this.name = "ResubmitForModerationError";
  }
}

export interface ResubmitForModerationResult {
  reviewId: number;
  factId: number;
  prepDispatch: PrepDispatchResult;
}

export async function resubmitInactiveFactForModeration(args: {
  factId: number;
  adminId: string | null;
}): Promise<ResubmitForModerationResult> {
  const { factId, adminId } = args;

  const { reviewId } = await db.transaction(async (tx) => {
    // Lock the fact for the duration of this decision: without it, a
    // concurrent activation of this exact fact (unlikely — it's inactive —
    // but not impossible if two admins act at once) could race this check.
    const [fact] = await tx
      .select({ id: factsTable.id, text: factsTable.text, isActive: factsTable.isActive, wordingWithdrawnAt: factsTable.wordingWithdrawnAt })
      .from(factsTable)
      .where(eq(factsTable.id, factId))
      .for("update")
      .limit(1);
    if (!fact) {
      throw new ResubmitForModerationError("FACT_NOT_FOUND", `Fact ${factId} not found.`);
    }
    if (fact.isActive) {
      throw new ResubmitForModerationError(
        "ALREADY_ACTIVE",
        "This fact is already live — use Send Back to Review to refresh it instead.",
      );
    }
    // A submission withdrawn because its wording needs replacing never goes
    // live (migration 0141): its corrected wording is a new fact.
    if (fact.wordingWithdrawnAt != null) {
      throw new ResubmitForModerationError(
        "WORDING_WITHDRAWN",
        "This submission was withdrawn because its wording needs replacing. Submit the corrected wording as a new fact.",
      );
    }
    const existing = await findUnresolvedReviewForStagingFact(factId, tx);
    if (existing) {
      throw new ResubmitForModerationError(
        "REVIEW_ALREADY_IN_PROGRESS",
        "A moderation review is already in progress for this fact.",
        { reviewId: existing.id },
      );
    }

    const [review] = await tx
      .insert(pendingReviewsTable)
      .values({
        submittedText: fact.text,
        submittedById: null,
        status: "pending",
        workflowStage: "triage_pending",
        stagingFactId: factId,
      })
      .returning({ id: pendingReviewsTable.id });

    // The review takes the fact's gag ideas (plan PLAN_THREE_GAGS.md, F).
    await claimConceptsForReview(tx, factId, review!.id);

    await prepareFirstTimeStagingPrep(tx, {
      review: { id: review!.id, submittedText: fact.text, submittedById: null, stagingFactId: factId },
      reviewedById: adminId,
    });

    return { reviewId: review!.id };
  });

  const prepDispatch = await ensureFirstTimeStagingPrepJobs(factId);
  logger.info({ factId, reviewId, adminId }, "[moderation] inactive fact resubmitted for moderation");
  return { reviewId, factId, prepDispatch };
}
