-- Delete the retired automatic-render queue's jobs (plan
-- docs/plans/PLAN_RENDERS_MANUAL.md, D2; Issue #1282, amending
-- PLAN_FACT_LIFECYCLE_REBUILD.md item 11 and 1E). Every render is now drawn on
-- request: the code that queued `review_render_scenarios_prepare` jobs (a gag
-- create, a gag save, the Gags approval) and the handler that ran them are
-- removed in the same change, so no job on it would ever run again.
--
-- Row-state matrix (counts are RAISEd as a NOTICE, by status):
--   async jobs on review_render_scenarios_prepare -> deleted, whatever their
--                                                    status (a pending one
--                                                    never drew; a done or
--                                                    failed one is history of
--                                                    a removed job)
--   jobs on every other queue                     -> untouched
--   none on the queue                             -> no-op ("none")
--
-- No render, picture or example selection is touched: the attempts those jobs
-- drew live in image_prompt_attempts and stay. Re-running deletes nothing.
-- Rollback: the deleted rows are queue bookkeeping only; the code is a revert.
DO $$
DECLARE
  v_jobs text;
BEGIN
  SELECT coalesce(string_agg(status || ' ' || n, ', ' ORDER BY status), 'none') INTO v_jobs
    FROM (SELECT status, count(*) AS n FROM async_jobs WHERE queue = 'review_render_scenarios_prepare' GROUP BY status) s;
  DELETE FROM async_jobs WHERE queue = 'review_render_scenarios_prepare';
  RAISE NOTICE '[0171] review_render_scenarios_prepare jobs deleted: %', v_jobs;
END $$;
