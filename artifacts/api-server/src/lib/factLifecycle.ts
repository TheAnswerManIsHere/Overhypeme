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
import { db, factsTable, factGagsTable } from "@workspace/db";
import { recordAdminAction } from "./adminActions";
import { clearPendingExamples } from "./gags/examples";
import { checkGoLive, describeGoLive, GoLiveError, type GoLiveCheck } from "./gags/goLive";
import { publishDraft, type PublishResult } from "./gags/publish";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Why a lifecycle action was refused. */
export type FactLifecycleRefusal =
  | { kind: "not_found" }
  | { kind: "no_changes" }
  | { kind: "already"; isActive: boolean }
  | { kind: "go_live"; check: GoLiveCheck; error: string };

export type FactLifecycleResult<T> = { kind: "done"; value: T } | FactLifecycleRefusal;

/** A gag row that differs between the draft and the published set. */
export const gagHasDraftChange = sql`(${factGagsTable.removedAt} IS NULL AND (${factGagsTable.pendingContent} IS NOT NULL OR ${factGagsTable.draftRemoved}))`;

/**
 * SQL: the fact (in an outer query over `facts`) has unpublished gag changes.
 * The outer column is written qualified: as a top-level column of a
 * single-table select, Drizzle renders `${factsTable.id}` as a bare "id"
 * (measured: `select "id", EXISTS (... WHERE g.fact_id = "id" ...) from
 * "facts"`), which inside this subquery binds to fact_gags.id.
 */
export const factHasUnpublishedChanges = sql<boolean>`EXISTS (
  SELECT 1 FROM fact_gags g
  WHERE g.fact_id = "facts"."id" AND g.removed_at IS NULL
    AND (g.pending_content IS NOT NULL OR g.draft_removed)
)`;

/** Whether one fact's draft differs from its published set. */
export async function hasUnpublishedChanges(factId: number, executor: Tx | typeof db = db): Promise<boolean> {
  const [row] = await executor.select({ id: factGagsTable.id }).from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), gagHasDraftChange)).limit(1);
  return row != null;
}

/** Lock an approved fact's row; null when there is no such approved fact. */
async function lockApprovedFact(tx: Tx, factId: number): Promise<{ id: number; isActive: boolean } | null> {
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
