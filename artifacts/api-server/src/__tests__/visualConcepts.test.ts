/**
 * Unit tests (pure, no DB / no LLM) for candidate Visual-concept generation
 * (Slice 2A):
 *   - api-zod schema/sanitize: exactly-3 validation, ≤1500 cap, {NAME}
 *     canonicalization, unknown-token → tokenValid:false.
 *   - the mode-agnostic candidate user message: OMITS the runtime blocks
 *     (source-image / subjectRenderMode / generationMode / identity / render
 *     controls / target engine) and INCLUDES fact text / taxonomy / render
 *     policy / authored strategy / cultural refs / semantic entities.
 *   - existing_draft_context vs. blank-field wording (distinct alternatives, NOT
 *     the authoritative directive).
 *   - generateVisualConceptsWithModel: sanitizes + validates count + retries once.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateCandidateConcepts,
  sanitizeCandidateSceneText,
  sanitizeCandidateConcept,
  CANDIDATE_SCENE_MAX_CHARS,
  type FactEnrichment,
} from "@workspace/api-zod";
import {
  buildVisualConceptsUserMessage,
  generateVisualConceptsWithModel,
  type GenerateVisualConceptsInput,
} from "../lib/visualConcepts/generator.js";

const ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: [],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [
    {
      sourcePhrase: "Shark Week",
      referenceType: "tv",
      canonicalReference: "Discovery's Shark Week",
      explanation: "annual shark programming",
      visualImplication: "sharks on a TV",
      confidence: 0.95,
      requiresAdminReview: false,
    },
  ],
  semanticEntities: [
    {
      surfaceText: "Earth",
      normalizedText: "earth",
      entityKind: "celestial_body",
      visualReferent: "the planet Earth",
      capitalizationSignal: "capitalized_named_entity",
      materiallyAffectsVisualPrompt: true,
      requiresAdminReview: false,
      confidence: 0.95,
      notes: "",
    },
  ],
} as unknown as FactEnrichment;

function conceptWire(overrides: Partial<{ title: string; whyItWorks: string; sceneDescription: string }> = {}) {
  return {
    title: overrides.title ?? "Concept",
    whyItWorks: overrides.whyItWorks ?? "It lands.",
    sceneDescription: overrides.sceneDescription ?? "{NAME} lifts the planet overhead in a stadium.",
  };
}

describe("validateCandidateConcepts", () => {
  it("accepts exactly three non-empty concepts", () => {
    const res = validateCandidateConcepts({ concepts: [conceptWire(), conceptWire(), conceptWire()] });
    assert.equal(res.ok, true);
  });

  it("rejects a count other than three", () => {
    assert.equal(validateCandidateConcepts({ concepts: [conceptWire(), conceptWire()] }).ok, false);
    assert.equal(validateCandidateConcepts({ concepts: [conceptWire(), conceptWire(), conceptWire(), conceptWire()] }).ok, false);
  });

  it("rejects an empty title or sceneDescription", () => {
    assert.equal(validateCandidateConcepts({ concepts: [conceptWire({ title: "  " }), conceptWire(), conceptWire()] }).ok, false);
    assert.equal(validateCandidateConcepts({ concepts: [conceptWire(), conceptWire({ sceneDescription: "" }), conceptWire()] }).ok, false);
  });
});

describe("sanitizeCandidateSceneText", () => {
  it("canonicalizes {name}/{Name} → {NAME} and marks a valid scene tokenValid", () => {
    const out = sanitizeCandidateSceneText("{name} lifts {Name_Possessive} planet.");
    assert.match(out.text, /\{NAME\} lifts \{NAME_POSSESSIVE\} planet\./);
    assert.equal(out.tokenValid, true);
    assert.equal(out.tokenError, undefined);
  });

  it("flags an unknown token tokenValid:false with an error", () => {
    const out = sanitizeCandidateSceneText("{NAME} wields {WEATHER} in the storm.");
    assert.equal(out.tokenValid, false);
    assert.ok(out.tokenError && out.tokenError.length > 0);
  });

  it("caps the scene to the coreSceneOverride budget", () => {
    const out = sanitizeCandidateSceneText("x".repeat(CANDIDATE_SCENE_MAX_CHARS + 500));
    assert.equal(out.text.length, CANDIDATE_SCENE_MAX_CHARS);
  });

  it("sanitizeCandidateConcept trims title/whyItWorks and carries token validity", () => {
    const c = sanitizeCandidateConcept(conceptWire({ title: "  Big Lift  ", sceneDescription: "{NAME} lifts {BOGUS}." }));
    assert.equal(c.title, "Big Lift");
    assert.equal(c.tokenValid, false);
    assert.ok(c.tokenError);
  });
});

describe("buildVisualConceptsUserMessage — mode-agnostic context", () => {
  const base: GenerateVisualConceptsInput = { factText: "{NAME} bench-presses the Earth.", enrichment: ENRICHMENT };

  it("INCLUDES the mode-agnostic context blocks", () => {
    const msg = buildVisualConceptsUserMessage(base);
    assert.match(msg, /factTextExact: \{NAME\} bench-presses the Earth\./);
    assert.match(msg, /TAXONOMY \(FIXED — DO NOT reclassify\)/);
    assert.match(msg, /RENDER POLICY/);
    assert.match(msg, /AUTHORED VISUAL STRATEGY/);
    assert.match(msg, /PER-FACT CULTURAL REFERENCES/);
    assert.match(msg, /SEMANTIC ENTITY INTERPRETATION/);
    assert.match(msg, /surfaceText="Earth"/);
  });

  it("OMITS every runtime / mode-specific block", () => {
    const msg = buildVisualConceptsUserMessage(base);
    assert.doesNotMatch(msg, /SOURCE-IMAGE ANALYSIS/);
    assert.doesNotMatch(msg, /RESOLVED subjectRenderMode/);
    assert.doesNotMatch(msg, /RESOLVED generationMode/);
    assert.doesNotMatch(msg, /IDENTITY POLICY/);
    assert.doesNotMatch(msg, /RENDER CONTROLS/);
    assert.doesNotMatch(msg, /TARGET ENGINE/);
  });

  it("OMITS the planner-only visualPlan/compiledPrompt echo-back directives (schema-incompatible with concept output)", () => {
    const msg = buildVisualConceptsUserMessage(base);
    // Data blocks stay (they carry the fact's locked interpretation)...
    assert.match(msg, /surfaceText="Earth"/);
    assert.match(msg, /sourcePhrase="Shark Week"/);
    // ...but the "populate visualPlan.*/compiledPrompt.*" directives must not.
    assert.doesNotMatch(msg, /visualPlan\.semanticEntitiesUsed/);
    assert.doesNotMatch(msg, /visualPlan\.culturalReferencesUsed/);
    assert.doesNotMatch(msg, /compiledPrompt\.prompt/);
  });

  it("blank field → fresh ideas: no moderator scene block at all", () => {
    const msg = buildVisualConceptsUserMessage(base);
    assert.doesNotMatch(msg, /MODERATOR-AUTHORED CORE SCENE/);
    assert.doesNotMatch(msg, /CURRENT MODERATOR DRAFT/);
  });

  it("a draft → existing_draft_context asks for DISTINCT alternatives, not an authoritative directive", () => {
    const msg = buildVisualConceptsUserMessage({ ...base, moderatorDraftScene: "{NAME} lifts a globe in a library." });
    assert.match(msg, /CURRENT MODERATOR DRAFT/);
    assert.match(msg, /\{NAME\} lifts a globe in a library\./);
    assert.match(msg.toLowerCase(), /distinct|different/);
    // Never the authoritative "realize this exact scene" directive.
    assert.doesNotMatch(msg, /MODERATOR-AUTHORED CORE SCENE \(AUTHORITATIVE/);
  });

  it("does NOT echo the moderator draft into an authoritative block three times", () => {
    const draft = "UNIQUEDRAFTMARKER duck stadium";
    const msg = buildVisualConceptsUserMessage({ ...base, moderatorDraftScene: draft });
    const occurrences = msg.split("UNIQUEDRAFTMARKER").length - 1;
    assert.equal(occurrences, 1, "draft appears once as context, not repeated as a directive");
  });
});

describe("generateVisualConceptsWithModel", () => {
  const input: GenerateVisualConceptsInput = { factText: "{NAME} bench-presses the Earth.", enrichment: ENRICHMENT };

  it("returns 3 sanitized candidates from a valid model response", async () => {
    const model = async () => JSON.stringify({ concepts: [conceptWire(), conceptWire(), conceptWire()] });
    const out = await generateVisualConceptsWithModel(input, model);
    assert.equal(out.length, 3);
    assert.equal(out[0]!.tokenValid, true);
  });

  it("retries once on an invalid count, then succeeds", async () => {
    let call = 0;
    const model = async () => {
      call += 1;
      return call === 1
        ? JSON.stringify({ concepts: [conceptWire()] })
        : JSON.stringify({ concepts: [conceptWire(), conceptWire(), conceptWire()] });
    };
    const out = await generateVisualConceptsWithModel(input, model);
    assert.equal(call, 2);
    assert.equal(out.length, 3);
  });

  it("throws after a second invalid response", async () => {
    const model = async () => JSON.stringify({ concepts: [conceptWire()] });
    await assert.rejects(() => generateVisualConceptsWithModel(input, model), /concepts/);
  });
});
