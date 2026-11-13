/**
 * Eval harness (Slice 2B) — shared wire schemas + types.
 *
 * A render carries a moderator VERDICT: a 1–5 `rating` and an optional
 * `failureTag` attributing a bad render to the concept, the compiler, or the
 * image model. The two are INDEPENDENT (a failure-tag with no rating is valid
 * quick-triage). Attribution values:
 *   concept      — the idea / staging was wrong (bad Visual concept / enrichment).
 *   compiler     — the concept was good but the compiled prompt lost it.
 *   image_model  — the prompt was good but the model executed it badly.
 *   none         — rated, no single dominant failure (distinct from NULL = unreviewed).
 */

// ─── Failure attribution ─────────────────────────────────────────────────────

export const FAILURE_TAG_VALUES = ["concept", "compiler", "image_model", "none"] as const;
export type FailureTag = (typeof FAILURE_TAG_VALUES)[number];

// ─── Shared signature / profile shapes (server computes; FE dashboard reads) ──

/** Broad pipeline profile captured ONCE per eval run. */
export interface EvalRunProfile {
  plannerEngineId: string | null;
  plannerModel: string | null;
  plannerReasoningEffort: string | null;
  imagePromptGenerationVersion: string;
  scenarioConfigVersion: string;
  archetypeStrategyVersion: string;
}

/**
 * Per-attempt signature — what varies row-to-row within a run (a run spans
 * multiple scenarios/engines, so one run ≠ one engine). Missing inputs bucket as
 * "unknown". Derived from the ACTUAL image engine, not the coarse targetEngine.
 */
export interface AttemptSignature {
  scenarioKey: string;
  subjectRenderMode: string;
  generationMode: string;
  actualImageEngineId: string;
  referenceIdentityType: string;
  referenceAssetVersion: string;
  lookStyleId: string;
  plannerModel: string;
  plannerReasoningEffort: string;
}

/** Stable string key for grouping attempts by signature in the dashboard. */
export function attemptSignatureKey(sig: AttemptSignature): string {
  return [
    sig.scenarioKey,
    sig.subjectRenderMode,
    sig.generationMode,
    sig.actualImageEngineId,
    sig.referenceIdentityType,
    sig.referenceAssetVersion,
    sig.lookStyleId,
    sig.plannerModel,
    sig.plannerReasoningEffort,
  ].join("|");
}
