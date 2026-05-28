/**
 * Phase 2 image-prompt validator unit tests.
 *
 * Exercises validateImagePromptPlan() against the wire schema + business
 * rules. Pure unit tests — no DB, no LLM, no IO.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateImagePromptPlan,
  type PlanExpectations,
} from "@workspace/api-zod";

const baseExpectations: PlanExpectations = {
  archetype: "object_logic_impossibility",
  subtype: "medium_contradiction",
  targetEngine: "nano_banana_2",
  subjectRenderMode: "human_identity_i2i",
  generationMode: "i2i",
  preserveHumanFace: true,
  preservePhysique: false,
  factText: "David sets an ant on fire with a magnifying glass. At night.",
  fallbackSubjectGender: null,
};

function basePlan(overrides: Partial<{
  subjectRenderMode: PlanExpectations["subjectRenderMode"];
  generationMode: PlanExpectations["generationMode"];
  archetype: PlanExpectations["archetype"];
  subtype: string;
  nonhumanApplicable: boolean;
  nonhumanSubjectKind: "animal_subject" | "object_subject" | "vehicle_subject" | "mascot_or_character_subject" | "not_applicable";
  preserveTraits: string[];
  anthropomorphicTreatment: "none" | "subtle_pose" | "costume_and_pose" | "full_cartoonish_anthropomorphism";
  doNotTransformIntoHuman: boolean;
  fallbackSubjectGender: "male" | "female" | "neutral" | "not_applicable";
  identityPreservation: "human_face" | "nonhuman_visual_identity" | "none";
  promptText: string;
  expressionAndPose: string;
  allowSupportingText: boolean;
  supportingTextElements: Array<{ content: string; purpose: string; placement: string }>;
  keyVisualElements: string[];
  compatibilityRating: "strong" | "workable" | "risky" | "poor";
  compatibilityFallback: "none" | "t2i_fallback" | "upload_human_photo" | "choose_different_fact";
}> = {}) {
  return {
    visualPlan: {
      sceneConcept: "David at night with magnifying glass focusing impossible moonlight onto an ant",
      visualGoal: "Make the night-time impossibility immediately legible",
      visualApproach: "Cinematic close-up with clear night sky and focused beam",
      archetypeApplication: {
        primaryArchetype: overrides.archetype ?? "object_logic_impossibility",
        subtype: overrides.subtype ?? "medium_contradiction",
        selectedFrame: "direct_action",
        strategyRationale: "Authored strategy applies; night sky must be visible.",
      },
      keyVisualElements: overrides.keyVisualElements ?? [
        "David central foreground",
        "clearly nighttime sky",
        "magnifying glass in hand",
        "focused impossible moonlight beam",
        "small flame at the ant position",
      ],
      subjectTreatment: {
        roleInScene: "Legendary protagonist",
        subjectRenderMode: overrides.subjectRenderMode ?? "human_identity_i2i",
        identityPreservation: overrides.identityPreservation ?? "human_face",
        nonhumanSubjectTreatment: {
          applicable: overrides.nonhumanApplicable ?? false,
          subjectKind: overrides.nonhumanSubjectKind ?? "not_applicable",
          preserveTraits: overrides.preserveTraits ?? [],
          anthropomorphicTreatment: overrides.anthropomorphicTreatment ?? "none",
          doNotTransformIntoHuman: overrides.doNotTransformIntoHuman ?? false,
        },
        fallbackSubjectGender: overrides.fallbackSubjectGender ?? "not_applicable",
        expressionAndPose: overrides.expressionAndPose ?? "Confident, focused, calm",
      },
      subjectFactCompatibility: {
        rating: overrides.compatibilityRating ?? "strong",
        reason: "The fact stages well on a human protagonist.",
        recommendedFallback: overrides.compatibilityFallback ?? "none",
      },
      composition: {
        subjectFraming: "Medium close-up",
        negativeSpace: "top" as const,
        cameraStyle: "Cinematic 35mm",
        sceneReadability: "Night sky + focused beam are the readable elements",
      },
      supportingTextPolicy: {
        allowSupportingText: overrides.allowSupportingText ?? false,
        supportingTextElements: overrides.supportingTextElements ?? [],
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
      styleIntegration: "Apply cinematic style with shallow depth of field",
      contentNotes: "SFW; no real brand marks",
      debugNotes: "Strategy v2; example #2 echoed",
      targetEngine: "nano_banana_2" as const,
      generationMode: (overrides.generationMode ?? "i2i") as "i2i" | "t2i",
    },
    compiledPrompt: {
      prompt:
        overrides.promptText ??
        "Image-to-image edit using the reference image as the person's facial identity source. Preserve the reference person's recognizable face. David stands outside at night holding a magnifying glass over a tiny ant while an impossible beam of moonlight focuses through the lens.",
      negativePrompt: "",
      engineNotes: "",
    },
  };
}

describe("validateImagePromptPlan", () => {
  it("accepts a valid human i2i plan", () => {
    const result = validateImagePromptPlan(basePlan(), baseExpectations);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
  });

  it("rejects when targetEngine echo mismatches", () => {
    const plan = basePlan();
    (plan.visualPlan as { targetEngine: string }).targetEngine = "some_other_engine";
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /targetEngine/);
    }
  });

  it("rejects archetype mismatch", () => {
    const plan = basePlan({ archetype: "superhuman_physical_feat" });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /primaryArchetype/);
  });

  it("rejects subtype not in archetype's allowed set", () => {
    const plan = basePlan({ subtype: "not_a_real_subtype" });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
  });

  it("rejects fewer than 3 keyVisualElements", () => {
    const plan = basePlan({ keyVisualElements: ["a", "b"] });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /keyVisualElements/);
  });

  it("rejects more than 12 keyVisualElements", () => {
    const plan = basePlan({ keyVisualElements: new Array(13).fill("x") });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
  });

  it("rejects missing mandatory forbiddenTextTypes entry", () => {
    const plan = basePlan();
    plan.visualPlan.supportingTextPolicy.forbiddenTextTypes = ["watermarks", "real logos"]; // missing the rest
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /forbiddenTextTypes/);
  });

  it("rejects supportingTextElements when allowSupportingText=false", () => {
    const plan = basePlan({
      allowSupportingText: false,
      supportingTextElements: [{ content: "1234", purpose: "PIN", placement: "keypad" }],
    });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /allowSupportingText/);
  });

  it("accepts structured supportingTextElements when allowed", () => {
    const plan = basePlan({
      allowSupportingText: true,
      supportingTextElements: [
        { content: "1234", purpose: "Random PIN digits", placement: "keypad" },
      ],
    });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
  });

  it("rejects human i2i without face-preservation language", () => {
    const plan = basePlan({ promptText: "A cinematic scene of David doing the impossible." });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /face-preservation/);
  });

  it("rejects t2i prompt that claims face preservation", () => {
    const t2iExpectations: PlanExpectations = {
      ...baseExpectations,
      subjectRenderMode: "t2i_fallback",
      generationMode: "t2i",
      preserveHumanFace: false,
      fallbackSubjectGender: "neutral",
    };
    const plan = basePlan({
      subjectRenderMode: "t2i_fallback",
      generationMode: "t2i",
      identityPreservation: "none",
      fallbackSubjectGender: "neutral",
      promptText: "Preserve the reference person's recognizable face. A cinematic scene featuring neutral.",
    });
    const result = validateImagePromptPlan(plan, t2iExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /facial likeness/i);
  });

  it("rejects t2i prompt missing fallbackSubjectGender", () => {
    const t2iExpectations: PlanExpectations = {
      ...baseExpectations,
      subjectRenderMode: "t2i_fallback",
      generationMode: "t2i",
      preserveHumanFace: false,
      fallbackSubjectGender: "male",
    };
    const plan = basePlan({
      subjectRenderMode: "t2i_fallback",
      generationMode: "t2i",
      identityPreservation: "none",
      fallbackSubjectGender: "male",
      promptText: "Generate a protagonist in a cinematic scene about an ant and a magnifying glass.",
    });
    const result = validateImagePromptPlan(plan, t2iExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /fallbackSubjectGender/);
  });

  it("accepts nonhuman_subject_i2i with applicable=true + traits + doNotTransformIntoHuman", () => {
    const nonhumanExpectations: PlanExpectations = {
      ...baseExpectations,
      subjectRenderMode: "nonhuman_subject_i2i",
      generationMode: "i2i",
      preserveHumanFace: false,
      preservePhysique: false,
    };
    const plan = basePlan({
      subjectRenderMode: "nonhuman_subject_i2i",
      generationMode: "i2i",
      identityPreservation: "nonhuman_visual_identity",
      nonhumanApplicable: true,
      nonhumanSubjectKind: "animal_subject",
      preserveTraits: ["orange tabby markings", "green eyes"],
      anthropomorphicTreatment: "costume_and_pose",
      doNotTransformIntoHuman: true,
      promptText:
        "Image-to-image edit using the reference image as the visual identity source. Preserve the uploaded subject's recognizable visual identity. Do not replace the subject with a human. A cat at night with a magnifying glass.",
    });
    const result = validateImagePromptPlan(plan, nonhumanExpectations);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
  });

  it("rejects nonhuman_subject_i2i when applicable=false", () => {
    const nonhumanExpectations: PlanExpectations = {
      ...baseExpectations,
      subjectRenderMode: "nonhuman_subject_i2i",
      generationMode: "i2i",
      preserveHumanFace: false,
    };
    const plan = basePlan({
      subjectRenderMode: "nonhuman_subject_i2i",
      generationMode: "i2i",
      identityPreservation: "nonhuman_visual_identity",
      nonhumanApplicable: false,
      nonhumanSubjectKind: "not_applicable",
      promptText:
        "Image-to-image edit using the reference image as the visual identity source. Preserve the uploaded subject's recognizable visual identity. Do not replace the subject with a human. Scene.",
    });
    const result = validateImagePromptPlan(plan, nonhumanExpectations);
    assert.equal(result.ok, false);
  });

  it("rejects human_identity_i2i with applicable=true non-human treatment", () => {
    const plan = basePlan({
      nonhumanApplicable: true,
      nonhumanSubjectKind: "animal_subject",
      preserveTraits: ["whiskers"],
      doNotTransformIntoHuman: true,
    });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
  });

  it("rejects compatibility rating=poor with recommendedFallback=none", () => {
    const plan = basePlan({
      compatibilityRating: "poor",
      compatibilityFallback: "none",
    });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /poor.*recommendedFallback/);
  });

  it("rejects full fact text embedded in compiledPrompt.prompt", () => {
    const plan = basePlan({
      promptText: `Image-to-image edit using the reference image as the person's facial identity source. Preserve the reference person's recognizable face. ${baseExpectations.factText}`,
    });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /full fact text/);
  });

  it("rejects preservePhysique=false with preserve-body language in expressionAndPose", () => {
    const plan = basePlan({
      expressionAndPose: "Preserve the subject's body and physique exactly as in the reference.",
    });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
  });

  it("populates correctableHint for fixable violations", () => {
    const plan = basePlan({ keyVisualElements: ["a"] });
    const result = validateImagePromptPlan(plan, baseExpectations);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.correctableHint, "expected correctableHint to be populated");
    }
  });
});
