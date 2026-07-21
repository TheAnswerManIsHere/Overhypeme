/**
 * `measureRequiredPromptBudget()` — the measured proof behind the §10.4 / §21
 * budget numbers.
 *
 * The api-zod `promptBudget.ts` declares the moderator authoring reserves
 * (FIXED_REQUIRED_RESERVE_BUDGET, CORE_SCENE_RENDERED_MAX, …) but CANNOT measure
 * the compiler's fixed overhead — the compiler lives here. This helper runs the
 * REAL compiler across all three subject render modes at MAXIMUM fixed shape:
 *   • the moderator Concept and every moderator addition EMPTY (their content is
 *     budgeted separately), and no AI compressible content, so what remains is
 *     exactly the compiler-owned fixed required sections;
 *   • the render identity at its bound (a RENDERED_IDENTITY_NAME_MAX-char name);
 *   • the render style at its bound (RENDER_STYLE_COPY_MAX_CHARS);
 *   • the longest fixed policy branches (require-text + violence-allow lines);
 *   • the age-transform binding active (the longest fixed SUBJECT BINDING form).
 *
 * It returns the per-mode measured length and the worst-case max. A proof test
 * asserts `worstCase + CORE_SCENE_RENDERED_MAX + MODERATOR_ADDITIONS_RENDERED_MAX
 * + PROMPT_OUTER_MARGIN <= PROMPT_TOTAL_BUDGET`, so a compiler wording change
 * that grows a required section fails the test instead of silently eating the
 * moderator pool.
 */

import type { ImagePromptGenerationInput, VisualPlan, RenderPolicy } from "@workspace/api-zod";
import { RENDERED_IDENTITY_NAME_MAX } from "@workspace/api-zod";
import {
  compileNanoBanana2HumanI2I,
  compileNanoBanana2NonhumanI2I,
  compileNanoBanana2T2I,
} from "./compilers/nanoBanana2";
import { RENDER_STYLE_COPY_MAX_CHARS } from "./styleResolution";

export type SubjectRenderModeKey = "human_identity_i2i" | "nonhuman_subject_i2i" | "t2i_fallback";

export interface RequiredPromptBudgetMeasurement {
  /** Measured fixed-required prompt length per mode. */
  perMode: Record<SubjectRenderModeKey, number>;
  /** The worst-case (largest) fixed reserve across modes — the number to reserve. */
  worstCase: number;
}

/** A visual plan carrying NO compressible/AI content, with the age-transform
 *  binding active (its de-aging form is the longest fixed SUBJECT BINDING). */
function fixedShapeVisualPlan(): VisualPlan {
  return {
    sceneConcept: "", visualGoal: "", visualApproach: "",
    archetypeApplication: {
      primaryArchetype: "superhuman_physical_feat", subtype: "force_scaled_action",
      selectedFrame: "direct_action", strategyRationale: "",
    },
    coreScene: "", subjectDetails: [], environment: [], lightingAndStyle: "",
    keyVisualElements: [],
    subjectTreatment: {
      roleInScene: "protagonist", subjectRenderMode: "human_identity_i2i", identityPreservation: "human_face",
      nonhumanSubjectTreatment: {
        applicable: false, subjectKind: "not_applicable", preserveTraits: [],
        anthropomorphicTreatment: "none", doNotTransformIntoHuman: false,
      },
      fallbackSubjectGender: "not_applicable", expressionAndPose: "",
      // Longest fixed SUBJECT BINDING branch (de-aging).
      ageLifeStageTransform: { applies: true, targetState: "a young child" },
    },
    secondaryCharacters: [],
    subjectFactCompatibility: { rating: "strong", reason: "", recommendedFallback: "none" },
    composition: { subjectFraming: "", negativeSpace: "none", cameraStyle: "", sceneReadability: "readable" },
    supportingTextPolicy: { allowSupportingText: false, supportingTextElements: [], forbiddenTextTypes: [] },
    semanticEntitiesUsed: [], culturalReferencesUsed: [], contentNotes: "", debugNotes: "",
    targetEngine: "nano_banana_2", generationMode: "i2i",
  };
}

// A render policy that emits the LONGEST fixed STRICT-CONSTRAINTS branches
// (require-text line + violence-allow line) with NO moderator guidance content.
const MAX_FIXED_POLICY: RenderPolicy = {
  supportingText: { mode: "require" },
  violence: { mode: "allow", intensity: "strong" },
};

function fixedShapeArgs(mode: SubjectRenderModeKey, gender?: "male" | "female" | "neutral") {
  const input = {
    subjectRenderMode: mode,
    stylePrompt: "S".repeat(RENDER_STYLE_COPY_MAX_CHARS),
    referenceImageUrl: mode === "t2i_fallback" ? null : "https://example.com/ref.png",
    // A violence-relevant fact so the fixed violence-allow line emits.
    factText: "Subject destroys a tank.",
    enrichment: { modifiers: ["violence"] },
    renderControls: { aspectRatio: "portrait", contentMode: "sfw", ...(gender ? { fallbackSubjectGender: gender } : {}) },
    renderPolicy: MAX_FIXED_POLICY,
  } as unknown as ImagePromptGenerationInput;
  return {
    visualPlan: fixedShapeVisualPlan(),
    compiledPrompt: { prompt: "", negativePrompt: "", engineNotes: "" },
    input,
    renderedSubject: { name: "N".repeat(RENDERED_IDENTITY_NAME_MAX), pronouns: "they/them" },
  };
}

export function measureRequiredPromptBudget(): RequiredPromptBudgetMeasurement {
  const human = compileNanoBanana2HumanI2I(fixedShapeArgs("human_identity_i2i")).imagePrompt.length;
  const nonhuman = compileNanoBanana2NonhumanI2I(fixedShapeArgs("nonhuman_subject_i2i")).imagePrompt.length;
  const t2i = compileNanoBanana2T2I(fixedShapeArgs("t2i_fallback", "neutral")).imagePrompt.length;
  const perMode = { human_identity_i2i: human, nonhuman_subject_i2i: nonhuman, t2i_fallback: t2i };
  return { perMode, worstCase: Math.max(human, nonhuman, t2i) };
}
