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

import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { pendingReviewsTable, factsTable, factEnrichmentVersionsTable } from "@workspace/db/schema";
import { isUnresolvedSubmissionStage, type ReviewWorkflowStage } from "@workspace/api-zod";
import { renderCanonical } from "./renderCanonical";
import { computeSplitTokenIndex } from "./splitTokenIndex";
import { enqueueJob } from "./asyncJobs";
import { logger } from "./logger";

// Queue name owned by reviewRenderScenarios.ts (kept as a literal here to avoid
// pulling that heavy orchestration module into this widely-imported helper).
const REVIEW_RENDER_PREPARE_QUEUE = "review_render_scenarios_prepare";

// Queue name owned by visualConceptJobs.ts (kept as a literal for the same
// reason — and because visualConceptJobs imports resolveReviewCycleEnrichment
// from THIS module, so importing it back would create a module cycle).
const FACT_VISUAL_CONCEPTS_QUEUE = "fact_visual_concepts";

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

/**
 * The current (newest) review linked to a staging fact, or null when the fact
 * has no linked review.
 *
 * A fact can accumulate MULTIPLE review rows once the stale-fact refresh feature
 * lands (each send-back creates a new cycle while the original approved review
 * persists). The original `LIMIT 1` with no ordering was nondeterministic in
 * that case, so this now takes the NEWEST review by `created_at` — which is the
 * active refresh cycle when one is in flight, and otherwise the same single row
 * as before. Deterministic ordering is the only change; the resolved-review
 * semantics the cost guards rely on (a rejected staging fact resolves to its
 * rejected review → guards skip paid work) are preserved. The candidate
 * enrichment path does NOT use this helper — it targets its exact
 * `source_review_id` (see runEnrichmentForCandidateVersion).
 */
export async function findReviewForStagingFact(
  factId: number,
  tx: DbLike = db,
): Promise<{ id: number; workflowStage: ReviewWorkflowStage } | null> {
  const [row] = await tx
    .select({ id: pendingReviewsTable.id, workflowStage: pendingReviewsTable.workflowStage })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.stagingFactId, factId))
    .orderBy(desc(pendingReviewsTable.createdAt))
    .limit(1);
  return row ? { id: row.id, workflowStage: row.workflowStage as ReviewWorkflowStage } : null;
}

/**
 * Resolve the ENRICHMENT + text a moderation-side visual surface should use for
 * a review cycle. The single source of truth so every review render/preview
 * reads the SAME enrichment — otherwise one surface could preview the active
 * fact while another previews the candidate.
 *
 * - Refresh cycle (`candidateVersionId != null`): the candidate version's
 *   enrichment (what the moderator is reviewing), with the fact's own text.
 * - First-time staging cycle: the staging fact's own `facts.enrichment`.
 *
 * Returns the RAW enrichment jsonb (caller validates) so it drops into the
 * existing `validateEnrichment` + `resolveRenderReviewInput` flow unchanged.
 * Null when the review has no staging fact / the fact is missing.
 */
export async function resolveReviewCycleEnrichment(
  review: { stagingFactId: number | null; candidateVersionId: number | null },
  tx: DbLike = db,
): Promise<{
  factId: number;
  text: string;
  rawEnrichment: unknown;
  source: "candidate_version" | "staging_fact";
} | null> {
  if (review.stagingFactId == null) return null;
  const [fact] = await tx
    .select({ text: factsTable.text, enrichment: factsTable.enrichment })
    .from(factsTable)
    .where(eq(factsTable.id, review.stagingFactId))
    .limit(1);
  if (!fact) return null;
  if (review.candidateVersionId != null) {
    const [version] = await tx
      .select({ enrichment: factEnrichmentVersionsTable.enrichment })
      .from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, review.candidateVersionId))
      .limit(1);
    if (version) {
      return { factId: review.stagingFactId, text: fact.text, rawEnrichment: version.enrichment, source: "candidate_version" };
    }
  }
  return { factId: review.stagingFactId, text: fact.text, rawEnrichment: fact.enrichment, source: "staging_fact" };
}

/**
 * Cost guard for enrichment prep jobs. Returns false when the fact is a staging
 * fact whose review has LEFT `prep_pending` (e.g. the moderator rejected it
 * mid-flight) — the caller must then skip all paid work. Live facts with no
 * linked review (an admin re-enriching an active fact) always return true.
 */
export async function isStagingPrepActive(factId: number): Promise<boolean> {
  const review = await findReviewForStagingFact(factId);
  if (!review) return true; // not a staged prep target — normal live-fact path
  return review.workflowStage === "prep_pending";
}

/**
 * Cost guard for image prep jobs. Returns false when the fact is a staging fact
 * whose review has been resolved (approved or rejected) — paid Pexels work is no
 * longer needed. Live facts with no linked review (an admin re-enriching an active
 * fact) always return true.
 *
 * Unlike `isStagingPrepActive`, this allows the Pexels job to continue running
 * while the review is in `production_review` (the moderator is still deciding),
 * so images can land before the final approval click.
 */
export async function isStagingImagePrepActive(factId: number): Promise<boolean> {
  const review = await findReviewForStagingFact(factId);
  if (!review) return true; // not a staged prep target — normal live-fact path
  return isUnresolvedSubmissionStage(review.workflowStage);
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

  // Success path ONLY: enrichment is now valid + the review is in
  // production_review, so the Step-2 default render scenarios can be prepared.
  // A separate durable job does the (expensive, multi-scenario) enqueue so this
  // transition stays cheap; the dedupeKey makes re-entry a no-op. Best-effort —
  // a failure here must not roll back the stage advance.
  if (nextStage === "production_review") {
    try {
      await enqueueJob({
        queue: REVIEW_RENDER_PREPARE_QUEUE,
        payload: { reviewId: review.id },
        dedupeKey: `review_render_prep:${review.id}`,
      });
    } catch (err) {
      logger.error(
        { err, reviewId: review.id },
        "[moderation] failed to enqueue review render prepare (stage advance kept)",
      );
    }

    // Slice 2A: also draft candidate Visual concepts for the moderator. Purely
    // best-effort and NON-BLOCKING — a failure here never affects the advance or
    // the render-prepare enqueue above. Enqueued inline (literal queue name +
    // "pending" status write, matching enqueueVisualConceptsForReview) so this
    // widely-imported helper doesn't import visualConceptJobs and create a cycle.
    try {
      await db
        .update(factsTable)
        .set({ visualConceptStatus: "pending" })
        .where(eq(factsTable.id, args.factId));
      await enqueueJob({
        queue: FACT_VISUAL_CONCEPTS_QUEUE,
        payload: { reviewId: review.id, factId: args.factId, candidateVersionId: null, moderatorDraftScene: null },
        dedupeKey: `fact_visual_concepts:review:${review.id}`,
      });
    } catch (err) {
      logger.error(
        { err, reviewId: review.id },
        "[moderation] failed to enqueue visual concepts (stage advance kept)",
      );
    }
  }
}
