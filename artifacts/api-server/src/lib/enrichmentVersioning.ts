/**
 * Shared helpers for versioned enrichment (stale-fact refresh).
 *
 * The versioning model: `facts.*` is the SOLE active enrichment truth;
 * `fact_enrichment_versions` is an append-only archive + in-flight candidate
 * store (statuses candidate | promoted | superseded | rejected). A send-back
 * creates a candidate, the candidate enrichment job fills it, moderation
 * previews it, approve promotes it into `facts.*`, reject retains it.
 */

import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, factEnrichmentVersionsTable, pendingReviewsTable } from "@workspace/db/schema";
import {
  validateEnrichment,
  canProductionApprove,
  type FactEnrichment,
  type EnrichmentOverrides,
  type ReviewWorkflowStage,
} from "@workspace/api-zod";
import { materializeEnrichment } from "./factEnrichment";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Hash of the RAW fact text a candidate was classified against. Stored on the
 * candidate at send-back and re-checked at promote so a candidate built for an
 * older fact text is never silently promoted after the text was edited.
 * Single source of truth — both the send-back primitive and the promote drift
 * guard must hash via THIS function so the comparison is apples-to-apples.
 */
export function hashFactText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export type PromoteCandidateErrorCode =
  | "REVIEW_NOT_FOUND"
  | "REVIEW_CANDIDATE_MISMATCH"
  | "REVIEW_NOT_APPROVABLE"
  | "CANDIDATE_NOT_FOUND"
  | "CANDIDATE_NOT_PENDING"
  | "FACT_NOT_FOUND"
  | "ENRICHMENT_INVALID"
  | "REFRESH_STALE_TEXT";

/** Typed failure from `promoteCandidateEnrichmentVersion`; the route maps codes to HTTP. */
export class PromoteCandidateError extends Error {
  constructor(
    public readonly code: PromoteCandidateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromoteCandidateError";
  }
}

/**
 * Promote a refresh candidate into `facts.*` (the sole active enrichment truth).
 * MUST run inside the caller's transaction — the caller commits the review-state
 * change (approved/production_approved) atomically with the promotion.
 *
 * Lock order: review → candidate → fact, all FOR UPDATE. Every precondition is
 * re-verified under those locks (the route's pre-checks are advisory only).
 *
 * What it does, in order:
 *  1. verify the review still points at THIS candidate and is approvable;
 *  2. verify the candidate belongs to the review's fact and is still `candidate`;
 *  3. fact-text drift guard: `hashFactText(facts.text)` must equal the hash the
 *     candidate was classified against, else `REFRESH_STALE_TEXT`;
 *  4. archive the prior active `facts.*` layers as a `superseded` version row
 *     (`source: 'prior_active_snapshot'`) so history is never lost;
 *  5. re-materialize the candidate's layers (baseline + overrides + visual
 *     override) and write ONLY the enrichment columns + projections +
 *     `last_processed_signature = candidate.signature` onto the fact. The
 *     signature is the CANDIDATE's (classify-time), not a fresh current one —
 *     permissive staleness: if the world moved on mid-review, the fact stays stale;
 *  6. mark the candidate `promoted`.
 *
 * FIELD-PRESERVATION INVARIANT (tested): step 5 never touches `isActive`,
 * `parentId`, hashtags, `pexelsImages`, `aiScenePrompts`, `aiMemeImages`,
 * scores/engagement, or `embedding`. Rendered memes/videos are immutable.
 */
// TODO(version-rollback): the archive rows written here already support an
// arbitrary-rollback UI (promote any historical version) — future enhancement.
export async function promoteCandidateEnrichmentVersion(
  args: { reviewId: number; candidateVersionId: number; adminId: string },
  tx: DbTx,
): Promise<{ factId: number; enrichment: FactEnrichment }> {
  const { reviewId, candidateVersionId, adminId } = args;

  // 1. Review, locked.
  const [review] = await tx
    .select({
      id: pendingReviewsTable.id,
      status: pendingReviewsTable.status,
      workflowStage: pendingReviewsTable.workflowStage,
      stagingFactId: pendingReviewsTable.stagingFactId,
      candidateVersionId: pendingReviewsTable.candidateVersionId,
    })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, reviewId))
    .for("update")
    .limit(1);
  if (!review) throw new PromoteCandidateError("REVIEW_NOT_FOUND", `Review ${reviewId} not found.`);
  if (review.candidateVersionId !== candidateVersionId || review.stagingFactId == null) {
    throw new PromoteCandidateError(
      "REVIEW_CANDIDATE_MISMATCH",
      `Review ${reviewId} does not point at candidate version ${candidateVersionId}.`,
    );
  }
  if (!canProductionApprove(review.workflowStage as ReviewWorkflowStage, review.status)) {
    throw new PromoteCandidateError(
      "REVIEW_NOT_APPROVABLE",
      `Cannot promote from stage ${review.workflowStage} (${review.status}).`,
    );
  }

  // 2. Candidate, locked.
  const [candidate] = await tx
    .select()
    .from(factEnrichmentVersionsTable)
    .where(eq(factEnrichmentVersionsTable.id, candidateVersionId))
    .for("update")
    .limit(1);
  if (!candidate || candidate.factId !== review.stagingFactId) {
    throw new PromoteCandidateError(
      "CANDIDATE_NOT_FOUND",
      `Candidate version ${candidateVersionId} not found for this review's fact.`,
    );
  }
  if (candidate.status !== "candidate") {
    throw new PromoteCandidateError(
      "CANDIDATE_NOT_PENDING",
      `Candidate version ${candidateVersionId} is already ${candidate.status}.`,
    );
  }

  // 3. Fact, locked.
  const [fact] = await tx
    .select()
    .from(factsTable)
    .where(eq(factsTable.id, candidate.factId))
    .for("update")
    .limit(1);
  if (!fact) throw new PromoteCandidateError("FACT_NOT_FOUND", `Fact ${candidate.factId} not found.`);

  // The candidate's layers must both validate — the effective blob is what ships;
  // the AI baseline is re-materialized below so projections can never drift.
  const effectiveCheck = validateEnrichment(candidate.enrichment);
  const baselineCheck = validateEnrichment(candidate.enrichmentAiDerived);
  if (!effectiveCheck.ok || !baselineCheck.ok) {
    throw new PromoteCandidateError(
      "ENRICHMENT_INVALID",
      "The refresh candidate has no valid enrichment yet — wait for enrichment to finish or re-run it.",
    );
  }

  // Fact-text drift guard: the candidate was classified against a specific text.
  if (candidate.factTextHash == null || hashFactText(fact.text) !== candidate.factTextHash) {
    throw new PromoteCandidateError(
      "REFRESH_STALE_TEXT",
      "The fact's text changed after this refresh was prepared. Reject this refresh and send the fact back again.",
    );
  }

  const now = new Date();

  // 4. Archive the prior active facts.* layers (append-only history).
  const [{ nextVersionNo }] = await tx
    .select({ nextVersionNo: sql<number>`coalesce(max(${factEnrichmentVersionsTable.versionNo}), 0) + 1` })
    .from(factEnrichmentVersionsTable)
    .where(eq(factEnrichmentVersionsTable.factId, fact.id));
  const priorVisualOverride =
    (fact.enrichment as { visualPromptStrategyOverride?: unknown } | null | undefined)
      ?.visualPromptStrategyOverride ?? null;
  await tx.insert(factEnrichmentVersionsTable).values({
    factId: fact.id,
    versionNo: nextVersionNo,
    status: "superseded",
    enrichment: fact.enrichment,
    enrichmentAiDerived: fact.enrichmentAiDerived,
    enrichmentOverrides: (fact.enrichmentOverrides ?? {}) as EnrichmentOverrides,
    visualOverride: priorVisualOverride,
    factTextHash: hashFactText(fact.text),
    signature: fact.lastProcessedSignature,
    source: "prior_active_snapshot",
    sourceReviewId: reviewId,
    createdBy: adminId,
    supersededAt: now,
  });

  // 5. Promote the candidate's layers into facts.* — re-materialized through THE
  // single write-shape so the effective blob, layer columns, and indexed
  // projections can never drift (and the visual override stays canonical).
  const { columns, effective } = materializeEnrichment({
    aiDerived: baselineCheck.data,
    overrides: (candidate.enrichmentOverrides ?? {}) as EnrichmentOverrides,
    visualPromptStrategyOverride: (candidate.visualOverride ?? undefined) as
      | FactEnrichment["visualPromptStrategyOverride"]
      | undefined,
  });
  await tx
    .update(factsTable)
    .set({
      ...columns,
      enrichmentStatus: "ok",
      // The signature captured when the CANDIDATE was classified (null until PR3).
      lastProcessedSignature: candidate.signature,
    })
    .where(eq(factsTable.id, fact.id));

  // 6. Retire the candidate as promoted history.
  await tx
    .update(factEnrichmentVersionsTable)
    .set({ status: "promoted", promotedAt: now })
    .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));

  return { factId: fact.id, enrichment: effective };
}
