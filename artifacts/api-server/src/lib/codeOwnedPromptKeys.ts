/**
 * @purpose The six AI system prompts whose text lives in code alone: boot does not seed them, no admin write reaches them, and every reader returns the code constant.
 * @subsystem ai-config
 *
 * Launch Phase 3, plan amendment 1, Part B (docs/plans/PLAN_PHASE3_AMENDMENT_1.md,
 * approved by David 2026-10-29). Their `admin_config` rows, where an older
 * database still holds them, are ignored until a later migration retires them.
 * A dependency-free leaf, so the config modules and the admin routes can all
 * import it without a cycle.
 */
export const CODE_OWNED_PROMPT_KEYS: ReadonlySet<string> = new Set([
  "fact_enrichment_system",
  "fact_source_classifier_system",
  "fact_visual_concepts_system",
  "fact_image_prompt_system",
  "scene_prompt_system",
  "reference_research_system",
]);

export const CODE_OWNED_PROMPT_REFUSAL = "This prompt is set in code; change it through a reviewed pull request.";
