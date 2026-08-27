/**
 * Pure unit tests for the override resolver (lib/api-zod/enrichmentOverrides):
 * effective assembly, baseline-change detection, canonical comparison, per-path
 * validation, the allowlist contract, and the cross-field subtype safety net.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveEnrichment,
  computeBaselineChangedPaths,
  overrideValuesEqual,
  normalizeForOverrideCompare,
  validateOverrideValue,
  OVERRIDABLE_PATH_KEYS,
  type FactEnrichment,
  type EnrichmentOverrides,
} from "@workspace/api-zod";

const AI: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: ["clear_causal_relationship"],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "pushups", "earth"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
  aiGenerationId: "gen-1",
};

function ov(value: unknown, overriddenFrom: unknown): EnrichmentOverrides[string] {
  return { value, overriddenFrom, createdAt: "2026-06-20T00:00:00.000Z" };
}

describe("resolveEnrichment", () => {
  it("effective == AI baseline when there are no overrides", () => {
    const { effective, summary } = resolveEnrichment({ aiDerived: AI, overrides: {} });
    assert.equal(effective.overhypeFit, "strong");
    assert.equal(summary.hasOverrides, false);
    assert.deepEqual(summary.overriddenPaths, []);
  });

  it("override wins in effective; AI baseline is untouched", () => {
    const overrides: EnrichmentOverrides = { "/overhypeFit": ov("questionable", "strong") };
    const { effective, summary } = resolveEnrichment({ aiDerived: AI, overrides });
    assert.equal(effective.overhypeFit, "questionable");
    assert.equal(AI.overhypeFit, "strong");
    assert.deepEqual(summary.overriddenPaths, ["/overhypeFit"]);
  });

  it("records baselineChanged when the AI value diverges from overriddenFrom", () => {
    const overrides: EnrichmentOverrides = { "/overhypeFit": ov("questionable", "reject") };
    const { summary } = resolveEnrichment({ aiDerived: AI, overrides });
    assert.deepEqual(summary.baselineChangedPaths, ["/overhypeFit"]);
  });

  it("keeps the AI value and flags invalidPaths when a stored override value is invalid", () => {
    const overrides = { "/overhypeFit": ov("bogus_value", "strong") } as unknown as EnrichmentOverrides;
    const { effective, summary } = resolveEnrichment({ aiDerived: AI, overrides });
    assert.equal(effective.overhypeFit, "strong"); // stays renderable
    assert.deepEqual(summary.invalidPaths, ["/overhypeFit"]);
  });

  it("best-effort repairs a cross-field archetype/subtype mismatch and stays renderable", () => {
    // Override archetype only; the AI subtype is invalid for it.
    const overrides: EnrichmentOverrides = { "/primaryArchetype": ov("object_logic_impossibility", "superhuman_physical_feat") };
    const { effective } = resolveEnrichment({ aiDerived: AI, overrides });
    assert.equal(effective.primaryArchetype, "object_logic_impossibility");
    // subtype repaired to a valid one for the new archetype.
    assert.notEqual(effective.subtype, "force_scaled_action");
  });

  it("carries the preserved visual override onto effective verbatim", () => {
    const visual = {
      version: 1 as const,
      requiredVisualDetails: ["a glowing aura"], forbiddenVisualDetails: [],
      roleBindings: [], bubbles: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
    };
    const { effective, summary } = resolveEnrichment({ aiDerived: AI, overrides: {}, visualPromptStrategyOverride: visual });
    assert.equal(effective.visualPromptStrategyOverride?.requiredVisualDetails[0], "a glowing aura");
    assert.equal(summary.hasVisualStrategyOverride, true);
  });

  // Regression — #579. A refresh copies the fact's STORED visual override into
  // the resolver verbatim, with no schema parse, so a blob that predates a list
  // field (or was written by a path that never parsed) arrives with that list
  // undefined. The resolver used to walk it eagerly and every enrichment job on
  // the refresh path died with "Cannot read properties of undefined (reading
  // 'forEach')". A partial stored blob must resolve, not throw.
  it("resolves a stored visual override whose lists are absent (no schema parse)", () => {
    const legacy = { version: 1, coreSceneOverride: "a giant lifting the earth" } as unknown as
      FactEnrichment["visualPromptStrategyOverride"];
    const { effective, summary } = resolveEnrichment({
      aiDerived: AI,
      overrides: {},
      visualPromptStrategyOverride: legacy,
    });
    // The override still counts as renderable content — its core scene is set.
    assert.equal(summary.hasVisualStrategyOverride, true);
    assert.equal(effective.visualPromptStrategyOverride?.coreSceneOverride, "a giant lifting the earth");
    // ...and the full-schema parse fills the absent lists back in.
    assert.deepEqual(effective.visualPromptStrategyOverride?.requiredVisualDetails, []);
  });

  it("resolves a stored visual override that is a bare version stub", () => {
    const stub = { version: 1 } as unknown as FactEnrichment["visualPromptStrategyOverride"];
    const { summary } = resolveEnrichment({ aiDerived: AI, overrides: {}, visualPromptStrategyOverride: stub });
    // Nothing renderable in it, but it must not throw.
    assert.equal(summary.hasVisualStrategyOverride, false);
  });
});

describe("comparison helpers", () => {
  it("overrideValuesEqual ignores object key order but respects array order", () => {
    assert.equal(overrideValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
    assert.equal(overrideValuesEqual(["a", "b"], ["b", "a"]), false);
  });

  it("normalizeForOverrideCompare is stable across key reordering", () => {
    assert.equal(normalizeForOverrideCompare({ a: 1, b: 2 }), normalizeForOverrideCompare({ b: 2, a: 1 }));
  });

  it("computeBaselineChangedPaths only reports diverged paths", () => {
    const overrides: EnrichmentOverrides = {
      "/overhypeFit": ov("questionable", "strong"),     // baseline still "strong" → unchanged
      "/adultSuitability": ov("compatible", "incompatible"), // baseline "safe" ≠ "incompatible" → changed
    };
    assert.deepEqual(computeBaselineChangedPaths(AI, overrides), ["/adultSuitability"]);
  });
});

describe("allowlist + per-path validation", () => {
  it("exposes exactly the 11 overridable paths", () => {
    assert.equal(OVERRIDABLE_PATH_KEYS.length, 11);
    assert.equal(OVERRIDABLE_PATH_KEYS.includes("/primaryArchetype"), true);
    assert.equal(OVERRIDABLE_PATH_KEYS.includes("/adminReviewNotes"), true);
    assert.equal(OVERRIDABLE_PATH_KEYS.includes("/suggestedHashtags" as never), false);
  });

  it("validates values against the canonical per-path schema", () => {
    assert.equal(validateOverrideValue("/overhypeFit", "questionable").ok, true);
    assert.equal(validateOverrideValue("/overhypeFit", "nope").ok, false);
    assert.equal(validateOverrideValue("/modifiers", ["a", "b"]).ok, true);
  });
});
