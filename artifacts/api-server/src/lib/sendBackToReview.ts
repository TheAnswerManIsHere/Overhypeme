/**
 * Send an ACTIVE fact back into moderation at Step 2 ("Production review") for a
 * versioned enrichment refresh — the core primitive of the stale-fact refresh
 * feature. Shared by the admin endpoint, the Taxonomy Health row action, and the
 * bulk re-process job (none of them HTTP-call each other).
 *
 * What it does (one transaction, then one enqueue):
 *  - creates a `candidate` row in `fact_enrichment_versions`, seeding the manual
 *    override layers from the fact's ACTIVE enrichment (unless `clearOverrides`);
 *  - creates a NEW `pending_reviews` cycle at `prep_pending` (the original
 *    approval review is never mutated — decision 7);
 *  - enqueues the candidate enrichment job, which classifies into the VERSION
 *    row, never `facts.*`.
 *
 * The fact itself stays fully live throughout: `isActive` is untouched, the
 * public feed keeps reading `facts.enrichment`, and rendered memes/Pexels images
 * are never touched. Only `facts.enrichment_status` flips to "pending" so the
 * admin UI shows prep running. No Pexels enqueue: `pexelsImages` derives from
 * fact TEXT, which a refresh never changes (decision 10).
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, factEnrichmentVersionsTable, pendingReviewsTable } from "@workspace/db/schema";
import type { EnrichmentOverrides } from "@workspace/api-zod";
import { findInFlightRefreshCandidate, hashFactText } from "./enrichmentVersioning";
import { enqueueJob } from "./asyncJobs";
import { logger } from "./logger";

export type SendBackToReviewErrorCode =
  | "FACT_NOT_FOUND"
  | "NOT_ACTIVE"
  | "HAS_ACTIVE_VARIANTS"
  | "REFRESH_ALREADY_IN_PROGRESS";

/** Typed failure from `sendFactBackToReview`; callers map codes to HTTP (409s). */
export class SendBackToReviewError extends Error {
  constructor(
    public readonly code: SendBackToReviewErrorCode,
    message: string,
    /** For REFRESH_ALREADY_IN_PROGRESS: the in-flight cycle so the UI can link to it. */
    public readonly existing?: { reviewId: number | null; candidateVersionId: number },
  ) {
    super(message);
    this.name = "SendBackToReviewError";
  }
}

/** True when `err` (or its cause chain) is the one-candidate-per-fact unique violation. */
function isCandidateUniqueViolation(err: unknown): boolean {
  for (let e = err; e != null; e = (e as { cause?: unknown }).cause) {
    const pg = e as { code?: string; constraint?: string; message?: string };
    if (pg.code === "23505" && (pg.constraint ?? pg.message ?? "").includes("UQ_fev_one_candidate_per_fact")) {
      return true;
    }
  }
  return false;
}

export interface SendBackToReviewResult {
  reviewId: number;
  candidateVersionId: number;
  versionNo: number;
}

export async function sendFactBackToReview(args: {
  factId: number;
  /** Wipe the manual override layers on the CANDIDATE only (default: seed from active). */
  clearOverrides?: boolean;
  /** Admin who triggered the refresh — recorded on the candidate row. */
  adminId?: string | null;
}): Promise<SendBackToReviewResult> {
  const { factId, clearOverrides = false, adminId = null } = args;

  let result: SendBackToReviewResult;
  try {
    result = await db.transaction(async (tx) => {
      // The fact lock serializes concurrent send-backs for the same fact, which
      // makes the one-candidate pre-check below race-free (the partial-unique
      // index is the backstop, caught in the catch).
      const [fact] = await tx
        .select({
          id: factsTable.id,
          text: factsTable.text,
          isActive: factsTable.isActive,
          enrichment: factsTable.enrichment,
          enrichmentOverrides: factsTable.enrichmentOverrides,
        })
        .from(factsTable)
        .where(eq(factsTable.id, factId))
        .for("update")
        .limit(1);
      if (!fact) throw new SendBackToReviewError("FACT_NOT_FOUND", `Fact ${factId} not found.`);
      if (!fact.isActive) {
        throw new SendBackToReviewError(
          "NOT_ACTIVE",
          "Only an active (live) fact can be sent back to review — this one is inactive.",
        );
      }
      // Variants are classified WITH their parent's text as context; refreshing a
      // root out from under active variants could silently invalidate them.
      const [variant] = await tx
        .select({ id: factsTable.id })
        .from(factsTable)
        .where(and(eq(factsTable.parentId, factId), eq(factsTable.isActive, true)))
        .limit(1);
      if (variant) {
        throw new SendBackToReviewError(
          "HAS_ACTIVE_VARIANTS",
          "This fact has active variants. Refresh the variants individually instead of the root.",
        );
      }
      const existing = await findInFlightRefreshCandidate(factId, tx);
      if (existing) {
        throw new SendBackToReviewError(
          "REFRESH_ALREADY_IN_PROGRESS",
          "A refresh is already in progress for this fact.",
          { reviewId: existing.reviewId, candidateVersionId: existing.candidateVersionId },
        );
      }

      const [{ nextVersionNo }] = await tx
        .select({ nextVersionNo: sql<number>`coalesce(max(${factEnrichmentVersionsTable.versionNo}), 0) + 1` })
        .from(factEnrichmentVersionsTable)
        .where(eq(factEnrichmentVersionsTable.factId, factId));

      // Manual edits are preserved by default: the candidate seeds the override
      // layers from the ACTIVE version and only the AI baseline is regenerated.
      // `clearOverrides` wipes the CANDIDATE's seed only — the fact's own
      // override layers are never touched here.
      const seedVisualOverride = clearOverrides
        ? null
        : ((fact.enrichment as { visualPromptStrategyOverride?: unknown } | null | undefined)
            ?.visualPromptStrategyOverride ?? null);

      // Circular-FK insert order: candidate first (source_review_id null), then
      // the review pointing at it, then backfill the candidate's back-pointer.
      const [candidate] = await tx
        .insert(factEnrichmentVersionsTable)
        .values({
          factId,
          versionNo: nextVersionNo,
          status: "candidate",
          enrichment: null, // the candidate job fills these
          enrichmentAiDerived: null,
          enrichmentOverrides: clearOverrides ? {} : ((fact.enrichmentOverrides ?? {}) as EnrichmentOverrides),
          visualOverride: seedVisualOverride,
          factTextHash: hashFactText(fact.text),
          signature: null, // TODO(PR3-signature): stamped at classify time once signatures land
          source: "refresh_candidate",
          sourceReviewId: null,
          createdBy: adminId,
        })
        .returning({ id: factEnrichmentVersionsTable.id });

      const [review] = await tx
        .insert(pendingReviewsTable)
        .values({
          submittedText: fact.text,
          submittedById: null, // admin-initiated refresh — there is no submitter to notify
          status: "pending",
          workflowStage: "prep_pending",
          stagingFactId: factId,
          candidateVersionId: candidate.id,
        })
        .returning({ id: pendingReviewsTable.id });

      await tx
        .update(factEnrichmentVersionsTable)
        .set({ sourceReviewId: review.id })
        .where(eq(factEnrichmentVersionsTable.id, candidate.id));

      // The fact stays live (isActive untouched); the pill shows prep running.
      await tx.update(factsTable).set({ enrichmentStatus: "pending" }).where(eq(factsTable.id, factId));

      return { reviewId: review.id, candidateVersionId: candidate.id, versionNo: nextVersionNo };
    });
  } catch (err) {
    if (isCandidateUniqueViolation(err)) {
      // Race path (two send-backs hit the partial-unique index): look the
      // winner up post-conflict so this path returns the SAME in-flight cycle
      // ids as the pre-check — the endpoint contract for
      // REFRESH_ALREADY_IN_PROGRESS. Null-safe if the winner vanished already.
      const existing = await findInFlightRefreshCandidate(factId);
      throw new SendBackToReviewError(
        "REFRESH_ALREADY_IN_PROGRESS",
        "A refresh is already in progress for this fact.",
        existing ? { reviewId: existing.reviewId, candidateVersionId: existing.candidateVersionId } : undefined,
      );
    }
    throw err;
  }

  // After commit: classify into the candidate row (deduped per version).
  await enqueueJob({
    queue: "enrichment",
    payload: { factId, versionId: result.candidateVersionId },
    dedupeKey: `enrichment:version:${result.candidateVersionId}`,
  });

  logger.info(
    { factId, reviewId: result.reviewId, candidateVersionId: result.candidateVersionId, clearOverrides, adminId },
    "[refresh] fact sent back to review",
  );
  return result;
}
