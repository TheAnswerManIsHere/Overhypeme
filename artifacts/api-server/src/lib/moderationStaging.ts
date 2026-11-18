/**
 * Server-side helpers for the staged moderation lifecycle.
 *
 * A "staging fact" is an inactive (isActive=false) row in `facts` created at a
 * moderator's provisional approval. All production-prep tooling (enrichment,
 * CPP, test memes, override editing) runs against this real factId;
 * production approval later flips it active. Keeping the prep target a fact —
 * not the review blob — lets the second stage reuse every existing fact-backed
 * system unchanged.
 */

import { and, eq, desc, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { pendingReviewsTable, factsTable } from "@workspace/db/schema";
import {
  PREPARING_STAGE_VALUES,
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
  type ReviewWorkflowStage,
} from "@workspace/api-zod";
import { renderCanonical } from "./renderCanonical";
import { computeSplitTokenIndex } from "./splitTokenIndex";
import { primaryWorkingGag } from "./gags/resolver";

// Matches any pronoun / gendered template token (same detection the approve
// path uses) so the staging fact records whether it needs pronoun handling.
const PRONOUN_TOKEN_RE =
  /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|[^|{}]+\|[^|{}]+)\}/;

type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * THE single ingestion primitive (Phase 2 fact-lifecycle closure): create a
 * Stage-1 (`triage`) review. Every way a fact enters the system —
 * manual user submission, bulk import, and any future
 * ingestion path (e.g. an API) — funnels through here, so a fact can never be
 * born active/enriched: it always starts at the front of the moderation pipeline
 * (triage → enrich → activate).
 *
 * The duplicate match is not written here: the server's duplicate check of the
 * saved wording writes it after the insert (lib/duplicateVerdict.ts). `enrichment` / `canonicalText` / hashtag-upsert /
 * embeddings are intentionally NOT derived here: they belong to later pipeline
 * stages (the cost gate), exactly as manual submit already defers them.
 *
 * `submittedById` is nullable: system imports via the API-key bulk endpoint have
 * no user (no user to notify, no activity-feed entry). Must run inside the caller's `tx` when
 * the caller needs the insert atomic with a cap check / advisory lock.
 */
export async function createTriageReview(
  tx: DbLike,
  input: {
    submittedText: string;
    submittedById: string | null;
    hashtags: string[];
    reason?: (typeof pendingReviewsTable.$inferInsert)["reason"];
  },
): Promise<typeof pendingReviewsTable.$inferSelect> {
  const [review] = await tx
    .insert(pendingReviewsTable)
    .values({
      submittedText: input.submittedText,
      submittedById: input.submittedById,
      hashtags: input.hashtags,
      status: "pending",
      workflowStage: "triage",
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
  /** Set when the submitter deleted their account: the fact is credited to a former member. */
  submitterDeletedAt?: Date | null;
  stagingFactId: number | null;
}

/**
 * Create the inactive staging fact for a review (idempotent): if the review
 * already points at a staging fact, that fact is returned untouched. The fact is
 * inserted with NO enrichment columns — enrichment runs asynchronously against
 * this factId and materializes them.
 */
export async function ensureStagingFact(
  review: StagingReviewRow,
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
      submitterDeletedAt: review.submitterDeletedAt ?? undefined,
      hasPronouns: PRONOUN_TOKEN_RE.test(review.submittedText),
      canonicalText: renderCanonical(review.submittedText),
      isActive: false,
      splitTokenIndex: computeSplitTokenIndex(review.submittedText),
    })
    .returning({ id: factsTable.id });
  return { factId: fact.id, created: true };
}

/**
 * The current UNRESOLVED review cycle linked to a staging fact, or null when
 * every linked review is resolved (or none exists).
 *
 * The prep guards below must never key off a RESOLVED row: a fact whose
 * review sits at approved is simply a live fact, not "a staging
 * fact whose review left prep". Newest-by-created_at keeps the lookup
 * deterministic.
 */
export async function findUnresolvedReviewForStagingFact(
  factId: number,
  tx: DbLike = db,
): Promise<{ id: number; workflowStage: ReviewWorkflowStage } | null> {
  const [row] = await tx
    .select({
      id: pendingReviewsTable.id,
      workflowStage: pendingReviewsTable.workflowStage,
    })
    .from(pendingReviewsTable)
    .where(and(
      eq(pendingReviewsTable.stagingFactId, factId),
      inArray(pendingReviewsTable.workflowStage, [...UNRESOLVED_SUBMISSION_STAGE_VALUES]),
    ))
    .orderBy(desc(pendingReviewsTable.createdAt))
    .limit(1);
  return row
    ? { id: row.id, workflowStage: row.workflowStage as ReviewWorkflowStage }
    : null;
}

/**
 * The text and render input a moderation-side visual surface uses for a review
 * cycle: the staging fact's text, and its primary working gag (lowest slot, its
 * pending change if there is one, else its approved version;
 * lib/gags/resolver.ts) as the raw render input `{ visualPromptStrategyOverride }`
 * (the caller validates with validateGagRenderInput). The taxonomy is not part
 * of it (Issue #1018, increment 1.2c-ii). Null when the review has no staging
 * fact / the fact is missing.
 */
export async function resolveReviewCycleEnrichment(
  review: { stagingFactId: number | null },
  tx: DbLike = db,
): Promise<{
  factId: number;
  text: string;
  rawRenderInput: unknown;
  gagId: number | null;
} | null> {
  if (review.stagingFactId == null) return null;
  const [fact] = await tx
    .select({ text: factsTable.text })
    .from(factsTable)
    .where(eq(factsTable.id, review.stagingFactId))
    .limit(1);
  if (!fact) return null;
  const primary = await primaryWorkingGag(review.stagingFactId, tx);
  return {
    factId: review.stagingFactId,
    text: fact.text,
    rawRenderInput: { visualPromptStrategyOverride: primary?.content ?? undefined },
    gagId: primary?.gag.id ?? null,
  };
}

/**
 * The saved scene of a review's primary gag, gating the Gags step's "Approve
 * the gags" transition. The moderator approves the *persisted* gag, never the
 * AI idea cards or an unsaved browser draft. The taxonomy plays no part: a
 * fact whose taxonomy is missing or failed is approved like any other (Issue
 * #1018, increment 1.2c-ii). Each failure carries a distinct status and code.
 */
export type SavedCoreSceneResult =
  | { ok: true; coreScene: string }
  | { ok: false; status: number; code: string; error: string };

export async function resolveSavedCoreSceneForReview(
  review: { stagingFactId: number | null },
  tx: DbLike = db,
): Promise<SavedCoreSceneResult> {
  if (review.stagingFactId == null) {
    return { ok: false, status: 409, code: "NO_STAGING_FACT", error: "No staging fact for this review — provisionally approve it first." };
  }
  const primary = await primaryWorkingGag(review.stagingFactId, tx);
  const coreScene = primary?.content?.coreSceneOverride?.trim() ?? "";
  if (!coreScene) {
    return { ok: false, status: 409, code: "CONCEPT_MISSING", error: "Save a non-empty Visual Concept (core scene) before approving the visual gag." };
  }
  return { ok: true, coreScene };
}

/**
 * Structured decision for the GENERIC fact-backed enrichment job ("should this
 * job classify and write facts.*?"). The generic job writes straight into the
 * fact's live enrichment layers, so it must run for exactly two shapes of work
 * and skip everything else:
 *
 *  - `live_fact` — no unresolved review cycle and the fact is active: a normal
 *    admin re-enrich. Resolved historical reviews must NOT block this.
 *  - `first_time_staging` — an unresolved cycle past triage (Reading, Gags or
 *    Test Renders): the taxonomy run started at provisional approval. It runs
 *    beside moderation and never moves the review (Issue #1018, increment
 *    1.2c-ii).
 *
 * Skips:
 *  - `staging_prep_left` — an unresolved cycle still at triage (never the case
 *    for a staging fact; kept so the answer is total).
 *  - `inactive_staging` — no unresolved cycle and the fact is inactive: an
 *    abandoned/rejected first-time staging fact; skip paid work.
 */
export type GenericFactEnrichmentDecision =
  | { action: "run"; mode: "live_fact" | "first_time_staging" }
  | { action: "skip"; reason: "staging_prep_left" | "inactive_staging" | "fact_missing" };

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
    return (PREPARING_STAGE_VALUES as readonly ReviewWorkflowStage[]).includes(unresolved.workflowStage)
      ? { action: "run", mode: "first_time_staging" }
      : { action: "skip", reason: "staging_prep_left" };
  }
  return fact.isActive ? { action: "run", mode: "live_fact" } : { action: "skip", reason: "inactive_staging" };
}
