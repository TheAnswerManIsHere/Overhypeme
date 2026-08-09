/**
 * Approved-fact-text lock — the server-authoritative protection model for
 * editing a fact's text (Plan v4). Answers, from the LOCKED fact row + review
 * history (never from the client): is this fact's text PROTECTED (approved,
 * so an edit needs the dire-warning confirmation) or is it a freely-editable
 * first-time staging fact?
 *
 * A root text edit does NOT look at its variants — a variant's enrichment is
 * classified from its own text only, so re-wording a root never invalidates
 * or blocks on a variant (variant independence; see
 * docs/ai-context/taxonomy-and-enrichment.md).
 *
 * The protection predicate fails CLOSED: only a fact positively identified as a
 * single, unresolved, first-time staging cycle is unprotected. Everything else
 * — live, ever-approved, ambiguous, orphaned, legacy — is protected.
 *
 * "Prep in progress" is judged from DURABLE async_jobs rows (nonterminal =
 * status IN ('pending','processing')), never from the facts.* status projection
 * columns, which are written separately from the enqueue and can strand a fake
 * "pending" behind a failed enqueue.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { pendingReviewsTable, asyncJobsTable } from "@workspace/db/schema";
import { UNRESOLVED_SUBMISSION_STAGE_VALUES, type ReviewWorkflowStage } from "@workspace/api-zod";

type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const NONTERMINAL_JOB_STATUSES = ["pending", "processing"] as const;

// ── Protection state ────────────────────────────────────────────────────────

export type FactTextProtectionState =
  | { protected: true; reason: "active" }
  | { protected: true; reason: "ever_approved" }
  | { protected: true; reason: "ambiguous_unresolved_reviews" }
  | { protected: true; reason: "orphan_or_legacy" }
  | {
      protected: false;
      reason: "single_first_time_staging";
      /** The one unresolved first-time review that owns this staging fact. */
      reviewId: number;
      workflowStage: ReviewWorkflowStage;
    };

/**
 * Classify a fact's text-edit protection. Call with the fact row ALREADY locked
 * (`SELECT … FOR UPDATE`) by the caller's transaction so the classification and
 * the subsequent write see the same snapshot; `tx` is that transaction.
 *
 * The unprotected staging exception requires ALL of:
 *   - the fact is inactive;
 *   - NO production-approved review points at it (`approvedFactId = factId`);
 *   - EXACTLY ONE unresolved review points at it as `stagingFactId`;
 *   - that review is a first-time cycle (`candidateVersionId IS NULL`).
 * Any other shape (count ≠ 1, a refresh cycle, an approved history row) is
 * protected. This deliberately does NOT reuse `findUnresolvedReviewForStagingFact`
 * (which is `LIMIT 1` and cannot prove single ownership).
 */
export async function resolveFactTextProtection(
  factId: number,
  isActive: boolean,
  tx: DbLike = db,
): Promise<FactTextProtectionState> {
  // 1. Live fact → protected outright.
  if (isActive) return { protected: true, reason: "active" };

  // 2. Ever production-approved (a review promoted this exact fact) → protected,
  //    even if it was later soft-deleted (isActive=false).
  const [approvedRow] = await tx
    .select({ id: pendingReviewsTable.id })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.approvedFactId, factId))
    .limit(1);
  if (approvedRow) return { protected: true, reason: "ever_approved" };

  // 3. Full unresolved-ownership set (NOT limit 1) — need to prove uniqueness.
  const unresolved = await tx
    .select({
      id: pendingReviewsTable.id,
      workflowStage: pendingReviewsTable.workflowStage,
      candidateVersionId: pendingReviewsTable.candidateVersionId,
    })
    .from(pendingReviewsTable)
    .where(and(
      eq(pendingReviewsTable.stagingFactId, factId),
      inArray(pendingReviewsTable.workflowStage, [...UNRESOLVED_SUBMISSION_STAGE_VALUES]),
    ));

  if (unresolved.length === 0) return { protected: true, reason: "orphan_or_legacy" };
  if (unresolved.length > 1) return { protected: true, reason: "ambiguous_unresolved_reviews" };

  const only = unresolved[0];
  // A lone unresolved cycle that is a REFRESH (candidateVersionId != null) on an
  // inactive fact is contradictory ownership (refresh cycles belong to live
  // facts) — fail closed.
  if (only.candidateVersionId != null) return { protected: true, reason: "ambiguous_unresolved_reviews" };

  return {
    protected: false,
    reason: "single_first_time_staging",
    reviewId: only.id,
    workflowStage: only.workflowStage as ReviewWorkflowStage,
  };
}

// ── Durable prep-job authority (staging branch) ──────────────────────────────

/**
 * Is there a nonterminal (pending|processing) prep job for this first-time
 * staging cycle? Judged from async_jobs — enrichment + Pexels keyed by fact,
 * Visual-Ideas keyed by review — never from the facts.* status columns (which
 * can strand a fake "pending" behind a failed enqueue). A staging text edit is
 * rejected (STAGING_PREP_IN_PROGRESS) only when this is true.
 */
export async function hasNonterminalPrepJobs(
  args: { factId: number; reviewId: number },
  tx: DbLike = db,
): Promise<boolean> {
  const rows = await tx
    .select({ id: asyncJobsTable.id })
    .from(asyncJobsTable)
    .where(and(
      inArray(asyncJobsTable.status, [...NONTERMINAL_JOB_STATUSES]),
      sql`(
        (${asyncJobsTable.queue} = 'enrichment' AND ${asyncJobsTable.dedupeKey} = ${`enrichment:fact:${args.factId}`})
        OR (${asyncJobsTable.queue} = 'fact_pexels' AND ${asyncJobsTable.dedupeKey} = ${`fact_pexels:fact:${args.factId}`})
        OR (${asyncJobsTable.queue} = 'fact_visual_concepts' AND ${asyncJobsTable.dedupeKey} = ${`fact_visual_concepts:review:${args.reviewId}`})
      )`,
    ))
    .limit(1);
  return rows.length > 0;
}

// Convenience guard for callers that only need the boolean.
export function isProtected(state: FactTextProtectionState): boolean {
  return state.protected;
}
