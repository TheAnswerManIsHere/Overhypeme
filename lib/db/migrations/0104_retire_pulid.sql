-- Launch Phase 4, removal 3: PuLID is deleted (#744; plan
-- docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
--
-- The wizard's "AI you" source, the PuLID job routes, the user generate route
-- (the meme page remix builder's stylise toggle), the PuLID engine and the
-- "Try AI mode" upsell are gone from the code in the same PR. This removes the
-- rows only they used. Data only: no schema changes. Forward-only and
-- idempotent: every step is keyed, so a re-run is a no-op.
--
-- ROW STATES (the plan's matrix, by serving path):
--   * an upload recipe built from a PuLID image (memes.image_transform =
--     'pulid')                                     -> untouched; it composes
--     from the user's stored image, and the label stays as historical data
--     with no writer
--   * a PuLID-made image in upload_image_metadata  -> untouched (the same)
-- No meme is soft-deleted: none renders broken without PuLID.
--
-- QUEUED WORK: PuLID jobs lived in the API process's memory, never in a
-- table, so there is no queued row to retire; the stop-first cutover ends
-- any in flight.
--
-- ADMIN-CURATED ROWS for the cut feature are deleted, since engine
-- reconciliation only adds and never removes: the pulid-flux engine, its fal
-- pricing row, the PuLID run-time estimate, and fal-ai/flux-pulid in
-- fal_active_endpoints. fal_safety_tolerance_pulid STAYS: despite its name it
-- sets the safety tolerance for the FLUX Pro models, which remain.
--
-- TWO FEATURES are retired the way 0099 retired meme_upload_photo, captured
-- into feature_permissions_migration_log.deleted_rows BEFORE the delete:
--   * meme_pulid_stylize: PuLID itself.
--   * meme_ai_background: its last enforcing route was the user generate route
--     deleted with PuLID, and its last reader the remix builder's "Try AI mode"
--     upsell, which led to that same AI mode.

DO $$
DECLARE
  v_engines integer := 0;
  v_pricing integer := 0;
  v_config integer := 0;
  v_deleted jsonb;
BEGIN
  -- 1. The PuLID engine, then its pricing row.
  WITH gone AS (
    DELETE FROM engines
      WHERE id = 'pulid-flux' OR endpoint_id = 'fal-ai/flux-pulid'
      RETURNING 1
  )
  SELECT count(*)::integer INTO v_engines FROM gone;

  WITH gone AS (
    DELETE FROM fal_pricing_cache WHERE endpoint_id = 'fal-ai/flux-pulid' RETURNING 1
  )
  SELECT count(*)::integer INTO v_pricing FROM gone;

  -- 2. Config: the PuLID run-time estimate, and the PuLID endpoint in the
  -- pricing-refresh list.
  WITH gone AS (
    DELETE FROM admin_config WHERE key = 'pulid_expected_run_ms_ema' RETURNING 1
  )
  SELECT count(*)::integer INTO v_config FROM gone;
  UPDATE admin_config
    SET value = (
      SELECT coalesce(jsonb_agg(e), '[]'::jsonb)::text
      FROM jsonb_array_elements_text(value::jsonb) AS e
      WHERE e <> 'fal-ai/flux-pulid'
    )
    WHERE key = 'fal_active_endpoints'
      AND value ~ '^\s*\['
      AND value LIKE '%fal-ai/flux-pulid%';

  -- 3. The two features, captured then deleted (children first).
  SELECT jsonb_build_object(
           'feature_flags', (
             SELECT coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
             FROM feature_flags f WHERE f.key IN ('meme_pulid_stylize', 'meme_ai_background')
           ),
           'tier_feature_permissions', (
             SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
             FROM tier_feature_permissions p WHERE p.feature_key IN ('meme_pulid_stylize', 'meme_ai_background')
           )
         )
    INTO v_deleted;

  IF v_deleted->'feature_flags' <> '[]'::jsonb
     OR v_deleted->'tier_feature_permissions' <> '[]'::jsonb THEN
    DELETE FROM tier_feature_permissions WHERE feature_key IN ('meme_pulid_stylize', 'meme_ai_background');
    DELETE FROM feature_flags WHERE key IN ('meme_pulid_stylize', 'meme_ai_background');
    INSERT INTO feature_permissions_migration_log (migration_name, deleted_rows)
      VALUES ('0104_retire_pulid', v_deleted);
    -- The grid changed shape, so clients holding the old revision refetch.
    UPDATE entitlement_grid_revision SET revision = revision + 1 WHERE id = 1;
  END IF;

  RAISE NOTICE '[0104] engines deleted: %, pricing rows deleted: %, config rows deleted: %, features retired: %, tier rows retired: %',
    v_engines, v_pricing, v_config,
    coalesce(jsonb_array_length(v_deleted->'feature_flags'), 0),
    coalesce(jsonb_array_length(v_deleted->'tier_feature_permissions'), 0);
END $$;
