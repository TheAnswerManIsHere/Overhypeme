-- Drop the old eval harness's data (prompt tuner plan docs/plans/PLAN_PROMPT_TUNER.md,
-- *E. Retirements* and *Data model and migration impact*; launch Phase 8 part 4,
-- Issue #887). PR #931 removed the harness's screens and routes, and PR #1290 took
-- these columns out of the Drizzle model and every reader. That release was
-- published on 2026-11-25 (`e266525`), so no published release reads or writes
-- what this drops (migrations-and-backfills.md, *Expand, then contract*).
--
-- What goes:
--   image_prompt_attempts: moderator_rating, failure_tag, eval_notes, eval_by,
--     eval_at, eval_run_id (and its foreign key to eval_runs), eval_scenario_key,
--     eval_input_hash, and the two partial indexes on eval_run_id
--     (IDX_ipa_eval_run_fact_created, IDX_ipa_eval_fact_run_created);
--   the eval_runs table.
-- The render attempts themselves stay: they are core to moderation. An attempt an
-- eval run drew stays too, as an ordinary attempt with no run.
--
-- Row-state matrix (counts are RAISEd as a NOTICE before anything is dropped):
--   columns present -> attempts tagged with an eval run, and attempts carrying a
--                      moderator rating or failure tag, counted; then the indexes
--                      and the eight columns dropped
--   eval_runs present -> its rows counted, then the table dropped
--   either absent   -> that part is a no-op (a re-run, or a database that never
--                      had it); counts read 0
--
-- Read before writing (read-only, 2026-11-25): production 0 eval runs, 0 attempts
-- with eval_run_id or eval_at set; dev 1 eval run and 11 rated attempts (read
-- 2026-11-11, the plan's count).
--
-- Re-running is a no-op. Rollback: the data is gone; the code and schema that
-- used it are at tag pre-cut/eval-harness (docs/retired/README.md).
DO $$
DECLARE
  v_run_tagged integer := 0;
  v_rated integer := 0;
  v_runs integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'image_prompt_attempts' AND column_name = 'eval_run_id') THEN
    EXECUTE 'SELECT count(*) FROM image_prompt_attempts WHERE eval_run_id IS NOT NULL' INTO v_run_tagged;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'image_prompt_attempts' AND column_name = 'moderator_rating') THEN
    EXECUTE 'SELECT count(*) FROM image_prompt_attempts WHERE moderator_rating IS NOT NULL OR failure_tag IS NOT NULL' INTO v_rated;
  END IF;
  IF to_regclass('eval_runs') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM eval_runs' INTO v_runs;
  END IF;

  DROP INDEX IF EXISTS "IDX_ipa_eval_run_fact_created";
  DROP INDEX IF EXISTS "IDX_ipa_eval_fact_run_created";
  ALTER TABLE image_prompt_attempts DROP CONSTRAINT IF EXISTS image_prompt_attempts_eval_run_id_eval_runs_id_fk;
  ALTER TABLE image_prompt_attempts DROP COLUMN IF EXISTS moderator_rating;
  ALTER TABLE image_prompt_attempts DROP COLUMN IF EXISTS failure_tag;
  ALTER TABLE image_prompt_attempts DROP COLUMN IF EXISTS eval_notes;
  ALTER TABLE image_prompt_attempts DROP COLUMN IF EXISTS eval_by;
  ALTER TABLE image_prompt_attempts DROP COLUMN IF EXISTS eval_at;
  ALTER TABLE image_prompt_attempts DROP COLUMN IF EXISTS eval_run_id;
  ALTER TABLE image_prompt_attempts DROP COLUMN IF EXISTS eval_scenario_key;
  ALTER TABLE image_prompt_attempts DROP COLUMN IF EXISTS eval_input_hash;
  DROP TABLE IF EXISTS eval_runs;

  RAISE NOTICE '[0170] eval harness dropped: % attempt(s) were tagged with an eval run, % carried a rating or failure tag, % eval run(s)',
    v_run_tagged, v_rated, v_runs;
END $$;
