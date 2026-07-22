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

import type {
  ImagePromptGenerationInput,
  VisualPlan,
  RenderPolicy,
  VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import {
  RENDERED_IDENTITY_NAME_MAX,
  collectRenderedTextEntries,
  setRenderedTextAtPath,
  projectWorstCaseRenderedLength,
  projectWorstCaseRenderedText,
  resolveRenderPolicy,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  validateVisualStrategyOverrideForSave,
  type VsoBudgetResult,
} from "@workspace/api-zod";
import {
  compileForSubjectRenderMode,
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

// ─── Moderator-additions emission (Codex P1, PR#224) ─────────────────────────

const ADDITIONS_MODES: ReadonlyArray<{ mode: SubjectRenderModeKey; gender?: "male" | "female" | "neutral" }> = [
  { mode: "human_identity_i2i" },
  { mode: "nonhuman_subject_i2i" },
  { mode: "t2i_fallback", gender: "neutral" },
];

const EMPTY_ENABLED_OVERRIDE: VisualPromptStrategyOverride = { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true };

/**
 * Build a WORST-CASE projection of a moderator override for measurement:
 * every non-core rendered field's text is replaced with a placeholder of its
 * worst-case rendered length (so token expansion is baked in), and the CORE
 * SCENE is dropped (it has its own reserve, measured separately). Policy
 * override MODES are preserved so their emitted lines are measured as they will
 * actually render.
 */
function projectAdditionsOverride(ov: VisualPromptStrategyOverride): VisualPromptStrategyOverride {
  // Bubbles are dropped: they have their OWN reserve, measured separately by
  // `measureBubbleDirectivesEmission` — counting them here would double-count.
  let projected: VisualPromptStrategyOverride = { ...ov, enabled: true, coreSceneOverride: undefined, bubbles: [] };
  for (const { path, value } of collectRenderedTextEntries(ov)) {
    if (path === "coreSceneOverride" || path.startsWith("bubbles[")) continue;
    projected = setRenderedTextAtPath(projected, path, "x".repeat(projectWorstCaseRenderedLength(value)));
  }
  return projected;
}

function compileWithOverride(
  entry: { mode: SubjectRenderModeKey; gender?: "male" | "female" | "neutral" },
  ov: VisualPromptStrategyOverride,
): number {
  const enrichment = { modifiers: [] as string[], visualPromptStrategyOverride: ov };
  const input = {
    subjectRenderMode: entry.mode,
    stylePrompt: "", // identical across the two runs → cancels out of the delta
    referenceImageUrl: entry.mode === "t2i_fallback" ? null : "https://example.com/ref.png",
    factText: "",
    enrichment,
    renderControls: {
      aspectRatio: "portrait",
      contentMode: "sfw",
      ...(entry.gender ? { fallbackSubjectGender: entry.gender } : {}),
    },
    // Effective policy resolved from the override, so a moderator policy guidance
    // line is emitted (and thus measured) exactly as it will render.
    renderPolicy: resolveRenderPolicy(enrichment),
  } as unknown as ImagePromptGenerationInput;
  return compileForSubjectRenderMode({
    visualPlan: fixedShapeVisualPlan(),
    compiledPrompt: { prompt: "", negativePrompt: "", engineNotes: "" },
    input,
    renderedSubject: { name: "N".repeat(RENDERED_IDENTITY_NAME_MAX), pronouns: "they/them" },
  }).imagePrompt.length;
}

/**
 * The number of characters the moderator's ADDITIONS (everything except the
 * CORE SCENE) actually add to the compiled prompt at worst case — measured
 * through the REAL compiler, so it INCLUDES the wrapping the naive raw-field sum
 * misses: "Do not …" negation prefixes, "label: " role forms, "; " list joins,
 * and the per-section labels that only appear once a field is populated (Codex
 * P1, PR#224).
 *
 * Method: for each subject mode, compile the fixed shape twice — once with the
 * worst-case-projected override, once with an empty (enabled) override — and
 * take the delta. Everything fixed (labels, guards, binding, identity, style)
 * is identical between the two runs and cancels, leaving exactly the additions'
 * emitted contribution. Returns the max across modes (the reserve to enforce).
 */
export function measureModeratorAdditionsEmission(ov: VisualPromptStrategyOverride): number {
  if (!ov.enabled) return 0;
  const projected = projectAdditionsOverride(ov);
  let worst = 0;
  for (const entry of ADDITIONS_MODES) {
    const withAdditions = compileWithOverride(entry, projected);
    const baseline = compileWithOverride(entry, EMPTY_ENABLED_OVERRIDE);
    worst = Math.max(worst, withAdditions - baseline);
  }
  return Math.max(0, worst);
}

/**
 * The number of characters the moderator's SPEECH & THOUGHT BUBBLES actually
 * add to the compiled prompt at worst case — the compiler-emitted directives
 * (template wording + attribution + serialized literal + section label), with
 * bubble text projected to its worst-case token expansion. Same delta method
 * as the additions measurement, with ONLY the bubbles populated, so the two
 * pools can never double-count. This is the `bubbleEmittedLength` input to
 * `validateVisualStrategyOverrideForSave`.
 */
export function measureBubbleDirectivesEmission(ov: VisualPromptStrategyOverride): number {
  if (!ov.enabled || (ov.bubbles ?? []).length === 0) return 0;
  let projected: VisualPromptStrategyOverride = { ...EMPTY_ENABLED_OVERRIDE, bubbles: ov.bubbles };
  for (const { path, value } of collectRenderedTextEntries(projected)) {
    if (!path.startsWith("bubbles[")) continue;
    if (path.endsWith(".entity")) {
      // Entities are never escaped (composeBubbleDirective inserts the
      // attribution noun raw, never through serializeLiteralPromptString) —
      // only their worst-case ATTRIBUTION TARGET length matters: a role
      // label emits as itself (raw length), but "subject" (7 chars) emits as
      // the rendered subject name (up to RENDERED_IDENTITY_NAME_MAX).
      const projectedLen = Math.max(value.length, RENDERED_IDENTITY_NAME_MAX);
      projected = setRenderedTextAtPath(projected, path, "x".repeat(projectedLen));
      continue;
    }
    // Text DOES run through `serializeLiteralPromptString`, which escapes
    // every embedded `"`/`\` to two characters — so the placeholder must
    // preserve the moderator's REAL literal characters (their true escaping
    // cost is already fully known at save time) and only substitute the
    // TOKEN-expansion portion with a safe worst-case-length filler.
    // `projectWorstCaseRenderedText` does exactly that (a plain "x" fill on
    // length alone would either undercount real quoted speech or, filled
    // with worst-case-escaping chars uniformly, wrongly over-inflate
    // ordinary quote-free bubbles — Codex P2, PR #229).
    projected = setRenderedTextAtPath(projected, path, projectWorstCaseRenderedText(value));
  }
  let worst = 0;
  for (const entry of ADDITIONS_MODES) {
    const withBubbles = compileWithOverride(entry, projected);
    const baseline = compileWithOverride(entry, EMPTY_ENABLED_OVERRIDE);
    worst = Math.max(worst, withBubbles - baseline);
  }
  return Math.max(0, worst);
}

// ─── The one server-side VSO persistence preflight ──────────────────────────

/**
 * The single authoritative save/pick gate for a visual-strategy override:
 * measures the additions and bubble emissions through the REAL compiler and
 * runs the pure api-zod budget validator on them. Every surface that persists
 * or promises to persist a VSO — the admin fact enrichment PATCH, the
 * review-candidate enrichment PATCH, and candidate-concept pickability — calls
 * THIS helper, so "valid to pick" and "valid to save" can never drift.
 * Disabled overrides validate trivially (nothing is emitted at compile).
 */
export function validateVisualStrategyOverridePersistence(
  ov: VisualPromptStrategyOverride,
): VsoBudgetResult {
  return validateVisualStrategyOverrideForSave(
    ov,
    measureModeratorAdditionsEmission(ov),
    measureBubbleDirectivesEmission(ov),
  );
}
