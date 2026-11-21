/**
 * @purpose Publish a fact's draft gag set: one transaction that checks the go-live rule on the draft and makes it the set members are offered.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1F and the Source-of-Truth
 * Analysis (*Which gags a fact offers members*): the fact is the unit of
 * publication. Approving a render records a draft pick and publishes nothing;
 * removing a gag from a live fact changes only the draft; the draft becomes
 * the published set in one step, never gag by gag. Callers: "Approve for
 * production" (routes/reviews.ts) and, from Phase 3, "Publish changes".
 *
 * The caller holds the locks, under the lock rule (lib/reviewLocks.ts):
 * the review first when there is one, then the fact row. This takes the
 * fact's gag rows after them.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, factGagsTable, factGagExamplesTable } from "@workspace/db";
import { checkGoLive, GoLiveError } from "./goLive";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PublishResult {
  /** Gags whose draft change became their published version. */
  published: number;
  /** Published gags the draft removed. */
  removed: number;
  /** Gags already published unchanged. */
  unchanged: number;
}

/**
 * Make the fact's draft its published set. Refuses, changing nothing, unless
 * the draft meets the go-live rule. Must run in the caller's transaction.
 */
export async function publishDraft(tx: Tx, factId: number, adminId: string): Promise<PublishResult> {
  const gags = await tx.select().from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt)))
    .orderBy(asc(factGagsTable.slot))
    .for("update");
  const check = await checkGoLive(factId, "draft", tx, gags);
  if (!check.ok) throw new GoLiveError(check);

  const now = new Date();
  const result: PublishResult = { published: 0, removed: 0, unchanged: 0 };
  const changed = gags.filter((g) => g.pendingContent != null).map((g) => g.id);
  const removed = gags.filter((g) => g.draftRemoved).map((g) => g.id);

  if (removed.length) {
    await tx.update(factGagsTable).set({ removedAt: now, removedBy: adminId, draftRemoved: false, updatedAt: now })
      .where(inArray(factGagsTable.id, removed));
    result.removed = removed.length;
  }
  if (changed.length) {
    await tx.delete(factGagExamplesTable)
      .where(and(inArray(factGagExamplesTable.gagId, changed), eq(factGagExamplesTable.stage, "approved")));
    await tx.update(factGagExamplesTable).set({ stage: "approved" })
      .where(and(inArray(factGagExamplesTable.gagId, changed), eq(factGagExamplesTable.stage, "pending")));
    await tx.update(factGagsTable).set({
      approvedContent: sql`${factGagsTable.pendingContent}`,
      approvedBy: sql`coalesce(${factGagsTable.pendingBy}, ${adminId})`,
      approvedAt: now,
      approvedBeforeExampleSets: false,
      approvedCarriedOver: false,
      pendingContent: null,
      pendingBy: null,
      pendingAt: null,
      updatedAt: now,
    }).where(inArray(factGagsTable.id, changed));
    result.published = changed.length;
  }
  result.unchanged = gags.length - result.published - result.removed;
  return result;
}
