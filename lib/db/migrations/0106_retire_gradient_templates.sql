-- Launch Phase 4, removal 5: the gradient template backgrounds are deleted
-- (#744; plan docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David
-- 2026-10-22).
--
-- The template list and preview routes, the renderer's template branch, the
-- `template` image source and the twenty gradient images are gone from the
-- code in the same PR, with the boot seed for the gradient picker limit.
-- memes.template_id stays: it is the background discriminator, and a meme
-- whose stored image was rendered from a gradient keeps serving from storage.
-- Data only: no schema changes. Forward-only and idempotent: a re-run finds
-- nothing left to retire and logs nothing.
--
-- MEMES, classified by serving path (the plan's row-state matrix):
--   * a live meme whose recipe is a template (image_source type 'template')
--     can no longer be composed, so it is soft-deleted and its permalink
--     shows the existing 410;
--   * a template recipe already soft-deleted is untouched, and counted;
--   * a gradient-labelled meme with no recipe is a stored image, served from
--     object storage as before, and is untouched.
--
-- ADMIN-CURATED ROWS: the bg_display_limit_gradient setting is captured into
-- feature_permissions_migration_log.deleted_rows BEFORE it is deleted, with the
-- ids of the memes soft-deleted here, so recovery is answerable from the
-- database (the lesson of 0105, which deleted admin-edited settings with only
-- a count).
DO $$
DECLARE
  v_captured jsonb;
  v_memes integer := 0;
  v_already integer := 0;
  v_stored integer := 0;
  v_config integer := 0;
BEGIN
  SELECT count(*)::integer INTO v_already
    FROM memes WHERE image_source->>'type' = 'template' AND deleted_at IS NOT NULL;
  SELECT count(*)::integer INTO v_stored
    FROM memes
    WHERE image_source IS NULL AND template_id NOT IN ('photo_upload', 'photo_stock')
      AND deleted_at IS NULL;

  SELECT jsonb_build_object(
           'admin_config', (
             SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
             FROM admin_config c WHERE c.key = 'bg_display_limit_gradient'
           ),
           'soft_deleted_meme_ids', (
             SELECT coalesce(jsonb_agg(m.id ORDER BY m.id), '[]'::jsonb)
             FROM memes m
             WHERE m.image_source->>'type' = 'template' AND m.deleted_at IS NULL
           )
         )
    INTO v_captured;

  IF v_captured->'admin_config' <> '[]'::jsonb
     OR v_captured->'soft_deleted_meme_ids' <> '[]'::jsonb THEN
    INSERT INTO feature_permissions_migration_log (migration_name, deleted_rows)
      VALUES ('0106_retire_gradient_templates', v_captured);

    WITH gone AS (
      UPDATE memes SET deleted_at = now()
        WHERE image_source->>'type' = 'template' AND deleted_at IS NULL
        RETURNING 1
    )
    SELECT count(*)::integer INTO v_memes FROM gone;

    WITH gone AS (
      DELETE FROM admin_config WHERE key = 'bg_display_limit_gradient' RETURNING 1
    )
    SELECT count(*)::integer INTO v_config FROM gone;
  END IF;

  RAISE NOTICE '[0106] template-recipe memes soft-deleted: %, template recipes already soft-deleted: %, gradient stored-image memes kept: %, config rows deleted: %',
    v_memes, v_already, v_stored, v_config;
END $$;
