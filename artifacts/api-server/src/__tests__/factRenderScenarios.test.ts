/**
 * Unit tests for the entity-agnostic render-scenario policy (factRenderScenarios.ts):
 * input-hash stability/sensitivity, 
 * required-scenario problem computation, status derivation, engine provenance.
 * Pure — no DB, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { FactEnrichment } from "@workspace/api-zod";
import {
  buildScenarioInputHash,
  deriveScenarioStatus,
  generationModeForSubjectRenderMode,
  isAttemptStale,
  type ScenarioHashInputs,
} from "../lib/factRenderScenarios.js";

const ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: ["grounded_realism"],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "legendary", "earth"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
  characters: [],
};

function baseHashInputs(): ScenarioHashInputs {
  return {
    stagingFactId: 1,
    scenarioKey: "i2i_male_default",
    subjectRenderMode: "human_identity_i2i",
    renderedFactText: "David Franklin bench-presses the Earth.",
    enrichment: ENRICHMENT,
    referenceIdentityType: "male",
    referenceAssetVersion: "1",
    renderControls: { aspectRatio: "portrait", contentMode: "sfw", fallbackSubjectGender: null },
    lookStyleId: null,
    styleSuffixVersion: null,
    identityPolicy: {
      subjectRenderMode: "human_identity_i2i",
      preserveHumanFace: true,
      preserveNonhumanSubjectIdentity: false,
      preservePhysique: false,
      allowBodyExaggeration: true,
      allowCostumeTransformation: true,
      allowAnthropomorphicTransformation: false,
      ageAndLifeStagePolicy: "follow_fact",
    },
    actualImageEngineId: "nano-banana-2-edit",
  };
}

describe("buildScenarioInputHash", () => {
  it("is deterministic for identical inputs", () => {
    assert.equal(buildScenarioInputHash(baseHashInputs()), buildScenarioInputHash(baseHashInputs()));
  });

  it("changes when a render-affecting field changes (modifier)", () => {
    const a = buildScenarioInputHash(baseHashInputs());
    const inputs = baseHashInputs();
    inputs.enrichment = { ...ENRICHMENT, modifiers: ["grounded_realism", "baby_child_version"] };
    assert.notEqual(buildScenarioInputHash(inputs), a);
  });

  it("does NOT change when only a non-render field changes (notes / hashtags / confidence / overhypeFit / adultSuitability)", () => {
    const a = buildScenarioInputHash(baseHashInputs());
    const inputs = baseHashInputs();
    inputs.enrichment = {
      ...ENRICHMENT,
      adminReviewNotes: "totally different note",
      suggestedHashtags: ["other", "tags", "here"],
      taxonomyConfidence: 0.1,
      adultSuitabilityNotes: "changed",
      // Quality/gating signals: printed only in the generator's fixed-taxonomy
      // context block, ignored by the compiler → must not flip renders stale.
      overhypeFit: "questionable",
      adultSuitability: "requires_review",
    };
    assert.equal(buildScenarioInputHash(inputs), a);
  });

  it("changes when ONLY visualPromptStrategyOverride.coreSceneOverride changes (visual-concept staleness)", () => {
    // The Visual concept UX depends on this: typing a scene must flip scenario
    // tiles stale without any other enrichment change.
    const override = (coreSceneOverride?: string) => ({
      version: 1 as const,
      requiredVisualDetails: [],
      forbiddenVisualDetails: [],
      roleBindings: [],
      compositionGuidance: [],
      styleAgnosticPromptAdditions: [],
      negativePromptAdditions: [],
      bubbles: [],
      ...(coreSceneOverride !== undefined ? { coreSceneOverride } : {}),
    });
    const withScene = baseHashInputs();
    withScene.enrichment = { ...ENRICHMENT, visualPromptStrategyOverride: override("David rides a giant rubber duck.") };
    const withoutScene = baseHashInputs();
    withoutScene.enrichment = { ...ENRICHMENT, visualPromptStrategyOverride: override() };
    const editedScene = baseHashInputs();
    editedScene.enrichment = { ...ENRICHMENT, visualPromptStrategyOverride: override("David rides a T-Rex.") };

    const a = buildScenarioInputHash(withScene);
    assert.notEqual(a, buildScenarioInputHash(withoutScene));
    assert.notEqual(a, buildScenarioInputHash(editedScene));
    // Deterministic for the identical scene.
    const again = baseHashInputs();
    again.enrichment = { ...ENRICHMENT, visualPromptStrategyOverride: override("David rides a giant rubber duck.") };
    assert.equal(a, buildScenarioInputHash(again));
  });

  it("changes when the reference asset version changes", () => {
    const a = buildScenarioInputHash(baseHashInputs());
    const inputs = baseHashInputs();
    inputs.referenceAssetVersion = "2";
    assert.notEqual(buildScenarioInputHash(inputs), a);
  });

  it("changes when the look style changes", () => {
    const a = buildScenarioInputHash(baseHashInputs());
    const inputs = baseHashInputs();
    inputs.lookStyleId = "noir";
    inputs.styleSuffixVersion = "v9";
    assert.notEqual(buildScenarioInputHash(inputs), a);
  });

  it("is insensitive to modifier ordering", () => {
    const a = baseHashInputs();
    a.enrichment = { ...ENRICHMENT, modifiers: ["a_mod", "b_mod"] };
    const b = baseHashInputs();
    b.enrichment = { ...ENRICHMENT, modifiers: ["b_mod", "a_mod"] };
    assert.equal(buildScenarioInputHash(a), buildScenarioInputHash(b));
  });

  it("does NOT change when only a retired text/logo modifier is added (inert legacy data)", () => {
    const a = baseHashInputs();
    a.enrichment = { ...ENRICHMENT, modifiers: ["grounded_realism"] };
    const withRetired = baseHashInputs();
    withRetired.enrichment = {
      ...ENRICHMENT,
      modifiers: ["grounded_realism", "no_readable_text", "avoid_readable_ui", "avoid_real_logos"],
    };
    // Retired names are filtered out of the render-affecting projection, so
    // removing an old amber chip must not spuriously flip a render stale.
    assert.equal(buildScenarioInputHash(a), buildScenarioInputHash(withRetired));
  });

  it("DOES change when a non-retired custom modifier is added (still render-affecting)", () => {
    const a = baseHashInputs();
    a.enrichment = { ...ENRICHMENT, modifiers: ["grounded_realism"] };
    const withCustom = baseHashInputs();
    withCustom.enrichment = { ...ENRICHMENT, modifiers: ["grounded_realism", "custom_live_modifier"] };
    assert.notEqual(buildScenarioInputHash(a), buildScenarioInputHash(withCustom));
  });
});

describe("buildScenarioInputHash — fact characters (PLAN_BUBBLE_SPEAKERS.md, A)", () => {
  const MOM = [{ label: "mom", kind: "person" as const, ofSubject: true }];
  it("changes when the character list changes (the planner reads it)", () => {
    const a = buildScenarioInputHash(baseHashInputs());
    const b = buildScenarioInputHash({ ...baseHashInputs(), enrichment: { ...ENRICHMENT, characters: MOM } });
    assert.notEqual(a, b);
  });
  it("does NOT change for an empty list (hashes exactly as before the field existed)", () => {
    const a = buildScenarioInputHash(baseHashInputs());
    const b = buildScenarioInputHash({ ...baseHashInputs(), enrichment: { ...ENRICHMENT, characters: [] } });
    assert.equal(a, b);
  });
  it("does NOT change when only the extraction marker changes", () => {
    const withList = { ...ENRICHMENT, characters: MOM };
    const a = buildScenarioInputHash({ ...baseHashInputs(), enrichment: withList });
    const b = buildScenarioInputHash({
      ...baseHashInputs(),
      enrichment: { ...withList, charactersExtraction: { promptVersion: "v1", extractedAt: "2026-11-15T00:00:00.000Z" } },
    });
    assert.equal(a, b);
  });
});

describe("isAttemptStale", () => {
  it("stale when the stored hash differs from the current hash", () => {
    assert.equal(isAttemptStale({ reviewRenderInputHash: "old" } as never, "new"), true);
    assert.equal(isAttemptStale({ reviewRenderInputHash: "same" } as never, "same"), false);
  });
});

describe("engine provenance + status derivation", () => {
  it("maps each subject render mode to its generation mode", () => {
    assert.equal(generationModeForSubjectRenderMode("human_identity_i2i"), "i2i");
    assert.equal(generationModeForSubjectRenderMode("nonhuman_subject_i2i"), "i2i");
    assert.equal(generationModeForSubjectRenderMode("t2i_fallback"), "t2i");
  });

  it("derives scenario status from attempt fields", () => {
    const base = { id: 1, subjectRenderMode: "t2i_fallback", generationMode: "t2i", visualPlan: null, compiledPrompt: null, subjectFactCompatibility: null, generatedImageObjectPath: null, error: null };
    assert.equal(deriveScenarioStatus(base as never), "queued");
    assert.equal(deriveScenarioStatus({ ...base, visualPlan: { a: 1 } } as never), "rendering");
    assert.equal(deriveScenarioStatus({ ...base, generatedImageObjectPath: "/x.png" } as never), "done");
    assert.equal(deriveScenarioStatus({ ...base, error: "boom" } as never), "failed");
    // Legacy-row compatibility only: new attempts never write this error string
    // (subjectFactCompatibility is advisory-only and never blocks), but historical
    // rows that already carry it must keep mapping to "blocked".
    assert.equal(deriveScenarioStatus({ ...base, error: "subject_fact_compatibility_poor" } as never), "blocked");
  });
});

describe("buildScenarioInputHash — a gag's cast (PLAN_GAG_DIRECT_RENDER.md, increment 2)", () => {
  const gag = { version: 1 as const, coreSceneOverride: "{NAME} lifts a car; mom gasps.", requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [], bubbles: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [] };
  const withGag = (vso: unknown) => buildScenarioInputHash({ ...baseHashInputs(), enrichment: { ...ENRICHMENT, visualPromptStrategyOverride: vso as FactEnrichment["visualPromptStrategyOverride"] } });
  it("does NOT change when the cast fill adds a cast (no render reads it before the switch)", () => {
    const filled = { ...gag, cast: [{ label: "mom", description: "the woman gasping" }], castExtraction: { promptVersion: "v2", extractedAt: "2026-11-17T00:00:00.000Z", sourceKey: "k" } };
    assert.equal(withGag(gag), withGag(filled));
  });
  it("still changes when the scene changes", () => {
    assert.notEqual(withGag(gag), withGag({ ...gag, coreSceneOverride: "{NAME} lifts a bus." }));
  });
});
