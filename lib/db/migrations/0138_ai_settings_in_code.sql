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
-- CAPTURED BEFORE DELETING (the rule from 0105,
-- .agents/memory/retirement-migration-captures-admin-curated-rows.md), into
-- feature_permissions_migration_log.deleted_rows under '0138_ai_settings_in_code':
-- every deleted admin_config row whole, and every engines row whole. An admin
-- could edit both until 2026-11-14, and a production key may predate 0137.
--
-- Row-state matrix: present -> captured, then deleted / dropped; absent (a
-- fresh database on the baseline lacks the newer keys; production never held
-- some) -> nothing captured, skipped. A second run finds nothing to capture,
-- writes no log row, and drops nothing: twice equals once.
-- Rollback: not by revert. The captured rows are in the log, and the values in
-- use are in git history (the engine files and the prompts' code defaults);
-- restoring the table would be a new migration and the boot-time reconciler
-- from before this change.
DO $$
DECLARE
  v_keys text[] := ARRAY[
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
  ];
  v_config jsonb := '[]'::jsonb;
  v_engines jsonb := '[]'::jsonb;
  v_config_deleted integer := 0;
  v_engines_count integer := 0;
  v_dropped boolean := false;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.key), '[]'::jsonb) INTO v_config
    FROM admin_config c WHERE c.key = ANY (v_keys);

  IF to_regclass('engines') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), ''[]''::jsonb) FROM engines e'
      INTO v_engines;
  END IF;

  IF v_config <> '[]'::jsonb OR v_engines <> '[]'::jsonb THEN
    INSERT INTO feature_permissions_migration_log (migration_name, deleted_rows)
      VALUES ('0138_ai_settings_in_code', jsonb_build_object('admin_config', v_config, 'engines', v_engines));
  END IF;

  WITH gone AS (DELETE FROM admin_config WHERE key = ANY (v_keys) RETURNING 1)
  SELECT count(*)::integer INTO v_config_deleted FROM gone;

  IF to_regclass('engines') IS NOT NULL THEN
    v_engines_count := jsonb_array_length(v_engines);
    DROP TABLE engines;
    v_dropped := true;
  END IF;

  RAISE NOTICE '0138: admin_config rows captured and deleted: %; engines rows captured: % (table dropped: %)',
    v_config_deleted, v_engines_count, v_dropped;
END $$;
