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
 * inactive row with an approved gag (e.g. a staging fact parked in `production_review`) go
 * live while skipping the rest of `approveForProduction`. Keep the single-caller
 * invariant intact.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, factsTable, factGagsTable } from "@workspace/db";
import { overrideValuesEqual } from "@workspace/api-zod";

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
 * @param tx                 the enclosing transaction executor
 * @param factId             the staging fact to flip active
 * @param expectedText       the exact wording the production gate validated (CAS guard)
 * @param expectedEnrichment the exact stored enrichment blob the render gate validated
 *   (the RAW value read from the row, not a Zod-normalized copy — pass it
 *   verbatim). When given, activation requires the row's enrichment to still
 *   match it exactly, closing the race where a concurrent edit changes the
 *   Visual Concept between the render gate and this activation — otherwise the
 *   fact would go live with enrichment nobody actually reviewed, while
 *   `pending_reviews.enrichment` records the older, reviewed blob. Optional so
 *   callers with no separately-validated snapshot (e.g. none today, but future
 *   ones) aren't forced to supply it.
 */
export async function activateFact(
  tx: DbExecutor,
  { factId, expectedText, expectedEnrichment }: { factId: number; expectedText: string; expectedEnrichment?: unknown },
): Promise<{ id: number }> {
  // 1. Lock and re-read the row inside the tx, then assert an approved gag.
  // `FOR UPDATE` locks the fact row for the rest of this transaction: without
  // it, a concurrent admin edit to the enrichment could commit between this
  // read and the activation UPDATE below (which never re-checks enrichment,
  // only is_active/text) — the expectedEnrichment comparison would pass
  // against a blob that's no longer what actually gets activated. Locking
  // forces any concurrent writer of this row to wait for this transaction to
  // commit/rollback, so the read, the comparison, and the activation are all
  // atomic with respect to the row's enrichment.
  const [row] = await tx
    .select({ enrichment: factsTable.enrichment })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .for("update")
    .limit(1);
  if (!row || !(await hasApprovedGag(tx, factId))) {
    throw new ConceptMissingError(factId);
  }
  if (expectedEnrichment !== undefined && !overrideValuesEqual(row.enrichment, expectedEnrichment)) {
    throw new ActivationConflictError(factId);
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
