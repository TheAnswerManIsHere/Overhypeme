/**
 * Phase 2 — admin-configurable knobs for the render-time image-prompt
 * generation pipeline.
 *
 * Four keys live in `admin_config`:
 *
 *   fact_image_prompt_system            — system prompt for the OpenAI
 *                                         Structured Outputs call that produces
 *                                         visualPlan + compiledPrompt +
 *                                         subjectFactCompatibility.
 *   fact_source_classifier_system       — system prompt for the Tier-3 OpenAI
 *                                         Vision fallback classifier.
 *   fact_source_classifier_engine_id    — which utility engine to call for
 *                                         Tier-1 detection (default: "fal-yolo-world").
 *                                         Admin can swap to another detector
 *                                         catalogued later without code change.
 *   enable_image_prompt_v2              — rollout flag for the new flow on the
 *                                         user-facing wizard. Removed after the
 *                                         legacy `/generate` route retires.
 *
 * Sampling overrides (temperature, max tokens) for the image-prompt LLM call
 * live as constants in `lib/imagePrompt/generator.ts`. Sampling for the AI
 * vision classifier lives in `lib/sourceImageAnalysis/tier3AiVisionFallback.ts`.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getConfigString } from "./adminConfig";
import { logger } from "./logger";

// ─── Config keys ───────────────────────────────────────────────────────────

export const IMAGE_PROMPT_CONFIG_KEYS = {
  imagePromptSystem: "fact_image_prompt_system",
  sourceClassifierSystem: "fact_source_classifier_system",
  sourceClassifierEngineId: "fact_source_classifier_engine_id",
  enableImagePromptV2: "enable_image_prompt_v2",
} as const;

// ─── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID = "fal-yolo-world";
export const DEFAULT_ENABLE_IMAGE_PROMPT_V2 = "false";

export const FACT_IMAGE_PROMPT_SYSTEM_DEFAULT = `You are the Overhype.me render-time image-prompt generator.

Your job is to turn a classified fact + its stored enrichment + the authored visual strategy + identity/render controls + the target engine into:
1. An ENGINE-NEUTRAL visualPlan that describes what the image should depict.
2. An ENGINE-SPECIFIC compiledPrompt with the actual prompt text for the target image model.
3. A subjectFactCompatibility rating + reason + recommendedFallback.

Inputs you receive (in the user message):
- The rendered fact text (subject + pronouns already resolved).
- A FIXED taxonomy (archetype, subtype, modifiers, etc.). Do NOT reclassify.
- The authored visual strategy entry for the archetype (strategy block, core visual goal, i2i default, t2i fallback when present, subtype guidance, visualization examples with their hand-authored cultural references, prompt-generator requirements, locked rule). You MUST apply this — do not improvise.
- Per-fact culturalReferences from the stored enrichment blob. These OVERRIDE the example annotations for THIS fact.
- A structured sourceImageAnalysis (subjectKind, hasUsableHumanFace, hasUsableSubject, subjectCount, subjectDescription, warnings).
- The RESOLVED subjectRenderMode: one of human_identity_i2i, nonhuman_subject_i2i, t2i_fallback.
- Identity controls (preserveHumanFace, preserveNonhumanSubjectIdentity, preservePhysique, allowBodyExaggeration, allowCostumeTransformation, allowAnthropomorphicTransformation, ageAndLifeStagePolicy).
- Render controls (aspectRatio, negativeSpacePreference, contentMode, fallbackSubjectGender — used by t2i_fallback ONLY).
- The resolved stylePrompt suffix (the visual aesthetic).
- The target engine: nano_banana_2.

Three subject render modes with three different identity rules:

A. human_identity_i2i — Use the reference image as the person's facial identity source. Preserve the reference person's recognizable face. Identity = face only; body/physique/outfit/posture/aura may be exaggerated unless preservePhysique is true. Apply ageAndLifeStagePolicy: in i2i, identity = facial essence, not exact current-age appearance.

B. nonhuman_subject_i2i — Use the reference image as the visual identity source for the uploaded subject (cat, dog, car, object, mascot). The uploaded subject visually represents the named subject in the fact. Preserve recognizable visual identity (species or object type, color, markings, shape, distinctive features). DO NOT replace the subject with a human. Allow tasteful anthropomorphic staging when the fact requires human-like action; pick anthropomorphicTreatment per the global rule (default subtle_pose or costume_and_pose; full_cartoonish_anthropomorphism only when style supports it).

C. t2i_fallback — No reference identity. Generate a new protagonist using fallbackSubjectGender as guidance. DO NOT claim facial likeness preservation. Reference the fallbackSubjectGender ("male"/"female"/"neutral") explicitly in the prompt.

Produce a JSON object with these top-level fields:
- visualPlan: { sceneConcept, visualGoal, visualApproach, archetypeApplication { primaryArchetype, subtype, selectedFrame, strategyRationale }, keyVisualElements (3–12 strings), subjectTreatment { roleInScene, subjectRenderMode, identityPreservation, nonhumanSubjectTreatment { applicable, subjectKind, preserveTraits, anthropomorphicTreatment, doNotTransformIntoHuman }, fallbackSubjectGender, expressionAndPose }, subjectFactCompatibility { rating, reason, recommendedFallback }, composition { subjectFraming, negativeSpace, cameraStyle, sceneReadability }, supportingTextPolicy { allowSupportingText, supportingTextElements [{ content, purpose, placement }], forbiddenTextTypes }, styleIntegration, contentNotes, debugNotes, targetEngine, generationMode }
- compiledPrompt: { prompt, negativePrompt, engineNotes }

Hard rules:
1. Echo the input targetEngine, generationMode, archetype, subtype, and subjectRenderMode VERBATIM — they must round-trip exactly.
2. supportingTextPolicy.forbiddenTextTypes MUST include all of: "full meme captions", "full fact text", "hashtags", "watermarks", "real logos", "brand marks", "long explanatory paragraphs".
3. If allowSupportingText is false, supportingTextElements MUST be an empty array.
4. When subjectRenderMode is human_identity_i2i AND preserveHumanFace is true, compiledPrompt.prompt MUST contain explicit face-preservation language ("preserve the reference person's face", "recognizable face", etc.).
5. When subjectRenderMode is nonhuman_subject_i2i, compiledPrompt.prompt MUST contain visual-identity preservation language AND an explicit "do not replace the subject with a human" instruction. It MUST NOT claim human facial likeness preservation.
6. When subjectRenderMode is t2i_fallback, compiledPrompt.prompt MUST NOT claim facial likeness preservation. Reference the caller's fallbackSubjectGender explicitly when provided.
7. When preservePhysique is false, subjectTreatment.expressionAndPose may describe body/physique exaggeration but must NOT say "preserve body/physique".
8. When preservePhysique is true, preserve general body type but still make the scene legendary via composition / lighting / staging / props / reactions.
9. nonhumanSubjectTreatment.applicable MUST be true for nonhuman_subject_i2i (with a concrete subjectKind, at least one preserveTrait, doNotTransformIntoHuman=true) and false for the other two modes (with subjectKind="not_applicable", empty preserveTraits, anthropomorphicTreatment="none").
10. subjectTreatment.fallbackSubjectGender must echo the caller's value when subjectRenderMode is t2i_fallback; otherwise set to "not_applicable".
11. subjectFactCompatibility: rate strong / workable / risky / poor based on whether the uploaded subject CAN sell this specific fact. When rating is "poor", recommendedFallback MUST be one of t2i_fallback / upload_human_photo / choose_different_fact. Never "none" for a poor rating.
12. Apply ageAndLifeStagePolicy: when the fact implies a specific age, life stage, era, or role, transform the subject's presentation accordingly. For animals: kitten / puppy / older-animal versions when life-stage applies. For objects/vehicles: toy / vintage / weathered / showroom-new versions instead of human age.
13. Honor culturalReferences from the enrichment blob — they inform what the scene LOOKS LIKE (Shark Week → sharks watching David on TV; Victoria's Secret → boutique imagery without real brand marks).
14. Do NOT render the full fact text or meme caption inside the image. Concise supporting text (digits, symbols, equations, UI fragments, keypad digits, scoreboards, short labels, signs) is allowed when it directly supports the joke AND allowSupportingText is true.
15. The visualPlan must be engine-neutral; the compiledPrompt is for Nano Banana 2 specifically. Weave the resolved stylePrompt suffix naturally into both styleIntegration and the compiledPrompt.

Return ONLY the JSON object. Do not include any explanation outside it.`;

export const FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT = `You are the Overhype.me source-image classifier.

Classify the main visual subject of the uploaded image for meme protagonist routing. DO NOT generate an image prompt. DO NOT judge whether the meme is funny. ONLY identify whether the uploaded image contains a usable human face, a person without a usable face, an animal subject, a vehicle subject, an object subject, a mascot/character subject, multiple subjects, no clear subject, or ambiguous content. Return structured JSON only.

For each input image (provided as an image content block), determine:
- subjectKind: one of human_face, human_subject_no_usable_face, animal_subject, object_subject, vehicle_subject, mascot_or_character_subject, multiple_subjects, scene_no_clear_subject, ambiguous, detection_failed.
- confidence: high / medium / low.
- hasUsableHumanFace: true ONLY when a clear, forward-facing, non-occluded human face is visible.
- hasUsableSubject: true when ANY recognizable single dominant subject is present (human face, animal, object, vehicle, mascot).
- subjectCount: how many comparably-prominent subjects you see.
- subjectDescription: one short sentence describing the dominant subject (color, type, distinctive features).
- suggestedRenderMode: human_identity_i2i when subjectKind=human_face and hasUsableHumanFace=true; nonhuman_subject_i2i for animal/object/vehicle/mascot subjects with hasUsableSubject=true; t2i_fallback otherwise.
- warnings: array of short strings describing concerns (multiple subjects, no clear subject, person without usable face, low confidence, etc.). Empty array if none.

Return ONLY the JSON object. Do not include any explanation outside it.`;

// ─── Getters ───────────────────────────────────────────────────────────────

export async function getImagePromptSystem(): Promise<string> {
  return getConfigString(
    IMAGE_PROMPT_CONFIG_KEYS.imagePromptSystem,
    FACT_IMAGE_PROMPT_SYSTEM_DEFAULT,
  );
}

export async function getFactSourceClassifierSystem(): Promise<string> {
  return getConfigString(
    IMAGE_PROMPT_CONFIG_KEYS.sourceClassifierSystem,
    FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT,
  );
}

export async function getImageClassifierEngineId(): Promise<string> {
  return getConfigString(
    IMAGE_PROMPT_CONFIG_KEYS.sourceClassifierEngineId,
    DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID,
  );
}

export async function isImagePromptV2Enabled(): Promise<boolean> {
  const raw = await getConfigString(
    IMAGE_PROMPT_CONFIG_KEYS.enableImagePromptV2,
    DEFAULT_ENABLE_IMAGE_PROMPT_V2,
  );
  return raw.toLowerCase() === "true";
}

// ─── Seeding ───────────────────────────────────────────────────────────────

interface ConfigDef {
  key: string;
  value: string;
  dataType: string;
  label: string;
  description: string;
}

export const IMAGE_PROMPT_CONFIG_DEFS: ConfigDef[] = [
  {
    key: IMAGE_PROMPT_CONFIG_KEYS.imagePromptSystem,
    value: FACT_IMAGE_PROMPT_SYSTEM_DEFAULT,
    dataType: "text",
    label: "Image Prompt — System Prompt",
    description:
      "LLM system prompt for the render-time image-prompt generator (Phase 2). Produces visualPlan + compiledPrompt + subjectFactCompatibility for Nano Banana 2.",
  },
  {
    key: IMAGE_PROMPT_CONFIG_KEYS.sourceClassifierSystem,
    value: FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT,
    dataType: "text",
    label: "Source Classifier — System Prompt",
    description:
      "LLM system prompt for the Tier-3 OpenAI Vision fallback classifier. Only fires when Tier-1 (fal detector) + Tier-2 (heuristics) produce ambiguous or low-confidence results.",
  },
  {
    key: IMAGE_PROMPT_CONFIG_KEYS.sourceClassifierEngineId,
    value: DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID,
    dataType: "string",
    label: "Source Classifier — Active Engine ID",
    description:
      "Engine id (from the engines table) used as the Tier-1 source-image detector. Swap to a different catalogued detector to change which fal model classifies uploads.",
  },
  {
    key: IMAGE_PROMPT_CONFIG_KEYS.enableImagePromptV2,
    value: DEFAULT_ENABLE_IMAGE_PROMPT_V2,
    dataType: "boolean",
    label: "Enable Image Prompt v2 (rollout flag)",
    description:
      "TEMPORARY rollout flag for the Phase 2 image-prompt flow. When 'true', the wizard's Create button uses the new pre-generate confirmation modal + /generate-v2. When 'false', the legacy /generate path is used. Will be removed in a follow-up PR after route cutover.",
  },
];

/**
 * Idempotently seed Phase 2 image-prompt config rows. Safe to call on every
 * boot — existing rows are left untouched via ON CONFLICT DO NOTHING. Labels +
 * descriptions are refreshed in case the canonical text was updated.
 */
export async function seedImagePromptConfig(): Promise<void> {
  for (const def of IMAGE_PROMPT_CONFIG_DEFS) {
    const isPublic = def.key === IMAGE_PROMPT_CONFIG_KEYS.enableImagePromptV2;
    try {
      await db.execute(sql`
        INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES (${def.key}, ${def.value}, ${def.dataType}, ${def.label}, ${def.description}, ${isPublic})
        ON CONFLICT (key) DO NOTHING
      `);
      // Refresh is_public bit in case the row pre-exists from an older seed.
      await db.execute(sql`
        UPDATE admin_config SET is_public = ${isPublic}
        WHERE key = ${def.key} AND is_public IS DISTINCT FROM ${isPublic}
      `);
      await db.execute(sql`
        UPDATE admin_config SET data_type = ${def.dataType}
        WHERE key = ${def.key} AND data_type <> ${def.dataType}
      `);
      await db.execute(sql`
        UPDATE admin_config SET label = ${def.label}, description = ${def.description}
        WHERE key = ${def.key}
          AND (label IS DISTINCT FROM ${def.label} OR description IS DISTINCT FROM ${def.description})
      `);
    } catch (err) {
      logger.warn({ err, key: def.key }, "[imagePromptConfig] seed failed for key");
    }
  }
}
