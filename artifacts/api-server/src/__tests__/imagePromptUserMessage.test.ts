/**
 * Unit tests for buildImagePromptUserMessage — the render-time generator's user
 * message. Pure (no LLM): asserts that compact research context, the rendered
 * fact text, the empty-negativePrompt instruction, and the cultural-reference
 * echo requirement are present, and that the taxonomy is presented as fixed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildImagePromptUserMessage, expectationsFromInput, generateImagePromptPlanWithModel } from "../lib/imagePrompt/generator.js";
import type { ImagePromptGenerationInput } from "@workspace/api-zod";

function makeInput(overrides: { culturalReferences?: unknown[]; factText?: string; semanticEntities?: unknown[]; primaryArchetype?: string; subtype?: string; modifiers?: string[]; renderPolicy?: unknown } = {}): ImagePromptGenerationInput {
  const enrichment = {
    primaryArchetype: overrides.primaryArchetype ?? "object_logic_impossibility",
    subtype: overrides.subtype ?? "medium_contradiction",
    modifiers: overrides.modifiers ?? ["face_prominent"],
    visualLiteralness: "literal",
    visualComplexity: "moderate",
    overhypeFit: "high",
    adultSuitability: "sfw",
    taxonomyConfidence: 0.9,
    culturalReferences: overrides.culturalReferences ?? [],
    semanticEntities: overrides.semanticEntities ?? [],
  };
  return {
    factText: overrides.factText ?? "David focuses moonlight through a magnifying glass to set an ant on fire. At night.",
    enrichment,
    renderPolicy: overrides.renderPolicy,
    sourceImageAnalysis: {
      subjectKind: "human_face",
      confidence: "high",
      hasUsableHumanFace: true,
      hasUsableSubject: true,
      subjectCount: 1,
      warnings: [],
      suggestedRenderMode: "human_identity_i2i",
      classificationMethod: "fal_detector",
      analyzerVersion: "v1",
    },
    subjectRenderMode: "human_identity_i2i",
    userSelectedSubjectRenderMode: null,
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
    renderControls: { aspectRatio: "portrait", contentMode: "sfw" },
    stylePrompt: "cinematic",
    referenceImageUrl: null,
    targetEngine: "nano_banana_2",
  } as unknown as ImagePromptGenerationInput;
}

describe("buildImagePromptUserMessage", () => {
  it("includes the rendered fact text verbatim with no template tokens", () => {
    const msg = buildImagePromptUserMessage(makeInput());
    assert.match(msg, /factTextExact: David focuses moonlight/);
    assert.doesNotMatch(msg, /\{NAME\}|\{SUBJ\}|\{POSS\}/);
  });

  it("instructs that negativePrompt must be empty (no negative param)", () => {
    const msg = buildImagePromptUserMessage(makeInput());
    assert.match(msg, /negativePrompt.*empty string/i);
    assert.match(msg.toLowerCase(), /positive scene language/);
  });

  it("presents the taxonomy as fixed (do not reclassify)", () => {
    const msg = buildImagePromptUserMessage(makeInput());
    assert.match(msg, /TAXONOMY \(FIXED — DO NOT reclassify\)/);
  });

  it("describes the concrete visual contract fields and the age-transform binding", () => {
    const msg = buildImagePromptUserMessage(makeInput());
    assert.match(msg, /coreScene: REQUIRED/);
    assert.match(msg, /subjectDetails: REQUIRED/);
    assert.match(msg, /environment: REQUIRED/);
    assert.match(msg, /ageLifeStageTransform/);
    assert.match(msg, /one entity, never an adult plus a separate baby\/child/);
  });

  it("describes secondaryCharacters role binding and the softened central-action rule", () => {
    const msg = buildImagePromptUserMessage(makeInput());
    assert.match(msg, /secondaryCharacters:/);
    assert.match(msg, /\{ label, visualRole \}/);
    // Concrete role, not a bare relationship label.
    assert.match(msg.toLowerCase(), /not\s+"his mother"|not a bare relationship word/i);
    // Softened sole-agent wording (not a global "only the subject acts").
    assert.match(msg.toLowerCase(), /sole active agent/);
    assert.match(msg.toLowerCase(), /co-action, crowd-reaction, role-reversal, causal, or symbolic/);
    // roleInScene must be concrete.
    assert.match(msg, /roleInScene: a CONCRETE visible role\/action/);
    // The baby fact is only a diagnostic — no overfitting.
    assert.match(msg.toLowerCase(), /only a diagnostic/);
  });

  it("forbids authorial-intent commentary in the visual fields", () => {
    const msg = buildImagePromptUserMessage(makeInput());
    assert.match(msg, /DESCRIBE THE PICTURE, NOT THE JOKE/);
    assert.match(msg.toLowerCase(), /showcasing the absurdity/);
  });

  it("omits research context for plain (un-researched) references", () => {
    const msg = buildImagePromptUserMessage(makeInput({
      culturalReferences: [
        { sourcePhrase: "the void", referenceType: "concept", canonicalReference: "", explanation: "", visualImplication: "darkness", confidence: 0.5, requiresAdminReview: false },
      ],
    }));
    assert.doesNotMatch(msg, /researchConfidence=/);
    assert.doesNotMatch(msg, /ambiguityWarnings=/);
  });

  it("includes compact research context (confidence, truncated notes, ≤3 warnings) when present", () => {
    const longNotes = "x".repeat(900);
    const msg = buildImagePromptUserMessage(makeInput({
      culturalReferences: [
        {
          sourcePhrase: "Shark Week",
          referenceType: "tv",
          canonicalReference: "Discovery's Shark Week",
          explanation: "annual shark programming",
          visualImplication: "sharks on a TV screen",
          confidence: 0.95,
          requiresAdminReview: false,
          researchConfidence: "high",
          researchNotes: longNotes,
          ambiguityWarnings: ["w1", "w2", "w3", "w4", "w5"],
        },
      ],
    }));
    assert.match(msg, /researchConfidence=high/);
    // Notes truncated well under the raw 900 chars.
    const notesMatch = msg.match(/researchNotes="([^"]*)"/);
    assert.ok(notesMatch, "expected researchNotes in message");
    assert.ok(notesMatch![1]!.length < 500, `notes not truncated: ${notesMatch![1]!.length}`);
    // At most 3 warnings surfaced.
    assert.match(msg, /ambiguityWarnings=\["w1", "w2", "w3"\]/);
    assert.doesNotMatch(msg, /w4/);
    // Material reference → required in culturalReferencesUsed echo.
    assert.match(msg, /culturalReferencesUsed: MUST include an entry/);
    assert.match(msg, /"Shark Week"/);
  });

  it("never echoes or requires the personalized subject even if enrichment stored it as a semantic entity", () => {
    const EARTH = {
      surfaceText: "Earth", normalizedText: "earth", entityKind: "celestial_body",
      visualReferent: "the planet Earth", capitalizationSignal: "capitalized_named_entity",
      materiallyAffectsVisualPrompt: true, requiresAdminReview: false, confidence: 0.95, notes: "",
    };
    const ALEX = {
      surfaceText: "Alex", normalizedText: "alex", entityKind: "named_entity",
      visualReferent: "a person", capitalizationSignal: "capitalized_named_entity",
      materiallyAffectsVisualPrompt: true, requiresAdminReview: false, confidence: 0.9, notes: "",
    };
    const input = makeInput({ semanticEntities: [EARTH, ALEX] });

    // Defensive strip in buildImagePromptUserMessage: the subject is neither
    // listed in the semantic block nor in the required-echo line; Earth still is.
    const msg = buildImagePromptUserMessage(input);
    assert.doesNotMatch(msg, /"Alex"/);
    assert.doesNotMatch(msg, /surfaceText="Alex"/);
    assert.match(msg, /surfaceText="Earth"/);
    assert.match(msg, /semanticEntitiesUsed: MUST include an entry for each of \["Earth"\]/);

    // Validator expectations (rule 14 required-echo list) exclude the subject
    // but still require the real referent.
    const exp = expectationsFromInput(input);
    assert.deepEqual(exp.materialSemanticEntities, ["Earth"]);
  });
});

// ── Template-token filter regression ─────────────────────────────────────────
//
// Facts whose semantic entities use template tokens ({NAME}, {Subj}, {SUBJ})
// as surfaceText are common. After renderPersonalized() the model receives
// "David Franklin doesn't read books." — the token {NAME} never appears in
// the rendered text. If the model echoes "David Franklin" instead of "{NAME}"
// in semanticEntitiesUsed, the old code would throw ImagePromptError on the
// second validation failure. The fix filters template-token surface texts out
// of expectationsFromInput so they are never required to be echoed back.
describe("generateImagePromptPlanWithModel — template-token entity filter", () => {
  const VALID_PLAN = {
    visualPlan: {
      sceneConcept: "David stares at books until they surrender their knowledge",
      visualGoal: "Convey awe-inspiring presence",
      visualApproach: "Cinematic close-up",
      archetypeApplication: {
        primaryArchetype: "presence_induced_reaction_aura",
        subtype: "awe_deference",
        selectedFrame: "direct_action",
        strategyRationale: "Presence causes objects to react.",
      },
      coreScene: "David stands in a library, books glowing around him as he stares them down.",
      subjectDetails: ["intense focused gaze", "calm commanding posture"],
      environment: ["library shelves towering overhead", "soft glow from books"],
      lightingAndStyle: "dramatic chiaroscuro lighting",
      keyVisualElements: [
        "David central",
        "glowing books",
        "library setting",
        "dramatic lighting",
        "subtle shimmer",
      ],
      subjectTreatment: {
        roleInScene: "Legendary protagonist",
        subjectRenderMode: "human_identity_i2i" as const,
        identityPreservation: "human_face" as const,
        nonhumanSubjectTreatment: {
          applicable: false,
          subjectKind: "not_applicable" as const,
          preserveTraits: [],
          anthropomorphicTreatment: "none" as const,
          doNotTransformIntoHuman: false,
        },
        fallbackSubjectGender: "not_applicable" as const,
        expressionAndPose: "Confident, intense, unfazed",
        ageLifeStageTransform: { applies: false, targetState: "" },
      },
      subjectFactCompatibility: {
        rating: "strong" as const,
        reason: "Human protagonist works well.",
        recommendedFallback: "none" as const,
      },
      composition: {
        subjectFraming: "Medium close-up",
        negativeSpace: "top" as const,
        cameraStyle: "Cinematic 35mm",
        sceneReadability: "Glowing books and intense gaze readable at a glance",
      },
      supportingTextPolicy: {
        allowSupportingText: false,
        supportingTextElements: [],
        forbiddenTextTypes: [
          "full meme captions",
          "full fact text",
          "hashtags",
          "watermarks",
          "real logos",
          "brand marks",
          "long explanatory paragraphs",
        ],
      },
      secondaryCharacters: [],
      // Model echoes the resolved name "David Franklin" — NOT the template token "{NAME}".
      // With the filter in place this should be accepted (no echo-back required for {NAME}).
      semanticEntitiesUsed: [],
      culturalReferencesUsed: [],
      styleIntegration: "Dramatic cinematic lighting",
      contentNotes: "SFW",
      debugNotes: "",
      targetEngine: "nano_banana_2" as const,
      generationMode: "i2i" as const,
    },
    compiledPrompt: {
      prompt:
        "Image-to-image edit using the reference image as the person's facial identity source. Preserve the reference person's recognizable face. David Franklin stands in a library surrounded by glowing books, staring them down with an intense gaze.",
      negativePrompt: "",
      engineNotes: "",
    },
  };

  it("succeeds when template-token material entities are omitted from semanticEntitiesUsed", async () => {
    const input: ImagePromptGenerationInput = {
      ...makeInput(),
      enrichment: {
        primaryArchetype: "presence_induced_reaction_aura",
        subtype: "awe_deference",
        modifiers: [],
        visualLiteralness: "mixed",
        visualComplexity: "medium",
        overhypeFit: "strong",
        adultSuitability: "safe",
        taxonomyConfidence: 0.9,
        culturalReferences: [],
        // Three material entities — all template tokens.
        // The model will receive the rendered text (no {NAME} etc.) and
        // cannot reliably echo these back; they should be filtered out of
        // the required echo-back list.
        semanticEntities: [
          {
            surfaceText: "{NAME}",
            entityKind: "named_entity",
            visualReferent: "a person with a legendary presence",
            capitalCaseLocked: false,
            capitalizationSignal: "capitalized_named_entity",
            materiallyAffectsVisualPrompt: true,
            requiresAdminReview: false,
            confidence: 0.9,
            notes: "Represents the subject's name.",
          },
          {
            surfaceText: "{Subj}",
            entityKind: "named_entity",
            visualReferent: "the subject of the fact",
            capitalCaseLocked: false,
            capitalizationSignal: "capitalized_named_entity",
            materiallyAffectsVisualPrompt: true,
            requiresAdminReview: false,
            confidence: 0.9,
            notes: "Represents the subject's pronoun.",
          },
          {
            surfaceText: "{SUBJ}",
            entityKind: "named_entity",
            visualReferent: "the subject of the fact",
            capitalCaseLocked: false,
            capitalizationSignal: "capitalized_named_entity",
            materiallyAffectsVisualPrompt: true,
            requiresAdminReview: false,
            confidence: 0.9,
            notes: "Represents the subject's pronoun.",
          },
        ],
      } as unknown as ImagePromptGenerationInput["enrichment"],
      factText: "David Franklin doesn't read books. He stares them down until he gets the information he wants.",
      subjectRenderMode: "human_identity_i2i",
      targetEngine: "nano_banana_2",
    };

    // Mock model always returns the valid plan (which has semanticEntitiesUsed: []).
    // Before the filter, this would fail with ImagePromptError because the
    // {NAME}/{Subj}/{SUBJ} template tokens wouldn't be found in semanticEntitiesUsed.
    const mockModel = async () => JSON.stringify(VALID_PLAN);
    const result = await generateImagePromptPlanWithModel(input, mockModel);
    assert.ok(result.visualPlan, "should resolve without throwing");
  });
});

describe("buildImagePromptUserMessage — no automatic violence/gore self-censoring", () => {
  const GRENADE = {
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: ["projectile_impact_power", "normal_function_rendered_unnecessary"],
    factText: "David threw a grenade and killed 50 people, then it exploded.",
  };

  it("the strategy prose fed to the generator no longer forbids bodies/gore/casualties", () => {
    const msg = buildImagePromptUserMessage(makeInput(GRENADE));
    assert.doesNotMatch(msg, /non-graphic/i);
    assert.doesNotMatch(msg, /avoid bodies|no bodies/i);
    assert.doesNotMatch(msg, /visible casualties|readable casualty numbers/i);
    assert.doesNotMatch(msg, /environmental impact only/i);
    assert.doesNotMatch(msg, /but no bodies or gore are depicted/i);
    // ...but the real redundant-mechanism constraints survive.
    assert.match(msg, /intact|unexploded/i);
    assert.match(msg, /the throw is/i);
  });

  it("includes a RENDER POLICY block ahead of the visual-strategy scene-planning context", () => {
    const msg = buildImagePromptUserMessage(makeInput(GRENADE));
    const policyAt = msg.indexOf("RENDER POLICY");
    const strategyAt = msg.indexOf("AUTHORED VISUAL STRATEGY");
    assert.ok(policyAt >= 0, "RENDER POLICY block present");
    assert.ok(policyAt < strategyAt, "RENDER POLICY appears before the strategy/scene-planning block");
    // Default policy = allow + strong: depict required bodies/casualties.
    assert.match(msg, /violence=ALLOW \(strong\)/);
    assert.match(msg, /INCLUDING the bodies\/casualties the fact calls for, without gratuitous gore/);
  });

  it("surfaces a moderator suppress override in the RENDER POLICY block", () => {
    const msg = buildImagePromptUserMessage(makeInput({
      ...GRENADE,
      renderPolicy: { supportingText: { mode: "allow" }, violence: { mode: "suppress", intensity: "nonviolent", guidance: "Keep it bloodless." } },
    }));
    assert.match(msg, /violence=SUPPRESS/);
    assert.match(msg, /Moderator guidance: Keep it bloodless\./);
    assert.doesNotMatch(msg, /violence=ALLOW/);
  });
});

// ── Moderator-authored core scene directive ("Visual concept") — slice 1 ────

describe("buildImagePromptUserMessage — moderator core-scene directive", () => {
  function withOverride(
    override: Record<string, unknown> | undefined,
    renderedSubject?: { name: string; pronouns: string | null },
  ): ImagePromptGenerationInput {
    const base = makeInput();
    return {
      ...base,
      enrichment: { ...base.enrichment, ...(override ? { visualPromptStrategyOverride: override } : {}) },
      ...(renderedSubject ? { renderedSubject } : {}),
    } as unknown as ImagePromptGenerationInput;
  }
  const OV = (partial: Record<string, unknown> = {}) => ({
    version: 1,
    enabled: true,
    requiredVisualDetails: [],
    forbiddenVisualDetails: [],
    roleBindings: [],
    compositionGuidance: [],
    styleAgnosticPromptAdditions: [],
    negativePromptAdditions: [],
    ...partial,
  });

  it("injects the authoritative directive when enabled + non-empty", () => {
    const msg = buildImagePromptUserMessage(
      withOverride(OV({ coreSceneOverride: "David rides a giant rubber duck across a stadium." })),
    );
    assert.match(msg, /MODERATOR-AUTHORED CORE SCENE \(AUTHORITATIVE — hard directive\)/);
    assert.match(msg, /"David rides a giant rubber duck across a stadium\."/);
    assert.match(msg, /Do NOT invent a different concept/);
    assert.match(msg, /faithful \(optionally tightened\) version/);
  });

  it("token-renders the directive so the model never sees raw tokens", () => {
    const msg = buildImagePromptUserMessage(
      withOverride(
        OV({ coreSceneOverride: "{NAME} rides a T-Rex through {NAME_POSSESSIVE} office." }),
        { name: "David Franklin", pronouns: "he/him" },
      ),
    );
    assert.match(msg, /"David Franklin rides a T-Rex through David Franklin's office\."/);
    assert.doesNotMatch(msg, /\{NAME\}|\{SUBJ\}|\{POSS\}/);
  });

  it("omits the directive when the override is disabled, empty, or absent", () => {
    for (const input of [
      withOverride(OV({ enabled: false, coreSceneOverride: "David rides a duck." })),
      withOverride(OV({ coreSceneOverride: "   " })),
      withOverride(undefined),
    ]) {
      const msg = buildImagePromptUserMessage(input);
      assert.doesNotMatch(msg, /MODERATOR-AUTHORED CORE SCENE/);
    }
  });

  it("reads ONLY coreSceneOverride — other override fields stay out of the planner message", () => {
    const msg = buildImagePromptUserMessage(
      withOverride(
        OV({
          coreSceneOverride: "David rides a duck.",
          requiredVisualDetails: ["a scoreboard reading 9999"],
          forbiddenVisualDetails: ["a separate adult version"],
        }),
      ),
    );
    assert.match(msg, /David rides a duck\./);
    assert.doesNotMatch(msg, /scoreboard reading 9999/);
    assert.doesNotMatch(msg, /separate adult version/);
  });
});
