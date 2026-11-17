/**
 * @purpose Who owns a fact's candidate gags: one generation at a time writes them, and opening a review takes them over.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md, increment 2, section F ("one owner per
 * generation"); migration 0140. A fact's candidate gags and their status are
 * written by the gag writer for either a review cycle ('review:<id>') or a
 * Draft more gags request on a live fact ('live:<id>'). Each generation
 * carries its owner, and every write of the fact's candidate state (pending,
 * ok, failed) goes through `ownedFact`, so it lands only while that owner
 * still holds the fact. Opening a review takes ownership, so a live draft
 * that finishes afterwards writes nothing.
 *
 * A leaf module on purpose: moderationStaging and enrichmentJobs call it, and none may import visualConceptJobs (an import
 * cycle).
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";

export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const LIVE_PREFIX = "live:";

export const reviewConceptOwner = (reviewId: number): string => `review:${reviewId}`;
export const liveConceptOwner = (requestId: string): string => `${LIVE_PREFIX}${requestId}`;

/** The WHERE for a write to one fact's candidate state: only while `owner` holds it. */
export function ownedFact(factId: number, owner: string): SQL {
  return and(eq(factsTable.id, factId), eq(factsTable.visualConceptOwner, owner)) as SQL;
}

/** True in SQL while a live draft holds the fact. */
const heldByLiveDraft = sql`${factsTable.visualConceptOwner} LIKE ${`${LIVE_PREFIX}%`}`;

/**
 * A review takes the fact's candidate state, called where its generation is
 * enqueued
 * (`markPending`, which also marks the state working, in the same write). A
 * live draft's state is cleared with it: its candidates were written for the
 * live fact, and a "pending" it left would have no job that could ever finish
 * it. A review's own state is left as it is.
 */
export async function claimConceptsForReview(
  executor: Executor,
  factId: number,
  reviewId: number,
  opts: { markPending?: boolean } = {},
): Promise<void> {
  await executor
    .update(factsTable)
    .set({
      visualConceptOwner: reviewConceptOwner(reviewId),
      visualConceptStatus: opts.markPending
        ? "pending"
        : sql`CASE WHEN ${heldByLiveDraft} THEN NULL ELSE ${factsTable.visualConceptStatus} END`,
      visualConceptCandidates: sql`CASE WHEN ${heldByLiveDraft} THEN NULL ELSE ${factsTable.visualConceptCandidates} END`,
    })
    .where(eq(factsTable.id, factId));
}
