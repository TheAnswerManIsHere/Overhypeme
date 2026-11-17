/**
 * The photoreal fallback (plan `docs/plans/PLAN_NB_FALLBACK.md`, Issue #980;
 * David, 2026-11-17, Q12 option 2, Q13 option 1, Q14 option 1).
 *
 * When the routed photoreal engine refuses a render on content grounds, the
 * same attempt is redrawn once on the fallback engine:
 *
 *   1. the refusal is recorded on `engine_fallback` (state `preparing`) before
 *      anything else can fail, so no later run calls the routed engine again;
 *   2. the stored scene plan is recompiled with the fallback recipe (no planner
 *      call) and passes the same render-time gates the first compile passed;
 *   3. the attempt is switched in one write (state `switched`): engine, recipe,
 *      compiled prompt;
 *   4. the image worker draws it on the fallback engine.
 *
 * Every run of the image job reads the attempt as persisted, so `preparing`
 * resumes at step 2 and `switched` draws on the fallback. A content refusal
 * from the fallback engine ends the render terminally, naming both refusals.
 */

import { eq } from "drizzle-orm";
import { db, imagePromptAttemptsTable, type EngineFallbackRecord, type ImagePromptAttempt } from "@workspace/db";
import { fallbackEngineIdFor } from "./imageEngineRouting";
import { engineFamilyOf, liveRecipeForEngine, recipeById } from "./imagePrompt/recipeStore";
import type { CompiledImagePrompt } from "./imagePrompt/types";

/** The fallback chosen when an attempt is queued, frozen on its render controls. */
export interface FrozenFallbackChoice {
  engineId: string;
  recipeVersionId: number | null;
}

/** Render-controls key the frozen fallback choice lives under. */
export const FROZEN_FALLBACK_KEY = "engineFallback";

/**
 * The fallback a render routed to `engineId` would use, with the fallback
 * family's live recipe, frozen at queue time so a recipe promotion never
 * changes queued work. Null when the engine has no fallback (styled engines).
 */
export async function freezeFallbackChoice(engineId: string): Promise<FrozenFallbackChoice | null> {
  const fallbackEngineId = fallbackEngineIdFor(engineId);
  if (!fallbackEngineId) return null;
  return { engineId: fallbackEngineId, recipeVersionId: (await liveRecipeForEngine(fallbackEngineId)).versionId };
}

/** The frozen fallback choice on an attempt's render controls, or null when none was frozen. */
export function frozenFallbackChoice(renderControls: unknown): FrozenFallbackChoice | null {
  if (!renderControls || typeof renderControls !== "object") return null;
  const raw = (renderControls as Record<string, unknown>)[FROZEN_FALLBACK_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { engineId, recipeVersionId } = raw as Record<string, unknown>;
  if (typeof engineId !== "string" || !engineId) return null;
  if (recipeVersionId !== null && typeof recipeVersionId !== "number") return null;
  return { engineId, recipeVersionId };
}

/**
 * The fallback this attempt would take now: the one frozen at queue time, or,
 * for an attempt queued before fallbacks were frozen, the routed engine's
 * fallback with its live recipe (`resolvedAtHandover`). Null when the
 * attempt's routed engine has no fallback.
 */
export async function fallbackChoiceForAttempt(
  attempt: Pick<ImagePromptAttempt, "renderControls">,
  routedEngineId: string,
): Promise<(FrozenFallbackChoice & { resolvedAtHandover: boolean }) | null> {
  const expected = fallbackEngineIdFor(routedEngineId);
  if (!expected) return null;
  const frozen = frozenFallbackChoice(attempt.renderControls);
  if (frozen && frozen.engineId === expected) return { ...frozen, resolvedAtHandover: false };
  const live = await freezeFallbackChoice(routedEngineId);
  return live ? { ...live, resolvedAtHandover: true } : null;
}

/** The attempt's fallback record, when it has one. */
export function engineFallbackOf(attempt: { engineFallback?: unknown }): EngineFallbackRecord | null {
  const rec = attempt.engineFallback as EngineFallbackRecord | null | undefined;
  return rec && (rec.state === "preparing" || rec.state === "switched") ? rec : null;
}

/** The attempt's fallback record once it has switched: the fallback engine draws, or drew, its picture. */
export function switchedFallbackOf(attempt: { engineFallback?: unknown }): EngineFallbackRecord | null {
  const rec = engineFallbackOf(attempt);
  return rec?.state === "switched" ? rec : null;
}

/**
 * Step 1: record the routed engine's refusal, before anything else can fail.
 * Writes only when the attempt has no fallback record yet, so a retried run
 * never overwrites the first refusal. Returns the record as stored.
 */
export async function recordRefusal(
  attempt: ImagePromptAttempt,
  refusal: {
    routedEngineId: string;
    reason: string;
    refusedGenerationRequestId: number | null;
    refusedVendorRequestId: string | null;
  },
  choice: FrozenFallbackChoice & { resolvedAtHandover: boolean },
): Promise<EngineFallbackRecord> {
  const existing = engineFallbackOf(attempt);
  if (existing) return existing;
  const record: EngineFallbackRecord = {
    state: "preparing",
    routedEngineId: refusal.routedEngineId,
    routedRecipeVersionId: attempt.recipeVersionId ?? null,
    refusedGenerationRequestId: refusal.refusedGenerationRequestId,
    refusedVendorRequestId: refusal.refusedVendorRequestId,
    reason: refusal.reason,
    fallbackEngineId: choice.engineId,
    fallbackRecipeVersionId: choice.recipeVersionId,
    resolvedAtHandover: choice.resolvedAtHandover,
    at: new Date().toISOString(),
  };
  await db
    .update(imagePromptAttemptsTable)
    .set({ engineFallback: record, updatedAt: new Date() })
    .where(eq(imagePromptAttemptsTable.id, attempt.id));
  return record;
}

/** Step 3: switch the attempt to the fallback engine, recipe and prompt, in one write. */
export async function switchToFallback(
  attempt: ImagePromptAttempt,
  record: EngineFallbackRecord,
  compiledPrompt: CompiledImagePrompt,
): Promise<void> {
  // Keep the planner's provenance on the recompiled prompt: the planner ran
  // once, for the routed engine, and its plan is what the fallback drew.
  const previous = (attempt.compiledPrompt ?? {}) as { diagnostics?: { plannerProvenance?: unknown } };
  const plannerProvenance = previous.diagnostics?.plannerProvenance;
  if (plannerProvenance !== undefined && compiledPrompt.diagnostics) {
    (compiledPrompt.diagnostics as { plannerProvenance?: unknown }).plannerProvenance = plannerProvenance;
  }
  await db
    .update(imagePromptAttemptsTable)
    .set({
      actualImageEngineId: record.fallbackEngineId,
      recipeVersionId: record.fallbackRecipeVersionId,
      compiledPrompt: compiledPrompt as unknown as Record<string, unknown>,
      engineFallback: { ...record, state: "switched" },
      updatedAt: new Date(),
    })
    .where(eq(imagePromptAttemptsTable.id, attempt.id));
}

/** The fallback recipe as the compiler uses it. */
export async function fallbackRecipe(record: EngineFallbackRecord) {
  return recipeById(record.fallbackRecipeVersionId, engineFamilyOf(record.fallbackEngineId));
}

/** The message a render ends with when the fallback engine refuses too. */
export function bothRefusedMessage(record: EngineFallbackRecord, fallbackLabel: string, fallbackReason: string): string {
  return `${record.routedEngineId} refused this picture under its content policy (${record.reason}); ` +
    `the fallback, ${fallbackLabel}, refused it too (${fallbackReason})`;
}
