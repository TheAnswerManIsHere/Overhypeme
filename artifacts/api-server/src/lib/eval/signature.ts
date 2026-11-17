/**
 * Eval harness (Slice 2B) — two signature levels.
 *
 * A RUN carries a broad `run_profile` captured once (planner engine/model/effort
 * + code-version constants). Each ATTEMPT carries a per-row signature derived at
 * read time (scenario, subjectRenderMode, generationMode, the ACTUAL image
 * engine — NOT the coarse targetEngine — reference identity/version, look style,
 * planner model/effort). A run spans multiple scenarios/engines, so the dashboard
 * groups by run, then by attempt-signature within. Missing inputs bucket as
 * "unknown" so old attempts lacking provenance are visible, not dropped.
 */

import {
  IMAGE_PROMPT_GENERATION_VERSION,
  VISUAL_STRATEGY_VERSION,
  RENDER_SCENARIO_DESCRIPTORS,
  type EvalRunProfile,
  type AttemptSignature,
  type RenderScenarioKey,
} from "@workspace/api-zod";
import type { ImagePromptAttempt } from "@workspace/db";
import {
  SCENARIO_CONFIG_VERSION,
  DEFAULT_REFERENCE_ASSET_VERSION,
} from "../factRenderScenarios";
import { attemptImageEngineId } from "../imageEngineRouting";

const UNKNOWN = "unknown";

function plannerProvenanceOf(attempt: ImagePromptAttempt): { model?: string | null; reasoningEffort?: string | null } | null {
  const compiled = attempt.compiledPrompt as { diagnostics?: { plannerProvenance?: { model?: string | null; reasoningEffort?: string | null } } } | null;
  return compiled?.diagnostics?.plannerProvenance ?? null;
}

function lookStyleIdOf(attempt: ImagePromptAttempt): string {
  const rc = attempt.renderControls as { lookStyleId?: unknown; styleId?: unknown } | null;
  const id = (rc?.lookStyleId ?? rc?.styleId);
  return typeof id === "string" && id.trim() ? id.trim() : "none";
}

/** The planner fields of a direct attempt, which no planner made. */
const NO_PLANNER = "none";

/**
 * Per-attempt signature. Reference identity/version come from the stored review
 * columns when present (moderation attempts) and otherwise from the scenario
 * descriptor (eval-run attempts don't set the review columns). The engine is the
 * ACTUAL image engine recorded on the attempt, not the coarse `targetEngine`.
 */
export function deriveAttemptSignature(attempt: ImagePromptAttempt): AttemptSignature {
  const scenarioKey = attempt.evalScenarioKey ?? attempt.reviewRenderScenarioKey ?? UNKNOWN;
  const desc = RENDER_SCENARIO_DESCRIPTORS[scenarioKey as RenderScenarioKey] as
    | { referenceIdentityType?: string | null }
    | undefined;

  const generationMode = attempt.generationMode || UNKNOWN;
  // The engine recorded at construction (or, for an older row, the engine its
  // release routed to) — never today's default.
  const actualImageEngineId = (attempt.actualImageEngineId || attempt.generationMode)
    ? attemptImageEngineId(attempt)
    : UNKNOWN;

  const referenceIdentityType =
    attempt.reviewReferenceIdentityType ?? desc?.referenceIdentityType ?? "none";
  const referenceAssetVersion =
    attempt.reviewReferenceAssetVersion ??
    (referenceIdentityType && referenceIdentityType !== "none"
      ? (DEFAULT_REFERENCE_ASSET_VERSION[referenceIdentityType] ?? UNKNOWN)
      : "none");

  const prov = plannerProvenanceOf(attempt);
  return {
    scenarioKey,
    subjectRenderMode: attempt.subjectRenderMode || UNKNOWN,
    generationMode,
    actualImageEngineId,
    referenceIdentityType: referenceIdentityType ?? "none",
    referenceAssetVersion,
    lookStyleId: lookStyleIdOf(attempt),
    // A direct attempt (plan PLAN_GAG_DIRECT_RENDER.md, D) had no planner;
    // only a planned one without its provenance is unknown.
    plannerModel: prov?.model ?? (attempt.visualPlan ? UNKNOWN : NO_PLANNER),
    plannerReasoningEffort: prov?.reasoningEffort ?? (attempt.visualPlan ? UNKNOWN : NO_PLANNER),
  };
}

/**
 * Broad pipeline profile, captured ONCE at run creation. No planner runs since
 * the switch (plan PLAN_GAG_DIRECT_RENDER.md, D), so its three fields are null.
 */
export async function captureRunProfile(): Promise<EvalRunProfile> {
  return {
    plannerEngineId: null,
    plannerModel: null,
    plannerReasoningEffort: null,
    imagePromptGenerationVersion: String(IMAGE_PROMPT_GENERATION_VERSION),
    scenarioConfigVersion: String(SCENARIO_CONFIG_VERSION),
    archetypeStrategyVersion: String(VISUAL_STRATEGY_VERSION),
  };
}
