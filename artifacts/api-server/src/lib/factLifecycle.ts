/**
 * @purpose An approved fact's lifecycle actions on the Facts page: Publish changes, Discard changes, Deactivate and Reactivate — each one transaction, each recorded.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 3B and oracle items 12, 14
 * and 21. A live fact's gags and examples change only through its draft (the
 * working copy members never see), which "Publish changes" swaps in under the
 * go-live rule (lib/gags/publish.ts) and "Discard changes" throws away.
 * Deactivate is the normal removal; Reactivate is allowed only when the
 * published set meets the go-live rule. A fact deactivated with unpublished
 * changes keeps them.
 *
 * Only an approved fact is acted on here (`approvedFact`, lib/factAttention.ts):
 * a fact in moderation is worked on from its review. Locks follow the lock rule
 * (lib/reviewLocks.ts): the fact row, then its gag rows.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, factsTable, factGagsTable, factHashtagsTable, memesTable, userAiImagesTable, commentsTable } from "@workspace/db";
import { detachHashtags } from "./factHashtags";
import { recordAdminAction } from "./adminActions";
import type { Executor } from "./visualConceptOwner";
import { clearPendingExamples } from "./gags/examples";
import { checkGoLive, describeGoLive, GoLiveError, type GoLiveCheck } from "./gags/goLive";
import { publishDraft, type PublishResult } from "./gags/publish";
import { unsettledPicturesOnFact } from "./memberPictures/settlement";


/** Why a lifecycle action was refused. */
export type FactLifecycleRefusal =
  | { kind: "not_found" }
  | { kind: "no_changes" }
  | { kind: "already"; isActive: boolean }
  | { kind: "go_live"; check: GoLiveCheck; error: string }
  | { kind: "still_live" }
  | { kind: "attached"; attached: AttachedContent };

export type FactLifecycleResult<T> = { kind: "done"; value: T } | FactLifecycleRefusal;

/** A gag row that differs between the draft and the published set: one definition, used by both forms below. */
export const gagHasDraftChange = sql`(${factGagsTable.removedAt} IS NULL AND (${factGagsTable.pendingContent} IS NOT NULL OR ${factGagsTable.draftRemoved}))`;

/**
 * SQL: the fact (in an outer query over `facts`) has unpublished gag changes.
 * The EXISTS is wrapped in a second fragment on purpose: as a bare top-level
 * column of a single-table select, Drizzle renders column references
 * unqualified (measured: `select "id", EXISTS (... WHERE "fact_id" = "id" ...)
 * from "facts"`), so the outer "id" would bind to fact_gags.id; nested, it
 * renders `"fact_gags"."fact_id" = "facts"."id"`.
 */
export const factHasUnpublishedChanges = sql<boolean>`(${sql`EXISTS (
  SELECT 1 FROM ${factGagsTable}
  WHERE ${factGagsTable.factId} = ${factsTable.id} AND ${gagHasDraftChange}
)`})`;

/** Whether one fact's draft differs from its published set. */
export async function hasUnpublishedChanges(factId: number, executor: Executor = db): Promise<boolean> {
  const [row] = await executor.select({ id: factGagsTable.id }).from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), gagHasDraftChange)).limit(1);
  return row != null;
}

/** Lock an approved fact's row; null when there is no such approved fact. */
async function lockApprovedFact(tx: Executor, factId: number): Promise<{ id: number; isActive: boolean } | null> {
  const [fact] = await tx.select({ id: factsTable.id, isActive: factsTable.isActive, approvedAt: factsTable.approvedAt })
    .from(factsTable).where(eq(factsTable.id, factId)).for("no key update").limit(1);
  if (!fact || fact.approvedAt == null) return null;
  return { id: fact.id, isActive: fact.isActive };
}

/**
 * Publish changes: the draft becomes the set members are offered, refused
 * (changing nothing) unless the draft meets the go-live rule.
 */
export async function publishFactChanges(factId: number, adminId: string): Promise<FactLifecycleResult<PublishResult>> {
  try {
    return await db.transaction(async (tx) => {
      const fact = await lockApprovedFact(tx, factId);
      if (!fact) return { kind: "not_found" } as const;
      if (!(await hasUnpublishedChanges(factId, tx))) return { kind: "no_changes" } as const;
      const result = await publishDraft(tx, factId, adminId);
      await recordAdminAction({ factId }, adminId, "publish", { ...result }, tx);
      return { kind: "done", value: result } as const;
    });
  } catch (err) {
    if (err instanceof GoLiveError) return { kind: "go_live", check: err.check, error: err.message };
    throw err;
  }
}

export interface DiscardResult {
  /** Published gags returned to their published version. */
  reverted: number;
  /** Gags that had never been published, removed. */
  removed: number;
}

/**
 * Discard changes: every gag returns to its published version, with its
 * published examples; a gag that was never published is removed. What was done
 * to the draft stays in the fact's history.
 */
export async function discardFactChanges(factId: number, adminId: string): Promise<FactLifecycleResult<DiscardResult>> {
  return db.transaction(async (tx) => {
    const fact = await lockApprovedFact(tx, factId);
    if (!fact) return { kind: "not_found" } as const;
    const gags = await tx.select().from(factGagsTable)
      .where(and(eq(factGagsTable.factId, factId), gagHasDraftChange))
      .for("update");
    if (gags.length === 0) return { kind: "no_changes" } as const;

    const now = new Date();
    const neverPublished = gags.filter((g) => g.approvedContent == null).map((g) => g.id);
    const reverted = gags.filter((g) => g.approvedContent != null).map((g) => g.id);
    await clearPendingExamples(tx, gags.map((g) => g.id));
    if (neverPublished.length) {
      await tx.update(factGagsTable).set({ removedAt: now, removedBy: adminId, pendingContent: null, pendingBy: null, pendingAt: null, updatedAt: now })
        .where(inArray(factGagsTable.id, neverPublished));
    }
    if (reverted.length) {
      await tx.update(factGagsTable).set({ draftRemoved: false, pendingContent: null, pendingBy: null, pendingAt: null, updatedAt: now })
        .where(inArray(factGagsTable.id, reverted));
    }
    const value: DiscardResult = { reverted: reverted.length, removed: neverPublished.length };
    await recordAdminAction({ factId }, adminId, "discard", { ...value }, tx);
    return { kind: "done", value } as const;
  });
}

/** Deactivate: off the site. Unpublished changes are kept. */
export async function deactivateFact(factId: number, adminId: string): Promise<FactLifecycleResult<{ isActive: false }>> {
  return db.transaction(async (tx) => {
    const fact = await lockApprovedFact(tx, factId);
    if (!fact) return { kind: "not_found" } as const;
    if (!fact.isActive) return { kind: "already", isActive: false } as const;
    await tx.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, factId));
    await recordAdminAction({ factId }, adminId, "deactivate", {}, tx);
    return { kind: "done", value: { isActive: false } } as const;
  });
}

/**
 * Reactivate: back on the site, only when the published set meets the go-live
 * rule (oracle item 12). Unpublished changes stay unpublished.
 */
export async function reactivateFact(factId: number, adminId: string): Promise<FactLifecycleResult<{ isActive: true }>> {
  return db.transaction(async (tx) => {
    const fact = await lockApprovedFact(tx, factId);
    if (!fact) return { kind: "not_found" } as const;
    if (fact.isActive) return { kind: "already", isActive: true } as const;
    const gags = await tx.select().from(factGagsTable)
      .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt)))
      .for("share");
    const check = await checkGoLive(factId, "published", tx, gags);
    if (!check.ok) return { kind: "go_live", check, error: describeGoLive(check) } as const;
    await tx.update(factsTable).set({ isActive: true }).where(eq(factsTable.id, factId));
    await recordAdminAction({ factId }, adminId, "reactivate", {}, tx);
    return { kind: "done", value: { isActive: true } } as const;
  });
}

/** Members' content attached to a fact: what a permanent delete would destroy. */
export interface AttachedContent {
  memes: number;
  aiPictures: number;
  comments: number;
}

/**
 * What members have attached to a fact: every meme, AI picture and comment
 * row, whatever a comment's review status, and every member picture still
 * owed its outcome (its credit spent, neither delivered nor returned). One definition, read by the delete
 * and by the fact sheet, so the sheet offers the delete exactly when the
 * server would allow it. (The public comment counter counts approved comments
 * only, so it cannot be this.)
 */
export async function attachedContent(factId: number, executor: Executor = db): Promise<AttachedContent> {
  const [[memes], [aiPictures], [comments], inFlight] = await Promise.all([
    executor.select({ n: sql<number>`count(*)::int` }).from(memesTable).where(eq(memesTable.factId, factId)),
    executor.select({ n: sql<number>`count(*)::int` }).from(userAiImagesTable).where(eq(userAiImagesTable.factId, factId)),
    executor.select({ n: sql<number>`count(*)::int` }).from(commentsTable).where(eq(commentsTable.factId, factId)),
    // A member's picture still owed an outcome (its credit spent, neither
    // delivered nor returned) counts as an attached AI picture: deleting the
    // fact would delete it and strand the credit (Codex review, PR #1300).
    unsettledPicturesOnFact(factId, executor),
  ]);
  return { memes: memes?.n ?? 0, aiPictures: (aiPictures?.n ?? 0) + inFlight, comments: comments?.n ?? 0 };
}

/**
 * Permanent delete (plan 3B, oracle item 21): refused while any member's meme,
 * AI picture or comment is attached, naming the counts, and offered only for a
 * deactivated fact, so a delete is never the first removal.
 *
 * The check and the delete are one protected operation. The fact row is taken
 * `FOR UPDATE`; inserting a meme, AI picture or comment takes `FOR KEY SHARE`
 * on the fact row through its foreign key, and the two conflict. So a member
 * attaching content at the same moment either committed first, and the count
 * sees it, or waits for this transaction and then fails on the deleted fact.
 * The foreign keys cascade, so a count followed by a delete outside one
 * transaction would not keep the promise.
 *
 * The record is written before the row goes, with the fact's id and wording in
 * its detail: the delete nulls the record's fact reference.
 */
export async function deleteFact(factId: number, adminId: string): Promise<FactLifecycleResult<{ deleted: true }>> {
  return db.transaction(async (tx) => {
    const [fact] = await tx.select({ id: factsTable.id, isActive: factsTable.isActive, approvedAt: factsTable.approvedAt, text: factsTable.text })
      .from(factsTable).where(eq(factsTable.id, factId)).for("update").limit(1);
    if (!fact || fact.approvedAt == null) return { kind: "not_found" } as const;
    if (fact.isActive) return { kind: "still_live" } as const;
    const attached = await attachedContent(factId, tx);
    if (attached.memes + attached.aiPictures + attached.comments > 0) return { kind: "attached", attached } as const;
    await recordAdminAction({ factId }, adminId, "delete", { factId, text: fact.text }, tx);
    // The join rows would go by cascade, which skips each hashtag's fact count;
    // detaching first lowers the counts through their one writer.
    const tags = await tx.select({ id: factHashtagsTable.hashtagId }).from(factHashtagsTable).where(eq(factHashtagsTable.factId, factId));
    await detachHashtags(tx, factId, tags.map((t) => t.id));
    await tx.delete(factsTable).where(eq(factsTable.id, factId));
    return { kind: "done", value: { deleted: true } } as const;
  });
}
