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

import { and, eq, desc, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { pendingReviewsTable, factsTable, factEnrichmentVersionsTable } from "@workspace/db/schema";
import {
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
  validateEnrichment,
  type FactEnrichment,
  type ReviewWorkflowStage,
} from "@workspace/api-zod";
import { renderCanonical } from "./renderCanonical";
import { computeSplitTokenIndex } from "./splitTokenIndex";
import { enqueueJob } from "./asyncJobs";
import { logger } from "./logger";

// Queue name owned by visualConceptJobs.ts (kept as a literal for the same
// reason — and because visualConceptJobs imports resolveReviewCycleEnrichment
// from THIS module, so importing it back would create a module cycle).
const FACT_VISUAL_CONCEPTS_QUEUE = "fact_visual_concepts";

// Matches any pronoun / gendered template token (same detection the approve
// path uses) so the staging fact records whether it needs pronoun handling.
const PRONOUN_TOKEN_RE =
  /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|[^|{}]+\|[^|{}]+)\}/;

type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * THE single ingestion primitive (Phase 2 fact-lifecycle closure): create a
 * Stage-1 (`triage_pending`) review. Every way a fact enters the system —
 * manual user submission, bulk import, variant creation, and any future
 * ingestion path (e.g. an API) — funnels through here, so a fact can never be
 * born active/enriched: it always starts at the front of the moderation pipeline
 * (triage → enrich → activate).
 *
 * Deliberately carries EVERY column the manual-submit path writes today —
 * `matchingFactId` / `matchingSimilarity` / `reason` (duplicate/near-match
 * context) and `parentFactId` (variant parent) — so refactoring manual submit
 * onto it is byte-identical. `enrichment` / `canonicalText` / hashtag-upsert /
 * embeddings are intentionally NOT derived here: they belong to later pipeline
 * stages (the cost gate), exactly as manual submit already defers them.
 *
 * `submittedById` is nullable: system imports via the API-key bulk endpoint have
 * no user (the same nullable-submitter shape refresh reviews already use — no
 * user to notify, no activity-feed entry). Must run inside the caller's `tx` when
 * the caller needs the insert atomic with a cap check / advisory lock.
 */
export async function createTriageReview(
  tx: DbLike,
  input: {
    submittedText: string;
    submittedById: string | null;
    hashtags: string[];
    parentFactId?: number | null;
    matchingFactId?: number | null;
    matchingSimilarity?: number;
    reason?: (typeof pendingReviewsTable.$inferInsert)["reason"];
  },
): Promise<typeof pendingReviewsTable.$inferSelect> {
  const [review] = await tx
    .insert(pendingReviewsTable)
    .values({
      submittedText: input.submittedText,
      submittedById: input.submittedById,
      matchingFactId: input.matchingFactId ?? null,
      matchingSimilarity: input.matchingSimilarity ?? 0,
      hashtags: input.hashtags,
      parentFactId: input.parentFactId ?? null,
      status: "pending",
      workflowStage: "triage_pending",
      reason: input.reason ?? null,
      enrichment: null,
      enrichmentStatus: null,
    })
    .returning();
  return review;
}

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
 * The current UNRESOLVED review cycle linked to a staging fact, or null when
 * every linked review is resolved (or none exists).
 *
 * A fact accumulates MULTIPLE review rows under the stale-fact refresh feature
 * (each send-back creates a new cycle while the original approved review
 * persists), and the prep guards below must never key off a RESOLVED row: a
 * fact whose refresh was approved/rejected — or a plain first-time fact whose
 * original review sits at production_approved — is simply a live fact again,
 * not "a staging fact whose review left prep". Newest-by-created_at keeps the
 * lookup deterministic. `candidateVersionId` is returned because a REFRESH
 * cycle (non-null) is owned exclusively by the version-targeted job
 * (runEnrichmentForCandidateVersion); the generic fact job must skip it.
 */
export async function findUnresolvedReviewForStagingFact(
  factId: number,
  tx: DbLike = db,
): Promise<{ id: number; workflowStage: ReviewWorkflowStage; candidateVersionId: number | null } | null> {
  const [row] = await tx
    .select({
      id: pendingReviewsTable.id,
      workflowStage: pendingReviewsTable.workflowStage,
      candidateVersionId: pendingReviewsTable.candidateVersionId,
    })
    .from(pendingReviewsTable)
    .where(and(
      eq(pendingReviewsTable.stagingFactId, factId),
      inArray(pendingReviewsTable.workflowStage, [...UNRESOLVED_SUBMISSION_STAGE_VALUES]),
    ))
    .orderBy(desc(pendingReviewsTable.createdAt))
    .limit(1);
  return row
    ? { id: row.id, workflowStage: row.workflowStage as ReviewWorkflowStage, candidateVersionId: row.candidateVersionId }
    : null;
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
 * Resolve the SAVED Visual Concept (core scene) for a review cycle, gating the
 * Step-2 "approve the visual gag" transition. Built on resolveReviewCycleEnrichment
 * so refresh cycles read the candidate version's enrichment and first-time cycles
 * read the staging fact's — the single source of truth every gag-gate check uses.
 *
 * The concept the moderator is approving is the *persisted* enrichment, NOT the
 * AI candidate cards or an unsaved browser draft (the server can't see those).
 * Each failure carries a distinct HTTP status + code so the endpoint returns a
 * precise 4xx. Shared by the endpoint and its tests.
 */
export type SavedCoreSceneResult =
  | { ok: true; coreScene: string; enrichment: FactEnrichment; source: "candidate_version" | "staging_fact" }
  | { ok: false; status: number; code: string; error: string };

export async function resolveSavedCoreSceneForReview(
  review: { stagingFactId: number | null; candidateVersionId: number | null },
  tx: DbLike = db,
): Promise<SavedCoreSceneResult> {
  const cycle = await resolveReviewCycleEnrichment(review, tx);
  if (!cycle) {
    return { ok: false, status: 409, code: "NO_STAGING_FACT", error: "No staging fact for this review — provisionally approve it first." };
  }
  const validated = validateEnrichment(cycle.rawEnrichment);
  if (!validated.ok) {
    return { ok: false, status: 400, code: "ENRICHMENT_INVALID", error: `Enrichment is invalid: ${validated.error}` };
  }
  const enrichment = validated.data;
  // Presence-based (the enable toggle was retired): the Visual Concept is required
  // and gates approval purely on a non-empty saved core scene. There is no separate
  // "enabled" requirement anymore.
  const ov = enrichment.visualPromptStrategyOverride;
  const coreScene = ov?.coreSceneOverride?.trim() ?? "";
  if (!coreScene) {
    return { ok: false, status: 409, code: "CONCEPT_MISSING", error: "Save a non-empty Visual Concept (core scene) before approving the visual gag." };
  }
  return { ok: true, coreScene, enrichment, source: cycle.source };
}

/**
 * Structured decision for the GENERIC fact-backed enrichment job ("should this
 * job classify and write facts.*?"). The generic job writes straight into the
 * fact's live enrichment layers, so it must run for exactly two shapes of work
 * and skip everything else:
 *
 *  - `live_fact` — no unresolved review cycle and the fact is active: a normal
 *    admin re-enrich. Resolved historical reviews (an approved first-time cycle,
 *    a promoted/rejected refresh) must NOT block this.
 *  - `first_time_staging` — an unresolved FIRST-TIME cycle
 *    (`candidateVersionId == null`) still in `prep_pending`.
 *
 * Skips:
 *  - `refresh_candidate_in_review` — an unresolved refresh cycle owns this fact:
 *    the candidate job (runEnrichmentForCandidateVersion) classifies into the
 *    VERSION row; a stale generic job running here would overwrite live facts.*
 *    mid-review and could advance the cycle with an unfilled candidate.
 *  - `staging_prep_left` — a first-time cycle that moved past prep (rejected, or
 *    already at production_review): the original cost guard, unchanged.
 *  - `inactive_staging` — no unresolved cycle and the fact is inactive: an
 *    abandoned/rejected first-time staging fact; skip paid work.
 */
export type GenericFactEnrichmentDecision =
  | { action: "run"; mode: "live_fact" | "first_time_staging" }
  | { action: "skip"; reason: "refresh_candidate_in_review" | "staging_prep_left" | "inactive_staging" | "fact_missing" };

export async function resolveGenericFactEnrichmentDecision(
  factId: number,
  tx: DbLike = db,
): Promise<GenericFactEnrichmentDecision> {
  const [fact] = await tx
    .select({ isActive: factsTable.isActive })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!fact) return { action: "skip", reason: "fact_missing" };
  const unresolved = await findUnresolvedReviewForStagingFact(factId, tx);
  if (unresolved) {
    if (unresolved.candidateVersionId != null) return { action: "skip", reason: "refresh_candidate_in_review" };
    return unresolved.workflowStage === "prep_pending"
      ? { action: "run", mode: "first_time_staging" }
      : { action: "skip", reason: "staging_prep_left" };
  }
  return fact.isActive ? { action: "run", mode: "live_fact" } : { action: "skip", reason: "inactive_staging" };
}

/**
 * Cost guard for image prep jobs. Pexels work runs while an unresolved cycle is
 * still deciding (including `production_review`, so images can land before the
 * approval click) and for any live fact; it skips only inactive facts with no
 * unresolved cycle (abandoned/rejected first-time staging).
 */
export async function isStagingImagePrepActive(factId: number): Promise<boolean> {
  const unresolved = await findUnresolvedReviewForStagingFact(factId);
  if (unresolved) return true; // unresolved by definition — moderator still deciding
  const [fact] = await db
    .select({ isActive: factsTable.isActive })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  return fact?.isActive ?? false;
}

/**
 * Advance a review off the terminal outcome of its staging fact's GENERIC
 * enrichment job. Success → concept_review (Step 2: Visual Concept gate);
 * terminal abandon → prep_failed. Acts ONLY on an unresolved FIRST-TIME cycle
 * (`candidateVersionId == null`) still in `prep_pending` — refresh cycles are
 * advanced exclusively by runEnrichmentForCandidateVersion, which targets its
 * exact version/review pair; a generic outcome must never move one.
 *
 * On success we enqueue the Visual-Idea candidates (fact_visual_concepts) but
 * NOT the render batch: renders are Step 3 and only fire once the moderator
 * approves the visual gag (see approve-visual-concept). Visual Ideas are a
 * BLOCKING prep artifact for that gag approval, so an enqueue failure marks the
 * status "failed" (retryable) rather than leaving it stuck "pending".
 */
export async function advanceReviewForStagingFactEnrichment(args: {
  factId: number;
  outcome: "success" | "terminal_failed";
}): Promise<void> {
  const review = await findUnresolvedReviewForStagingFact(args.factId);
  if (!review) return; // live-fact enrichment — nothing to advance
  if (review.candidateVersionId != null || review.workflowStage !== "prep_pending") {
    logger.info(
      { factId: args.factId, reviewId: review.id, stage: review.workflowStage, refreshCycle: review.candidateVersionId != null, outcome: args.outcome },
      "[moderation] stale staging enrichment outcome ignored (not an in-prep first-time cycle)",
    );
    return;
  }
  const nextStage: ReviewWorkflowStage = args.outcome === "success" ? "concept_review" : "prep_failed";
  await db
    .update(pendingReviewsTable)
    .set({ workflowStage: nextStage })
    .where(eq(pendingReviewsTable.id, review.id));
  logger.info(
    { factId: args.factId, reviewId: review.id, nextStage },
    "[moderation] staging enrichment advanced review stage",
  );

  // Success path ONLY: enrichment is valid and the review has entered Step 2
  // (concept_review). Draft the Visual-Idea candidates for the moderator. These
  // gate gag approval (Step 2 = Visual Concept gate), so on enqueue failure we
  // flip the status to "failed" (retryable via regenerate) — never leave it
  // hanging "pending" with no job behind it. NO render-prepare here: the render
  // batch is force-enqueued at gag approval (Step 3), not on enrichment success.
  // Enqueued inline (literal queue name + "pending" status write, matching
  // enqueueVisualConceptsForReview) so this widely-imported helper doesn't import
  // visualConceptJobs and create a cycle.
  if (nextStage === "concept_review") {
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
        "[moderation] failed to enqueue visual concepts (stage advance kept; status → failed)",
      );
      // Don't leave the gate stuck "pending" with no job — mark failed so the
      // moderator can retry/regenerate. Best-effort; swallow secondary errors.
      try {
        await db
          .update(factsTable)
          .set({ visualConceptStatus: "failed" })
          .where(eq(factsTable.id, args.factId));
      } catch (statusErr) {
        logger.error(
          { err: statusErr, reviewId: review.id },
          "[moderation] failed to mark visual concepts failed after enqueue error",
        );
      }
    }
  }
}
