/**
 * The SINGLE `is_active = false → true` writer (Phase 2 fact-lifecycle closure).
 *
 * A fact may only become active by passing through `activateFact`, and
 * `activateFact` is called from exactly ONE place: `approveForProduction` in
 * routes/reviews.ts, whose surrounding logic enforces the rest of the production
 * gate (render-waiver checks, the `pending_reviews` transition, production-approval
 * recording, submitter notification). This helper is the last-line, in-transaction
 * assertion of the two invariants that must hold at the instant of activation:
 *
 *   1. Concept present — the fact carries a non-empty Visual Concept
 *      (`enrichment.visualPromptStrategyOverride.coreSceneOverride`), re-read
 *      inside the activating transaction so a concurrent edit can't race the
 *      pre-flight check (and mirrored by the DB CHECK `facts_active_requires_concept`).
 *   2. Parent is an active root — when activating a VARIANT, its parent is re-read
 *      in the same transaction and must still be an active root
 *      (`is_active = true AND parent_id IS NULL`); otherwise a variant could go
 *      live stranded under an inactive/orphaned root (the TOCTOU gap where the
 *      caller trusted a stale `stagingFact.parentId`).
 *
 * It is deliberately NOT a standalone activation API: on its own it would let any
 * concept-bearing inactive row (e.g. a staging fact parked in `concept_review`) go
 * live while skipping the rest of `approveForProduction`. Keep the single-caller
 * invariant intact.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";
import type { FactEnrichment } from "@workspace/api-zod";

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The fact has no non-empty Visual Concept at activation time. */
export class ConceptMissingError extends Error {
  constructor(public readonly factId: number) {
    super(`Fact #${factId} cannot be activated without a non-empty Visual Concept.`);
    this.name = "ConceptMissingError";
  }
}

/** A variant's carried parent is missing, inactive, or not a root at activation. */
export class ParentNotActiveError extends Error {
  constructor(public readonly parentId: number) {
    super(`Parent fact #${parentId} is not an active root — variant cannot be activated under it.`);
    this.name = "ParentNotActiveError";
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

/** Non-empty (trimmed) Visual Concept scene, or null. */
function coreScene(enrichment: unknown): string | null {
  const scene = (enrichment as FactEnrichment | null)?.visualPromptStrategyOverride?.coreSceneOverride;
  const trimmed = typeof scene === "string" ? scene.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Activate a prepared, inactive staging fact. MUST run inside the caller's
 * transaction (`tx`) so the concept/parent re-reads and the compare-and-set are
 * atomic. Throws `ConceptMissingError` / `ParentNotActiveError` /
 * `ActivationConflictError` — never activates on any failure.
 *
 * @param tx           the enclosing transaction executor
 * @param factId       the staging fact to flip active
 * @param parentId     the variant parent to record + revalidate, or null/undefined for a root
 * @param expectedText the exact wording the production gate validated (CAS guard)
 */
export async function activateFact(
  tx: DbExecutor,
  { factId, parentId, expectedText }: { factId: number; parentId?: number | null; expectedText: string },
): Promise<{ id: number }> {
  // 1. Re-read the row inside the tx and assert the concept is still present.
  const [row] = await tx
    .select({ enrichment: factsTable.enrichment })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!row || coreScene(row.enrichment) == null) {
    throw new ConceptMissingError(factId);
  }

  // 2. Variant parent revalidation — must still be an ACTIVE ROOT at commit time.
  if (parentId != null) {
    const [parent] = await tx
      .select({ id: factsTable.id })
      .from(factsTable)
      .where(and(eq(factsTable.id, parentId), eq(factsTable.isActive, true), isNull(factsTable.parentId)))
      .limit(1);
    if (!parent) {
      throw new ParentNotActiveError(parentId);
    }
  }

  // 3. Compare-and-set activation: only while still inactive AND still the exact
  //    validated wording. Either mismatch fails closed.
  const activated = await tx
    .update(factsTable)
    .set({ isActive: true, parentId: parentId ?? null })
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, false), eq(factsTable.text, expectedText)))
    .returning({ id: factsTable.id });
  if (activated.length === 0) {
    throw new ActivationConflictError(factId);
  }
  return activated[0];
}
