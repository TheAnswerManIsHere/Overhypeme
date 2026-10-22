-- Launch Phase 4, removal 2: video is deleted (#744; plan
-- docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
--
-- The video pipeline, its routes, the wizard's video step, the video engines,
-- motion presets / Video Styles and /video/:id are gone from the code in the
-- same PR. This removes the data and schema only they used. Forward-only and
-- idempotent: every step is IF EXISTS or keyed so a re-run is a no-op.
--
-- ROW STATES (the plan's matrix, by serving path):
--   * a video meme (artifact_type = 'video', not yet soft-deleted) -> soft-deleted;
--     its permalink then shows the existing 410 copy
--   * every image meme, and every already soft-deleted meme         -> untouched
-- Soft delete, not hard delete, so an admin can still see what existed and the
-- fixture's foreign keys hold. The video columns are dropped after the soft
-- delete, so the MP4's object path goes with them: the file itself stays in
-- object storage, unreferenced (recorded on the retirement ledger).
--
-- ADMIN-CURATED ROWS for the cut feature are deleted, since engine
-- reconciliation only adds and never removes: the five video engines and the
-- caption utility (fal-auto-subtitle, whose only caller was the video
-- pipeline), their fal pricing cache rows, the video hero examples, the
-- video-direction system prompt, and the video endpoints in
-- fal_active_endpoints. look_styles stays: the admin image bench reads it.
--
-- THE video_generation FEATURE is retired the way 0099 retired
-- meme_upload_photo: the removed rows are captured into
-- feature_permissions_migration_log.deleted_rows BEFORE the delete, so recovery
-- is answerable from the database. engine_experiments is NOT retired here; it is
-- the generic engine-gating flag Plan 3 owns.
--
-- QUEUED WORK: the video pipeline ran in-process from video_jobs rows, not
-- through async_jobs, so its queued work goes with the table.
--
-- ORDERING: this runs only after every old process is stopped (the plan's
-- stop-first cutover), because the old pipeline writes video_jobs and memes'
-- video columns.

DO $$
DECLARE
  v_video_memes integer := 0;
  v_video_jobs integer := 0;
  v_engines integer := 0;
  v_pricing integer := 0;
  v_hero integer := 0;
  v_deleted jsonb;
BEGIN
  -- 1. Retire video memes (soft delete), counted.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'memes' AND column_name = 'video_object_path') THEN
    UPDATE memes SET deleted_at = now()
      WHERE artifact_type = 'video' AND deleted_at IS NULL;
    GET DIAGNOSTICS v_video_memes = ROW_COUNT;
  END IF;

  IF to_regclass('public.video_jobs') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::integer FROM video_jobs' INTO v_video_jobs;
  END IF;

  -- 2. Video engines and the caption utility, then their pricing rows.
  WITH gone AS (
    DELETE FROM engines
      WHERE kind = 'video' OR id = 'fal-auto-subtitle'
      RETURNING 1
  )
  SELECT count(*)::integer INTO v_engines FROM gone;

  WITH gone AS (
    DELETE FROM fal_pricing_cache
      WHERE endpoint_id LIKE '%-to-video'
         OR endpoint_id LIKE '%/auto-subtitle'
      RETURNING 1
  )
  SELECT count(*)::integer INTO v_pricing FROM gone;

  -- 3. Video hero examples (the image rows stay; nothing reads them now and
  -- they are a removal-11 orphan candidate).
  IF to_regclass('public.hero_examples') IS NOT NULL THEN
    WITH gone AS (
      DELETE FROM hero_examples WHERE artifact_type = 'video' RETURNING 1
    )
    SELECT count(*)::integer INTO v_hero FROM gone;
  END IF;

  -- 4. Config: the video-direction prompt, and the video endpoints in the
  -- pricing-refresh list.
  DELETE FROM admin_config WHERE key = 'video_direction_system';
  UPDATE admin_config
    SET value = (
      SELECT coalesce(jsonb_agg(e), '[]'::jsonb)::text
      FROM jsonb_array_elements_text(value::jsonb) AS e
      WHERE e NOT LIKE '%-to-video' AND e NOT LIKE '%/auto-subtitle'
    )
    WHERE key = 'fal_active_endpoints'
      AND value ~ '^\s*\['
      AND (value LIKE '%-to-video%' OR value LIKE '%/auto-subtitle%');

  -- 5. The video_generation feature, captured then deleted (children first).
  SELECT jsonb_build_object(
           'feature_flags', (
             SELECT coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
             FROM feature_flags f WHERE f.key = 'video_generation'
           ),
           'tier_feature_permissions', (
             SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
             FROM tier_feature_permissions p WHERE p.feature_key = 'video_generation'
           )
         )
    INTO v_deleted;

  IF v_deleted->'feature_flags' <> '[]'::jsonb
     OR v_deleted->'tier_feature_permissions' <> '[]'::jsonb THEN
    DELETE FROM tier_feature_permissions WHERE feature_key = 'video_generation';
    DELETE FROM feature_flags WHERE key = 'video_generation';
    INSERT INTO feature_permissions_migration_log (migration_name, deleted_rows)
      VALUES ('0103_retire_video', v_deleted);
    -- The grid changed shape, so clients holding the old revision refetch.
    UPDATE entitlement_grid_revision SET revision = revision + 1 WHERE id = 1;
  END IF;

  RAISE NOTICE '[0103] video memes soft-deleted: %, video_jobs rows dropped: %, engines deleted: %, pricing rows deleted: %, video hero examples deleted: %, video_generation feature retired: %',
    v_video_memes, v_video_jobs, v_engines, v_pricing, v_hero, (v_deleted IS NOT NULL AND v_deleted->'feature_flags' <> '[]'::jsonb);
END $$;
--> statement-breakpoint

-- 6. Schema. The memes video columns (look_style_id included: its only writer
-- was the video pipeline), then the video tables. video_styles is the pre-0056
-- name of motion_presets, which the old boot seed recreated beside it.
ALTER TABLE memes DROP COLUMN IF EXISTS video_object_path;
--> statement-breakpoint
ALTER TABLE memes DROP COLUMN IF EXISTS video_job_id;
--> statement-breakpoint
ALTER TABLE memes DROP COLUMN IF EXISTS motion_preset_id;
--> statement-breakpoint
ALTER TABLE memes DROP COLUMN IF EXISTS look_style_id;
--> statement-breakpoint
DROP TABLE IF EXISTS video_jobs;
--> statement-breakpoint
DROP TYPE IF EXISTS video_job_status;
--> statement-breakpoint
DROP TABLE IF EXISTS motion_presets;
--> statement-breakpoint
DROP TABLE IF EXISTS video_styles;
