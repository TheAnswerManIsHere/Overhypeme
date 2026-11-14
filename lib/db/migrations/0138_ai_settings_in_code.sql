-- AI call settings live in code: the stored copies go (scope agreed by David,
-- 2026-11-14, Issue #943, option 1; decisions.md 2026-11-14). Contract only.
--
-- Nothing reads what this deletes. Every engine and every AI call setting is
-- read from the code catalogue (artifacts/api-server/src/lib/engines/) since
-- PR #946, and these rows had been hidden and refused by the admin API since.
--
-- 1. admin_config: the 15 retired AI-setting rows, by name. Ten engine
--    choices and parameters (the seven engine keys, the NSFW endpoint, the
--    0137 recovery copy of the gag writer's previous engine, and the FLUX Pro
--    safety tolerance, now FAL_SAFETY_TOLERANCE in code) and the six system
--    prompts (codeOwnedPrompts.ts). A key not present is skipped, so the
--    statement is a no-op on a database that never held it.
-- 2. engines: dropped. Nothing references it: image provenance, image prompt
--    attempts and comparison cells keep the engine id as plain text, with no
--    foreign key, so their history is unchanged. Its availability, tier and
--    ordering values were read on dev and production on 2026-11-14 and equal
--    the code's (Issue #943), so no engine switches on or off.
--
-- Row-state matrix: present -> deleted / dropped; absent (a fresh database on
-- the baseline already lacks the 2026-11-14 keys; production never held the
-- newer ones) -> skipped. Running it twice equals once.
-- Rollback: not by revert. The values are in git history (the engine files
-- and the prompts' code defaults); restoring the table would be a new
-- migration and the boot-time reconciler from before this change.
DELETE FROM "admin_config" WHERE "key" IN (
  'fact_enrichment_engine_id',
  'fact_visual_concepts_engine_id',
  'fact_visual_concepts_engine_id_before_0137',
  'fact_image_prompt_engine_id',
  'fact_source_classifier_engine_id',
  'image_engine_t2i',
  'image_engine_i2i',
  'nsfw_classifier_endpoint',
  'fal_safety_tolerance_pulid',
  'fact_enrichment_system',
  'fact_visual_concepts_system',
  'fact_image_prompt_system',
  'fact_source_classifier_system',
  'scene_prompt_system',
  'reference_research_system'
);--> statement-breakpoint
DROP TABLE IF EXISTS "engines";
