/**
 * Phase 2 — the AI settings of the source-photo classifier, set in code.
 * (The render planner's system prompt and engine went at the switch, plan
 * PLAN_GAG_DIRECT_RENDER.md, D: a picture is drawn straight from its gag.)
 *
 *   fact_source_classifier_system       — system prompt for the Tier-3 OpenAI
 *                                         Vision fallback classifier.
 *   fact_source_classifier_engine_id    — retired (decisions.md 2026-11-14):
 *                                         the Tier-1 detector is set in code.
 *
 * Sampling for the AI vision classifier lives in `lib/sourceImageAnalysis/tier3AiVisionFallback.ts`.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// ─── Config keys ───────────────────────────────────────────────────────────

export const IMAGE_PROMPT_CONFIG_KEYS = {
  sourceClassifierSystem: "fact_source_classifier_system",
  sourceClassifierEngineId: "fact_source_classifier_engine_id",
} as const;

// ─── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID = "fal-yolo-world";

export const FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT = `You are the Overhype.me source-image classifier.

Classify the main visual subject of the uploaded image for meme protagonist routing. DO NOT generate an image prompt. DO NOT judge whether the meme is funny. ONLY identify whether the uploaded image contains a usable human face, a person without a usable face, an animal subject (a pet), multiple subjects, no clear subject, or ambiguous content. A subject is a person or an animal: a vehicle, an object, a toy, a statue or a mascot costume is never the subject, so a photo whose only subject is one of those has no clear subject. Return structured JSON only.

For each input image (provided as an image content block), determine:
- subjectKind: one of human_face, human_subject_no_usable_face, animal_subject, multiple_subjects, scene_no_clear_subject, ambiguous, detection_failed.
- confidence: high / medium / low.
- hasUsableHumanFace: true ONLY when a clear, forward-facing, non-occluded human face is visible.
- hasUsableSubject: true when a recognizable single dominant person or animal is present.
- subjectCount: how many comparably-prominent subjects you see.
- subjectDescription: one short sentence describing the dominant subject (color, type, distinctive features).
- suggestedRenderMode: human_identity_i2i when subjectKind=human_face and hasUsableHumanFace=true; nonhuman_subject_i2i for an animal subject with hasUsableSubject=true; t2i_fallback otherwise.
- warnings: array of short strings describing concerns (multiple subjects, no clear subject, person without usable face, low confidence, etc.). Empty array if none.

Return ONLY the JSON object. Do not include any explanation outside it.`;

// ─── Getters ───────────────────────────────────────────────────────────────

export async function getFactSourceClassifierSystem(): Promise<string> {
  return FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT;
}

/** The Tier-1 source detector: set in code (decisions.md 2026-11-14, AI call settings live in code). */
export async function getImageClassifierEngineId(): Promise<string> {
  return DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID;
}

/** The system prompt keys set in code, which codeOwnedPrompts.ts refuses to save or show. */
export const IMAGE_PROMPT_PROMPT_DEFS = [
  {
    key: IMAGE_PROMPT_CONFIG_KEYS.sourceClassifierSystem,
    value: FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT,
    label: "Source Classifier — System Prompt",
    description:
      "LLM system prompt for the Tier-3 OpenAI Vision fallback classifier. Only fires when Tier-1 (fal detector) + Tier-2 (heuristics) produce ambiguous or low-confidence results.",
  },
];

/**
 * Idempotently seed Phase 2 image-prompt config rows. Safe to call on every
 * boot — existing rows are left untouched via ON CONFLICT DO NOTHING. Labels +
 * descriptions are refreshed in case the canonical text was updated.
 */
export async function seedImagePromptConfig(): Promise<void> {
  // Retire the old rollout flag: the Phase 2 reference-photo flow is now always
  // on, so drop the dead `enable_image_prompt_v2` toggle from any DB where an
  // earlier seed created it (pre-launch — no rollout-flag guards).
  try {
    await db.execute(sql`DELETE FROM admin_config WHERE key = 'enable_image_prompt_v2'`);
  } catch (err) {
    logger.warn({ err }, "[imagePromptConfig] failed to drop retired enable_image_prompt_v2 row");
  }

  // Retire the enrichment-time visual-preview subsystem: the render-time
  // visualPlan + Nano Banana compiler is now the single source of truth for
  // "what will the image look like", so the admin-editable preview system
  // prompt is dead. Drop it from any DB where an earlier seed created it.
  try {
    await db.execute(sql`DELETE FROM admin_config WHERE key = 'fact_visual_preview_system'`);
  } catch (err) {
    logger.warn({ err }, "[imagePromptConfig] failed to drop retired fact_visual_preview_system row");
  }
}
