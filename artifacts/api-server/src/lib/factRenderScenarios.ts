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
 *   - the conservative non-human applicability check
 *   - required-scenario approval-problem computation
 *
 * Named entity-agnostically (`fact*`, not `review*`) so PR 3 (Edit Fact) can
 * reuse the policy without forking — review-specific wiring (auth, staging-fact
 * lookup, routes, waiver enforcement) lives in the review layer.
 *
 * Presentation state is DERIVED here, never persisted, so a stale badge can't
 * drift from the current enrichment/config.
 */

import { createHash } from "node:crypto";
import {
  IMAGE_PROMPT_GENERATION_VERSION,
  RENDER_SCENARIO_DESCRIPTORS,
  REQUIRED_RENDER_SCENARIO_KEYS,
  type FactEnrichment,
  type GenerationMode,
  type IdentityPolicy,
  type NonHumanApplicability,
  type RenderControls,
  type RenderScenarioKey,
  type RenderScenarioStatus,
  type SubjectRenderMode,
} from "@workspace/api-zod";
import { buildRenderStatusPayload } from "./imagePromptAttempts";
import type { ImagePromptAttempt } from "@workspace/db/schema";

// ─── Version constants (bumping any of these invalidates prior hashes) ───────

/** Bump when the *set/shape* of default scenarios or hash inputs changes.
 *  v2: dropped overhypeFit / adultSuitability from the render-input hash (they
 *  are quality/gating signals that never reach the compiled prompt). */
export const SCENARIO_CONFIG_VERSION = "2";
/** Bump when the required-scenario set or approval gate semantics change. */
export const REQUIRED_SCENARIO_POLICY_VERSION = "1";
/**
 * Version of the default reference assets, per identity type. Bump the relevant
 * entry when an asset is swapped so prior i2i attempts using it go stale.
 * NOTE: the actual asset bytes/URLs are owned by `defaultReferenceResolver`;
 * this is just the version stamp folded into the hash + persisted on the attempt.
 */
export const DEFAULT_REFERENCE_ASSET_VERSION: Record<string, string> = {
  male: "1",
  female: "1",
  nonhuman_animal: "1",
  nonhuman_object_vehicle: "1",
};

// ─── Engine provenance ───────────────────────────────────────────────────────

export function generationModeForSubjectRenderMode(mode: SubjectRenderMode): GenerationMode {
  return mode === "t2i_fallback" ? "t2i" : "i2i";
}

/**
 * The ACTUAL fal image engine a scenario routes to — i2i goes through the edit
 * engine. The legacy `image_prompt_attempts.target_engine` column stamps
 * "nano_banana_2" for everything, so it is NOT a reliable provenance signal;
 * this derivation is what we fold into the hash + surface in diagnostics.
 */
export function actualImageEngineIdForGenerationMode(mode: GenerationMode): string {
  return mode === "i2i" ? "nano-banana-2-edit" : "nano-banana-2";
}

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
  /** Actual image engine the scenario routes to (edit engine for i2i). */
  actualImageEngineId: string;
}

/**
 * The RENDER-AFFECTING projection of an enrichment blob — exactly the fields that
 * can change the compiled t2i/i2i prompt (traced through the image-prompt
 * generator + the Nano-Banana-2 compiler):
 *   - primaryArchetype / subtype  → select the authored visual strategy + guidance
 *   - modifiers                   → LLM taxonomy block AND compiler directives
 *   - visualLiteralness / visualComplexity → visual-treatment directives
 *   - culturalReferences / semanticEntities → dedicated per-fact visual-context blocks
 *   - visualPromptStrategyOverride → consumed by the compiler
 *
 * Excludes fields that DON'T feed the prompt: adminReviewNotes,
 * suggestedHashtags, adultSuitabilityNotes (never referenced in generation), and
 * the quality/gating signals overhypeFit, adultSuitability, taxonomyConfidence —
 * these appear only in the generator's "TAXONOMY (FIXED — DO NOT reclassify)"
 * context block, are ignored by the compiler, and never change the drawn image
 * (overhypeFit is an approval gate; the render's SFW level is the separate
 * `contentMode` control, not adultSuitability). Editing any of them must NOT flip
 * a render stale.
 */
export function renderAffectingEnrichment(e: FactEnrichment): Record<string, unknown> {
  return {
    primaryArchetype: e.primaryArchetype,
    subtype: e.subtype,
    modifiers: [...e.modifiers].sort(),
    visualLiteralness: e.visualLiteralness,
    visualComplexity: e.visualComplexity,
    culturalReferences: e.culturalReferences,
    semanticEntities: e.semanticEntities,
    visualPromptStrategyOverride: e.visualPromptStrategyOverride ?? null,
  };
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

/** A latest attempt is stale when its frozen input hash differs from the current one. */
export function isAttemptStale(attempt: ImagePromptAttempt, currentHash: string): boolean {
  return (attempt.reviewRenderInputHash ?? "") !== currentHash;
}

// ─── Non-human applicability (conservative) ──────────────────────────────────

const ANIMAL_HINT_RE =
  /\b(cat|kitten|dog|puppy|shark|lion|tiger|bear|horse|cow|pig|goat|sheep|wolf|fox|fish|bird|eagle|hawk|owl|snake|frog|rabbit|bunny|mouse|rat|elephant|giraffe|monkey|ape|gorilla|dolphin|whale|octopus|crab|lobster|dinosaur|dragon|animal|creature|beast)\b/i;

/**
 * Decide whether the conditional non-human i2i scenario should auto-run.
 *
 * CONSERVATIVE BY DESIGN. `autoRun` flips true ONLY on a high-confidence signal
 * that the *personalized subject itself* is non-human — never because a
 * non-human entity merely appears in the scene, is the antagonist/target, or is
 * named in a cultural reference (the common false positives). Overhype facts are
 * almost always about a human protagonist, and there is no dedicated
 * subject-identity classifier yet — so in PR 1 `autoRun` stays false and the
 * scenario is run by explicit moderator force. The returned `subtype`/reason are
 * still surfaced in the UI so the moderator can see the suggestion + force the
 * right reference. A future PR can add a real subject-identity signal and flip
 * `autoRun` on without changing any callers.
 */
export function resolveNonHumanScenarioApplicability(
  enrichment: FactEnrichment,
  factText: string,
): NonHumanApplicability {
  const evidence: string[] = [];
  const negativeEvidence: string[] = [];

  // Subtype HINT (used only when the moderator forces the scenario): is the
  // most prominent non-human referent an animal or an object/vehicle? We never
  // treat this hint as proof the subject is non-human.
  const materialEntities = enrichment.semanticEntities.filter((e) => e.materiallyAffectsVisualPrompt);
  const hasObjectEntity = materialEntities.some(
    (e) => e.entityKind === "physical_object" || e.entityKind === "celestial_body",
  );
  const textSuggestsAnimal = ANIMAL_HINT_RE.test(factText);
  const entitySuggestsAnimal = materialEntities.some((e) => ANIMAL_HINT_RE.test(e.normalizedText));

  let subtype: NonHumanApplicability["subtype"] = "none";
  if (textSuggestsAnimal || entitySuggestsAnimal) {
    subtype = "animal";
    evidence.push("Fact text or a material entity names an animal/creature.");
  } else if (hasObjectEntity) {
    subtype = "object_vehicle";
    evidence.push("A material semantic entity is a physical object / celestial body.");
  } else {
    subtype = "object_vehicle"; // default reference if forced with no signal
  }

  // Hard negatives: these are why we do NOT auto-run.
  negativeEvidence.push(
    "No dedicated subject-identity classifier exists yet; a non-human entity in the scene does not imply a non-human personalized subject.",
  );
  negativeEvidence.push(
    `Fact archetype "${enrichment.primaryArchetype}" describes what the protagonist does — not that the protagonist is non-human.`,
  );

  return {
    autoRun: false, // PR 1: manual-force only (see doc comment).
    confidence: "low",
    subtype,
    reason:
      "Non-human render is manual-only in PR 1: Overhype protagonists are human by default and there is no subject-identity classifier yet. Force it with the checkbox to preview a non-human subject.",
    evidence,
    negativeEvidence,
  };
}

/**
 * Which single non-human scenario the grid should surface (the UI exposes one
 * "non-human" control). Maps the applicability subtype to its scenario key;
 * defaults to the object/vehicle reference when there's no signal.
 */
export function nonHumanScenarioKeyForApplicability(app: NonHumanApplicability): RenderScenarioKey {
  return app.subtype === "animal" ? "i2i_nonhuman_animal" : "i2i_nonhuman_object_vehicle";
}

// ─── Required-scenario approval problems ─────────────────────────────────────

export interface ScenarioProblem {
  scenarioKey: RenderScenarioKey;
  status: RenderScenarioStatus | "stale";
}

/**
 * Given the derived state of each required scenario, list the ones that block a
 * clean approval (anything not a fresh, successful render). The approval route
 * requires the moderator's waiver to name exactly these.
 */
export function requiredScenarioProblems(
  states: Array<{ scenarioKey: RenderScenarioKey; status: RenderScenarioStatus; stale: boolean }>,
): ScenarioProblem[] {
  const required = new Set<RenderScenarioKey>(REQUIRED_RENDER_SCENARIO_KEYS);
  const problems: ScenarioProblem[] = [];
  for (const s of states) {
    if (!required.has(s.scenarioKey)) continue;
    if (s.stale) {
      problems.push({ scenarioKey: s.scenarioKey, status: "stale" });
    } else if (s.status !== "done") {
      problems.push({ scenarioKey: s.scenarioKey, status: s.status });
    }
  }
  return problems;
}

export { RENDER_SCENARIO_DESCRIPTORS };
