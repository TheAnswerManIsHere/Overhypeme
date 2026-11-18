-- The stage cutover (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1B, 1D and
-- Data Model; Issue #1018, increment 1.2c-ii). Three parts, one transaction.
--
-- 1. Expand: fact_readings, one row per reading run (research, then a draft
--    humor note), and facts.humor_note_reading_id, the run an approved note was
--    written from.
-- 2. Contract (pre-launch latitude: the code that stops using the old labels
--    ships in this release): review_workflow_stage becomes the six steps
--    triage, reading, gags, test_renders, approved, rejected, by the
--    text-cast recreate (migrations-and-backfills.md). Existing rows map:
--      triage_pending                         -> triage
--      prep_pending, prep_failed, concept_review
--                                             -> gags when the staging fact
--                                                has an approved humor note,
--                                                else reading
--      production_review                      -> test_renders
--      production_approved                    -> approved
--      triage_rejected, production_rejected   -> rejected (reason kept)
--    A review mapped to reading has no reading run yet; its Reading step offers
--    "Write the reading". Counts per old stage and per new stage are reported.
-- 3. Contract: Withdraw's columns, retired by increment 1.2c-i (PR #1036),
--    whose release reads and writes none of them:
--    pending_reviews.withdrawn_at, withdrawn_by; facts.wording_withdrawn_at
--    and its check facts_withdrawn_stays_inactive.
--
-- Row states: every review row is mapped exactly once (old -> new). A re-run
-- finds the type already carrying 'reading' and skips the recast (no-op,
-- reported). A row with a label outside the map aborts the migration and
-- names itself (failed). The table, column and drops are IF [NOT] EXISTS.
--
-- Rollback: revert the code and restore from the pre-publish backup; the old
-- labels cannot be recovered from the new ones (two old stages merge into
-- rejected, three into reading/gags). Pre-launch there is no member data in
-- these rows.

CREATE TABLE IF NOT EXISTS fact_readings (
  id serial PRIMARY KEY,
  fact_id integer NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  review_id integer REFERENCES pending_reviews(id) ON DELETE SET NULL,
  status varchar(16) NOT NULL,
  research jsonb,
  draft_note text,
  error text,
  provenance jsonb,
  requested_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS fact_readings_fact_idx ON fact_readings (fact_id, created_at);

ALTER TABLE facts ADD COLUMN IF NOT EXISTS humor_note_reading_id integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facts_humor_note_reading_id_fkey') THEN
    ALTER TABLE facts ADD CONSTRAINT facts_humor_note_reading_id_fkey
      FOREIGN KEY (humor_note_reading_id) REFERENCES fact_readings(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
DECLARE
  v_before text;
  v_after text;
  v_unmapped text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
     WHERE e.enumtypid = to_regtype('review_workflow_stage') AND e.enumlabel = 'reading'
  ) THEN
    RAISE NOTICE '0155_moderation_four_steps: stages already recast; no-op';
    RETURN;
  END IF;

  SELECT string_agg(workflow_stage::text || '=' || n, ', ' ORDER BY workflow_stage::text) INTO v_before
    FROM (SELECT workflow_stage, count(*) AS n FROM pending_reviews GROUP BY workflow_stage) c;

  ALTER TABLE pending_reviews ALTER COLUMN workflow_stage DROP DEFAULT;
  ALTER TABLE pending_reviews ALTER COLUMN workflow_stage TYPE text USING workflow_stage::text;

  UPDATE pending_reviews r SET workflow_stage = CASE
      WHEN r.workflow_stage = 'triage_pending' THEN 'triage'
      WHEN r.workflow_stage IN ('prep_pending', 'prep_failed', 'concept_review') THEN
        CASE WHEN EXISTS (
          SELECT 1 FROM facts f WHERE f.id = r.staging_fact_id AND f.humor_note_approved_at IS NOT NULL
        ) THEN 'gags' ELSE 'reading' END
      WHEN r.workflow_stage = 'production_review' THEN 'test_renders'
      WHEN r.workflow_stage = 'production_approved' THEN 'approved'
      WHEN r.workflow_stage IN ('triage_rejected', 'production_rejected') THEN 'rejected'
      ELSE r.workflow_stage
    END;

  SELECT string_agg(DISTINCT workflow_stage, ', ') INTO v_unmapped FROM pending_reviews
   WHERE workflow_stage NOT IN ('triage', 'reading', 'gags', 'test_renders', 'approved', 'rejected');
  IF v_unmapped IS NOT NULL THEN
    RAISE EXCEPTION '0155_moderation_four_steps: unmapped stages: %', v_unmapped;
  END IF;

  DROP TYPE review_workflow_stage;
  CREATE TYPE review_workflow_stage AS ENUM ('triage', 'reading', 'gags', 'test_renders', 'approved', 'rejected');
  ALTER TABLE pending_reviews ALTER COLUMN workflow_stage TYPE review_workflow_stage USING workflow_stage::review_workflow_stage;
  ALTER TABLE pending_reviews ALTER COLUMN workflow_stage SET DEFAULT 'triage';

  SELECT string_agg(workflow_stage::text || '=' || n, ', ' ORDER BY workflow_stage::text) INTO v_after
    FROM (SELECT workflow_stage, count(*) AS n FROM pending_reviews GROUP BY workflow_stage) c;
  RAISE NOTICE '0155_moderation_four_steps: before [%]; after [%]', coalesce(v_before, 'no rows'), coalesce(v_after, 'no rows');
END $$;

ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_withdrawn_stays_inactive;
ALTER TABLE facts DROP COLUMN IF EXISTS wording_withdrawn_at;
ALTER TABLE pending_reviews DROP COLUMN IF EXISTS withdrawn_at;
ALTER TABLE pending_reviews DROP COLUMN IF EXISTS withdrawn_by;
