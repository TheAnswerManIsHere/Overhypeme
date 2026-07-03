/**
 * Unit tests for the entity-agnostic render-scenario policy (factRenderScenarios.ts):
 * input-hash stability/sensitivity, conservative non-human applicability,
 * required-scenario problem computation, status derivation, engine provenance.
 * Pure — no DB, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { FactEnrichment } from "@workspace/api-zod";
import {
  actualImageEngineIdForGenerationMode,
  buildScenarioInputHash,
  deriveScenarioStatus,
  generationModeForSubjectRenderMode,
  isAttemptStale,
  nonHumanScenarioKeyForApplicability,
  requiredScenarioProblems,
  resolveNonHumanScenarioApplicability,
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
      enabled: true,
      requiredVisualDetails: [],
      forbiddenVisualDetails: [],
      roleBindings: [],
      compositionGuidance: [],
      styleAgnosticPromptAdditions: [],
      negativePromptAdditions: [],
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
});

describe("isAttemptStale", () => {
  it("stale when the stored hash differs from the current hash", () => {
    assert.equal(isAttemptStale({ reviewRenderInputHash: "old" } as never, "new"), true);
    assert.equal(isAttemptStale({ reviewRenderInputHash: "same" } as never, "same"), false);
  });
});

describe("resolveNonHumanScenarioApplicability", () => {
  it("does NOT auto-run (PR1 conservative: manual-force only)", () => {
    const app = resolveNonHumanScenarioApplicability(ENRICHMENT, "{NAME} bench-presses the Earth.");
    assert.equal(app.autoRun, false);
    assert.ok(app.negativeEvidence.length > 0);
  });

  it('"fought a shark" does NOT auto-run just because an animal is present', () => {
    const app = resolveNonHumanScenarioApplicability(ENRICHMENT, "{NAME} fought a shark and won.");
    assert.equal(app.autoRun, false);
    // subtype hint may lean animal, but that never implies a non-human subject.
    assert.equal(app.subtype, "animal");
  });

  it("maps subtype to the correct scenario key", () => {
    assert.equal(nonHumanScenarioKeyForApplicability({ subtype: "animal" } as never), "i2i_nonhuman_animal");
    assert.equal(nonHumanScenarioKeyForApplicability({ subtype: "object_vehicle" } as never), "i2i_nonhuman_object_vehicle");
    assert.equal(nonHumanScenarioKeyForApplicability({ subtype: "none" } as never), "i2i_nonhuman_object_vehicle");
  });
});

describe("requiredScenarioProblems", () => {
  it("flags missing/failed/stale required scenarios; ignores optional + done", () => {
    const problems = requiredScenarioProblems([
      { scenarioKey: "generic_t2i", status: "done", stale: false },
      { scenarioKey: "i2i_male_default", status: "failed", stale: false },
      { scenarioKey: "i2i_female_default", status: "done", stale: true },
      { scenarioKey: "i2i_nonhuman_animal", status: "missing", stale: false }, // optional — ignored
    ]);
    const byKey = Object.fromEntries(problems.map((p) => [p.scenarioKey, p.status]));
    assert.equal(problems.length, 2);
    assert.equal(byKey["i2i_male_default"], "failed");
    assert.equal(byKey["i2i_female_default"], "stale"); // stale wins over done
    assert.equal(byKey["generic_t2i"], undefined);
    assert.equal(byKey["i2i_nonhuman_animal"], undefined);
  });

  it("clean when all required are fresh + done", () => {
    assert.equal(
      requiredScenarioProblems([
        { scenarioKey: "generic_t2i", status: "done", stale: false },
        { scenarioKey: "i2i_male_default", status: "done", stale: false },
        { scenarioKey: "i2i_female_default", status: "done", stale: false },
      ]).length,
      0,
    );
  });
});

describe("engine provenance + status derivation", () => {
  it("i2i routes to the edit engine; t2i to the base engine", () => {
    assert.equal(actualImageEngineIdForGenerationMode("i2i"), "nano-banana-2-edit");
    assert.equal(actualImageEngineIdForGenerationMode("t2i"), "nano-banana-2");
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
    assert.equal(deriveScenarioStatus({ ...base, error: "subject_fact_compatibility_poor" } as never), "blocked");
  });
});
