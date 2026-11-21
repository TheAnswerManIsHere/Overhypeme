/**
 * @purpose A gag's examples per subject kind: loading them, recording a moderator's draft pick, and opening a published gag's draft examples.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_GAG_EXAMPLES.md, sections A and B (David, 2026-11-15,
 * Q8 and Q11; migration 0143). A gag's examples live in `fact_gag_examples`,
 * one per kind (male, female, pet) per stage:
 *   - approved rows belong to the approved version users get;
 *   - pending rows are picks for the content being worked on.
 * The stages are the fact's two sets (migration 0157): approved rows are the
 * published set's examples, pending rows the draft's. A pick is always a
 * draft pick; only a publish (./publish.ts) turns picks into published
 * examples.
 *
 * The database enforces the set at commit (`enforce_gag_example_set`): every
 * function here runs inside a transaction that holds the fact and gag locks.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, factGagsTable, factGagExamplesTable, type FactGag, type FactGagExample } from "@workspace/db";
import { mapKinds, type GagExampleKind, type PerKind } from "@workspace/api-zod";

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
 * Open a published gag's draft examples: copy its published examples into the
 * draft, replacing any draft picks. Used when a published gag unchanged in
 * the draft gets its first draft change that keeps its content (a re-picked
 * example), so the draft holds its whole set.
 */
export async function copyPublishedExamplesToDraft(tx: Tx, gagId: number): Promise<void> {
  await clearPendingExamples(tx, [gagId]);
  await tx.execute(sql`
    INSERT INTO fact_gag_examples (gag_id, subject_kind, stage, attempt_id, approved_by)
    SELECT gag_id, subject_kind, 'pending', attempt_id, approved_by
      FROM fact_gag_examples WHERE gag_id = ${gagId} AND stage = 'approved'`);
}
