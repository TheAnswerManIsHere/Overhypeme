/**
 * Phase 2 — render-time image-prompt generation schemas.
 *
 * Produces an engine-neutral `visualPlan` + an engine-specific `compiledPrompt`
 * for Nano Banana 2 (i2i or t2i). Three first-class subject render modes:
 *
 *   human_identity_i2i      — preserve recognizable human face
 *   nonhuman_subject_i2i    — preserve uploaded subject's visual identity
 *   t2i_fallback            — no reference; uses fallback subject gender
 *
 * Wire schemas are STRICT (every field required, no transforms / defaults /
 * refinements) for OpenAI's strict json_schema response_format. Business
 * validation lives in `validateImagePromptPlan`, which runs cross-field rules
 * (mode-appropriate prompt language, forbidden-text floor, archetype echo,
 * compatibility coherence, structured supporting-text, etc.).
 */

import { z } from "zod";
import { PRIMARY_ARCHETYPES, SUBTYPES_BY_ARCHETYPE, type PrimaryArchetype, type FactSubtype, type FactEnrichment } from "./taxonomy";

// ─── Versioning ────────────────────────────────────────────────────────────

// v2: visualPlan gained `culturalReferencesUsed` (audit echo-back of the
// material cultural references the plan consumed, parallel to semanticEntitiesUsed).
export const IMAGE_PROMPT_GENERATION_VERSION = "v2";
export const SOURCE_IMAGE_ANALYZER_VERSION = "v1";

// ─── Enums ────────────────────────────────────────────────────────────────

export const IMAGE_PROMPT_TARGET_ENGINE_VALUES = ["nano_banana_2"] as const;
export type ImagePromptTargetEngine = (typeof IMAGE_PROMPT_TARGET_ENGINE_VALUES)[number];

export const GENERATION_MODE_VALUES = ["i2i", "t2i"] as const;
export type GenerationMode = (typeof GENERATION_MODE_VALUES)[number];

export const SUBJECT_RENDER_MODE_VALUES = [
  "human_identity_i2i",
  "nonhuman_subject_i2i",
  "t2i_fallback",
] as const;
export type SubjectRenderMode = (typeof SUBJECT_RENDER_MODE_VALUES)[number];

export const SOURCE_SUBJECT_KIND_VALUES = [
  "human_face",
  // Person visible but face is unusable (back-facing, blurry, occluded by sunglasses/hat).
  // Distinct from "no face at all" — routes to t2i fallback with a clear UI warning.
  "human_subject_no_usable_face",
  "animal_subject",
  "object_subject",
  "vehicle_subject",
  "mascot_or_character_subject",
  "multiple_subjects",
  "scene_no_clear_subject",
  "ambiguous",
  "detection_failed",
] as const;
export type SourceSubjectKind = (typeof SOURCE_SUBJECT_KIND_VALUES)[number];

export const ANTHROPOMORPHIC_TREATMENT_VALUES = [
  "none",
  "subtle_pose",
  "costume_and_pose",
  "full_cartoonish_anthropomorphism",
] as const;
export type AnthropomorphicTreatment = (typeof ANTHROPOMORPHIC_TREATMENT_VALUES)[number];

export const SUBJECT_FACT_COMPATIBILITY_RATING_VALUES = [
  "strong",
  "workable",
  "risky",
  "poor",
] as const;
export type SubjectFactCompatibilityRating = (typeof SUBJECT_FACT_COMPATIBILITY_RATING_VALUES)[number];

export const RECOMMENDED_FALLBACK_VALUES = [
  "none",
  "t2i_fallback",
  "upload_human_photo",
  "choose_different_fact",
] as const;
export type RecommendedFallback = (typeof RECOMMENDED_FALLBACK_VALUES)[number];

// `fal_detector` = paid network call to a fal-hosted detector (the Phase 2
// default). `local_detector` is RESERVED for a future true in-process model
// (MediaPipe / YOLO ONNX). Renaming this enum entry is a breaking change.
export const CLASSIFICATION_METHOD_VALUES = [
  "fal_detector",
  "local_detector",
  "ai_vision_fallback",
  "manual_user_choice",
  "legacy_face_error",
  "not_analyzed",
] as const;
export type ClassificationMethod = (typeof CLASSIFICATION_METHOD_VALUES)[number];

export const CLASSIFICATION_CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
export type ClassificationConfidence = (typeof CLASSIFICATION_CONFIDENCE_VALUES)[number];

export const FALLBACK_SUBJECT_GENDER_VALUES = ["male", "female", "neutral"] as const;
export type FallbackSubjectGender = (typeof FALLBACK_SUBJECT_GENDER_VALUES)[number];

export const CONTENT_MODE_VALUES = ["sfw", "suggestive", "spicy"] as const;
export type ContentMode = (typeof CONTENT_MODE_VALUES)[number];

export const NEGATIVE_SPACE_VALUES = ["top", "bottom", "left", "right", "auto", "none"] as const;
export type NegativeSpacePreference = (typeof NEGATIVE_SPACE_VALUES)[number];

export const IDENTITY_PRESERVATION_VALUES = ["human_face", "nonhuman_visual_identity", "none"] as const;
export type IdentityPreservation = (typeof IDENTITY_PRESERVATION_VALUES)[number];

// The seven mandatory forbidden text categories that MUST appear (case-insensitive)
// in `visualPlan.supportingTextPolicy.forbiddenTextTypes` for any plan to validate.
export const MANDATORY_FORBIDDEN_TEXT_TYPES = [
  "full meme captions",
  "full fact text",
  "hashtags",
  "watermarks",
  "real logos",
  "brand marks",
  "long explanatory paragraphs",
] as const;

// ─── Source-image analysis ────────────────────────────────────────────────

export interface SourceImageDetection {
  label: string;
  score: number;
  box?: { x: number; y: number; width: number; height: number };
}

export interface SourceImageAnalysis {
  subjectKind: SourceSubjectKind;
  confidence: ClassificationConfidence;
  hasUsableHumanFace: boolean;
  hasUsableSubject: boolean;
  subjectCount: number;
  subjectDescription?: string;
  detections?: SourceImageDetection[];
  suggestedRenderMode: SubjectRenderMode;
  warnings: string[];
  classificationMethod: ClassificationMethod;
  analyzerVersion: string;
  sourceImageSha256?: string;
}

// ─── Identity policy ──────────────────────────────────────────────────────

export interface IdentityPolicy {
  subjectRenderMode: SubjectRenderMode;
  preserveHumanFace: boolean;
  preserveNonhumanSubjectIdentity: boolean;
  preservePhysique: boolean;
  allowBodyExaggeration: boolean;
  allowCostumeTransformation: boolean;
  allowAnthropomorphicTransformation: boolean;
  ageAndLifeStagePolicy: "follow_fact" | "ignore";
}

export const DEFAULT_HUMAN_I2I_IDENTITY_POLICY: IdentityPolicy = {
  subjectRenderMode: "human_identity_i2i",
  preserveHumanFace: true,
  preserveNonhumanSubjectIdentity: false,
  preservePhysique: false,
  allowBodyExaggeration: true,
  allowCostumeTransformation: true,
  allowAnthropomorphicTransformation: false,
  ageAndLifeStagePolicy: "follow_fact",
};

export const DEFAULT_NONHUMAN_I2I_IDENTITY_POLICY: IdentityPolicy = {
  subjectRenderMode: "nonhuman_subject_i2i",
  preserveHumanFace: false,
  preserveNonhumanSubjectIdentity: true,
  preservePhysique: false,
  allowBodyExaggeration: true,
  allowCostumeTransformation: true,
  allowAnthropomorphicTransformation: true,
  ageAndLifeStagePolicy: "follow_fact",
};

export const DEFAULT_T2I_FALLBACK_IDENTITY_POLICY: IdentityPolicy = {
  subjectRenderMode: "t2i_fallback",
  preserveHumanFace: false,
  preserveNonhumanSubjectIdentity: false,
  preservePhysique: false,
  allowBodyExaggeration: true,
  allowCostumeTransformation: true,
  allowAnthropomorphicTransformation: false,
  ageAndLifeStagePolicy: "follow_fact",
};

export function defaultIdentityPolicyForRenderMode(mode: SubjectRenderMode): IdentityPolicy {
  if (mode === "human_identity_i2i") return DEFAULT_HUMAN_I2I_IDENTITY_POLICY;
  if (mode === "nonhuman_subject_i2i") return DEFAULT_NONHUMAN_I2I_IDENTITY_POLICY;
  return DEFAULT_T2I_FALLBACK_IDENTITY_POLICY;
}

// ─── Render controls ─────────────────────────────────────────────────────

export interface RenderControls {
  aspectRatio: string;
  negativeSpacePreference?: NegativeSpacePreference;
  contentMode: ContentMode;
  /** Used by t2i ONLY. Ignored for i2i modes (the reference image is the subject). */
  fallbackSubjectGender?: FallbackSubjectGender | null;
}

// ─── Input contract ──────────────────────────────────────────────────────

export interface ImagePromptGenerationInput {
  factText: string;
  enrichment: FactEnrichment;
  sourceImageAnalysis: SourceImageAnalysis;
  subjectRenderMode: SubjectRenderMode;
  userSelectedSubjectRenderMode?: SubjectRenderMode | null;
  identityPolicy: IdentityPolicy;
  renderControls: RenderControls;
  stylePrompt: string;
  referenceImageUrl?: string | null;
  targetEngine: ImagePromptTargetEngine;
  requestId?: string;
}

// ─── Wire schemas (strict — for OpenAI json_schema) ──────────────────────
//
// Every property is required. No `.transform()`, `.default()`, `.pipe()`, or
// `.superRefine()` — these break OpenAI's strict json_schema. Cross-field +
// business rules run in `validateImagePromptPlan` after the wire parse.

const NONHUMAN_SUBJECT_KIND_WIRE_VALUES = [
  "animal_subject",
  "object_subject",
  "vehicle_subject",
  "mascot_or_character_subject",
  "not_applicable",
] as const;

const nonhumanSubjectTreatmentWireSchema = z.object({
  /** false when subjectRenderMode !== "nonhuman_subject_i2i". */
  applicable: z.boolean(),
  subjectKind: z.enum(NONHUMAN_SUBJECT_KIND_WIRE_VALUES),
  preserveTraits: z.array(z.string()),
  anthropomorphicTreatment: z.enum(ANTHROPOMORPHIC_TREATMENT_VALUES),
  doNotTransformIntoHuman: z.boolean(),
});

const FALLBACK_SUBJECT_GENDER_WIRE_VALUES = ["male", "female", "neutral", "not_applicable"] as const;

const subjectTreatmentWireSchema = z.object({
  roleInScene: z.string(),
  subjectRenderMode: z.enum(SUBJECT_RENDER_MODE_VALUES),
  identityPreservation: z.enum(IDENTITY_PRESERVATION_VALUES),
  nonhumanSubjectTreatment: nonhumanSubjectTreatmentWireSchema,
  fallbackSubjectGender: z.enum(FALLBACK_SUBJECT_GENDER_WIRE_VALUES),
  expressionAndPose: z.string(),
});

const supportingTextElementWireSchema = z.object({
  content: z.string(),
  purpose: z.string(),
  placement: z.string(),
});

const supportingTextPolicyWireSchema = z.object({
  allowSupportingText: z.boolean(),
  supportingTextElements: z.array(supportingTextElementWireSchema),
  forbiddenTextTypes: z.array(z.string()),
});

const subjectFactCompatibilityWireSchema = z.object({
  rating: z.enum(SUBJECT_FACT_COMPATIBILITY_RATING_VALUES),
  reason: z.string(),
  recommendedFallback: z.enum(RECOMMENDED_FALLBACK_VALUES),
});

const archetypeApplicationWireSchema = z.object({
  primaryArchetype: z.enum(PRIMARY_ARCHETYPES),
  subtype: z.string(),
  selectedFrame: z.string(),
  strategyRationale: z.string(),
});

const compositionWireSchema = z.object({
  subjectFraming: z.string(),
  negativeSpace: z.enum(NEGATIVE_SPACE_VALUES),
  cameraStyle: z.string(),
  sceneReadability: z.string(),
});

/**
 * Phase 2 visual-plan echo-back of the semantic entities (capitalization-aware
 * referents) consumed from the fact enrichment. For every entity in
 * `input.enrichment.semanticEntities` with `materiallyAffectsVisualPrompt=true`,
 * the generator MUST list a matching `{surfaceText, visualReferentUsed,
 * effectOnVisualPlan}`. The validator enforces this.
 *
 * Empty array allowed when the enrichment has no material entities.
 */
const semanticEntityUsedWireSchema = z.object({
  surfaceText: z.string(),
  visualReferentUsed: z.string(),
  effectOnVisualPlan: z.string(),
});

/**
 * Phase 2 visual-plan echo-back of the cultural references consumed from the
 * fact enrichment. For every MATERIAL reference (high research confidence, or
 * confident + not flagged for admin review), the generator MUST list a matching
 * `{sourcePhrase, canonicalReferenceUsed, visualImplicationUsed,
 * effectOnVisualPlan}`. The validator enforces this; the compiler turns these
 * into explicit engine directives so a researched reference reliably reaches
 * the image. Empty array allowed when the enrichment has no material references.
 */
const culturalReferenceUsedWireSchema = z.object({
  sourcePhrase: z.string(),
  canonicalReferenceUsed: z.string(),
  visualImplicationUsed: z.string(),
  effectOnVisualPlan: z.string(),
});

const visualPlanWireSchema = z.object({
  sceneConcept: z.string(),
  visualGoal: z.string(),
  visualApproach: z.string(),
  archetypeApplication: archetypeApplicationWireSchema,
  keyVisualElements: z.array(z.string()),
  subjectTreatment: subjectTreatmentWireSchema,
  subjectFactCompatibility: subjectFactCompatibilityWireSchema,
  composition: compositionWireSchema,
  supportingTextPolicy: supportingTextPolicyWireSchema,
  // Echo-back of capitalization-aware referents. Must cover every input
  // semanticEntity with materiallyAffectsVisualPrompt=true (validator rule 14).
  semanticEntitiesUsed: z.array(semanticEntityUsedWireSchema),
  // Echo-back of consumed cultural references. Must cover every MATERIAL
  // reference in the enrichment (validator rule 15).
  culturalReferencesUsed: z.array(culturalReferenceUsedWireSchema),
  styleIntegration: z.string(),
  contentNotes: z.string(),
  debugNotes: z.string(),
  targetEngine: z.enum(IMAGE_PROMPT_TARGET_ENGINE_VALUES),
  generationMode: z.enum(GENERATION_MODE_VALUES),
});

const compiledPromptWireSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string(),
  engineNotes: z.string(),
});

export const imagePromptPlanWireSchema = z.object({
  visualPlan: visualPlanWireSchema,
  compiledPrompt: compiledPromptWireSchema,
});

export type ImagePromptPlanWire = z.infer<typeof imagePromptPlanWireSchema>;
export type VisualPlan = z.infer<typeof visualPlanWireSchema>;
export type CompiledPrompt = z.infer<typeof compiledPromptWireSchema>;
export type SubjectTreatment = z.infer<typeof subjectTreatmentWireSchema>;
export type SubjectFactCompatibility = z.infer<typeof subjectFactCompatibilityWireSchema>;
export type SupportingTextElement = z.infer<typeof supportingTextElementWireSchema>;
export type SemanticEntityUsed = z.infer<typeof semanticEntityUsedWireSchema>;
export type CulturalReferenceUsed = z.infer<typeof culturalReferenceUsedWireSchema>;

// ─── Business validator ──────────────────────────────────────────────────

export interface PlanExpectations {
  archetype: PrimaryArchetype;
  subtype: FactSubtype;
  targetEngine: ImagePromptTargetEngine;
  subjectRenderMode: SubjectRenderMode;
  generationMode: GenerationMode;
  preserveHumanFace: boolean;
  preservePhysique: boolean;
  factText: string;
  fallbackSubjectGender?: FallbackSubjectGender | null;
  /**
   * Surface texts of semantic entities with materiallyAffectsVisualPrompt=true.
   * The validator requires each to appear (case-insensitive) in
   * visualPlan.semanticEntitiesUsed[].surfaceText.
   */
  materialSemanticEntities?: string[];
  /**
   * Source phrases (canonical fallback) of MATERIAL cultural references. The
   * validator requires each to appear (case-insensitive) in
   * visualPlan.culturalReferencesUsed[].sourcePhrase (canonical fallback).
   */
  materialCulturalReferences?: string[];
}

export type ImagePromptValidationResult =
  | { ok: true; data: ImagePromptPlanWire }
  | { ok: false; error: string; correctableHint?: string };

const HUMAN_FACE_PRESERVATION_RE = /(preserve|maintain|keep)\s+(the\s+)?(reference\s+)?(person'?s\s+)?face|face\s+(must|should)\s+remain\s+recognizable|recognizable\s+face/i;
const T2I_LIKENESS_CLAIM_RE = /preserve\s+.*?face|recognizable\s+face|reference\s+person|facial\s+likeness|reference\s+image\s+as\s+(the\s+)?(person'?s\s+)?facial/i;
const NONHUMAN_VISUAL_IDENTITY_RE = /(visual\s+identity|recognizable\s+(?:visual\s+)?identity|preserve.*?subject'?s\s+(?:recognizable|visual|markings|color|shape))/i;
const NONHUMAN_NO_HUMAN_RE = /(do\s+not|don'?t|never)\s+(replace|transform|turn)\s+(the\s+)?(uploaded\s+|reference\s+)?subject\s+(into|with)\s+a\s+human/i;
const PHYSIQUE_PRESERVE_RE = /preserv\w*\s+(the\s+)?(reference\s+)?(person'?s\s+|subject'?s\s+)?(body|physique|build|frame)/i;

function lowercaseSet(arr: readonly string[]): Set<string> {
  return new Set(arr.map((s) => s.toLowerCase().trim()));
}

const MANDATORY_FORBIDDEN_LC = lowercaseSet(MANDATORY_FORBIDDEN_TEXT_TYPES);

/**
 * Validate a raw image-prompt plan against the wire schema + business rules.
 * Returns `{ok:true, data}` on success or `{ok:false, error, correctableHint?}`
 * on failure. The `correctableHint` is populated for violations that the
 * model can plausibly fix on a corrective retry (echo mismatches, supporting
 * text shape, missing must-include language).
 */
export function validateImagePromptPlan(
  raw: unknown,
  expectations: PlanExpectations,
): ImagePromptValidationResult {
  const parsed = imagePromptPlanWireSchema.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error, correctableHint: error };
  }
  const data = parsed.data;
  const vp = data.visualPlan;
  const cp = data.compiledPrompt;

  // 1. targetEngine echo
  if (vp.targetEngine !== expectations.targetEngine) {
    return {
      ok: false,
      error: `visualPlan.targetEngine "${vp.targetEngine}" must equal "${expectations.targetEngine}"`,
      correctableHint: `Set visualPlan.targetEngine to exactly "${expectations.targetEngine}".`,
    };
  }
  // 2. generationMode echo
  if (vp.generationMode !== expectations.generationMode) {
    return {
      ok: false,
      error: `visualPlan.generationMode "${vp.generationMode}" must equal "${expectations.generationMode}"`,
      correctableHint: `Set visualPlan.generationMode to exactly "${expectations.generationMode}".`,
    };
  }
  // 3. archetype + subtype echo + membership
  if (vp.archetypeApplication.primaryArchetype !== expectations.archetype) {
    return {
      ok: false,
      error: `archetypeApplication.primaryArchetype "${vp.archetypeApplication.primaryArchetype}" must equal "${expectations.archetype}"`,
      correctableHint: `Set archetypeApplication.primaryArchetype to exactly "${expectations.archetype}".`,
    };
  }
  if (vp.archetypeApplication.subtype !== expectations.subtype) {
    return {
      ok: false,
      error: `archetypeApplication.subtype "${vp.archetypeApplication.subtype}" must equal "${expectations.subtype}"`,
      correctableHint: `Set archetypeApplication.subtype to exactly "${expectations.subtype}".`,
    };
  }
  const allowedSubtypes = SUBTYPES_BY_ARCHETYPE[expectations.archetype] as readonly string[];
  if (!allowedSubtypes.includes(vp.archetypeApplication.subtype)) {
    return {
      ok: false,
      error: `subtype "${vp.archetypeApplication.subtype}" is not in SUBTYPES_BY_ARCHETYPE["${expectations.archetype}"]`,
    };
  }
  // 4. subjectRenderMode echo
  if (vp.subjectTreatment.subjectRenderMode !== expectations.subjectRenderMode) {
    return {
      ok: false,
      error: `subjectTreatment.subjectRenderMode "${vp.subjectTreatment.subjectRenderMode}" must equal "${expectations.subjectRenderMode}"`,
      correctableHint: `Set subjectTreatment.subjectRenderMode to exactly "${expectations.subjectRenderMode}".`,
    };
  }
  // 5. keyVisualElements bounds
  if (vp.keyVisualElements.length < 3 || vp.keyVisualElements.length > 12) {
    return {
      ok: false,
      error: `keyVisualElements.length is ${vp.keyVisualElements.length}; must be in [3, 12]`,
      correctableHint: `Return between 3 and 12 keyVisualElements.`,
    };
  }
  // 6. forbiddenTextTypes superset
  const forbiddenLc = lowercaseSet(vp.supportingTextPolicy.forbiddenTextTypes);
  for (const required of MANDATORY_FORBIDDEN_LC) {
    if (!forbiddenLc.has(required)) {
      return {
        ok: false,
        error: `supportingTextPolicy.forbiddenTextTypes is missing required entry "${required}"`,
        correctableHint: `Include all of ${Array.from(MANDATORY_FORBIDDEN_LC).join(", ")} in forbiddenTextTypes (verbatim, lowercase).`,
      };
    }
  }
  // 7. allowSupportingText=false → empty elements
  if (!vp.supportingTextPolicy.allowSupportingText && vp.supportingTextPolicy.supportingTextElements.length > 0) {
    return {
      ok: false,
      error: `allowSupportingText is false but supportingTextElements has ${vp.supportingTextPolicy.supportingTextElements.length} items`,
      correctableHint: `When allowSupportingText is false, supportingTextElements MUST be an empty array.`,
    };
  }
  // 8. Per-mode prompt regex
  if (expectations.subjectRenderMode === "human_identity_i2i" && expectations.preserveHumanFace) {
    if (!HUMAN_FACE_PRESERVATION_RE.test(cp.prompt)) {
      return {
        ok: false,
        error: `human_identity_i2i compiledPrompt.prompt is missing explicit face-preservation language`,
        correctableHint: `When subjectRenderMode is human_identity_i2i and preserveHumanFace is true, the compiledPrompt.prompt MUST contain explicit face-preservation language (e.g. "preserve the reference person's face" or "recognizable face").`,
      };
    }
  }
  if (expectations.subjectRenderMode === "nonhuman_subject_i2i") {
    if (!NONHUMAN_VISUAL_IDENTITY_RE.test(cp.prompt)) {
      return {
        ok: false,
        error: `nonhuman_subject_i2i compiledPrompt.prompt is missing visual-identity preservation language`,
        correctableHint: `The compiledPrompt.prompt MUST describe preserving the uploaded subject's recognizable visual identity (color, markings, shape).`,
      };
    }
    if (!NONHUMAN_NO_HUMAN_RE.test(cp.prompt)) {
      return {
        ok: false,
        error: `nonhuman_subject_i2i compiledPrompt.prompt is missing "do not replace the subject with a human" instruction`,
        correctableHint: `Add an explicit instruction not to replace or transform the uploaded subject into a human.`,
      };
    }
    if (HUMAN_FACE_PRESERVATION_RE.test(cp.prompt)) {
      return {
        ok: false,
        error: `nonhuman_subject_i2i compiledPrompt.prompt must NOT claim human facial likeness preservation`,
        correctableHint: `Remove human face-preservation language for non-human subjects.`,
      };
    }
  }
  if (expectations.subjectRenderMode === "t2i_fallback") {
    if (T2I_LIKENESS_CLAIM_RE.test(cp.prompt)) {
      return {
        ok: false,
        error: `t2i_fallback compiledPrompt.prompt must NOT claim facial likeness preservation`,
        correctableHint: `t2i_fallback generates without a reference image. Remove any face/likeness preservation language.`,
      };
    }
    // Require fallbackSubjectGender language when caller provided one
    if (expectations.fallbackSubjectGender) {
      const gender = expectations.fallbackSubjectGender;
      const re = new RegExp(`\\b${gender}\\b`, "i");
      if (!re.test(cp.prompt)) {
        return {
          ok: false,
          error: `t2i_fallback prompt missing fallbackSubjectGender "${gender}"`,
          correctableHint: `Reference the fallbackSubjectGender ("${gender}") in the compiledPrompt.prompt so the generated protagonist matches.`,
        };
      }
    }
  }
  // 9. preservePhysique invariant
  if (!expectations.preservePhysique && PHYSIQUE_PRESERVE_RE.test(vp.subjectTreatment.expressionAndPose)) {
    return {
      ok: false,
      error: `preservePhysique is false but subjectTreatment.expressionAndPose claims to preserve body/physique`,
      correctableHint: `When preservePhysique is false, do not say "preserve body/physique" in expressionAndPose — body/physique exaggeration is allowed.`,
    };
  }
  // 10. Full fact text must not be embedded verbatim
  const factTrim = expectations.factText.trim();
  if (factTrim.length > 20 && cp.prompt.includes(factTrim)) {
    return {
      ok: false,
      error: `compiledPrompt.prompt contains the full fact text verbatim`,
      correctableHint: `Do not embed the full fact text in the compiledPrompt.prompt. Render the SCENE, not the caption.`,
    };
  }
  // 11. nonhumanSubjectTreatment.applicable coherence
  const nht = vp.subjectTreatment.nonhumanSubjectTreatment;
  if (expectations.subjectRenderMode === "nonhuman_subject_i2i") {
    if (!nht.applicable) {
      return {
        ok: false,
        error: `subjectTreatment.nonhumanSubjectTreatment.applicable must be true for nonhuman_subject_i2i`,
        correctableHint: `Set nonhumanSubjectTreatment.applicable to true and fill in subjectKind + preserveTraits + anthropomorphicTreatment + doNotTransformIntoHuman.`,
      };
    }
    if (nht.subjectKind === "not_applicable") {
      return {
        ok: false,
        error: `nonhumanSubjectTreatment.subjectKind must NOT be "not_applicable" for nonhuman_subject_i2i`,
        correctableHint: `Pick the correct subjectKind: animal_subject, object_subject, vehicle_subject, or mascot_or_character_subject.`,
      };
    }
    if (nht.preserveTraits.length < 1) {
      return {
        ok: false,
        error: `nonhumanSubjectTreatment.preserveTraits must contain at least one trait for nonhuman_subject_i2i`,
        correctableHint: `List the subject's distinctive visual traits to preserve (markings, color, shape, etc.).`,
      };
    }
    if (!nht.doNotTransformIntoHuman) {
      return {
        ok: false,
        error: `nonhumanSubjectTreatment.doNotTransformIntoHuman must be true for nonhuman_subject_i2i`,
        correctableHint: `Set doNotTransformIntoHuman to true — the global rule forbids transforming non-human subjects into humans.`,
      };
    }
  } else {
    // Human i2i / t2i fallback → applicable must be false, sentinel values
    if (nht.applicable) {
      return {
        ok: false,
        error: `nonhumanSubjectTreatment.applicable must be false for ${expectations.subjectRenderMode}`,
        correctableHint: `Set nonhumanSubjectTreatment.applicable to false.`,
      };
    }
    if (nht.subjectKind !== "not_applicable") {
      return {
        ok: false,
        error: `nonhumanSubjectTreatment.subjectKind must be "not_applicable" for ${expectations.subjectRenderMode}`,
        correctableHint: `Set nonhumanSubjectTreatment.subjectKind to "not_applicable".`,
      };
    }
    if (nht.preserveTraits.length !== 0) {
      return {
        ok: false,
        error: `nonhumanSubjectTreatment.preserveTraits must be empty for ${expectations.subjectRenderMode}`,
        correctableHint: `Empty the preserveTraits array.`,
      };
    }
    if (nht.anthropomorphicTreatment !== "none") {
      return {
        ok: false,
        error: `nonhumanSubjectTreatment.anthropomorphicTreatment must be "none" for ${expectations.subjectRenderMode}`,
        correctableHint: `Set anthropomorphicTreatment to "none".`,
      };
    }
  }
  // 12. subjectFactCompatibility coherence
  if (vp.subjectFactCompatibility.rating === "poor" && vp.subjectFactCompatibility.recommendedFallback === "none") {
    return {
      ok: false,
      error: `subjectFactCompatibility.rating is "poor" but recommendedFallback is "none"; must recommend a fallback`,
      correctableHint: `When rating is "poor", recommendedFallback must be one of t2i_fallback / upload_human_photo / choose_different_fact.`,
    };
  }
  // 13. fallbackSubjectGender consistency
  if (expectations.subjectRenderMode === "t2i_fallback") {
    if (expectations.fallbackSubjectGender) {
      if (vp.subjectTreatment.fallbackSubjectGender === "not_applicable") {
        return {
          ok: false,
          error: `t2i_fallback requires a concrete fallbackSubjectGender (${expectations.fallbackSubjectGender}), got "not_applicable"`,
          correctableHint: `Echo the caller's fallbackSubjectGender ("${expectations.fallbackSubjectGender}") in subjectTreatment.fallbackSubjectGender.`,
        };
      }
    }
  } else {
    if (vp.subjectTreatment.fallbackSubjectGender !== "not_applicable") {
      return {
        ok: false,
        error: `subjectTreatment.fallbackSubjectGender must be "not_applicable" for ${expectations.subjectRenderMode}`,
        correctableHint: `fallbackSubjectGender applies only to t2i_fallback.`,
      };
    }
  }
  // 14. semanticEntitiesUsed echo-back. Every input semantic entity with
  // materiallyAffectsVisualPrompt=true MUST be covered by an entry whose
  // surfaceText matches (case-insensitively).
  const material = expectations.materialSemanticEntities ?? [];
  if (material.length > 0) {
    const echoed = new Set(
      vp.semanticEntitiesUsed.map((e) => e.surfaceText.trim().toLowerCase()),
    );
    for (const expected of material) {
      const wanted = expected.trim().toLowerCase();
      if (!echoed.has(wanted)) {
        return {
          ok: false,
          error: `visualPlan.semanticEntitiesUsed is missing required surfaceText "${expected}"`,
          correctableHint: `For every semantic entity in the enrichment with materiallyAffectsVisualPrompt=true, echo it back in visualPlan.semanticEntitiesUsed as { surfaceText, visualReferentUsed, effectOnVisualPlan }. Required surfaceText: ${material.join(", ")}.`,
        };
      }
    }
    // Each echoed entry must carry non-empty visualReferentUsed +
    // effectOnVisualPlan so it actually informs the plan.
    for (const entry of vp.semanticEntitiesUsed) {
      if (!entry.visualReferentUsed.trim() || !entry.effectOnVisualPlan.trim()) {
        return {
          ok: false,
          error: `semanticEntitiesUsed entry for "${entry.surfaceText}" has empty visualReferentUsed or effectOnVisualPlan`,
          correctableHint: `Each semanticEntitiesUsed entry must include a concrete visualReferentUsed and a short effectOnVisualPlan describing how it shaped the scene.`,
        };
      }
    }
  }

  // 15. culturalReferencesUsed echo-back. Every MATERIAL cultural reference
  // (high research confidence, or confident + not flagged for admin review)
  // MUST be covered by an entry whose sourcePhrase matches (case-insensitively).
  // Ambiguous / review-required references are intentionally NOT forced.
  const materialCultural = expectations.materialCulturalReferences ?? [];
  if (materialCultural.length > 0) {
    const echoed = new Set(
      vp.culturalReferencesUsed.map((e) => e.sourcePhrase.trim().toLowerCase()),
    );
    for (const expected of materialCultural) {
      const wanted = expected.trim().toLowerCase();
      if (!echoed.has(wanted)) {
        return {
          ok: false,
          error: `visualPlan.culturalReferencesUsed is missing required sourcePhrase "${expected}"`,
          correctableHint: `For every material cultural reference in the enrichment, echo it back in visualPlan.culturalReferencesUsed as { sourcePhrase, canonicalReferenceUsed, visualImplicationUsed, effectOnVisualPlan }. Required sourcePhrase: ${materialCultural.join(", ")}.`,
        };
      }
    }
    for (const entry of vp.culturalReferencesUsed) {
      if (
        !entry.canonicalReferenceUsed.trim() ||
        !entry.visualImplicationUsed.trim() ||
        !entry.effectOnVisualPlan.trim()
      ) {
        return {
          ok: false,
          error: `culturalReferencesUsed entry for "${entry.sourcePhrase}" has an empty canonicalReferenceUsed, visualImplicationUsed, or effectOnVisualPlan`,
          correctableHint: `Each culturalReferencesUsed entry needs a concrete canonicalReferenceUsed, visualImplicationUsed, and a short effectOnVisualPlan.`,
        };
      }
    }
  }

  // 16. Nano Banana 2 has no negative-prompt parameter — the compiler drops it.
  // Force exclusions into the positive prompt so they actually take effect.
  if (expectations.targetEngine === "nano_banana_2" && cp.negativePrompt.trim().length > 0) {
    return {
      ok: false,
      error: `compiledPrompt.negativePrompt must be empty for nano_banana_2 (it has no negative-prompt parameter)`,
      correctableHint: `Leave compiledPrompt.negativePrompt as an empty string and express every exclusion as positive scene language inside compiledPrompt.prompt (e.g. "a clean wall" instead of a "no posters" negative).`,
    };
  }

  return { ok: true, data };
}
