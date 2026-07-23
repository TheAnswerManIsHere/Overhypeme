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
 *
 * `parentId` for a variant is NOT threaded through here: it already lives on
 * `facts.parent_id` (untouched by deactivation) and `approveForProduction`
 * reads it from there at final approval, where `activateFact` revalidates it
 * as an active root exactly as it does for any other approval.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { findUnresolvedReviewForStagingFact } from "./moderationStaging";
import { prepareFirstTimeStagingPrep, ensureFirstTimeStagingPrepJobs, type PrepDispatchResult } from "./firstTimeStagingPrep";
import { logger } from "./logger";

export type ResubmitForModerationErrorCode =
  | "FACT_NOT_FOUND"
  | "ALREADY_ACTIVE"
  | "REVIEW_ALREADY_IN_PROGRESS"
  | "ORPHANED_PARENT";

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
      .select({ id: factsTable.id, text: factsTable.text, isActive: factsTable.isActive, parentId: factsTable.parentId })
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
    const existing = await findUnresolvedReviewForStagingFact(factId, tx);
    if (existing) {
      throw new ResubmitForModerationError(
        "REVIEW_ALREADY_IN_PROGRESS",
        "A moderation review is already in progress for this fact.",
        { reviewId: existing.id },
      );
    }

    // pending_reviews.parent_fact_id has a real FK (ON DELETE SET NULL) —
    // unlike facts.parent_id, which carries none. A hard-deleted root leaves
    // its former children inactive with parent_id still pointing at the
    // now-gone row (cascadeDeactivateActiveChildren only flips is_active, it
    // never clears parent_id), so blindly copying that stale value into this
    // INSERT would hit the FK and throw. Reject with a clear error instead of
    // letting it fall through to a 500 — the admin must re-parent or promote
    // this fact to a root (PATCH parentId) before it can be resubmitted.
    if (fact.parentId != null) {
      const [parent] = await tx.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, fact.parentId)).limit(1);
      if (!parent) {
        throw new ResubmitForModerationError(
          "ORPHANED_PARENT",
          `This fact's parent (#${fact.parentId}) no longer exists. Re-parent it or promote it to a root before resubmitting.`,
        );
      }
    }

    const [review] = await tx
      .insert(pendingReviewsTable)
      .values({
        submittedText: fact.text,
        submittedById: null,
        parentFactId: fact.parentId,
        status: "pending",
        workflowStage: "triage_pending",
        stagingFactId: factId,
      })
      .returning({ id: pendingReviewsTable.id });

    await prepareFirstTimeStagingPrep(tx, {
      review: { id: review!.id, submittedText: fact.text, submittedById: null, stagingFactId: factId },
      parentFactId: fact.parentId,
      reviewedById: adminId,
    });

    return { reviewId: review!.id };
  });

  const prepDispatch = await ensureFirstTimeStagingPrepJobs(factId);
  logger.info({ factId, reviewId, adminId }, "[moderation] inactive fact resubmitted for moderation");
  return { reviewId, factId, prepDispatch };
}
