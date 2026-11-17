/**
 * Moderation render-scenario POLICY + derivation (server-side logic).
 *
 * The shared vocabulary (scenario keys, descriptors, status enum, waiver wire
 * schema) lives in `@workspace/api-zod` (`renderScenarios.ts`) so the frontend
 * shares one source of truth. This module owns the SERVER-ONLY pieces:
 *
 *   - version constants stamped into the input hash + waiver
 *   - the canonical scenario input-hash builder (drives idempotency + staleness)
 *   - status / stale / tally derivation from `image_prompt_attempts` rows
 *   - required-scenario approval-problem computation
 *
 * Named entity-agnostically (`fact*`, not `review*`) so PR 3 (Edit Fact) can
 * reuse the policy without forking — review-specific wiring (auth, staging-fact
 * lookup, routes, waiver enforcement) lives in the review layer.
 *
 * Presentation state is DERIVED here, never persisted, so a stale badge can't
 * drift from the current enrichment/config.
 */

import { switchedFallbackOf } from "./engineFallback";
import { createHash } from "node:crypto";
import {
  IMAGE_PROMPT_GENERATION_VERSION,
  RENDER_SCENARIO_DESCRIPTORS,
  REQUIRED_RENDER_SCENARIO_KEYS,
  type FactEnrichment,
  type GenerationMode,
  type IdentityPolicy,
  type RenderControls,
  type RenderScenarioKey,
  type RenderScenarioStatus,
  type SubjectRenderMode,
} from "@workspace/api-zod";
import { renderedGagProjection } from "./imagePrompt/directInput";
import { buildRenderStatusPayload } from "./imagePromptAttempts";
import type { ImagePromptAttempt } from "@workspace/db/schema";

// ─── Version constants (bumping any of these invalidates prior hashes) ───────

/** Bump when the *set/shape* of default scenarios or hash inputs changes.
 *  v2: dropped overhypeFit / adultSuitability from the render-input hash (they
 *  are quality/gating signals that never reach the compiled prompt).
 *  v3: the object/vehicle scenario is gone (people and pets only, 2026-11-15). */
export const SCENARIO_CONFIG_VERSION = "3";
/**
 * Version of the default reference assets, per identity type. Bump the relevant
 * entry when an asset is swapped so prior i2i attempts using it go stale.
 * NOTE: the actual asset bytes/URLs are owned by `defaultReferenceResolver`;
 * this is just the version stamp folded into the hash + persisted on the attempt.
 */
export const DEFAULT_REFERENCE_ASSET_VERSION: Record<string, string> = {
  male: "1",
  female: "1",
  nonhuman_animal: "2", // David's cat, 2026-11-17 (compiler review); was a stand-in cat
};

// ─── Engine provenance ───────────────────────────────────────────────────────

export function generationModeForSubjectRenderMode(mode: SubjectRenderMode): GenerationMode {
  return mode === "t2i_fallback" ? "t2i" : "i2i";
}

// The ACTUAL image engine a scenario routes to is no longer derived from the
// mode here: the configured engine per mode is read by `imageEngineRouting.ts`
// and passed into the hash, and a stored attempt carries its own engine
// (`actual_image_engine_id`). The legacy `target_engine` column stamps
// "nano_banana_2" for everything and is NOT a provenance signal.

// ─── Scenario input hash (idempotency + staleness) ───────────────────────────

/** Canonical, render-affecting inputs for one scenario attempt. */
export interface ScenarioHashInputs {
  stagingFactId: number;
  scenarioKey: RenderScenarioKey;
  subjectRenderMode: SubjectRenderMode;
  /** RENDERED fact text (tokens resolved) the generator will receive. */
  renderedFactText: string;
  /** Validated effective enrichment, including any visualPromptStrategyOverride. */
  enrichment: FactEnrichment;
  referenceIdentityType: string | null;
  referenceAssetVersion: string | null;
  renderControls: Pick<RenderControls, "aspectRatio" | "contentMode" | "negativeSpacePreference" | "fallbackSubjectGender">;
  lookStyleId: string | null;
  /** Resolved style-suffix version/stamp, if a style is selected. */
  styleSuffixVersion: string | null;
  identityPolicy: IdentityPolicy;
  /** Image engine the scenario routes to now (the configured engine for its mode). */
  actualImageEngineId: string;
  /** The live prompt recipe version for that engine; null or absent is the baseline (and is left out of the hash). */
  recipeVersionId?: number | null;
}

/**
 * The RENDER-AFFECTING part of a render input: the one selected gag's scene,
 * complete bubbles and cast entries (`renderedGagProjection`). Since the
 * switch (plan PLAN_GAG_DIRECT_RENDER.md, D) nothing else in the enrichment
 * reaches a prompt, so no classification field, and not the fact character
 * list, is hashed: editing any of them never marks a render out of date. The
 * cast's extraction marker is left out too; a cast read again with the same
 * entries changes nothing drawn.
 */
export function renderAffectingEnrichment(e: FactEnrichment): Record<string, unknown> {
  return { gag: renderedGagProjection(e.visualPromptStrategyOverride ?? null) };
}

/** Deterministic JSON: object keys sorted recursively so key order can't churn the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * sha256 hex of the canonical render-affecting inputs. Explicitly EXCLUDES
 * timestamps, signed-URL expiry, admin id, render-job id, and transient status —
 * so editing an admin note never marks a render stale, while editing an
 * override / style / reference-version / render-control does.
 */
export function buildScenarioInputHash(inputs: ScenarioHashInputs): string {
  const canonical = {
    scenarioConfigVersion: SCENARIO_CONFIG_VERSION,
    imagePromptGenerationVersion: IMAGE_PROMPT_GENERATION_VERSION,
    stagingFactId: inputs.stagingFactId,
    scenarioKey: inputs.scenarioKey,
    subjectRenderMode: inputs.subjectRenderMode,
    renderedFactText: inputs.renderedFactText,
    enrichment: renderAffectingEnrichment(inputs.enrichment),
    referenceIdentityType: inputs.referenceIdentityType,
    referenceAssetVersion: inputs.referenceAssetVersion,
    renderControls: {
      aspectRatio: inputs.renderControls.aspectRatio,
      contentMode: inputs.renderControls.contentMode,
      negativeSpacePreference: inputs.renderControls.negativeSpacePreference ?? null,
      fallbackSubjectGender: inputs.renderControls.fallbackSubjectGender ?? null,
    },
    lookStyleId: inputs.lookStyleId,
    styleSuffixVersion: inputs.styleSuffixVersion,
    identityPolicy: inputs.identityPolicy,
    actualImageEngineId: inputs.actualImageEngineId,
    // A promoted prompt recipe for the routed engine (the prompt tuner); added
    // only when set, so the baseline hashes exactly as before recipes existed.
    ...(inputs.recipeVersionId != null ? { recipeVersionId: inputs.recipeVersionId } : {}),
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

// ─── Status / stale derivation ───────────────────────────────────────────────

/** Map an attempt row to the Step-2 scenario status (reuses the shared render-status mapping). */
export function deriveScenarioStatus(attempt: ImagePromptAttempt): RenderScenarioStatus {
  const payload = buildRenderStatusPayload(attempt);
  switch (payload.status) {
    case "blocked": return "blocked";
    case "failed": return "failed";
    case "image_ready": return "done";
    case "prompt_ready": return "rendering";
    case "pending": return "queued";
    default: return "queued";
  }
}

/**
 * A latest attempt is stale when its frozen input hash differs from the
 * current one, or, for an attempt the photoreal fallback redrew, when the
 * fallback recipe it drew with is no longer the fallback family's live one
 * (plan PLAN_NB_FALLBACK.md, *Moderation freshness*). The hash is never
 * rewritten by a fallback, so a fallback alone never makes a render stale,
 * and a change to the fallback's wording never touches a render GPT drew.
 * `currentFallbackRecipeVersionId` is undefined when the caller did not read
 * it, which compares the hash alone.
 */
export function isAttemptStale(
  attempt: ImagePromptAttempt,
  currentHash: string,
  currentFallbackRecipeVersionId?: number | null,
): boolean {
  if ((attempt.reviewRenderInputHash ?? "") !== currentHash) return true;
  const fallback = switchedFallbackOf(attempt);
  if (!fallback || currentFallbackRecipeVersionId === undefined) return false;
  return fallback.fallbackRecipeVersionId !== currentFallbackRecipeVersionId;
}

export { RENDER_SCENARIO_DESCRIPTORS };
