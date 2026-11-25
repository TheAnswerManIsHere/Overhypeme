/**
 * @purpose Purge a rejected submission's staging fact: the fact and everything that exists only to make it a fact, its render files onto the durable cleanup list; the submitter's rejection record stays.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_RENDER_HISTORY.md D7 (Issue #1304; David, Q52,
 * 2026-11-25: "If a fact isn't going to live in the system, it should be
 * purged."). Supersedes 1.2c-i's tie-break that a rejected submission's
 * pictures are "never offered", not deleted.
 *
 * A staging fact qualifies when it was never approved: not active, no
 * "ever approved" record (`facts.approved_at`, 1.2b), and no other open
 * review on it. Two more conditions keep anything that is not the
 * submission's own from going with it by cascade: no member content attached
 * (memes, AI pictures, comments, the permanent delete's own rule) and no
 * engine-comparison panel drawn from it. A fact that fails any is skipped and
 * counted by reason; one already gone is a no-op.
 *
 * What goes: the fact row, and by its foreign keys' cascade its renders,
 * gags (and their examples), readings, taxonomy runs and hashtag links. The
 * hashtags are detached through their one writer first, as the permanent
 * delete does, so their counts stay right. Every render's own picture and
 * every picture its provenance records name are queued on
 * `stored_file_deletions` in the same transaction (D6/D7, Astra C4).
 *
 * What stays: the review row (all the submitter's Library reads, through
 * mySubmissions.ts), whose `staging_fact_id` the foreign key nulls, and the
 * admin record of the rejection, whose fact link is nulled and review link
 * kept. Provenance records stay, as the 2026-11-10 tracing decision keeps them.
 *
 * Locking: the caller holds the review's lock when there is one (the lock
 * rule, lib/reviewLocks.ts); this takes the fact's, the lock every gag action
 * and the render worker's final store take, so a picture a worker committed
 * is seen here and one it has not yet recorded is never stored (D7).
 */
import { and, eq, ne, or, sql } from "drizzle-orm";
import {
  db, comparisonPanelsTable, factsTable, imagePromptAttemptsTable, pendingReviewsTable,
} from "@workspace/db";
import { attachedContent, deleteFactRow } from "./factLifecycle";
import { lockFactRow, lockReview } from "./reviewLocks";
import { cleanUpQueuedFiles, queueStoredFileDeletions, renderFilePaths } from "./storedFileDeletions";
import type { Executor } from "./visualConceptOwner";

export type PurgeSkipReason = "approved" | "open_review" | "member_content" | "in_comparison";

export type PurgeOutcome =
  | { kind: "purged"; factId: number; renders: number; files: string[] }
  | { kind: "skipped"; factId: number; reason: PurgeSkipReason }
  | { kind: "gone"; factId: number };

/** What a purge would hold, read without deleting: the dry run's numbers (zero unless it qualifies). */
export interface PurgeAssessment {
  outcome: "qualifies" | PurgeSkipReason | "gone";
  renders: number;
  files: string[];
}

/**
 * Whether a staging fact qualifies, and what it holds. Read under the fact's
 * lock when called from `purgeRejectedFact`; a dry run reads it unlocked.
 * `excludeReviewId` is the rejected review itself, which is not "another" open
 * review (the reject route checks after it has set the review rejected, so
 * this matters only for a caller that has not).
 */
export async function assessRejectedFact(
  tx: Executor,
  factId: number,
  opts: { excludeReviewId?: number | null } = {},
): Promise<PurgeAssessment> {
  const [fact] = await tx.select({ isActive: factsTable.isActive, approvedAt: factsTable.approvedAt })
    .from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  const none = { renders: 0, files: [] };
  if (!fact) return { outcome: "gone", ...none };
  if (fact.isActive || fact.approvedAt != null) return { outcome: "approved", ...none };
  const r = pendingReviewsTable;
  const [open] = await tx.select({ id: r.id }).from(r)
    .where(and(
      eq(r.status, "pending"),
      or(eq(r.stagingFactId, factId), eq(r.approvedFactId, factId)),
      opts.excludeReviewId != null ? ne(r.id, opts.excludeReviewId) : undefined,
    ))
    .limit(1);
  if (open) return { outcome: "open_review", ...none };
  const attached = await attachedContent(factId, tx);
  if (attached.memes + attached.aiPictures + attached.comments > 0) return { outcome: "member_content", ...none };
  const [panel] = await tx.select({ id: comparisonPanelsTable.id }).from(comparisonPanelsTable)
    .where(eq(comparisonPanelsTable.factId, factId)).limit(1);
  if (panel) return { outcome: "in_comparison", ...none };
  // What it holds is read only for one that qualifies.
  const attempts = await tx.select({ id: imagePromptAttemptsTable.id })
    .from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.factId, factId));
  return { outcome: "qualifies", renders: attempts.length, files: await renderFilePaths(tx, attempts.map((a) => a.id)) };
}

/**
 * Purge one rejected submission's staging fact, inside the caller's
 * transaction. The caller cleans up the returned files after its commit
 * (`cleanUpQueuedFiles`); the hourly sweep retries any it cannot.
 */
export async function purgeRejectedFact(
  tx: Executor,
  factId: number,
  opts: { excludeReviewId?: number | null } = {},
): Promise<PurgeOutcome> {
  const locked = await lockFactRow(tx, factId);
  if (!locked) return { kind: "gone", factId };
  const assessed = await assessRejectedFact(tx, factId, opts);
  if (assessed.outcome === "gone") return { kind: "gone", factId };
  if (assessed.outcome !== "qualifies") return { kind: "skipped", factId, reason: assessed.outcome };
  const files = await queueStoredFileDeletions(tx, assessed.files, "rejected_submission_purge");
  await deleteFactRow(tx, factId);
  return { kind: "purged", factId, renders: assessed.renders, files };
}

/**
 * Every rejected review that still names a staging fact: the one-time purge's
 * candidates (scripts/purge-rejected-submissions.ts). Oldest first.
 */
export async function rejectedReviewsWithStagingFacts(tx: Executor): Promise<{ reviewId: number; factId: number }[]> {
  const r = pendingReviewsTable;
  const rows = await tx.select({ reviewId: r.id, factId: r.stagingFactId }).from(r)
    .where(and(eq(r.status, "rejected"), sql`${r.stagingFactId} IS NOT NULL`))
    .orderBy(r.id);
  return rows.map((row) => ({ reviewId: row.reviewId, factId: row.factId! }));
}

export interface RejectedPurgeCounts {
  mode: "dry-run" | "apply";
  /** Rejected reviews that still name a staging fact. */
  matched: number;
  /** Facts purged (apply), or that would be (dry run). */
  purged: number;
  skipped: Record<PurgeSkipReason, number>;
  /** Already gone by the time it was reached: a no-op. */
  gone: number;
  /** Renders and picture files the purged facts held. */
  renders: number;
  files: number;
  /** Apply only: files still on the cleanup list after this run's cleanup (the hourly sweep retries them). */
  filesOutstanding: number;
}

/**
 * The one-time purge of submissions rejected before this release (D7). Run
 * without `apply`, it reports what it matched and skipped, by reason, and the
 * renders and files the qualifying facts hold, and deletes nothing. With
 * `apply`, each is purged in its own transaction under the lock rule (its
 * review, then its fact), so one that changed since the dry run is judged as
 * it stands; a re-run finds nothing.
 */
export async function runRejectedSubmissionPurge(
  opts: { apply: boolean },
  deps: { cleanUp?: (paths: string[]) => Promise<number> } = {},
): Promise<RejectedPurgeCounts> {
  const cleanUp = deps.cleanUp ?? cleanUpQueuedFiles;
  const counts: RejectedPurgeCounts = {
    mode: opts.apply ? "apply" : "dry-run",
    matched: 0, purged: 0, gone: 0, renders: 0, files: 0, filesOutstanding: 0,
    skipped: { approved: 0, open_review: 0, member_content: 0, in_comparison: 0 },
  };
  const candidates = await rejectedReviewsWithStagingFacts(db);
  counts.matched = candidates.length;
  const tally = (outcome: PurgeOutcome) => {
    if (outcome.kind === "gone") counts.gone++;
    else if (outcome.kind === "skipped") counts.skipped[outcome.reason]++;
    else {
      counts.purged++;
      counts.renders += outcome.renders;
      counts.files += outcome.files.length;
    }
  };
  for (const { reviewId, factId } of candidates) {
    if (!opts.apply) {
      const a = await assessRejectedFact(db, factId, { excludeReviewId: reviewId });
      tally(a.outcome === "gone" ? { kind: "gone", factId }
        : a.outcome === "qualifies" ? { kind: "purged", factId, renders: a.renders, files: a.files }
        : { kind: "skipped", factId, reason: a.outcome });
      continue;
    }
    const outcome = await db.transaction(async (tx): Promise<PurgeOutcome> => {
      const review = await lockReview(tx, reviewId);
      // Re-read under the lock: a review no longer rejected, or one that no
      // longer names this fact, is left to whatever changed it.
      if (!review || review.status !== "rejected" || review.stagingFactId !== factId) return { kind: "gone", factId };
      return purgeRejectedFact(tx, factId, { excludeReviewId: reviewId });
    });
    tally(outcome);
    if (outcome.kind === "purged") counts.filesOutstanding += await cleanUp(outcome.files);
  }
  return counts;
}
