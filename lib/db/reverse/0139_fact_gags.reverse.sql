-- Reverse of migration 0139_fact_gags (plan docs/plans/PLAN_THREE_GAGS.md,
-- "Recovery"). NOT a migration: the runner never reads this directory. It is
-- run by hand, on David's say, with the release before 0139 deployed, and is
-- tested by artifacts/api-server/src/__tests__/migration0139.factGags.test.ts.
--
-- It rebuilds every prior state from the capture 0139 wrote to
-- feature_permissions_migration_log: each fact's override back into
-- facts.enrichment (and enrichment_ai_derived where it was there), each open
-- refresh candidate's back into its enrichment and visual_override; then it
-- restores the facts_active_requires_concept CHECK and removes fact_gags,
-- image_prompt_attempts.gag_id and the trigger.
--
-- It refuses once any gag has been added, changed or approved under the new
-- model (a gag row 0139 did not write, or one changed since): reversing then
-- would lose a moderator's work, and the route is fix-forward.
DO $$
DECLARE
  v_log jsonb;
  v_touched integer;
BEGIN
  IF to_regclass('fact_gags') IS NULL THEN
    RAISE NOTICE '0139 reverse: fact_gags is absent; nothing to do';
    RETURN;
  END IF;

  SELECT count(*) INTO v_touched FROM fact_gags
   WHERE created_by IS NOT NULL OR approved_example_attempt_id IS NOT NULL
      OR removed_at IS NOT NULL OR updated_at <> created_at OR slot <> 1
      OR (approved_content IS NOT NULL AND NOT approved_carried_over);
  IF v_touched > 0 THEN
    RAISE EXCEPTION '0139 reverse refused: % gags were added, changed or approved after the migration; fix forward', v_touched;
  END IF;

  SELECT deleted_rows INTO v_log FROM feature_permissions_migration_log
   WHERE migration_name = '0139_fact_gags' ORDER BY id DESC LIMIT 1;

  IF v_log IS NOT NULL THEN
    UPDATE facts f
       SET enrichment = CASE WHEN x ? 'override' AND x -> 'override' <> 'null'::jsonb
                             THEN jsonb_set(coalesce(f.enrichment, '{}'::jsonb), '{visualPromptStrategyOverride}', x -> 'override')
                             ELSE f.enrichment END,
           enrichment_ai_derived = CASE WHEN x ? 'ai_derived_override' AND x -> 'ai_derived_override' <> 'null'::jsonb
                             THEN jsonb_set(f.enrichment_ai_derived, '{visualPromptStrategyOverride}', x -> 'ai_derived_override')
                             ELSE f.enrichment_ai_derived END
      FROM jsonb_array_elements(v_log -> 'facts') x
     WHERE f.id = (x ->> 'id')::integer;

    UPDATE fact_enrichment_versions v
       SET visual_override = CASE WHEN c -> 'visual_override' <> 'null'::jsonb THEN c -> 'visual_override' END,
           enrichment = CASE WHEN c -> 'enrichment_override' IS NOT NULL AND c -> 'enrichment_override' <> 'null'::jsonb AND v.enrichment IS NOT NULL
                             THEN jsonb_set(v.enrichment, '{visualPromptStrategyOverride}', c -> 'enrichment_override')
                             ELSE v.enrichment END
      FROM jsonb_array_elements(v_log -> 'candidates') c
     WHERE v.id = (c ->> 'id')::integer;
  END IF;

  DROP TRIGGER IF EXISTS facts_live_requires_approved_gag ON facts;
  DROP TRIGGER IF EXISTS fact_gags_live_fact_keeps_approved_gag ON fact_gags;
  DROP FUNCTION IF EXISTS enforce_live_fact_has_approved_gag();
  ALTER TABLE image_prompt_attempts DROP COLUMN IF EXISTS gag_id;
  DROP TABLE fact_gags;

  ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_active_requires_concept;
  ALTER TABLE facts ADD CONSTRAINT facts_active_requires_concept CHECK (
    is_active = false OR COALESCE(
      jsonb_typeof(enrichment #> '{visualPromptStrategyOverride,coreSceneOverride}') = 'string'
      AND (enrichment #>> '{visualPromptStrategyOverride,coreSceneOverride}') ~ '\S',
      false));
END $$;
