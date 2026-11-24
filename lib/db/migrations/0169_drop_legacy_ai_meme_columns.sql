-- Drop the legacy AI-meme columns and the retired backfill queue's jobs (plan
-- docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, oracle item 23; Issue #1018,
-- increment 3.2e). 3.2d (PR #1242) removed the retired AI-background backfill:
-- its route, its queue's handler and its lane. Nothing reads or writes:
--   facts.ai_scene_prompts         — scene prompts of the retired generator
--   facts.ai_meme_backfill_status  — that queue's per-fact lifecycle
-- facts.ai_meme_images is NOT dropped: the image worker still appends every
-- production render to it, and members and account deletion read it (3.2d).
--
-- Row-state matrix (counts are RAISEd as a NOTICE):
--   async jobs on fact_ai_meme_backfill -> deleted (no handler is registered
--                                          since 3.2d, so none would ever run)
--   column present -> the facts holding a value counted, then the column dropped
--   column absent  -> no-op (a re-run, or a database that never had it)
--
-- Re-running is a no-op. Rollback: the values and jobs are gone; the code and
-- schema are at tag pre-cut/fact-admin-legacy (docs/retired/README.md). No
-- picture is lost: the pictures that generator stored live in ai_meme_images.
DO $$
DECLARE
  v_jobs text;
  v_prompts integer := 0;
  v_status integer := 0;
BEGIN
  SELECT coalesce(string_agg(status || ' ' || n, ', ' ORDER BY status), 'none') INTO v_jobs
    FROM (SELECT status, count(*) AS n FROM async_jobs WHERE queue = 'fact_ai_meme_backfill' GROUP BY status) s;
  DELETE FROM async_jobs WHERE queue = 'fact_ai_meme_backfill';

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'facts' AND column_name = 'ai_scene_prompts') THEN
    EXECUTE 'SELECT count(*) FROM facts WHERE ai_scene_prompts IS NOT NULL' INTO v_prompts;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'facts' AND column_name = 'ai_meme_backfill_status') THEN
    EXECUTE 'SELECT count(*) FROM facts WHERE ai_meme_backfill_status IS NOT NULL' INTO v_status;
  END IF;
  ALTER TABLE facts DROP COLUMN IF EXISTS ai_scene_prompts;
  ALTER TABLE facts DROP COLUMN IF EXISTS ai_meme_backfill_status;
  RAISE NOTICE '[0169] fact_ai_meme_backfill jobs deleted: %; dropped ai_scene_prompts (% fact(s) held one) and ai_meme_backfill_status (% fact(s) held one)', v_jobs, v_prompts, v_status;
END $$;
