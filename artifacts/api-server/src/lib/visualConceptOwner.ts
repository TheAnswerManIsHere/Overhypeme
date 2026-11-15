/**
 * @purpose Who owns a fact's candidate gags: one generation at a time writes them, and opening a review takes them over.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md, increment 2, section F ("one owner per
 * generation"); migration 0140. A fact's candidate gags and their status are
 * written by the gag writer for either a review cycle ('review:<id>') or a
 * Draft more gags request on a live fact ('live:<id>'). Each generation
 * carries its owner, and success, failure and abandonment change the fact's
 * candidate state only while that owner still holds it. Opening a review
 * takes ownership, so a live draft that finishes afterwards writes nothing.
 *
 * A leaf module on purpose: moderationStaging and sendBackToReview call it,
 * and neither may import visualConceptJobs (an import cycle).
 */
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const reviewConceptOwner = (reviewId: number): string => `review:${reviewId}`;
export const liveConceptOwner = (requestId: string): string => `live:${requestId}`;
export const isLiveConceptOwner = (owner: string): boolean => owner.startsWith("live:");

/**
 * The condition under which `owner` may write a fact's candidate state: it
 * holds the fact. A review cycle's generation may also write a fact no
 * generation has claimed (null: every fact before migration 0140), since
 * that is what it did before owners existed; a live draft never may.
 */
export function conceptOwnerHolds(owner: string): SQL {
  const held = eq(factsTable.visualConceptOwner, owner);
  return isLiveConceptOwner(owner) ? held : (or(held, isNull(factsTable.visualConceptOwner)) as SQL);
}

/** The WHERE for a guarded write to one fact's candidate state. */
export function ownedFact(factId: number, owner: string): SQL {
  return and(eq(factsTable.id, factId), conceptOwnerHolds(owner)) as SQL;
}

/**
 * A review takes the fact's candidate state, called where the review is
 * created (a refresh, a resubmission) and where its generation is enqueued.
 * A live draft's state is cleared with it: its candidates were written for
 * the live fact, and a "pending" it left would have no job that could ever
 * finish it. A review's own state is left as it is.
 */
export async function claimConceptsForReview(executor: Executor, factId: number, reviewId: number): Promise<void> {
  await executor
    .update(factsTable)
    .set({
      visualConceptOwner: reviewConceptOwner(reviewId),
      visualConceptStatus: sql`CASE WHEN ${factsTable.visualConceptOwner} LIKE 'live:%' THEN NULL ELSE ${factsTable.visualConceptStatus} END`,
      visualConceptCandidates: sql`CASE WHEN ${factsTable.visualConceptOwner} LIKE 'live:%' THEN NULL ELSE ${factsTable.visualConceptCandidates} END`,
    })
    .where(eq(factsTable.id, factId));
}
