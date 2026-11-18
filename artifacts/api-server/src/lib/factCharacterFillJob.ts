/**
 * The one-off character-list fill (PLAN_BUBBLE_SPEAKERS.md, G) — queue
 * `fact_character_fill`.
 *
 * For every fact or open refresh candidate whose AI baseline has no
 * `charactersExtraction` marker, run the character call ALONE (the same
 * extractor `enrichFact` uses, so a filled list and a freshly enriched one
 * cannot drift) and write the list plus its marker into the AI baseline only.
 * Nothing else changes: no other enrichment field, no signature, no status, no
 * review cycle, no gag, no render.
 *
 * Targets (`pickCharacterFillTargets`):
 *   - live facts;
 *   - facts in first-time moderation that already have a valid baseline (at the
 *     Gags or Test Renders step) — a submission still at triage or awaiting its
 *     first classification gets the list from normal prep;
 *   - open refresh candidates (`fact_enrichment_versions.status = 'candidate'`).
 * Superseded/rejected versions and frozen render snapshots stay historical.
 *
 * Per target, the write happens in one transaction that re-reads the row under
 * a lock and rematerializes with the overrides read THERE, so a moderator
 * correction saved meanwhile survives. Outcomes:
 *   done → processed; `{ skipped, reason: "already_current" }` → already
 *   complete (marker present, e.g. a concurrent re-enrich filled it);
 *   `{ skipped, reason: "missing_required_data" }` → no valid baseline yet /
 *   not a target any more; a failed call → `ok: false`, retried by the worker,
 *   no marker written; wording changed under it → `ok: false` (deferred, retried).
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";
import { factEnrichmentVersionsTable, pendingReviewsTable } from "@workspace/db/schema";
import {
  hasExtractedCharacters,
  validateEnrichment,
  type EnrichmentOverrides,
  type FactCharacter,
} from "@workspace/api-zod";
import { RESUMES_FROM_CHECKPOINTS, registerJobHandler, type HandlerResult, type JobHandler } from "./asyncJobs";
import { materializeEnrichment, resolveFactEnrichmentLLMSettings } from "./factEnrichment";
import { extractFactCharacters, withExtractedCharacters } from "./factCharacters";
import { renderCanonical } from "./renderCanonical";
import { logger } from "./logger";
import { assertJobOwnership, fencedTransaction } from "./jobFence";

export const FACT_CHARACTER_FILL_QUEUE = "fact_character_fill";

export type FactCharacterFillPayload =
  | { target: "fact"; factId: number }
  | { target: "candidate"; factId: number; versionId: number };

export interface FactCharacterFillDeps {
  /** The character call on rendered fact text. Tests inject a stub. */
  extract: (renderedFactText: string) => Promise<FactCharacter[]>;
}

const realDeps: FactCharacterFillDeps = {
  extract: async (text) => extractFactCharacters(text, await resolveFactEnrichmentLLMSettings()),
};

/** First-time moderation stages at which a fact already has a valid baseline. */
const FIRST_TIME_FILLABLE_STAGES = ["gags", "test_renders"] as const;

export function fillDedupeKey(p: FactCharacterFillPayload): string {
  return p.target === "fact" ? `fact_character_fill:fact:${p.factId}` : `fact_character_fill:candidate:${p.versionId}`;
}

/** Every fact and open candidate whose baseline lacks the extraction marker. */
export async function pickCharacterFillTargets(): Promise<FactCharacterFillPayload[]> {
  const noMarker = sql`(${factsTable.enrichmentAiDerived} -> 'charactersExtraction') IS NULL`;
  const firstTime = db
    .select({ id: pendingReviewsTable.stagingFactId })
    .from(pendingReviewsTable)
    .where(
      and(
        isNotNull(pendingReviewsTable.stagingFactId),
        inArray(pendingReviewsTable.workflowStage, [...FIRST_TIME_FILLABLE_STAGES]),
      ),
    );
  const facts = await db
    .select({ id: factsTable.id, aiDerived: factsTable.enrichmentAiDerived })
    .from(factsTable)
    .where(
      and(
        isNotNull(factsTable.enrichmentAiDerived),
        noMarker,
        sql`(${factsTable.isActive} = true OR ${factsTable.id} IN (${firstTime}))`,
      ),
    );
  const candidates = await db
    .select({
      versionId: factEnrichmentVersionsTable.id,
      factId: factEnrichmentVersionsTable.factId,
      aiDerived: factEnrichmentVersionsTable.enrichmentAiDerived,
    })
    .from(factEnrichmentVersionsTable)
    .where(
      and(
        eq(factEnrichmentVersionsTable.status, "candidate"),
        isNotNull(factEnrichmentVersionsTable.enrichmentAiDerived),
        sql`(${factEnrichmentVersionsTable.enrichmentAiDerived} -> 'charactersExtraction') IS NULL`,
      ),
    );
  const out: FactCharacterFillPayload[] = [];
  for (const f of facts) if (validateEnrichment(f.aiDerived).ok) out.push({ target: "fact", factId: f.id });
  for (const c of candidates) {
    if (validateEnrichment(c.aiDerived).ok) out.push({ target: "candidate", factId: c.factId, versionId: c.versionId });
  }
  return out;
}

const ALREADY_CURRENT: HandlerResult = { ok: true, result: { skipped: true, reason: "already_current" } };
const NOT_A_TARGET: HandlerResult = { ok: true, result: { skipped: true, reason: "missing_required_data" } };
const WORDING_CHANGED: HandlerResult = { ok: false, error: "deferred: the fact's wording changed during the character call" };

/**
 * The shared decision for one locked row: not a target (no valid baseline),
 * already complete (marker present), or the materialized columns with the list
 * and its marker written into the AI baseline only, against the overrides read
 * under the lock.
 */
function fillColumns(
  rawAiDerived: unknown,
  overrides: unknown,
  characters: FactCharacter[],
): { skip: HandlerResult } | { columns: ReturnType<typeof materializeEnrichment>["columns"] } {
  const v = validateEnrichment(rawAiDerived);
  if (!v.ok) return { skip: NOT_A_TARGET };
  if (hasExtractedCharacters(v.data)) return { skip: ALREADY_CURRENT };
  return {
    columns: materializeEnrichment({
      aiDerived: withExtractedCharacters(v.data, characters),
      overrides: (overrides ?? {}) as EnrichmentOverrides,
    }).columns,
  };
}

export async function runFactCharacterFill(
  payload: unknown,
  deps: FactCharacterFillDeps = realDeps,
): Promise<HandlerResult> {
  const p = payload as FactCharacterFillPayload;
  if (!p || typeof p.factId !== "number" || (p.target !== "fact" && p.target !== "candidate")) {
    return { ok: false, error: "fact_character_fill: bad payload" };
  }
  if (p.target === "candidate" && typeof p.versionId !== "number") {
    return { ok: false, error: "fact_character_fill: candidate payload missing versionId" };
  }

  // Pre-read (no lock): the fact text, and whether there is still work to do —
  // so an already-filled row never costs a character call.
  const [fact] = await db
    .select({ text: factsTable.text, aiDerived: factsTable.enrichmentAiDerived })
    .from(factsTable)
    .where(eq(factsTable.id, p.factId))
    .limit(1);
  if (!fact) return NOT_A_TARGET;
  const pre =
    p.target === "fact"
      ? fact.aiDerived
      : (
          await db
            .select({ aiDerived: factEnrichmentVersionsTable.enrichmentAiDerived })
            .from(factEnrichmentVersionsTable)
            .where(eq(factEnrichmentVersionsTable.id, p.versionId))
            .limit(1)
        )[0]?.aiDerived ?? null;
  const preDecision = fillColumns(pre, {}, []);
  if ("skip" in preDecision) return preDecision.skip;

  const classifiedText = fact.text;
  let characters: FactCharacter[];
  try {
    await assertJobOwnership(); // paid AI call: only while this run owns its job (Issue #1000)
    characters = await deps.extract(renderCanonical(classifiedText));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, ...p }, "[fact_character_fill] character call failed (retried; no marker written)");
    return { ok: false, error: `character call failed: ${msg}` };
  }

  return fencedTransaction(db, async (tx): Promise<HandlerResult> => {
    if (p.target === "fact") {
      const [lockedFact] = await tx
        .select({
          text: factsTable.text,
          aiDerived: factsTable.enrichmentAiDerived,
          overrides: factsTable.enrichmentOverrides,
        })
        .from(factsTable)
        .where(eq(factsTable.id, p.factId))
        .for("update")
        .limit(1);
      if (!lockedFact) return NOT_A_TARGET;
      if (lockedFact.text !== classifiedText) return WORDING_CHANGED;
      const d = fillColumns(lockedFact.aiDerived, lockedFact.overrides, characters);
      if ("skip" in d) return d.skip;
      await tx
        .update(factsTable)
        .set({
          enrichment: d.columns.enrichment,
          enrichmentAiDerived: d.columns.enrichmentAiDerived,
          enrichmentBaselineChanged: d.columns.enrichmentBaselineChanged,
        })
        .where(eq(factsTable.id, p.factId));
      return { ok: true, result: { target: "fact", factId: p.factId, characters: characters.length } };
    }

    // A candidate: lock ONLY its version row — the one row this branch writes.
    // Promote, decline and the candidate enrichment job all take the candidate
    // before the fact; taking the fact here first would invert that order and
    // let a fill and an approval deadlock (Codex, PR #973 round 1). The fact's
    // wording is read without a lock: it is locked after triage, and promotion
    // re-checks it itself.
    const [v1] = await tx
      .select({
        status: factEnrichmentVersionsTable.status,
        aiDerived: factEnrichmentVersionsTable.enrichmentAiDerived,
        overrides: factEnrichmentVersionsTable.enrichmentOverrides,
      })
      .from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, p.versionId))
      .for("update")
      .limit(1);
    if (!v1 || v1.status !== "candidate") return NOT_A_TARGET;
    const [factNow] = await tx
      .select({ text: factsTable.text })
      .from(factsTable)
      .where(eq(factsTable.id, p.factId))
      .limit(1);
    if (!factNow) return NOT_A_TARGET;
    if (factNow.text !== classifiedText) return WORDING_CHANGED;
    const d = fillColumns(v1.aiDerived, v1.overrides, characters);
    if ("skip" in d) return d.skip;
    await tx
      .update(factEnrichmentVersionsTable)
      .set({ enrichment: d.columns.enrichment, enrichmentAiDerived: d.columns.enrichmentAiDerived })
      .where(eq(factEnrichmentVersionsTable.id, p.versionId));
    return { ok: true, result: { target: "candidate", versionId: p.versionId, characters: characters.length } };
  });
}

export const factCharacterFillHandler: JobHandler = {
  run: (payload: unknown) => runFactCharacterFill(payload),
};

export function registerFactCharacterFillHandler(): void {
  // Execution limit (Issue #1000): one extraction call, up to 3 tries of 120 s (about 6 min), plus margin.
  registerJobHandler(FACT_CHARACTER_FILL_QUEUE, factCharacterFillHandler, { executionLimitMs: 12 * 60_000, ...RESUMES_FROM_CHECKPOINTS });
}
