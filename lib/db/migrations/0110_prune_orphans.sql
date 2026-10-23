-- Launch Phase 4, removal 11: orphans after verification (#744; plan
-- docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
--
-- Each object dropped here was traced in the code before deletion and has no
-- reader or writer left (the PR body quotes the trace):
--   * ratings — the legacy per-fact thumbs table. Migration 0035 copied every
--     up/down row into reactions, which has been the only place ratings are
--     written and read since;
--   * hero_examples — the wizard's Step 1 examples. Their route and Step 1 went
--     with video (removal 2, migration 0103, which deleted the video rows);
--   * affiliate_clicks and its enums affiliate_destination and
--     affiliate_source_type — the Zazzle click log. Its writer went with merch
--     (removal 4, migration 0105); the admin hard delete was its last reader;
--   * six engines columns only video engines ever set: allowed_durations_sec,
--     default_duration_sec, supported_modes, default_mode, audio_handling and
--     estimated_cost_usd_per_second. Every surviving engine carries null, an
--     empty list or "none" in them;
--   * the admin_config row ai_gallery_display_limit — the size of the legacy
--     meme studio's AI background gallery. Its reader went with the studio
--     (removal 1); the admin setting and its boot seed go in the same PR.
--
-- CAPTURED BEFORE DELETING (the rule from 0105), into
-- feature_permissions_migration_log.deleted_rows, and only when there is
-- something to keep:
--   * hero_examples rows, all of them: an admin curated that list;
--   * ratings rows with no matching reactions row — a rating 0035's copy did
--     not carry, which would otherwise be lost (dev has none: its ten ratings
--     are all in reactions);
--   * engines rows whose video columns hold anything but the empty values,
--     with those values;
--   * the ai_gallery_display_limit row, which an admin could edit.
-- NOT CAPTURED, by design: affiliate_clicks is per-visitor telemetry nothing
-- reads; its row count is logged, like 0109's.
--
-- ORDERING: the old server reads and writes engines' video columns at boot
-- (reconcile), so this runs after the old processes are stopped (the
-- stop-first cutover). Forward-only and idempotent: every read of a dropped
-- table or column checks that it exists first, because a schema push run
-- before migrate (the test-database sequence) has already dropped them, and
-- every drop is IF EXISTS. A re-run finds nothing, captures nothing and logs
-- zeros.
DO $$
DECLARE
  v_hero jsonb := '[]'::jsonb;
  v_ratings jsonb := '[]'::jsonb;
  v_engines jsonb := '[]'::jsonb;
  v_config jsonb;
  v_config_deleted integer := 0;
  v_rating_rows integer := 0;
  v_clicks integer := 0;
BEGIN
  IF to_regclass('hero_examples') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id), ''[]''::jsonb) FROM hero_examples h'
      INTO v_hero;
  END IF;

  IF to_regclass('ratings') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::integer FROM ratings' INTO v_rating_rows;
    EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.fact_id, r.user_id), ''[]''::jsonb)
               FROM ratings r
              WHERE NOT EXISTS (
                SELECT 1 FROM reactions x
                 WHERE x.user_id = r.user_id AND x.target_type = ''fact''
                   AND x.target_id = r.fact_id AND x.reaction_type = r.rating)'
      INTO v_ratings;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'engines'
               AND column_name = 'allowed_durations_sec') THEN
    EXECUTE 'SELECT coalesce(jsonb_agg(jsonb_build_object(
                 ''id'', e.id,
                 ''allowed_durations_sec'', e.allowed_durations_sec,
                 ''default_duration_sec'', e.default_duration_sec,
                 ''supported_modes'', e.supported_modes,
                 ''default_mode'', e.default_mode,
                 ''audio_handling'', e.audio_handling,
                 ''estimated_cost_usd_per_second'', e.estimated_cost_usd_per_second
               ) ORDER BY e.id), ''[]''::jsonb)
               FROM engines e
              WHERE e.allowed_durations_sec IS NOT NULL
                 OR e.default_duration_sec IS NOT NULL
                 OR (e.supported_modes IS NOT NULL AND e.supported_modes <> ''[]''::jsonb)
                 OR e.default_mode IS NOT NULL
                 OR e.audio_handling IS DISTINCT FROM ''none''
                 OR e.estimated_cost_usd_per_second IS NOT NULL'
      INTO v_engines;
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.key), '[]'::jsonb) INTO v_config
    FROM admin_config c WHERE c.key = 'ai_gallery_display_limit';

  IF to_regclass('affiliate_clicks') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::integer FROM affiliate_clicks' INTO v_clicks;
  END IF;

  IF v_hero <> '[]'::jsonb OR v_ratings <> '[]'::jsonb OR v_engines <> '[]'::jsonb
     OR v_config <> '[]'::jsonb THEN
    INSERT INTO feature_permissions_migration_log (migration_name, deleted_rows)
      VALUES ('0110_prune_orphans', jsonb_build_object(
        'hero_examples', v_hero,
        'ratings_not_in_reactions', v_ratings,
        'engines_video_columns', v_engines,
        'admin_config', v_config));

    WITH gone AS (
      DELETE FROM admin_config WHERE key = 'ai_gallery_display_limit' RETURNING 1
    )
    SELECT count(*)::integer INTO v_config_deleted FROM gone;
  END IF;

  RAISE NOTICE '[0110] hero_examples captured: %, ratings dropped: % (not in reactions, captured: %), engines with video values captured: %, affiliate_clicks rows dropped: %, admin_config rows deleted: %',
    jsonb_array_length(v_hero), v_rating_rows, jsonb_array_length(v_ratings), jsonb_array_length(v_engines), v_clicks, v_config_deleted;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS ratings;
--> statement-breakpoint
DROP TABLE IF EXISTS hero_examples;
--> statement-breakpoint
DROP TABLE IF EXISTS affiliate_clicks;
--> statement-breakpoint
DROP TYPE IF EXISTS affiliate_destination;
--> statement-breakpoint
DROP TYPE IF EXISTS affiliate_source_type;
--> statement-breakpoint
ALTER TABLE engines
  DROP COLUMN IF EXISTS allowed_durations_sec,
  DROP COLUMN IF EXISTS default_duration_sec,
  DROP COLUMN IF EXISTS supported_modes,
  DROP COLUMN IF EXISTS default_mode,
  DROP COLUMN IF EXISTS audio_handling,
  DROP COLUMN IF EXISTS estimated_cost_usd_per_second;
