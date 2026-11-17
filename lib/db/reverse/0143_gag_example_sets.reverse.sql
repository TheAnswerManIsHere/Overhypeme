-- Reverse of migration 0143_gag_example_sets (plan docs/plans/PLAN_GAG_EXAMPLES.md,
-- "Data Model and Migration Impact"). NOT a migration: the runner never reads
-- this directory. It is run by hand, on David's say, with the release before
-- 0143 deployed, and is tested by
-- artifacts/api-server/src/__tests__/migration0143.gagExampleSets.test.ts.
--
-- 0143 copied the example selections and left approved_example_attempt_id and
-- pending_example_attempt_id untouched, so dropping the new table restores the
-- previous state exactly. It refuses once examples have been approved or picked
-- under the new model (a gag that completed a set, or an example row the old
-- columns do not name), or once a migrated refresh pick was discarded or
-- declined, or its content edited, or any row the restored checks would refuse
-- (the retained columns then disagree with the current state):
-- reversing then would lose a moderator's work, and the route is fix-forward.
DO $$
DECLARE
  v_new integer;
BEGIN
  IF to_regclass('fact_gag_examples') IS NULL THEN
    RAISE NOTICE '0143 reverse: fact_gag_examples is absent; nothing to do';
    RETURN;
  END IF;

  SELECT count(*) INTO v_new FROM (
    SELECT g.id FROM fact_gags g
     WHERE g.approved_content IS NOT NULL AND NOT (g.approved_before_example_sets OR g.approved_carried_over)
    UNION ALL
    SELECT e.id FROM fact_gag_examples e JOIN fact_gags g ON g.id = e.gag_id
     WHERE (e.stage = 'approved' AND e.attempt_id IS DISTINCT FROM g.approved_example_attempt_id)
        OR (e.stage = 'pending' AND e.attempt_id IS DISTINCT FROM g.pending_example_attempt_id)
    UNION ALL
    SELECT g.id FROM fact_gags g
     WHERE (g.pending_example_attempt_id IS NOT NULL AND (g.pending_content IS NULL OR g.pending_review_id IS NULL))
        OR (g.approved_content IS NOT NULL AND g.approved_example_attempt_id IS NULL AND NOT g.approved_carried_over)
    UNION ALL
    -- A retained pick no longer drawn from the gag's pending content: the
    -- content was edited after the migration. The previous release promotes on
    -- that column without checking content, so reversing would approve the
    -- edited gag with a render of something else. Compared by the render's own
    -- record of what it drew, which also covers a retired-scenario pick the
    -- migration never copied (Codex, PR #972 round 1).
    SELECT g.id FROM fact_gags g
     WHERE g.pending_example_attempt_id IS NOT NULL AND g.pending_content IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM image_prompt_attempts a
          WHERE a.id = g.pending_example_attempt_id
            AND a.fact_enrichment_snapshot -> 'visualPromptStrategyOverride' = g.pending_content)
  ) touched;
  IF v_new > 0 THEN
    RAISE EXCEPTION '0143 reverse refused: % gag(s) or example(s) were approved or picked under example sets; fix forward', v_new;
  END IF;

  DROP TRIGGER IF EXISTS fact_gag_examples_set ON fact_gag_examples;
  DROP TRIGGER IF EXISTS fact_gags_example_set ON fact_gags;
  DROP FUNCTION IF EXISTS enforce_gag_example_set();
  DROP TABLE fact_gag_examples;

  ALTER TABLE fact_gags DROP CONSTRAINT IF EXISTS fact_gags_pending_ops_owned;
  ALTER TABLE fact_gags ADD CONSTRAINT fact_gags_pending_ops_owned
    CHECK ((pending_example_attempt_id IS NULL AND NOT pending_remove) OR pending_review_id IS NOT NULL);
  ALTER TABLE fact_gags ADD CONSTRAINT fact_gags_pending_example_has_content
    CHECK (pending_example_attempt_id IS NULL OR pending_content IS NOT NULL);
  ALTER TABLE fact_gags ADD CONSTRAINT fact_gags_approved_has_example
    CHECK (approved_content IS NULL OR approved_example_attempt_id IS NOT NULL OR approved_carried_over);
  ALTER TABLE fact_gags DROP COLUMN approved_before_example_sets;

  RAISE NOTICE '0143 reverse: example sets removed; the previous selections stand';
END $$;
