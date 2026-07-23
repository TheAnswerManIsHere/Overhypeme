/**
 * Approved-fact-text lock — the one transactional service behind the text half
 * of PATCH /admin/facts/:id (Plan v4 §A/§B/§C/§G/§V). All text-write policy
 * lives here so the route stays a thin HTTP mapper.
 *
 * Flow (single fact-row lock):
 *   1. length + grammar validation (pre-transaction, cheap).
 *   2. lock the fact; compare NORMALIZED proposed text to the LOCKED stored
 *      text — a normalization-equivalent proposal is a NO-OP (non-text deltas
 *      still apply). This is why request-field presence is never the signal.
 *   3. resolve protection from the locked row + review history.
 *   4. PROTECTED branch → require the phrase+reason+expected-hash confirmation;
 *      block if a direct variant is mid-cycle; write text, clear the fact's +
 *      its direct variants' signatures, PRESERVE enrichment, insert one audit
 *      row — all atomically.
 *   5. STAGING branch (single first-time cycle) → no confirmation/audit; reject
 *      if prep is durably in flight; write text, clear signature, set
 *      enrichmentStatus=pending, move the review to prep_pending, then ensure
 *      fresh prep jobs after commit.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, factTextEditHistoryTable, memesTable } from "@workspace/db/schema";
import {
  confirmTextEditSchema,
  FACT_TEXT_MAX_CHARS,
  type ApprovedFactTextEditImpact,
  type BlockingVariant,
  type FactTextProtectionReason,
  type PrepDispatchState,
} from "@workspace/api-zod";
import { normalizeFactTemplateForStorage } from "./normalizeFactTemplateForStorage";
import { hashFactText, findInFlightRefreshCandidate } from "./enrichmentVersioning";
import {
  resolveFactTextProtection,
  loadDirectVariantDependencies,
  hasNonterminalPrepJobs,
} from "./factTextEditProtection";
import { prepareFirstTimeStagingPrep, ensureFirstTimeStagingPrepJobs } from "./firstTimeStagingPrep";
import { cascadeDeactivateActiveChildren } from "./factActivation";

type FactRow = typeof factsTable.$inferSelect;
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type FactTextEditOutcome =
  | { kind: "not_found" }
  | { kind: "too_long"; message: string }
  | { kind: "grammar_invalid"; message: string }
  | { kind: "no_text_change"; fact: FactRow }
  | { kind: "confirmation_required"; impact: ApprovedFactTextEditImpact }
  | { kind: "stale_baseline"; impact: ApprovedFactTextEditImpact }
  | { kind: "invalid_confirmation"; message: string }
  | { kind: "dependent_variant_in_progress"; blockingVariants: BlockingVariant[]; affectedVariantCount: number }
  | { kind: "staging_prep_in_progress" }
  | { kind: "protected_committed"; fact: FactRow; auditRowId: number; affectedVariantCount: number }
  | { kind: "staging_restarted"; fact: FactRow; prepDispatch: PrepDispatchState };

export interface ConfirmedFactTextEditArgs {
  factId: number;
  rawText: string;
  /** The raw `confirmTextEdit` envelope from the request body (unvalidated). */
  confirmation?: unknown;
  performedBy: string | null;
  /** Already-coerced non-text column updates (upvotes, score, useCase, …) to
   *  apply in the same write. Omit `text`/`canonicalText`/`splitTokenIndex`. */
  nonTextUpdates: Record<string, unknown>;
}

async function countMemes(factId: number, tx: DbTx): Promise<{ persisted: number; live: number }> {
  const [[persisted], [live]] = await Promise.all([
    tx.select({ n: sql<number>`count(*)::int` }).from(memesTable).where(eq(memesTable.factId, factId)),
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(memesTable)
      .where(and(eq(memesTable.factId, factId), isNull(memesTable.deletedAt), eq(memesTable.status, "live"))),
  ]);
  return { persisted: persisted?.n ?? 0, live: live?.n ?? 0 };
}

async function buildImpact(
  fact: FactRow,
  normalizedProposedText: string,
  protectionReason: FactTextProtectionReason,
  tx: DbTx,
): Promise<ApprovedFactTextEditImpact> {
  const isRoot = fact.parentId === null;
  const memes = await countMemes(fact.id, tx);
  const refresh = await findInFlightRefreshCandidate(fact.id, tx);
  let affectedVariantCount = 0;
  let blockingVariants: BlockingVariant[] = [];
  if (isRoot) {
    const dep = await loadDirectVariantDependencies(fact.id, tx);
    affectedVariantCount = dep.childFactIds.length;
    blockingVariants = dep.blockingChildren;
  }
  return {
    protected: true,
    protectionReason,
    currentStoredText: fact.text,
    normalizedProposedText,
    expectedOldTextHash: hashFactText(fact.text),
    isRoot,
    affectedVariantCount,
    blockingVariants,
    persistedMemeCount: memes.persisted,
    liveMemeCount: memes.live,
    refreshInFlight: refresh != null,
  };
}

export async function confirmedFactTextEdit(args: ConfirmedFactTextEditArgs): Promise<FactTextEditOutcome> {
  // 1. Cheap pre-transaction validation.
  if (args.rawText.length > FACT_TEXT_MAX_CHARS) {
    return { kind: "too_long", message: `Fact text exceeds the ${FACT_TEXT_MAX_CHARS}-character limit.` };
  }
  const normalized = normalizeFactTemplateForStorage(args.rawText);
  if (!normalized.valid) {
    return { kind: "grammar_invalid", message: `Template grammar validation failed: ${normalized.grammarResult.error}` };
  }
  const proposed = normalized.text;

  const committed = await db.transaction(async (tx): Promise<FactTextEditOutcome> => {
    // 2. Lock the fact row; compare normalized-proposed vs locked-stored text.
    const [fact] = await tx.select().from(factsTable).where(eq(factsTable.id, args.factId)).for("update").limit(1);
    if (!fact) return { kind: "not_found" };

    const textColumns = {
      text: normalized.text,
      canonicalText: normalized.canonicalText,
      splitTokenIndex: normalized.splitTokenIndex,
      hasPronouns: normalized.hasPronouns,
    };

    if (proposed === fact.text) {
      // NO-OP text: apply only the non-text deltas (if any), no confirmation /
      // audit / signature clear / prep restart / side effects.
      if (Object.keys(args.nonTextUpdates).length > 0) {
        const [updated] = await tx.update(factsTable).set(args.nonTextUpdates).where(eq(factsTable.id, fact.id)).returning();
        // The admin editor combines text + Active-toggle edits in one PATCH, so a
        // deactivation can arrive here via nonTextUpdates — cascade the same as
        // the direct PATCH path (no-op if there's nothing to cascade).
        if (args.nonTextUpdates.isActive === false) {
          await cascadeDeactivateActiveChildren(tx, fact.id);
        }
        return { kind: "no_text_change", fact: updated! };
      }
      return { kind: "no_text_change", fact };
    }

    const protection = await resolveFactTextProtection(fact.id, fact.isActive, tx);
    const isRoot = fact.parentId === null;

    // ── PROTECTED branch ────────────────────────────────────────────────────
    if (protection.protected) {
      // Confirmation gate.
      if (args.confirmation == null) {
        return { kind: "confirmation_required", impact: await buildImpact(fact, proposed, protection.reason, tx) };
      }
      const parsed = confirmTextEditSchema.safeParse(args.confirmation);
      if (!parsed.success) {
        return { kind: "invalid_confirmation", message: "Type the exact phrase and a reason (10–2000 chars) to confirm." };
      }
      if (parsed.data.expectedOldTextHash !== hashFactText(fact.text)) {
        // Someone changed the wording since the modal opened — force a re-review.
        return { kind: "stale_baseline", impact: await buildImpact(fact, proposed, protection.reason, tx) };
      }

      // Root dependency: block (don't strand) a re-word while a variant is mid-cycle.
      let affectedVariantCount = 0;
      if (isRoot) {
        const dep = await loadDirectVariantDependencies(fact.id, tx);
        if (dep.blockingChildren.length > 0) {
          return {
            kind: "dependent_variant_in_progress",
            blockingVariants: dep.blockingChildren,
            affectedVariantCount: dep.childFactIds.length,
          };
        }
        affectedVariantCount = dep.childFactIds.length;
        // Invalidate direct variants: their enrichment was classified against
        // the OLD parent wording. Clear only their signatures (Taxonomy Health
        // then shows them stale_for_reprocess) — never their text/enrichment.
        if (dep.childFactIds.length > 0) {
          await tx.update(factsTable).set({ lastProcessedSignature: null }).where(inArray(factsTable.id, dep.childFactIds));
        }
      }

      // Write text + clear THIS fact's signature; PRESERVE enrichmentStatus/
      // enrichment/overrides. Apply any non-text deltas in the same write.
      const [updated] = await tx
        .update(factsTable)
        .set({ ...textColumns, lastProcessedSignature: null, ...args.nonTextUpdates })
        .where(eq(factsTable.id, fact.id))
        .returning();
      // See the no-op branch above: a combined text+deactivate PATCH must cascade too.
      if (args.nonTextUpdates.isActive === false) {
        await cascadeDeactivateActiveChildren(tx, fact.id);
      }

      const [audit] = await tx
        .insert(factTextEditHistoryTable)
        .values({ factId: fact.id, oldText: fact.text, newText: proposed, reason: parsed.data.reason, performedBy: args.performedBy })
        .returning({ id: factTextEditHistoryTable.id });

      return {
        kind: "protected_committed",
        fact: updated!,
        auditRowId: audit!.id,
        affectedVariantCount,
      };
    }

    // ── STAGING branch (single unresolved first-time cycle) ──────────────────
    if (await hasNonterminalPrepJobs({ factId: fact.id, reviewId: protection.reviewId }, tx)) {
      return { kind: "staging_prep_in_progress" };
    }

    // Write the new wording + clear signature (staging field contract), then
    // restart prep: enrichmentStatus=pending + review → prep_pending.
    const [updated] = await tx
      .update(factsTable)
      .set({ ...textColumns, lastProcessedSignature: null, ...args.nonTextUpdates })
      .where(eq(factsTable.id, fact.id))
      .returning();
    // See the no-op branch above: a combined text+deactivate PATCH must cascade too.
    if (args.nonTextUpdates.isActive === false) {
      await cascadeDeactivateActiveChildren(tx, fact.id);
    }
    await prepareFirstTimeStagingPrep(tx, {
      review: { id: protection.reviewId, submittedText: "", submittedById: null, stagingFactId: fact.id },
      parentFactId: fact.parentId ?? null,
    });

    // prepDispatch is filled by the post-commit ensure step below (placeholder here).
    return { kind: "staging_restarted", fact: updated!, prepDispatch: { factId: fact.id, enrichment: { status: "pending", inserted: false }, pexels: { status: "pending", inserted: false } } };
  });

  // Post-commit: a staging restart ENSURES the durable prep jobs outside the
  // fact-row lock, and surfaces their real dispatch state.
  if (committed.kind === "staging_restarted") {
    const prepDispatch = await ensureFirstTimeStagingPrepJobs(committed.fact.id);
    return { kind: "staging_restarted", fact: committed.fact, prepDispatch };
  }
  return committed;
}
