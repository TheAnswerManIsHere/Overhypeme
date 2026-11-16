/**
 * @purpose A gag's examples per subject kind: loading them, recording a moderator's pick, and completing a set, which applies the gag's change.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_GAG_EXAMPLES.md, sections A and B (David, 2026-11-15,
 * Q8 and Q11; migration 0143). A gag's examples live in `fact_gag_examples`,
 * one per kind (male, female, pet) per stage:
 *   - approved rows belong to the approved version users get;
 *   - pending rows are picks for the content being worked on.
 * Outside a refresh, the third pending pick applies the change: the pending
 * content becomes the approved version and its picks the approved set, in
 * the caller's transaction. Inside a refresh, picks wait for promotion.
 *
 * A gag with no pending change that gets picks (a grandfathered gag gaining
 * its set, or an approved gag re-picking an example) records them straight
 * into its approved set: the content is the approved content already, so
 * nothing users get changes except the example shown.
 *
 * The database enforces the set at commit (`enforce_gag_example_set`): every
 * function here runs inside a transaction that holds the fact and gag locks.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, factGagsTable, factGagExamplesTable, type FactGag, type FactGagExample } from "@workspace/db";
import { isCompleteSet, mapKinds, type GagExampleKind, type PerKind } from "@workspace/api-zod";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type ExampleStage = "approved" | "pending";

/** A gag's examples by stage and kind. */
export interface GagExamples {
  approved: PerKind<FactGagExample | null>;
  pending: PerKind<FactGagExample | null>;
}

export function emptyExamples(): GagExamples {
  return { approved: mapKinds(() => null), pending: mapKinds(() => null) };
}

/** A gag approved before example sets (migration 0143's marker, or carried over by 0139): offered without a complete set (Q11). */
export function isGrandfathered(gag: Pick<FactGag, "approvedBeforeExampleSets" | "approvedCarriedOver">): boolean {
  return gag.approvedBeforeExampleSets || gag.approvedCarriedOver;
}

/** Load the examples of several gags at once. */
export async function loadExamples(gagIds: number[], executor: Executor = db): Promise<Map<number, GagExamples>> {
  const out = new Map<number, GagExamples>();
  if (gagIds.length === 0) return out;
  const rows = await executor.select().from(factGagExamplesTable).where(inArray(factGagExamplesTable.gagId, gagIds));
  for (const r of rows) {
    const entry = out.get(r.gagId) ?? emptyExamples();
    entry[r.stage as ExampleStage][r.subjectKind as GagExampleKind] = r;
    out.set(r.gagId, entry);
  }
  return out;
}

/** One gag's examples (empty sets when it has none). */
export async function loadGagExamples(gagId: number, executor: Executor = db): Promise<GagExamples> {
  return (await loadExamples([gagId], executor)).get(gagId) ?? emptyExamples();
}

/** A gag's examples from a batch `loadExamples` read (empty sets when it has none). */
export function examplesFor(map: Map<number, GagExamples>, gagId: number): GagExamples {
  return map.get(gagId) ?? emptyExamples();
}

/** Record one example, replacing any for the same gag, kind and stage. */
export async function putExample(tx: Tx, gagId: number, kind: GagExampleKind, stage: ExampleStage, attemptId: number, adminId: string): Promise<void> {
  await tx.delete(factGagExamplesTable).where(and(
    eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.subjectKind, kind), eq(factGagExamplesTable.stage, stage),
  ));
  await tx.insert(factGagExamplesTable).values({ gagId, subjectKind: kind, stage, attemptId, approvedBy: adminId });
}

/** Drop every pending pick of a gag: its content changed, or its change was discarded or declined. */
export async function clearPendingExamples(tx: Tx, gagIds: number[]): Promise<void> {
  if (gagIds.length === 0) return;
  await tx.delete(factGagExamplesTable).where(and(inArray(factGagExamplesTable.gagId, gagIds), eq(factGagExamplesTable.stage, "pending")));
}

/**
 * Apply a gag's change once its pending picks form a complete set: the pending
 * content becomes the approved version, the picks become the approved set,
 * the old approved examples go, and the gag is no longer grandfathered.
 * Returns the updated gag, or null when the set is not complete yet.
 */
export async function applyPendingSetIfComplete(tx: Tx, gag: FactGag, adminId: string): Promise<FactGag | null> {
  if (gag.pendingContent == null) return null;
  const examples = await loadGagExamples(gag.id, tx);
  if (!isCompleteSet(examples.pending)) return null;
  await tx.delete(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gag.id), eq(factGagExamplesTable.stage, "approved")));
  await tx.update(factGagExamplesTable).set({ stage: "approved" })
    .where(and(eq(factGagExamplesTable.gagId, gag.id), eq(factGagExamplesTable.stage, "pending")));
  const now = new Date();
  const [updated] = await tx.update(factGagsTable).set({
    approvedContent: gag.pendingContent,
    approvedBeforeExampleSets: false,
    approvedCarriedOver: false,
    approvedBy: gag.pendingBy ?? adminId,
    approvedAt: now,
    pendingContent: null,
    pendingRemove: false,
    pendingReviewId: null,
    pendingBy: null,
    pendingAt: null,
    updatedAt: now,
  }).where(eq(factGagsTable.id, gag.id)).returning();
  return updated!;
}

/**
 * A grandfathered gag whose approved set has just become complete leaves the
 * grandfathered state (Q11: it lasts until the gag's first complete set).
 */
export async function endGrandfatheringIfComplete(tx: Tx, gag: FactGag): Promise<FactGag> {
  if (!isGrandfathered(gag)) return gag;
  const examples = await loadGagExamples(gag.id, tx);
  if (!isCompleteSet(examples.approved)) return gag;
  const [updated] = await tx.update(factGagsTable).set({ approvedBeforeExampleSets: false, approvedCarriedOver: false, updatedAt: new Date() })
    .where(eq(factGagsTable.id, gag.id)).returning();
  return updated!;
}
