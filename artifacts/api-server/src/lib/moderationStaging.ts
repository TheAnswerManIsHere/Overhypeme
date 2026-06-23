/**
 * Server-side helpers for the staged moderation lifecycle.
 *
 * A "staging fact" is an inactive (isActive=false) row in `facts` created at a
 * moderator's provisional approval. All production-prep tooling (enrichment,
 * Pexels, CPP, test memes, override editing) runs against this real factId;
 * production approval later flips it active. Keeping the prep target a fact —
 * not the review blob — lets the second stage reuse every existing fact-backed
 * system unchanged.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { pendingReviewsTable, factsTable } from "@workspace/db/schema";
import type { ReviewWorkflowStage } from "@workspace/api-zod";
import { renderCanonical } from "./renderCanonical";
import { computeSplitTokenIndex } from "./splitTokenIndex";
import { logger } from "./logger";

// Matches any pronoun / gendered template token (same detection the approve
// path uses) so the staging fact records whether it needs pronoun handling.
const PRONOUN_TOKEN_RE =
  /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|[^|{}]+\|[^|{}]+)\}/;

type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface StagingReviewRow {
  id: number;
  submittedText: string;
  submittedById: string | null;
  stagingFactId: number | null;
}

/**
 * Create the inactive staging fact for a review (idempotent): if the review
 * already points at a staging fact, that fact is returned untouched. The fact is
 * inserted with NO enrichment columns — enrichment runs asynchronously against
 * this factId and materializes them. `parentFactId` makes the staging fact a
 * variant; it inherits its own (independent) enrichment + images all the same.
 */
export async function ensureStagingFact(
  review: StagingReviewRow,
  parentFactId: number | null,
  tx: DbLike = db,
): Promise<{ factId: number; created: boolean }> {
  if (review.stagingFactId != null) {
    return { factId: review.stagingFactId, created: false };
  }
  const [fact] = await tx
    .insert(factsTable)
    .values({
      text: review.submittedText,
      submittedById: review.submittedById ?? undefined,
      hasPronouns: PRONOUN_TOKEN_RE.test(review.submittedText),
      canonicalText: renderCanonical(review.submittedText),
      isActive: false,
      parentId: parentFactId ?? undefined,
      splitTokenIndex: computeSplitTokenIndex(review.submittedText),
    })
    .returning({ id: factsTable.id });
  return { factId: fact.id, created: true };
}

/** The review linked to a staging fact, or null when the fact has no linked review. */
export async function findReviewForStagingFact(
  factId: number,
): Promise<{ id: number; workflowStage: ReviewWorkflowStage } | null> {
  const [row] = await db
    .select({ id: pendingReviewsTable.id, workflowStage: pendingReviewsTable.workflowStage })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.stagingFactId, factId))
    .limit(1);
  return row ? { id: row.id, workflowStage: row.workflowStage as ReviewWorkflowStage } : null;
}

/**
 * Cost guard for prep jobs. Returns false when the fact is a staging fact whose
 * review has LEFT `prep_pending` (e.g. the moderator rejected it mid-flight) —
 * the caller must then skip all paid work. Live facts with no linked review (an
 * admin re-enriching an active fact) always return true.
 */
export async function isStagingPrepActive(factId: number): Promise<boolean> {
  const review = await findReviewForStagingFact(factId);
  if (!review) return true; // not a staged prep target — normal live-fact path
  return review.workflowStage === "prep_pending";
}

/**
 * Advance a review off the terminal outcome of its staging fact's enrichment
 * job. Success → production_review; terminal abandon → prep_failed. Only acts on
 * a review still in `prep_pending`; a review that has moved on (rejected,
 * re-prepped, approved) is left untouched and the stale outcome is logged.
 */
export async function advanceReviewForStagingFactEnrichment(args: {
  factId: number;
  outcome: "success" | "terminal_failed";
}): Promise<void> {
  const review = await findReviewForStagingFact(args.factId);
  if (!review) return; // live-fact enrichment — nothing to advance
  if (review.workflowStage !== "prep_pending") {
    logger.info(
      { factId: args.factId, reviewId: review.id, stage: review.workflowStage, outcome: args.outcome },
      "[moderation] stale staging enrichment outcome ignored (review left prep_pending)",
    );
    return;
  }
  const nextStage: ReviewWorkflowStage = args.outcome === "success" ? "production_review" : "prep_failed";
  await db
    .update(pendingReviewsTable)
    .set({ workflowStage: nextStage })
    .where(eq(pendingReviewsTable.id, review.id));
  logger.info(
    { factId: args.factId, reviewId: review.id, nextStage },
    "[moderation] staging enrichment advanced review stage",
  );
}
