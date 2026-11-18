/**
 * @purpose The AI settings that live in code alone (the system prompts and the retired engine-choice keys): boot does not seed them, no admin write reaches them, every reader returns the code constant, and the admin config list does not show them.
 * @subsystem ai-config
 *
 * Launch Phase 3, plan amendment 1, Part B (docs/plans/PLAN_PHASE3_AMENDMENT_1.md,
 * approved by David 2026-10-29). Migration 0138 deleted their `admin_config`
 * rows; the refusal below keeps a write from recreating one. The read-only AI
 * settings page shows them, from code (aiSettingsView.ts).
 */
import type { AdminConfig } from "@workspace/db/schema";

import { FACT_ENRICHMENT_PROMPT_DEFS } from "./factEnrichmentConfig";
import { IMAGE_PROMPT_PROMPT_DEFS } from "./imagePromptConfig";
import { READING_PROMPT_DEF } from "./readingConfig";
import { REFERENCE_RESEARCH_PROMPT_DEF } from "./referenceResearchConfig";
import { VISUAL_CONCEPTS_PROMPT_DEFS } from "./visualConceptsConfig";

export const CODE_OWNED_PROMPT_DEFS = [
  ...FACT_ENRICHMENT_PROMPT_DEFS,
  ...IMAGE_PROMPT_PROMPT_DEFS,
  REFERENCE_RESEARCH_PROMPT_DEF,
  READING_PROMPT_DEF,
  ...VISUAL_CONCEPTS_PROMPT_DEFS,
];

const CODE_OWNED_PROMPT_KEYS: ReadonlySet<string> = new Set(CODE_OWNED_PROMPT_DEFS.map((d) => d.key));

export function isCodeOwnedPromptKey(key: string): boolean {
  return CODE_OWNED_PROMPT_KEYS.has(key);
}

/**
 * The engine-choice keys retired by decisions.md 2026-11-14 (AI call settings
 * live in code): their rows, where a database still holds them, are no longer
 * read, and like the prompts they are neither shown nor writable.
 */
export const RETIRED_AI_ENGINE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "fact_visual_concepts_engine_id",
  "fact_enrichment_engine_id",
  "fact_image_prompt_engine_id",
  "fact_source_classifier_engine_id",
  "image_engine_t2i",
  "image_engine_i2i",
  "nsfw_classifier_endpoint",
  "fact_visual_concepts_engine_id_before_0137",
  "fal_safety_tolerance_pulid",
  // The render planner's system prompt, retired with the planner (plan
  // PLAN_GAG_DIRECT_RENDER.md, D); a row a database still holds is never read.
  "fact_image_prompt_system",
]);

export const CODE_OWNED_AI_SETTING_REFUSAL = "This AI setting is set in code; change it through a reviewed pull request.";

/** True for an AI setting set in code: a system prompt or a retired engine-choice key. */
export function isCodeOwnedAiConfigKey(key: string): boolean {
  return isCodeOwnedPromptKey(key) || RETIRED_AI_ENGINE_CONFIG_KEYS.has(key);
}

/**
 * The admin config list without any AI setting set in code (David,
 * 2026-11-14: the admin UI that defines engines or other AI settings is
 * retired and removed, so an admin no longer sees it).
 */
export function withoutCodeOwnedAiSettings(rows: AdminConfig[]): AdminConfig[] {
  return rows.filter((r) => !isCodeOwnedAiConfigKey(r.key));
}
