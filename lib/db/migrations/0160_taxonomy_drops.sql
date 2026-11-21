-- The taxonomy drops (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, item 15,
-- 2A/2B and Data Model; Issue #1018, increment 2.1c). 2.1a stopped reading and
-- writing the override, signature and engine-revision machinery; 2.1b stopped
-- reading and writing the four projection columns and converted the legacy
-- enrichment versions into fact_taxonomy_runs (0159). This migration removes
-- what is left of them.
--
-- 1. Seed today's taxonomy into the history (origin 'legacy_current'), so the
--    first Re-run on a fact never replaces a result nobody kept. Per fact with a
--    stored taxonomy:
--      seeded            — no history row holds it yet: one 'ok' row is added
--      already held      — (no-op) a 'legacy_current' row exists (a re-run), or
--                          the fact's newest 'ok' run is exactly its taxonomy
--      skipped           — the fact has no stored taxonomy
--      failed            — the stored taxonomy is not a JSON object: the
--                          migration aborts and names the facts, rather than
--                          record something that is not a taxonomy
--    The legacy_marked CHECK needs no change: it ties legacy_version_id to the
--    two origins converted from a version row, and a 'legacy_current' row has
--    no version row, so it already satisfies it with a null id.
-- 2. Delete the async jobs on the three queues 2.1a removed (taxonomy backfill,
--    character fill, projection repair), and any review-keyed 'enrichment' job
--    (nothing has queued one since 1.2c-ii, and 2.1c removes its handler).
-- 3. Drop: facts.enrichment_overrides, enrichment_baseline_changed,
--    last_processed_signature, primary_archetype, subtype, overhype_fit,
--    adult_suitability and their indexes; the tables fact_enrichment_versions,
--    enrichment_override_history and engine_revision_bumps; the engine_revision
--    config key. fact_taxonomy_runs.legacy_version_id stays as a plain value.
--
-- Every count is in the notice, including what each drop removed. Re-running
-- is a no-op: every step is guarded by IF EXISTS or by what it already did.
-- Rollback: the data is gone; the code and schema are at tag
-- pre-cut/taxonomy-health (docs/retired/README.md). Undo of step 1 alone:
-- DELETE FROM fact_taxonomy_runs WHERE origin = 'legacy_current'.

ALTER TABLE fact_taxonomy_runs DROP CONSTRAINT IF EXISTS fact_taxonomy_runs_origin_valid;
ALTER TABLE fact_taxonomy_runs ADD CONSTRAINT fact_taxonomy_runs_origin_valid CHECK (((origin)::text = ANY (ARRAY[('provisional_approval'::character varying)::text, ('rerun'::character varying)::text, ('unrecorded'::character varying)::text, ('legacy_promoted'::character varying)::text, ('legacy_superseded'::character varying)::text, ('legacy_current'::character varying)::text])));

DO $$
DECLARE
  v_facts integer;
  v_seeded integer;
  v_held integer;
  v_skipped integer;
  v_bad_ids text;
  v_jobs text;
  v_overridden integer := 0;
  v_signed integer := 0;
  v_projected integer := 0;
  v_versions integer := 0;
  v_override_history integer := 0;
  v_bumps integer := 0;
  v_config integer;
BEGIN
  -- 1. The seed.
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO v_bad_ids
    FROM facts WHERE enrichment IS NOT NULL AND jsonb_typeof(enrichment) <> 'object';
  IF v_bad_ids IS NOT NULL THEN
    RAISE EXCEPTION '[0160] facts whose stored taxonomy is not a JSON object, not seeded: %', v_bad_ids;
  END IF;

  SELECT count(*) INTO v_facts FROM facts;
  SELECT count(*) INTO v_skipped FROM facts WHERE enrichment IS NULL;

  -- "Held": a re-run's own row, or the fact's newest stored run is already it.
  SELECT count(*) INTO v_held
    FROM facts f
   WHERE f.enrichment IS NOT NULL
     AND (EXISTS (SELECT 1 FROM fact_taxonomy_runs r
                   WHERE r.fact_id = f.id AND r.origin = 'legacy_current')
          OR (SELECT r.output FROM fact_taxonomy_runs r
               WHERE r.fact_id = f.id AND r.outcome = 'ok'
               ORDER BY r.created_at DESC, r.id DESC LIMIT 1) = f.enrichment);

  INSERT INTO fact_taxonomy_runs (fact_id, outcome, origin, output)
  SELECT f.id, 'ok', 'legacy_current', f.enrichment
    FROM facts f
   WHERE f.enrichment IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM fact_taxonomy_runs r
                      WHERE r.fact_id = f.id AND r.origin = 'legacy_current')
     AND (SELECT r.output FROM fact_taxonomy_runs r
           WHERE r.fact_id = f.id AND r.outcome = 'ok'
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1) IS DISTINCT FROM f.enrichment;
  GET DIAGNOSTICS v_seeded = ROW_COUNT;

  RAISE NOTICE '[0160] facts %: taxonomy seeded into history %, already held (no-op) %, skipped (no taxonomy) %, failed 0',
    v_facts, v_seeded, v_held, v_skipped;

  -- 2. The orphaned jobs.
  WITH gone AS (
    DELETE FROM async_jobs
     WHERE queue IN ('fact_enrichment_backfill', 'fact_character_fill', 'projection_repair')
        OR (queue = 'enrichment' AND payload ? 'reviewId' AND NOT (payload ? 'factId'))
    RETURNING queue, status
  )
  SELECT string_agg(queue || '/' || status || ' ' || n, ', ' ORDER BY queue, status) INTO v_jobs
    FROM (SELECT queue, status, count(*) AS n FROM gone GROUP BY 1, 2) c;
  RAISE NOTICE '[0160] jobs deleted: %', coalesce(v_jobs, 'none');

  -- 3. The drops, each counted first.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'facts' AND column_name = 'enrichment_overrides') THEN
    EXECUTE $q$SELECT count(*) FROM facts WHERE enrichment_overrides <> '{}'::jsonb OR enrichment_baseline_changed$q$
      INTO v_overridden;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'facts' AND column_name = 'last_processed_signature') THEN
    EXECUTE $q$SELECT count(*) FROM facts WHERE last_processed_signature IS NOT NULL$q$ INTO v_signed;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'facts' AND column_name = 'primary_archetype') THEN
    EXECUTE $q$SELECT count(*) FROM facts
                WHERE primary_archetype IS NOT NULL OR subtype IS NOT NULL
                   OR overhype_fit IS NOT NULL OR adult_suitability IS NOT NULL$q$ INTO v_projected;
  END IF;
  IF to_regclass('fact_enrichment_versions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM fact_enrichment_versions' INTO v_versions;
  END IF;
  IF to_regclass('enrichment_override_history') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM enrichment_override_history' INTO v_override_history;
  END IF;
  IF to_regclass('engine_revision_bumps') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM engine_revision_bumps' INTO v_bumps;
  END IF;

  DROP INDEX IF EXISTS facts_has_overrides_idx;
  DROP INDEX IF EXISTS facts_primary_archetype_idx;
  DROP INDEX IF EXISTS facts_adult_suitability_idx;
  ALTER TABLE facts
    DROP COLUMN IF EXISTS enrichment_overrides,
    DROP COLUMN IF EXISTS enrichment_baseline_changed,
    DROP COLUMN IF EXISTS last_processed_signature,
    DROP COLUMN IF EXISTS primary_archetype,
    DROP COLUMN IF EXISTS subtype,
    DROP COLUMN IF EXISTS overhype_fit,
    DROP COLUMN IF EXISTS adult_suitability;
  DROP TABLE IF EXISTS fact_enrichment_versions;
  DROP TABLE IF EXISTS enrichment_override_history;
  DROP TABLE IF EXISTS engine_revision_bumps;
  DELETE FROM admin_config WHERE key = 'engine_revision';
  GET DIAGNOSTICS v_config = ROW_COUNT;

  RAISE NOTICE '[0160] dropped: facts with an override or baseline flag %, with a signature %, with a projection value %; enrichment versions %, override history rows %, engine revision bumps %; engine_revision config rows %',
    v_overridden, v_signed, v_projected, v_versions, v_override_history, v_bumps, v_config;
END $$;
