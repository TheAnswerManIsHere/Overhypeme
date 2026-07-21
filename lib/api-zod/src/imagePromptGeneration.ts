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
import {
  SUPPORTING_TEXT_MODE_VALUES,
  VIOLENCE_MODE_VALUES,
  VIOLENCE_INTENSITY_VALUES,
  type SupportingTextMode,
  type ViolenceMode,
  type ViolenceIntensity,
} from "./renderPolicyEnums";
import type { VisualPromptStrategyOverride } from "./visualStrategyOverride";

// ─── Versioning ────────────────────────────────────────────────────────────

// v2: visualPlan gained `culturalReferencesUsed` (audit echo-back of the
// material cultural references the plan consumed, parallel to semanticEntitiesUsed).
// v3: visualPlan gained the concrete visual specification (coreScene,
// subjectDetails, environment, lightingAndStyle) and subjectTreatment gained the
// ageLifeStageTransform binding signal; the compiler now assembles a labeled,
// deterministic visual contract and the abstract intent line was dropped.
// v4: visualPlan gained `secondaryCharacters` (concrete visible roles for every
// non-subject person/animal/crowd) so the compiler can emit an ADDITIVE ROLE
// DETAILS section (originally REFERENCE INTERPRETATION) binding the subject's
// role + each secondary character's role, and reusable failure-mode constraints.
// (PR: the Visual Concept now leads the prompt; ROLE DETAILS is additive-only.)
// v5: removed the modifier→prompt-prose injection channel (modifiers are now
// planner context only); added the always-on incidental-text guard and
// content-word key-element gap-fill; generalized age-transform SUBJECT BINDING
// to non-human/t2i renders. Compiled output changes for identical inputs, so
// existing test renders correctly flag stale.
// v6: CORE SCENE now leads the compiled prompt in every render mode; ROLE
// DETAILS replaces REFERENCE INTERPRETATION and never doubles a name; additive
// de-dupe upgraded from substring to content-word contiguity. Compiled output
// changes for identical inputs, so existing test renders correctly flag stale.
export const IMAGE_PROMPT_GENERATION_VERSION = "v7";
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
//
// SCOPE: these govern OVERLAY / CAPTION text — the meme caption, full fact text,
// hashtags, watermarks, real logos, and brand marks — which are composited
// separately and must NEVER be baked into the generated image. They do NOT ban
// in-WORLD readable scene text (signs, TV titles, scoreboards, documents,
// labels); that is governed by `renderPolicy.supportingText` (allow/forbid/
// require). The compiler emits a narrow overlay-text exclusion from this list,
// not a blanket "no readable text" ban.
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

// ─── Render policy (platform / moderator content policy) ───────────────────
//
// Phase 1 render-policy layer. This is the PLATFORM/MODERATOR policy that
// controls what the compiler is ALLOWED to put in the engine prompt — distinct
// from `visualPlan.supportingTextPolicy`, which is the planner-selected *scene*
// text (the specific in-world strings the LLM chose for this one render). Keep
// the two straight:
//
//   renderPolicy.supportingText   — MAY in-world readable text appear at all?
//                                    (platform/moderator policy: allow/forbid/require)
//   visualPlan.supportingTextPolicy — WHICH in-world strings did the planner pick
//                                    for this render? (per-render scene content)
//
// The render policy is built so Phase 2 can override it per-fact and future
// child-safe / NSFW modes can swap the global defaults — without re-touching the
// compiler. The render-policy slot is the one named (but unimplemented) in
// `visualPromptStrategies.ts` ("render policy — what content level is allowed?").

/**
 * Platform/moderator policy controlling whether in-WORLD readable text (signs,
 * TV titles, scoreboards, documents, labels) may appear in the rendered image.
 * Distinct from `visualPlan.supportingTextPolicy` (the planner-selected scene
 * text). Overlay/caption text (the meme caption, fact text, hashtags,
 * watermarks, logos) is ALWAYS excluded regardless of this policy — that is the
 * separate `MANDATORY_FORBIDDEN_TEXT_TYPES` floor.
 *
 * - "allow"   — in-world text permitted; the compiler stays SILENT unless
 *               `guidance` is intentionally provided (no encouragement of
 *               unnecessary text).
 * - "forbid"  — in-world text avoided unless a higher-priority instruction
 *               requires it.
 * - "require" — in-world text is required; `guidance` describes what to show.
 */
export interface SupportingTextRenderPolicy {
  mode: SupportingTextMode;
  guidance?: string;
}

/**
 * Platform/moderator policy controlling whether action-hero violence, visible
 * death, weapons, and destruction may be depicted when the fact requires it.
 *
 * - "allow"    — permitted; the compiler emits a short, self-conditioned
 *                permission line ONLY when the fact/plan is violence-relevant
 *                (or `guidance` is explicitly provided).
 * - "soften"   — soften violent consequences; avoid graphic injury/visible death.
 * - "suppress" — do not depict violence/injury/death directly.
 */
export interface ViolenceRenderPolicy {
  mode: ViolenceMode;
  intensity: ViolenceIntensity;
  guidance?: string;
}

export interface RenderPolicy {
  supportingText: SupportingTextRenderPolicy;
  violence: ViolenceRenderPolicy;
}

/**
 * Phase 1 global default render policy for Overhype's current adult/general
 * mode: in-world text allowed (silently — no line unless required/guided), and
 * action-hero violence allowed at "strong" intensity when the fact requires it,
 * without gratuitous gore. The absence of `guidance` keeps the "allow" modes
 * silent until relevance / explicit guidance triggers a line.
 */
export const DEFAULT_RENDER_POLICY: RenderPolicy = {
  supportingText: { mode: "allow" },
  violence: { mode: "allow", intensity: "strong" },
};

/**
 * Resolve the EFFECTIVE render policy for a render: the Phase 1 default, with the
 * moderator's per-fact override applied when its visual-strategy override is
 * enabled (Phase 2). Precedence: moderator override > default. An explicit
 * moderator `soften`/`suppress` mode is now the ONLY thing that reduces violent
 * depiction — the old per-fact auto-softening modifiers were retired.
 */
export function resolveRenderPolicy(
  enrichment: { visualPromptStrategyOverride?: VisualPromptStrategyOverride } | null | undefined,
): RenderPolicy {
  const ov = enrichment?.visualPromptStrategyOverride;
  if (!ov?.enabled) return DEFAULT_RENDER_POLICY;
  return {
    supportingText: ov.supportingTextPolicyOverride
      ? { mode: ov.supportingTextPolicyOverride.mode, guidance: ov.supportingTextPolicyOverride.guidance }
      : DEFAULT_RENDER_POLICY.supportingText,
    violence: ov.violencePolicyOverride
      ? {
          mode: ov.violencePolicyOverride.mode,
          intensity: ov.violencePolicyOverride.intensity,
          guidance: ov.violencePolicyOverride.guidance,
        }
      : DEFAULT_RENDER_POLICY.violence,
  };
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
  /**
   * Effective platform/moderator render policy for this render. Optional —
   * the compiler falls back to `DEFAULT_RENDER_POLICY` when omitted (so existing
   * callers and tests need no change). Phase 2 resolves global-default ←
   * per-fact moderator override upstream and passes the result here.
   */
  renderPolicy?: RenderPolicy;
  stylePrompt: string;
  referenceImageUrl?: string | null;
  targetEngine: ImagePromptTargetEngine;
  requestId?: string;
  /**
   * The rendered subject identity ({NAME}/pronoun tokens already resolved
   * upstream into `factText`). Used to token-render moderator-authored
   * override text (e.g. the visual-concept core scene) before it reaches the
   * planner LLM — the planner's contract is that it never sees raw template
   * tokens. Optional: when absent, moderator text is injected as-is.
   */
  renderedSubject?: { name: string; pronouns: string | null };
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

/**
 * Age / life-stage transform signal. When the fact implies an age the reference
 * subject must be rendered at (born → infant, "as a kid" → child, "in his 90s" →
 * elderly), `applies` is true and `targetState` is the concrete transformed noun
 * (e.g. "a baby/infant", "a school-age child", "an elderly man"). The compiler
 * uses this to emit the deterministic SUBJECT BINDING block that fuses the
 * reference identity and the transformed life stage into ONE entity — so the
 * engine de-ages the same person instead of pairing an adult with a separate
 * baby. `applies=false` ⟹ `targetState` is an empty string.
 */
const ageLifeStageTransformWireSchema = z.object({
  applies: z.boolean(),
  targetState: z.string(),
});

const subjectTreatmentWireSchema = z.object({
  roleInScene: z.string(),
  subjectRenderMode: z.enum(SUBJECT_RENDER_MODE_VALUES),
  identityPreservation: z.enum(IDENTITY_PRESERVATION_VALUES),
  nonhumanSubjectTreatment: nonhumanSubjectTreatmentWireSchema,
  fallbackSubjectGender: z.enum(FALLBACK_SUBJECT_GENDER_WIRE_VALUES),
  expressionAndPose: z.string(),
  // Age / life-stage transform binding signal (drives SUBJECT BINDING).
  ageLifeStageTransform: ageLifeStageTransformWireSchema,
});

export const SUPPORTING_TEXT_KIND_VALUES = ["literal_text", "visual_graphic"] as const;
export type SupportingTextKind = (typeof SUPPORTING_TEXT_KIND_VALUES)[number];

const supportingTextElementWireSchema = z.object({
  content: z.string(),
  // Whether `content` is a LITERAL glyph string to render as readable in-scene
  // text ("COBRA", "GAME OVER", "E=mc²") or a VISUAL GRAPHIC described in words
  // ("a flatline trace", "five crossed-off calendar days"). The compiler quotes
  // literal_text as exact glyphs and routes visual_graphic to an unquoted
  // scene-detail directive — so a description is never baked in as literal text.
  kind: z.enum(SUPPORTING_TEXT_KIND_VALUES),
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

/**
 * A non-subject entity that must appear in the image (the subject's mother, a
 * referee, a reacting crowd, sharks, …). `label` is a short relationship/name/
 * type; `visualRole` is the CONCRETE visible role — position, action/reaction,
 * and relationship to the subject — not a bare relationship word. The compiler
 * turns these into an additive ROLE DETAILS section (emitted only for roles the
 * Visual Concept omitted) plus role-preservation constraints, so a secondary character
 * keeps their stated role instead of taking over the subject's central action.
 * Empty array when the subject is alone or no secondary entity must appear.
 */
const secondaryCharacterWireSchema = z.object({
  label: z.string(),
  visualRole: z.string(),
});

const visualPlanWireSchema = z.object({
  sceneConcept: z.string(),
  // visualGoal / visualApproach are INTERNAL reasoning (admin/debug + tone
  // checks) — the compiler no longer emits them to the engine prompt. The
  // engine prompt is built from the concrete visual fields below.
  visualGoal: z.string(),
  visualApproach: z.string(),
  archetypeApplication: archetypeApplicationWireSchema,
  // ─ Concrete visual specification (1:1 with the engine prompt sections) ─
  // coreScene → CORE SCENE: one tight paragraph of what is happening.
  coreScene: z.string(),
  // subjectDetails → SUBJECT DETAILS: pose, expression, age/body presentation,
  // wardrobe, distinctive features (subject-specific, visible).
  subjectDetails: z.array(z.string()),
  // environment → ENVIRONMENT: setting, background, props, scale (scene-side).
  environment: z.array(z.string()),
  // lightingAndStyle → LIGHTING: physical light, mood, and palette ONLY. The
  // selected visual STYLE is compiler-owned and emitted as its own RENDER STYLE
  // section (single-channel), so no rendering-medium claim belongs here.
  lightingAndStyle: z.string(),
  // keyVisualElements stays as a gap-fill safety net: any must-see element the
  // concrete fields above missed is injected once, de-duped against them.
  keyVisualElements: z.array(z.string()),
  subjectTreatment: subjectTreatmentWireSchema,
  // Concrete visible roles for every non-subject entity in the scene. Drives the
  // compiler's additive ROLE DETAILS section + role-preservation constraints.
  // Empty array when the subject is alone.
  secondaryCharacters: z.array(secondaryCharacterWireSchema),
  subjectFactCompatibility: subjectFactCompatibilityWireSchema,
  composition: compositionWireSchema,
  supportingTextPolicy: supportingTextPolicyWireSchema,
  // Echo-back of capitalization-aware referents. Must cover every input
  // semanticEntity with materiallyAffectsVisualPrompt=true (validator rule 14).
  semanticEntitiesUsed: z.array(semanticEntityUsedWireSchema),
  // Echo-back of consumed cultural references. Must cover every MATERIAL
  // reference in the enrichment (validator rule 15).
  culturalReferencesUsed: z.array(culturalReferenceUsedWireSchema),
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
export type AgeLifeStageTransform = z.infer<typeof ageLifeStageTransformWireSchema>;
export type SubjectFactCompatibility = z.infer<typeof subjectFactCompatibilityWireSchema>;
export type SupportingTextElement = z.infer<typeof supportingTextElementWireSchema>;
export type SemanticEntityUsed = z.infer<typeof semanticEntityUsedWireSchema>;
export type CulturalReferenceUsed = z.infer<typeof culturalReferenceUsedWireSchema>;
export type SecondaryCharacter = z.infer<typeof secondaryCharacterWireSchema>;

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
  /**
   * True when an enabled, non-empty moderator core-scene override is the
   * authoritative scene (the compiler emits it verbatim and ignores the AI
   * `coreScene`). Under this mode the planner's additive delta collections
   * (`subjectDetails`, `environment`, `keyVisualElements`) may legally be EMPTY
   * — a complete human Concept needs no invented filler. The upper bound on
   * `keyVisualElements` and every other rule still apply. Defaults to false
   * (the AI-scene minimums stay in force), so existing callers are unchanged.
   */
  hasAuthoritativeCoreScene?: boolean;
}

export type ImagePromptValidationResult =
  | { ok: true; data: ImagePromptPlanWire }
  | { ok: false; error: string; correctableHint?: string };

const HUMAN_FACE_PRESERVATION_RE = /(preserve|maintain|keep)\s+(the\s+)?(reference\s+)?(person'?s\s+)?face|face\s+(must|should)\s+remain\s+recognizable|recognizable\s+face/i;
const T2I_LIKENESS_CLAIM_RE = /preserve\s+.*?face|recognizable\s+face|reference\s+person|facial\s+likeness|reference\s+image\s+as\s+(the\s+)?(person'?s\s+)?facial/i;
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
  // 5. keyVisualElements bounds. The UPPER bound always applies; the lower bound
  // (≥3) is relaxed under an authoritative moderator Concept, where the scene is
  // complete and additive elements may legitimately be zero.
  if (vp.keyVisualElements.length > 12) {
    return {
      ok: false,
      error: `keyVisualElements.length is ${vp.keyVisualElements.length}; must be at most 12`,
      correctableHint: `Return at most 12 keyVisualElements.`,
    };
  }
  if (!expectations.hasAuthoritativeCoreScene && vp.keyVisualElements.length < 3) {
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
  // 8. Per-mode prompt regex.
  //
  // Identity ownership: the deterministic compiler injects the mode preamble's
  // identity language itself (human face preservation; non-human visual-identity
  // + "do not replace with a human"), so the LLM prose is NO LONGER REQUIRED to
  // author it — the generator is instructed not to, and the compiler strips any
  // that leaks. We still ENFORCE the FORBIDS below, which catch genuinely wrong
  // claims (a non-human subject claiming human facial likeness; a t2i render
  // claiming to preserve a reference face) that the compiler can't silently fix.
  if (expectations.subjectRenderMode === "nonhuman_subject_i2i") {
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
    // Require explicit gender language for male/female so the generated
    // protagonist visibly matches the caller's choice. "neutral" is exempt:
    // it means NO specified gender, so there is no literal word to assert — the
    // model correctly writes "a person", never "a neutral person", and demanding
    // the word "neutral" would (and did) fail every generic t2i render.
    if (expectations.fallbackSubjectGender && expectations.fallbackSubjectGender !== "neutral") {
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
  // 12. (retired) subjectFactCompatibility coherence — a "poor" rating no longer
  // requires a non-"none" recommendedFallback. The rating is advisory only and
  // never blocks rendering (see imagePromptJobs.ts); "none" is valid for every
  // rating, including poor.
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

  // 17. Concrete visual specification must be present. The engine prompt's CORE
  // SCENE / SUBJECT DETAILS / ENVIRONMENT sections are built from these — empty
  // fields would yield a hollow, intent-only prompt (the exact failure we are
  // fixing). Require a non-empty coreScene and at least one concrete
  // subjectDetail and one environment entry.
  if (!vp.coreScene.trim()) {
    return {
      ok: false,
      error: `visualPlan.coreScene is empty`,
      correctableHint: `Write coreScene as one tight paragraph describing what is literally happening in the frame (subject + action + key objects). Concrete visuals only — no authorial intent.`,
    };
  }
  // subjectDetails / environment minimums are relaxed under an authoritative
  // moderator Concept (the compiler emits the human scene verbatim; these
  // additive fields exist only for details the scene omits, and may be empty).
  const subjectDetailsNonEmpty = vp.subjectDetails.filter((s) => s.trim());
  if (!expectations.hasAuthoritativeCoreScene && subjectDetailsNonEmpty.length < 1) {
    return {
      ok: false,
      error: `visualPlan.subjectDetails must contain at least one concrete entry`,
      correctableHint: `List concrete subject details: pose, expression, apparent age/body presentation, wardrobe, distinctive features.`,
    };
  }
  const environmentNonEmpty = vp.environment.filter((s) => s.trim());
  if (!expectations.hasAuthoritativeCoreScene && environmentNonEmpty.length < 1) {
    return {
      ok: false,
      error: `visualPlan.environment must contain at least one concrete entry`,
      correctableHint: `List concrete environment details: setting, background, props, and scale.`,
    };
  }

  // 18. Age / life-stage transform coherence. When the subject must be rendered
  // at a transformed age, the binding needs a concrete target noun; when it does
  // not apply, the targetState must be empty so the compiler skips binding.
  const lifeStage = vp.subjectTreatment.ageLifeStageTransform;
  if (lifeStage.applies && !lifeStage.targetState.trim()) {
    return {
      ok: false,
      error: `subjectTreatment.ageLifeStageTransform.applies is true but targetState is empty`,
      correctableHint: `Set targetState to the concrete transformed life stage the fact implies (e.g. "a baby/infant", "a school-age child", "an elderly man").`,
    };
  }
  if (!lifeStage.applies && lifeStage.targetState.trim()) {
    return {
      ok: false,
      error: `subjectTreatment.ageLifeStageTransform.applies is false but targetState is non-empty`,
      correctableHint: `When the fact does not imply an age transform, set ageLifeStageTransform.applies=false and targetState to "".`,
    };
  }

  return { ok: true, data };
}
