/**
 * @purpose Who owns a fact's candidate gags: one generation at a time writes them, and opening a review takes them over.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md, increment 2, section F ("one owner per
 * generation"); migration 0140. A fact's candidate gags and their status are
 * written by the gag writer for a review cycle ('review:<id>:<generation>').
 * Each generation carries its owner, and every write of the fact's candidate
 * state (pending, ok, failed) goes through `ownedFact`, so it lands only while
 * that owner still holds the fact. (Draft more gags on a live fact, the
 * 'live:<id>' owner, was removed with live gag editing: plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md, increment 1.3; migration 0157.)
 *
 * A leaf module on purpose: moderationStaging and enrichmentJobs call it, and none may import visualConceptJobs (an import
 * cycle).
 */
import { and, eq, type SQL } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";

export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A review's generation owner. Each request for a review's ideas is its own
 * generation (`review:<id>:<generation>`), so a later request is never folded
 * into an earlier job that has already written (Codex, PR #1041 round 1); the
 * bare `review:<id>` is what jobs queued before generations carried.
 */
export const reviewConceptOwner = (reviewId: number, generation?: string): string =>
  generation ? `review:${reviewId}:${generation}` : `review:${reviewId}`;

/** The WHERE for a write to one fact's candidate state: only while `owner` holds it. */
export function ownedFact(factId: number, owner: string): SQL {
  return and(eq(factsTable.id, factId), eq(factsTable.visualConceptOwner, owner)) as SQL;
}

/**
 * A review takes the fact's candidate state, called where its generation is
 * enqueued (`markPending`, which also marks the state working, in the same
 * write). The state itself is left as it is.
 */
export async function claimConceptsForReview(
  executor: Executor,
  factId: number,
  reviewId: number,
  opts: { markPending?: boolean; owner?: string } = {},
): Promise<void> {
  await executor
    .update(factsTable)
    .set({
      visualConceptOwner: opts.owner ?? reviewConceptOwner(reviewId),
      ...(opts.markPending ? { visualConceptStatus: "pending" } : {}),
    })
    .where(eq(factsTable.id, factId));
}
