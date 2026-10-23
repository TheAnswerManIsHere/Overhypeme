-- Launch Phase 4, removal 6: stock photos, Pexels and the per-user image
-- preferences are deleted (#744; plan docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md,
-- approved by David 2026-10-22).
--
-- The wizard's and remix builder's stock source, the Pexels client, the
-- fact_pexels queue and its worker lane, the moderation Pexels panel and the
-- backfill buttons, the stock-photo keyword extractor, the `stock` image source
-- and the image-preference routes are gone from the code in the same PR, with
-- the boot seeds for the two Pexels settings. Forward-only and idempotent: a
-- re-run finds nothing left to retire, logs nothing, and the drops are IF
-- EXISTS.
--
-- MEMES, classified by serving path (the plan's row-state matrix):
--   * a live meme whose recipe is a stock photo (image_source type 'stock'),
--     with or without a stored photoUrl, re-resolved its photo through Pexels
--     on every view and can no longer be composed: soft-deleted, so its
--     permalink shows the existing 410 (David, 2026-10-21);
--   * a stock recipe already soft-deleted is untouched, and counted;
--   * a `photo_stock`-labelled meme with no recipe is a stored image, served
--     from object storage as before, and is untouched.
--
-- QUEUED WORK: nonterminal fact_pexels jobs are retired by their feature
-- (status 'failed', last_error naming why); every other queue is untouched.
-- The pexels lane's heartbeat rows are deleted so queue health stops listing
-- a lane nothing runs.
--
-- CAPTURED BEFORE DELETING (the rule from 0105): the two admin-editable
-- settings (pexels_photos_per_gender, bg_display_limit_stock), the ids of the
-- memes soft-deleted here and the retired job ids go into
-- feature_permissions_migration_log.deleted_rows. Not captured, by design:
-- facts.pexels_images is a cache of Pexels search results the pipeline wrote
-- (rebuildable by searching again, and nothing serves it), and the two
-- user_fact_preferences columns held an index into those results with no
-- reader since the builders stopped calling the preference routes; their row
-- counts are logged. user_fact_preferences itself stays: the home-page hero
-- rotator reads its last_seen_as_hero_at.
--
-- ORDERING: runs after the old processes are stopped (the stop-first
-- cutover), because the old worker writes facts.pexels_images and
-- pexels_status. Every statement before the drops reads only columns this
-- migration keeps, or checks the column exists first, because a schema push
-- run before migrate (the test-database sequence) has already dropped them.
DO $$
DECLARE
  v_captured jsonb;
  v_memes integer := 0;
  v_already integer := 0;
  v_stored integer := 0;
  v_jobs integer := 0;
  v_heartbeats integer := 0;
  v_config integer := 0;
  v_pexels_facts integer := 0;
  v_pref_rows integer := 0;
BEGIN
  SELECT count(*)::integer INTO v_already
    FROM memes WHERE image_source->>'type' = 'stock' AND deleted_at IS NOT NULL;
  SELECT count(*)::integer INTO v_stored
    FROM memes WHERE image_source IS NULL AND template_id = 'photo_stock' AND deleted_at IS NULL;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'facts' AND column_name = 'pexels_images') THEN
    EXECUTE 'SELECT count(*)::integer FROM facts WHERE pexels_images IS NOT NULL' INTO v_pexels_facts;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'user_fact_preferences' AND column_name = 'image_index') THEN
    EXECUTE 'SELECT count(*)::integer FROM user_fact_preferences WHERE image_index <> 0 OR ai_meme_image_index <> 0' INTO v_pref_rows;
  END IF;

  SELECT jsonb_build_object(
           'admin_config', (
             SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.key), '[]'::jsonb)
             FROM admin_config c WHERE c.key IN ('pexels_photos_per_gender', 'bg_display_limit_stock')
           ),
           'soft_deleted_meme_ids', (
             SELECT coalesce(jsonb_agg(m.id ORDER BY m.id), '[]'::jsonb)
             FROM memes m
             WHERE m.image_source->>'type' = 'stock' AND m.deleted_at IS NULL
           ),
           'retired_job_ids', (
             SELECT coalesce(jsonb_agg(j.id ORDER BY j.id), '[]'::jsonb)
             FROM async_jobs j
             WHERE j.queue = 'fact_pexels' AND j.status IN ('pending', 'processing')
           )
         )
    INTO v_captured;

  IF v_captured->'admin_config' <> '[]'::jsonb
     OR v_captured->'soft_deleted_meme_ids' <> '[]'::jsonb
     OR v_captured->'retired_job_ids' <> '[]'::jsonb THEN
    INSERT INTO feature_permissions_migration_log (migration_name, deleted_rows)
      VALUES ('0107_retire_stock_pexels', v_captured);

    WITH gone AS (
      UPDATE memes SET deleted_at = now()
        WHERE image_source->>'type' = 'stock' AND deleted_at IS NULL
        RETURNING 1
    )
    SELECT count(*)::integer INTO v_memes FROM gone;

    WITH retired AS (
      UPDATE async_jobs
        SET status = 'failed',
            last_error = 'retired: stock photos and Pexels were removed (launch Phase 4, removal 6)',
            updated_at = now()
        WHERE queue = 'fact_pexels' AND status IN ('pending', 'processing')
        RETURNING 1
    )
    SELECT count(*)::integer INTO v_jobs FROM retired;

    WITH gone AS (
      DELETE FROM admin_config WHERE key IN ('pexels_photos_per_gender', 'bg_display_limit_stock') RETURNING 1
    )
    SELECT count(*)::integer INTO v_config FROM gone;
  END IF;

  WITH gone AS (
    DELETE FROM worker_lane_heartbeats WHERE lane = 'pexels' RETURNING 1
  )
  SELECT count(*)::integer INTO v_heartbeats FROM gone;

  RAISE NOTICE '[0107] stock-recipe memes soft-deleted: %, stock recipes already soft-deleted: %, photo_stock stored-image memes kept: %, fact_pexels jobs retired: %, pexels heartbeat rows deleted: %, config rows deleted: %, facts with pexels_images dropped: %, preference rows with a non-default index dropped: %',
    v_memes, v_already, v_stored, v_jobs, v_heartbeats, v_config, v_pexels_facts, v_pref_rows;
END $$;
--> statement-breakpoint

ALTER TABLE facts DROP COLUMN IF EXISTS pexels_images;
--> statement-breakpoint
ALTER TABLE facts DROP COLUMN IF EXISTS pexels_status;
--> statement-breakpoint
ALTER TABLE user_fact_preferences DROP COLUMN IF EXISTS image_index;
--> statement-breakpoint
ALTER TABLE user_fact_preferences DROP COLUMN IF EXISTS ai_meme_image_index;
