/**
 * Render-time image-prompt generator (Phase 2).
 *
 * Calls OpenAI with strict Structured Outputs to produce:
 *   - visualPlan (engine-neutral)
 *   - compiledPrompt (Nano Banana 2)
 *   - subjectFactCompatibility (inline)
 *
 * Mirrors `lib/promptStrategy/visualPreview.ts`: build user message, call
 * model via `callUtilityLLM` + `zodResponseFormat(strictSchema)`, parse,
 * run business validator with mode-aware rules, retry ONCE on validation
 * failure with a corrective message, throw on second failure.
 */

import { zodResponseFormat } from "openai/helpers/zod";
import {
  imagePromptPlanWireSchema,
  validateImagePromptPlan,
  IMAGE_PROMPT_GENERATION_VERSION,
  VISUAL_PROMPT_GLOBAL_RULES,
  VISUAL_STRATEGY_VERSION,
  getVisualPromptStrategy,
  getSubtypeGuidance,
  type ImagePromptGenerationInput,
  type PlanExpectations,
  type FactSubtype,
} from "@workspace/api-zod";
import { callUtilityLLM } from "../utilityLLM";
import { getImagePromptSystem } from "../imagePromptConfig";
import { logger } from "../logger";
import { generationModeFromSubjectRenderMode } from "../sourceImageAnalysis";
import type { ImagePromptGenerationOutput } from "./types";

export const IMAGE_PROMPT_TEMPERATURE = 0.4;
export const IMAGE_PROMPT_MAX_TOKENS = 2800;

export class ImagePromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePromptError";
  }
}

type UserMessage = { role: "user"; content: string };

// ─── User-message assembly ────────────────────────────────────────────────

/** Truncate to `max` chars on a word boundary with an ellipsis. */
function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

/**
 * A cultural reference is "material" — strong enough to force into the plan and
 * the engine prompt — when it was researched with high confidence, OR the
 * enrichment was confident about it and it isn't flagged for admin review.
 * Ambiguous / review-required references are surfaced to the generator as
 * context but never forced (they may be wrong).
 */
export function isMaterialCulturalReference(r: {
  confidence: number;
  requiresAdminReview: boolean;
  researchConfidence?: "high" | "medium" | "low";
}): boolean {
  if (r.researchConfidence === "high") return true;
  return r.confidence >= 0.8 && !r.requiresAdminReview;
}

/** Identity key for a reference: its sourcePhrase, falling back to canonical. */
export function culturalReferenceKey(r: { sourcePhrase: string; canonicalReference: string }): string {
  return (r.sourcePhrase.trim() || r.canonicalReference.trim());
}

function expectationsFromInput(input: ImagePromptGenerationInput): PlanExpectations {
  const materialSemanticEntities = (input.enrichment.semanticEntities ?? [])
    .filter((e) => e.materiallyAffectsVisualPrompt)
    .map((e) => e.surfaceText);
  const materialCulturalReferences = (input.enrichment.culturalReferences ?? [])
    .filter(isMaterialCulturalReference)
    .map(culturalReferenceKey)
    .filter(Boolean);
  return {
    archetype: input.enrichment.primaryArchetype,
    subtype: input.enrichment.subtype as FactSubtype,
    targetEngine: input.targetEngine,
    subjectRenderMode: input.subjectRenderMode,
    generationMode: generationModeFromSubjectRenderMode(input.subjectRenderMode),
    preserveHumanFace: input.identityPolicy.preserveHumanFace,
    preservePhysique: input.identityPolicy.preservePhysique,
    factText: input.factText,
    fallbackSubjectGender: input.renderControls.fallbackSubjectGender ?? null,
    materialSemanticEntities,
    materialCulturalReferences,
  };
}

export function buildImagePromptUserMessage(input: ImagePromptGenerationInput): string {
  const e = input.enrichment;
  const strategy = getVisualPromptStrategy(e.primaryArchetype);
  const subtypeGuide = getSubtypeGuidance(e.primaryArchetype, e.subtype as FactSubtype);

  const culturalRefsBlock = e.culturalReferences.length
    ? e.culturalReferences
        .map((r, i) => {
          const base = `  ${i + 1}. sourcePhrase="${r.sourcePhrase}", referenceType=${r.referenceType}, canonical="${r.canonicalReference}", explanation="${r.explanation}", visualImplication="${r.visualImplication}", confidence=${r.confidence}, requiresAdminReview=${r.requiresAdminReview}, material=${isMaterialCulturalReference(r)}`;
          // Research context (only present after an admin runs "Research
          // Reference"). Compact: confidence + truncated notes + ≤3 warnings.
          const research: string[] = [];
          if (r.researchConfidence) research.push(`researchConfidence=${r.researchConfidence}`);
          if (r.researchNotes && r.researchNotes.trim()) {
            research.push(`researchNotes="${truncateText(r.researchNotes.trim(), 400)}"`);
          }
          if (r.ambiguityWarnings && r.ambiguityWarnings.length) {
            research.push(`ambiguityWarnings=[${r.ambiguityWarnings.slice(0, 3).map((w) => `"${w}"`).join(", ")}]`);
          }
          return research.length ? `${base}\n       ${research.join(", ")}` : base;
        })
        .join("\n")
    : "  (no cultural references — render the joke from the literal text + taxonomy alone)";

  const materialCulturalRefs = e.culturalReferences.filter(isMaterialCulturalReference).map(culturalReferenceKey).filter(Boolean);

  const semanticEntities = e.semanticEntities ?? [];
  const materialEntities = semanticEntities.filter((s) => s.materiallyAffectsVisualPrompt);
  const semanticEntitiesBlock = semanticEntities.length
    ? semanticEntities
        .map(
          (s, i) =>
            `  ${i + 1}. surfaceText="${s.surfaceText}", entityKind=${s.entityKind}, visualReferent="${s.visualReferent}", capitalizationSignal=${s.capitalizationSignal}, materiallyAffectsVisualPrompt=${s.materiallyAffectsVisualPrompt}, requiresAdminReview=${s.requiresAdminReview}, confidence=${s.confidence}${s.notes ? `, notes="${s.notes}"` : ""}`,
        )
        .join("\n")
    : "  (no capitalization-sensitive entities flagged by enrichment)";

  const examplesBlock = strategy.visualizationExamples
    .map((ex, i) => {
      const refs = ex.culturalReferences?.length
        ? `\n     example culturalReferences:\n${ex.culturalReferences.map((r) => `       - reference="${r.reference}", type=${r.type}, meaning="${r.meaning}", visualImplication="${r.visualImplication}"`).join("\n")}`
        : "";
      return `  ${i + 1}. fact: "${ex.fact}"
     visualApproach: ${ex.visualApproach || "(authoring pending)"}
     whyItWorks: ${ex.whyItWorks || "(authoring pending)"}
     avoid: ${ex.avoid || "(authoring pending)"}${refs}`;
    })
    .join("\n");

  // Per-mode global-rule excerpts.
  const modeRuleExcerpt = (() => {
    if (input.subjectRenderMode === "human_identity_i2i") {
      const physique = input.identityPolicy.preservePhysique
        ? VISUAL_PROMPT_GLOBAL_RULES.preservePhysiqueOverride
        : "";
      return [
        "Identity rule (human i2i):",
        VISUAL_PROMPT_GLOBAL_RULES.identityBaseline,
        physique ? `\nPreserve-physique override:\n${physique}` : "",
        `\nAge / life-stage policy:\n${VISUAL_PROMPT_GLOBAL_RULES.ageAndLifeStagePolicy}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (input.subjectRenderMode === "nonhuman_subject_i2i") {
      return [
        "Identity rule (non-human i2i):",
        VISUAL_PROMPT_GLOBAL_RULES.nonhumanSubjectIdentityPolicy,
        `\nAnthropomorphic treatment policy:\n${VISUAL_PROMPT_GLOBAL_RULES.anthropomorphicTreatmentPolicy}`,
        `\nAge / life-stage policy:\n${VISUAL_PROMPT_GLOBAL_RULES.ageAndLifeStagePolicy}`,
      ].join("\n");
    }
    return [
      "Identity rule (t2i fallback):",
      VISUAL_PROMPT_GLOBAL_RULES.textToImageFallbackPolicy,
    ].join("\n");
  })();

  const fallbackGender = input.renderControls.fallbackSubjectGender ?? null;

  return [
    "Generate the engine-neutral visualPlan + Nano Banana 2 compiledPrompt + subjectFactCompatibility for this render.",
    "",
    "RENDERED FACT TEXT (subject/pronouns already resolved). Inspect the EXACT spelling and capitalization — capitalization is meaningful for visual interpretation:",
    `factTextExact: ${input.factText}`,
    "",
    "TAXONOMY (FIXED — DO NOT reclassify):",
    `- primaryArchetype: ${e.primaryArchetype}`,
    `- subtype: ${e.subtype}`,
    `- modifiers: ${e.modifiers.join(", ") || "(none)"}`,
    `- visualLiteralness: ${e.visualLiteralness}`,
    `- visualComplexity: ${e.visualComplexity}`,
    `- overhypeFit: ${e.overhypeFit}`,
    `- adultSuitability: ${e.adultSuitability}`,
    `- taxonomyConfidence: ${e.taxonomyConfidence}`,
    "",
    "AUTHORED VISUAL STRATEGY (apply this — do not improvise):",
    `Strategy block: ${strategy.strategyBlock}`,
    `Core visual goal: ${strategy.coreVisualGoal}`,
    `i2i default: ${strategy.i2iDefault}`,
    strategy.t2iFallback ? `t2i fallback: ${strategy.t2iFallback}` : "",
    strategy.preservePhysique ? `Per-archetype preservePhysique: ${strategy.preservePhysique}` : "",
    subtypeGuide ? `Subtype guidance for ${e.subtype}: ${subtypeGuide.principle}${subtypeGuide.useWhen ? ` (use when: ${subtypeGuide.useWhen})` : ""}` : "",
    "",
    "Visualization examples:",
    examplesBlock,
    "",
    `Locked rule: ${strategy.lockedRule}`,
    strategy.frameSelectionGuidance && strategy.frameSelectionGuidance.length
      ? `Frames: ${strategy.frameSelectionGuidance.map((f) => `${f.frame} (${f.useWhen})`).join("; ")}`
      : "",
    "",
    "PER-FACT CULTURAL REFERENCES (override example annotations for THIS fact):",
    culturalRefsBlock,
    "",
    "SEMANTIC ENTITY INTERPRETATION (hard visual context — DO NOT override; treat as the locked meaning of the surface term in this fact):",
    semanticEntitiesBlock,
    materialEntities.length > 0
      ? `\nFor every entity above with materiallyAffectsVisualPrompt=true, include a matching entry in visualPlan.semanticEntitiesUsed (echo surfaceText verbatim; fill visualReferentUsed with the resolved referent; fill effectOnVisualPlan with one sentence on how this shaped the scene). Required surfaceTexts: ${materialEntities.map((s) => `"${s.surfaceText}"`).join(", ")}.`
      : "\n(semanticEntitiesUsed may be an empty array.)",
    materialCulturalRefs.length > 0
      ? `\nFor every MATERIAL cultural reference (material=true above), include a matching entry in visualPlan.culturalReferencesUsed (echo sourcePhrase verbatim; fill canonicalReferenceUsed + visualImplicationUsed + a one-sentence effectOnVisualPlan). Bake the reference's visual implication into keyVisualElements + the compiledPrompt.prompt, but never draw a real logo or brand mark. Required sourcePhrases: ${materialCulturalRefs.map((s) => `"${s}"`).join(", ")}.`
      : "\n(culturalReferencesUsed may be an empty array — no material references in this fact.)",
    "",
    "SOURCE-IMAGE ANALYSIS:",
    `- subjectKind: ${input.sourceImageAnalysis.subjectKind}`,
    `- confidence: ${input.sourceImageAnalysis.confidence}`,
    `- hasUsableHumanFace: ${input.sourceImageAnalysis.hasUsableHumanFace}`,
    `- hasUsableSubject: ${input.sourceImageAnalysis.hasUsableSubject}`,
    `- subjectCount: ${input.sourceImageAnalysis.subjectCount}`,
    input.sourceImageAnalysis.subjectDescription ? `- subjectDescription: "${input.sourceImageAnalysis.subjectDescription}"` : "",
    input.sourceImageAnalysis.warnings.length ? `- warnings: ${input.sourceImageAnalysis.warnings.join("; ")}` : "",
    `- classificationMethod: ${input.sourceImageAnalysis.classificationMethod}`,
    "",
    `RESOLVED subjectRenderMode: ${input.subjectRenderMode}`,
    input.userSelectedSubjectRenderMode ? `(user explicitly overrode suggestedRenderMode to ${input.userSelectedSubjectRenderMode})` : "",
    `RESOLVED generationMode: ${generationModeFromSubjectRenderMode(input.subjectRenderMode)}`,
    `Reference image present: ${input.referenceImageUrl ? "yes" : "no"}`,
    "",
    modeRuleExcerpt,
    "",
    "IDENTITY POLICY:",
    `- preserveHumanFace: ${input.identityPolicy.preserveHumanFace}`,
    `- preserveNonhumanSubjectIdentity: ${input.identityPolicy.preserveNonhumanSubjectIdentity}`,
    `- preservePhysique: ${input.identityPolicy.preservePhysique}`,
    `- allowBodyExaggeration: ${input.identityPolicy.allowBodyExaggeration}`,
    `- allowCostumeTransformation: ${input.identityPolicy.allowCostumeTransformation}`,
    `- allowAnthropomorphicTransformation: ${input.identityPolicy.allowAnthropomorphicTransformation}`,
    `- ageAndLifeStagePolicy: ${input.identityPolicy.ageAndLifeStagePolicy}`,
    "",
    "RENDER CONTROLS:",
    `- aspectRatio: ${input.renderControls.aspectRatio}`,
    `- negativeSpacePreference: ${input.renderControls.negativeSpacePreference ?? "auto"}`,
    `- contentMode: ${input.renderControls.contentMode}`,
    `- fallbackSubjectGender: ${fallbackGender ?? "(unset)"} ${input.subjectRenderMode === "t2i_fallback" ? "(REQUIRED for t2i_fallback — reference this in the prompt)" : "(ignore unless t2i_fallback)"}`,
    "",
    "STYLE INTEGRATION (weave naturally):",
    input.stylePrompt || "(no style suffix configured)",
    "",
    `TARGET ENGINE: ${input.targetEngine} (use t2i variant when generationMode=t2i, edit/i2i variant otherwise)`,
    "",
    "OUTPUT CONTRACT:",
    "- Echo input targetEngine, generationMode, archetype, subtype, subjectRenderMode verbatim.",
    "- The engine prompt is a fixed labeled contract assembled by the compiler: IMAGE-TO-IMAGE TASK · SUBJECT BINDING · CORE SCENE · SUBJECT DETAILS · ENVIRONMENT · COMPOSITION · LIGHTING AND STYLE · STRICT CONSTRAINTS. The compiler owns TASK + BINDING + STRICT CONSTRAINTS; you fill the concrete visual fields.",
    "- visualGoal / visualApproach: INTERNAL reasoning only (NOT sent to the image model). ONE short clause each — payoff and staging logic. Do NOT pack scene detail here.",
    "- coreScene: REQUIRED, non-empty. ONE tight paragraph of what is literally happening (subject + action + key objects). Concrete visuals only.",
    "- subjectDetails: REQUIRED, ≥1 concrete entry — pose, expression, apparent age/body presentation, wardrobe, distinctive features. For an age transform, visibly describe the transformed life stage (proportions, skin, hair).",
    "- environment: REQUIRED, ≥1 concrete entry — setting, background, props, scale.",
    "- lightingAndStyle: light, mood, palette, aesthetic. The resolved stylePrompt is appended by the compiler — do not repeat it verbatim.",
    "- ageLifeStageTransform: { applies, targetState }. applies=true with a concrete targetState noun (\"a baby/infant\", \"a school-age child\", \"an elderly man\") when the fact implies a life stage other than the reference person's current one; otherwise applies=false and targetState=\"\". The reference person IS the transformed subject — one entity, never an adult plus a separate baby/child.",
    "- DESCRIBE THE PICTURE, NOT THE JOKE: coreScene/subjectDetails/environment/lightingAndStyle must map to visible pixels. Do NOT write authorial-intent commentary (\"showcasing the absurdity\", \"emphasizing the humor\", \"creating a humorous contrast\", \"comedic effect\", \"the absurdity of the situation\"). Show the humor through concrete visuals.",
    "- Tone: when a scene is both serious and funny, state the hierarchy explicitly (e.g. \"serious cinematic staging; the humor comes from the visual contrast\") rather than mixing competing tone words like \"grounded\" and \"playful\" without relating them.",
    "- keyVisualElements: 3-12 entries; concrete visible elements only (no abstract joke explanation, no policy language). Gap-fill safety net — the compiler injects any not already covered by the concrete fields.",
    "- compiledPrompt.prompt OWNERSHIP: legacy CORE-SCENE fallback (the compiler prefers coreScene). Write ONLY the concrete scene. The compiler injects identity, reference-image, de-aging/binding, token, and text-policy language itself, so do NOT author any of these — they are stripped before the engine sees them: (a) face/identity/likeness preservation or de-aging (\"preserve the … face\", \"recognizable face\", \"same person\", \"de-age\", \"do not replace … with a human\"); (b) mentions of the uploaded/reference/source image or i2i/t2i; (c) NAME/SUBJ-style identity template tokens or \"interpret these terms\" clauses; (d) readable-text/logo/watermark policy. Describe what SHOULD be in the frame; the compiler owns the rest.",
    "- supportingTextPolicy.forbiddenTextTypes MUST include all 7 mandatory entries (full meme captions, full fact text, hashtags, watermarks, real logos, brand marks, long explanatory paragraphs).",
    "- If allowSupportingText is false, supportingTextElements MUST be an empty array.",
    "- supportingTextElements (when present) MUST have shape { content, purpose, placement } per element.",
    `- nonhumanSubjectTreatment.applicable MUST be ${input.subjectRenderMode === "nonhuman_subject_i2i" ? "true" : "false"}.`,
    `- subjectTreatment.fallbackSubjectGender MUST be ${input.subjectRenderMode === "t2i_fallback" ? `"${fallbackGender ?? "neutral"}"` : '"not_applicable"'}.`,
    "- subjectFactCompatibility: rate strong/workable/risky/poor with a reason; when rating is poor, recommendedFallback must NOT be \"none\".",
    materialEntities.length > 0
      ? `- semanticEntitiesUsed: MUST include an entry for each of [${materialEntities.map((s) => `"${s.surfaceText}"`).join(", ")}]; each entry needs surfaceText + visualReferentUsed + effectOnVisualPlan all non-empty.`
      : "- semanticEntitiesUsed: may be an empty array (no material entities in this fact).",
    materialCulturalRefs.length > 0
      ? `- culturalReferencesUsed: MUST include an entry for each of [${materialCulturalRefs.map((s) => `"${s}"`).join(", ")}]; each entry needs sourcePhrase + canonicalReferenceUsed + visualImplicationUsed + effectOnVisualPlan all non-empty.`
      : "- culturalReferencesUsed: may be an empty array (no material references in this fact).",
    `- compiledPrompt.negativePrompt: Nano Banana 2 has NO negative-prompt parameter — leave it as an empty string ("") and express every exclusion as positive scene language inside compiledPrompt.prompt (describe what SHOULD be there, e.g. "a clean bare wall" rather than "no posters").`,
    "- Return ONLY the JSON object.",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function buildCorrective(error: string, hint?: string): string {
  if (hint && hint !== error) {
    return `The previous response failed validation: ${error}\n\nFix: ${hint}\n\nReturn the full JSON object again with all fields correct.`;
  }
  return `The previous response failed validation: ${error}\n\nReturn the full JSON object again with all fields correct.`;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────

export async function generateImagePromptPlanWithModel(
  input: ImagePromptGenerationInput,
  callModel: (msgs: UserMessage[]) => Promise<string>,
): Promise<ImagePromptGenerationOutput> {
  const expectations = expectationsFromInput(input);
  const firstUser: UserMessage = { role: "user", content: buildImagePromptUserMessage(input) };

  let raw = await callModel([firstUser]);
  let parsed = safeJsonParse(raw);
  let result = validateImagePromptPlan(parsed, expectations);

  if (!result.ok) {
    raw = await callModel([firstUser, { role: "user", content: buildCorrective(result.error, result.correctableHint) }]);
    parsed = safeJsonParse(raw);
    result = validateImagePromptPlan(parsed, expectations);
  }

  if (!result.ok) {
    throw new ImagePromptError(result.error);
  }

  const data = result.data;
  return {
    visualPlan: data.visualPlan,
    compiledPrompt: data.compiledPrompt,
    promptVersion: IMAGE_PROMPT_GENERATION_VERSION,
    archetypeStrategyVersion: VISUAL_STRATEGY_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: "openai",
  };
}

// ─── Live wrapper ─────────────────────────────────────────────────────────

async function callOpenAIImagePrompt(userMessages: UserMessage[]): Promise<string> {
  const systemPrompt = await getImagePromptSystem();
  const response = await callUtilityLLM({
    temperature: IMAGE_PROMPT_TEMPERATURE,
    maxTokens: IMAGE_PROMPT_MAX_TOKENS,
    responseFormat: zodResponseFormat(imagePromptPlanWireSchema, "image_prompt_plan"),
    messages: [{ role: "system", content: systemPrompt }, ...userMessages],
  });
  return response.choices[0]?.message?.content ?? "{}";
}

/**
 * Generate the image-prompt plan via OpenAI. Throws `ImagePromptError` on
 * unrecoverable failure. Callers (the async-jobs handler + admin route)
 * catch this and surface `error` on the attempt row.
 */
export async function generateImagePromptPlan(
  input: ImagePromptGenerationInput,
): Promise<ImagePromptGenerationOutput> {
  try {
    return await generateImagePromptPlanWithModel(input, callOpenAIImagePrompt);
  } catch (err) {
    if (err instanceof ImagePromptError) throw err;
    logger.error({ err }, "[imagePrompt.generator] unexpected failure");
    throw new ImagePromptError(err instanceof Error ? err.message : String(err));
  }
}
