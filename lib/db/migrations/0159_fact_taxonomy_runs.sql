-- A fact's AI taxonomy run history (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md,
-- item 16 and 2B; Issue #1018, increment 2.1b).
--
-- 1. fact_taxonomy_runs: one row per classifier call, failures included,
--    written by the app from now on (runEnrichmentForFact).
-- 2. Every legacy fact_enrichment_versions row becomes a history row. Nothing
--    has written that table since candidate/promote was retired, and 0151/0153
--    deleted its candidate and rejected rows, so what remains are:
--      promoted   -> origin 'legacy_promoted', timed at promoted_at (else created_at)
--      superseded -> origin 'legacy_superseded', timed at created_at (the
--                    archive time: its run time was never recorded)
--    The output is the version's pure AI baseline (enrichment_ai_derived), else
--    its stored blob, with any gag removed (a gag lives only in fact_gags, 0139).
--
-- Row states, each counted in the notice: converted (old shape -> new row);
-- already converted (a re-run, or a partial earlier run: the unique
-- legacy_version_id makes it a no-op); skipped (no output to keep); failed
-- (a candidate or rejected row, which must not exist: the migration aborts and
-- names it, rather than guess what it means).
--
-- The source table stays until increment 2.1c drops it.
-- Rollback: revert the code and drop fact_taxonomy_runs; nothing else changed.

CREATE TABLE IF NOT EXISTS fact_taxonomy_runs (
  id bigserial PRIMARY KEY,
  fact_id integer NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  outcome varchar(16) NOT NULL,
  origin varchar(24) NOT NULL,
  output jsonb,
  error text,
  requested_by varchar REFERENCES users(id) ON DELETE SET NULL,
  legacy_version_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fact_taxonomy_runs_outcome_valid CHECK (outcome IN ('ok', 'failed', 'discarded')),
  CONSTRAINT fact_taxonomy_runs_origin_valid CHECK (origin IN ('provisional_approval', 'rerun', 'unrecorded', 'legacy_promoted', 'legacy_superseded')),
  CONSTRAINT fact_taxonomy_runs_output_matches_outcome CHECK ((outcome = 'failed') = (output IS NULL)),
  CONSTRAINT fact_taxonomy_runs_legacy_marked CHECK ((legacy_version_id IS NOT NULL) = (origin IN ('legacy_promoted', 'legacy_superseded')))
);
CREATE INDEX IF NOT EXISTS fact_taxonomy_runs_fact_idx ON fact_taxonomy_runs (fact_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS fact_taxonomy_runs_legacy_version_uq ON fact_taxonomy_runs (legacy_version_id);

DO $$
DECLARE
  v_total integer := 0;
  v_converted integer := 0;
  v_already integer := 0;
  v_skipped integer := 0;
  v_bad_ids text;
BEGIN
  IF to_regclass('public.fact_enrichment_versions') IS NULL THEN
    RAISE NOTICE '[0159] fact_enrichment_versions is gone: nothing to convert';
    RETURN;
  END IF;

  SELECT string_agg(id::text || ' (' || status || ')', ', ' ORDER BY id) INTO v_bad_ids
    FROM fact_enrichment_versions WHERE status NOT IN ('promoted', 'superseded');
  IF v_bad_ids IS NOT NULL THEN
    RAISE EXCEPTION '[0159] unexpected fact_enrichment_versions rows, not converted: %', v_bad_ids;
  END IF;

  SELECT count(*) INTO v_total FROM fact_enrichment_versions;
  SELECT count(*) INTO v_already FROM fact_enrichment_versions v
   WHERE EXISTS (SELECT 1 FROM fact_taxonomy_runs r WHERE r.legacy_version_id = v.id);
  SELECT count(*) INTO v_skipped FROM fact_enrichment_versions v
   WHERE coalesce(v.enrichment_ai_derived, v.enrichment) IS NULL
     AND NOT EXISTS (SELECT 1 FROM fact_taxonomy_runs r WHERE r.legacy_version_id = v.id);

  INSERT INTO fact_taxonomy_runs (fact_id, outcome, origin, output, legacy_version_id, created_at)
  SELECT v.fact_id,
         'ok',
         CASE v.status WHEN 'promoted' THEN 'legacy_promoted' ELSE 'legacy_superseded' END,
         coalesce(v.enrichment_ai_derived, v.enrichment) - 'visualPromptStrategyOverride',
         v.id,
         CASE v.status WHEN 'promoted' THEN coalesce(v.promoted_at, v.created_at) ELSE v.created_at END
    FROM fact_enrichment_versions v
   WHERE coalesce(v.enrichment_ai_derived, v.enrichment) IS NOT NULL
  ON CONFLICT (legacy_version_id) DO NOTHING;
  GET DIAGNOSTICS v_converted = ROW_COUNT;

  RAISE NOTICE '[0159] legacy versions %: converted %, already converted (no-op) %, skipped (no output) %, failed 0',
    v_total, v_converted, v_already, v_skipped;
END $$;
