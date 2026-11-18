/**
 * The SINGLE `is_active = false → true` writer (Phase 2 fact-lifecycle closure).
 *
 * A fact may only become active by passing through `activateFact`, and
 * `activateFact` is called from exactly ONE place: `approveForProduction` in
 * routes/reviews.ts, whose surrounding logic enforces the rest of the production
 * gate (render-waiver checks, the `pending_reviews` transition, production-approval
 * recording, submitter notification). This helper is the last-line, in-transaction
 * assertion of the invariant that must hold at the instant of activation: an
 * approved gag — the fact has a non-removed gag with an approved version in
 * `fact_gags` (since migration 0139; plan docs/plans/PLAN_THREE_GAGS.md),
 * re-read inside the activating transaction after the fact row is locked, so a
 * concurrent gag change can't race the pre-flight check (and mirrored by the
 * deferred trigger `enforce_live_fact_has_approved_gag`, which holds against raw
 * SQL too).
 *
 * It is deliberately NOT a standalone activation API: on its own it would let any
 * inactive row with an approved gag (e.g. a staging fact parked in `test_renders`) go
 * live while skipping the rest of `approveForProduction`. Keep the single-caller
 * invariant intact.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, factsTable, factGagsTable } from "@workspace/db";
import { lockFactRow } from "./reviewLocks";

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The fact has no approved gag at activation time. */
export class ConceptMissingError extends Error {
  constructor(public readonly factId: number) {
    super(`Fact #${factId} cannot be activated without an approved gag.`);
    this.name = "ConceptMissingError";
  }
}

/**
 * The compare-and-set activation lost: the fact was no longer inactive, its text
 * had changed from `expectedText`, or the row vanished. Fails CLOSED — nothing was
 * activated. The caller maps this to its "fact text changed during approval" 409.
 */
export class ActivationConflictError extends Error {
  constructor(public readonly factId: number) {
    super(`Activation of fact #${factId} lost the compare-and-set (row changed concurrently).`);
    this.name = "ActivationConflictError";
  }
}

/** Whether the fact has a non-removed gag with an approved version. Call with the fact row locked. */
export async function hasApprovedGag(tx: DbExecutor, factId: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: factGagsTable.id })
    .from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt), sql`${factGagsTable.approvedContent} IS NOT NULL`))
    .limit(1);
  return !!row;
}

/**
 * Activate a prepared, inactive staging fact. MUST run inside the caller's
 * transaction (`tx`) so the gag re-read and the compare-and-set are atomic.
 * Throws `ConceptMissingError` / `ActivationConflictError` — never activates on
 * any failure.
 *
 * @param tx           the enclosing transaction executor
 * @param factId       the staging fact to flip active
 * @param expectedText the exact wording the production gate validated (CAS guard)
 *
 * The fact row is locked FOR NO KEY UPDATE (the lock rule, lib/reviewLocks.ts):
 * a caller acting for a review has locked the review first.
 */
export async function activateFact(
  tx: DbExecutor,
  { factId, expectedText }: { factId: number; expectedText: string },
): Promise<{ id: number }> {
  // 1. Lock the row inside the tx, then assert an approved gag.
  const row = await lockFactRow(tx, factId);
  if (!row || !(await hasApprovedGag(tx, factId))) {
    throw new ConceptMissingError(factId);
  }

  // 2. Compare-and-set activation: only while still inactive AND still the exact
  //    validated wording. Either mismatch fails closed.
  const activated = await tx
    .update(factsTable)
    .set({ isActive: true })
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, false), eq(factsTable.text, expectedText)))
    .returning({ id: factsTable.id });
  if (activated.length === 0) {
    throw new ActivationConflictError(factId);
  }
  return activated[0];
}

/**
 * Record that a fact was approved for production, by whom and when (plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md, Source-of-Truth Analysis). The first approval
 * is the one on record: a fact already approved keeps it, so a later
 * activation never rewrites who approved it.
 */
export async function recordFirstApproval(tx: DbExecutor, factId: number, approvedById: string): Promise<void> {
  await tx
    .update(factsTable)
    .set({ approvedAt: sql`now()`, approvedById, approvalSource: "moderator" })
    .where(and(eq(factsTable.id, factId), isNull(factsTable.approvedAt)));
}
