-- Plan 1a — One resolver, one client contract, no admin lockout (PR #421, workstream #405).
--
-- Forward-only and idempotent. ONE destructive step: retiring the dead
-- `meme_upload_photo` feature row, which captures the removed row into
-- `feature_permissions_migration_log.deleted_rows` BEFORE deleting it so
-- recovery is answerable from the database rather than from a document.
-- `meme_ai_background` is NOT retired here — see the note below.
--
-- Recovery, post-Plan-1b: `create_feature_flag` then `set_tier_feature` per
-- tier, passing the captured values — which additionally makes the restoration
-- audited and revision-bumped, as any other grid change is. Pre-1b a direct
-- INSERT of the same captured values is equivalent and available. Both read
-- from the same `deleted_rows` capture; only the write mechanism differs.
--
-- ORDERING NOTE — this migration MUST run before Plan 1b's (PR #422). The
-- deletion below is a direct `tier_feature_permissions` row delete, which 1b's
-- protection trigger rejects; post-1b the sanctioned path is
-- `delete_feature_flag`. 1b's own migration fails fast without this one's
-- journal entry, so the ordering is enforced from both sides.

-- ── 1. The grid-mutation audit trail ────────────────────────────────────────
-- `feature_key` deliberately carries NO foreign key: a live FK would either
-- block feature deletion (NO ACTION) or destroy history with the feature
-- (CASCADE). It is a denormalized historical fact, same as `actor_id`'s
-- ON DELETE SET NULL — the record must survive its referent.
CREATE TABLE IF NOT EXISTS tier_feature_permission_audit (
  id serial PRIMARY KEY,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  tier varchar(50) NOT NULL,
  feature_key varchar(100) NOT NULL,
  enabled_before boolean,
  enabled_after boolean NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS tier_feature_permission_audit_created_at_idx
  ON tier_feature_permission_audit (created_at);
--> statement-breakpoint

-- ── 2. The client contract's version source ─────────────────────────────────
-- A second row is rejected by the primary key, a wrong-keyed row by the CHECK.
CREATE TABLE IF NOT EXISTS entitlement_grid_revision (
  id integer PRIMARY KEY DEFAULT 1,
  revision bigint NOT NULL DEFAULT 0,
  CONSTRAINT entitlement_grid_revision_singleton CHECK (id = 1)
);
--> statement-breakpoint

-- Clean install, re-run, and already-populated all converge on one row.
INSERT INTO entitlement_grid_revision (id, revision) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- ── 3. The backfill's observable outcome ────────────────────────────────────
-- The canonical runner (lib/db/src/migrate.ts) ignores statement result rows,
-- and skips an already-applied migration by hash, so an in-migration SELECT is
-- always invisible on a normal run. As of migration 0100 the runner DOES
-- install a NOTICE listener for the duration of each migrate() call, so a
-- RAISE NOTICE now reaches the console log — but that is a transient, run-time
-- log line, not a durable record: nothing persists it, nothing can query it
-- after the fact, and it exists only in whatever process happened to run the
-- migration. This table is what makes the outcome durable and queryable.
CREATE TABLE IF NOT EXISTS feature_permissions_migration_log (
  id serial PRIMARY KEY,
  migration_name varchar(200) NOT NULL,
  inserted_count integer NOT NULL DEFAULT 0,
  already_complete_count integer NOT NULL DEFAULT 0,
  engine_experiments_skipped_count integer NOT NULL DEFAULT 0,
  deleted_rows jsonb,
  ran_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ── 4. The authorization snapshot on queued work ────────────────────────────
-- Added nullable, backfilled, then constrained, so the column reaches NOT NULL
-- without a nullable interim state surviving the migration.
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS authorization_snapshot jsonb;
--> statement-breakpoint

-- Rows that predate this plan record exactly that. This placeholder is
-- acceptable ONLY from the migration; a live writer that emitted it would be
-- defeating the column's whole purpose, which is to record what actually
-- authorized THIS job.
UPDATE video_jobs
  SET authorization_snapshot = '{"predatesPlan": true, "tier": null, "isAdmin": null, "decisions": {}, "resolvedAt": null}'::jsonb
  WHERE authorization_snapshot IS NULL;
--> statement-breakpoint

ALTER TABLE video_jobs ALTER COLUMN authorization_snapshot SET NOT NULL;
--> statement-breakpoint

-- ── 5. The five capabilities that were gated by inline role checks ──────────
-- Each already exists as a capability; what is new is the grid being able to
-- express it. Values reproduce today's real behaviour exactly (legendary and
-- admin only), so day-one behaviour change is zero.
-- `video_generation` is listed here for a different reason than the other five:
-- it is an EXISTING capability whose grid rows were created only by `seed.ts`'s
-- startup INSERTs, which this plan deletes. Nothing else in migration history
-- creates them, so a clean install would otherwise come up with no
-- `video_generation` row at all and the resolver would deny it for everyone.
-- ON CONFLICT DO NOTHING throughout, so an operator's existing toggle is never
-- overwritten — the boot-time `DO UPDATE SET enabled = EXCLUDED.enabled` that
-- made this feature impossible to switch off is exactly what is being removed.
INSERT INTO feature_flags (key, display_name, description) VALUES
  ('video_generation', 'Video Generation',
   'Ability to generate AI-powered videos from meme images'),
  ('meme_pulid_stylize', 'PuLID Stylized Memes',
   'Generate memes that stylize the user''s own uploaded photo via PuLID.'),
  ('fact_submit_captcha_bypass', 'Skip Captcha on Fact Submission',
   'Submit facts without completing a captcha challenge.'),
  ('fact_submit_rate_limit_bypass', 'Higher Fact Submission Rate Limit',
   'Bypass the standard rate limit on fact submissions.'),
  ('ads_free', 'Ad-Free Browsing',
   'Browse the site without advertisements.'),
  ('custom_avatar', 'Custom Avatar Photo',
   'Select an uploaded photo as the public profile avatar instead of a generated icon.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO tier_feature_permissions (tier, feature_key, enabled) VALUES
  ('unregistered', 'video_generation', false),
  ('registered',   'video_generation', false),
  ('legendary',    'video_generation', true),
  ('admin',        'video_generation', true),
  ('unregistered', 'meme_pulid_stylize', false),
  ('registered',   'meme_pulid_stylize', false),
  ('legendary',    'meme_pulid_stylize', true),
  ('admin',        'meme_pulid_stylize', true),
  ('unregistered', 'fact_submit_captcha_bypass', false),
  ('registered',   'fact_submit_captcha_bypass', false),
  ('legendary',    'fact_submit_captcha_bypass', true),
  ('admin',        'fact_submit_captcha_bypass', true),
  ('unregistered', 'fact_submit_rate_limit_bypass', false),
  ('registered',   'fact_submit_rate_limit_bypass', false),
  ('legendary',    'fact_submit_rate_limit_bypass', true),
  ('admin',        'fact_submit_rate_limit_bypass', true),
  ('unregistered', 'ads_free', false),
  ('registered',   'ads_free', false),
  ('legendary',    'ads_free', true),
  ('admin',        'ads_free', true),
  ('unregistered', 'custom_avatar', false),
  ('registered',   'custom_avatar', false),
  ('legendary',    'custom_avatar', true),
  ('admin',        'custom_avatar', true)
ON CONFLICT (tier, feature_key) DO NOTHING;
--> statement-breakpoint

-- ── 6. Wrong copy on the one screen this plan makes authoritative ───────────
-- The row claimed "100/hour instead of 10/hour"; the real behaviour is a
-- 200-vs-30 DAILY save cap.
UPDATE feature_flags
  SET description = 'Higher daily meme save cap (200/day instead of 30/day).'
  WHERE key = 'meme_rate_limit_high';
--> statement-breakpoint

-- ── 7. The backfill, as a callable function ─────────────────────────────────
-- A function rather than inline SQL so idempotency is provable: an integration
-- test calls it TWICE in one test, which the hash-tracking runner never does on
-- a normal deploy.
--
-- SECURITY INVOKER (the default) is deliberate. Once Plan 1b revokes the
-- application role's direct write privileges on the grid tables, this function
-- stops working for that role along with every other direct write — it is not a
-- standing bypass of the boundary 1b installs.
CREATE OR REPLACE FUNCTION backfill_feature_permissions(p_migration_name text)
RETURNS TABLE (
  inserted_count integer,
  already_complete_count integer,
  engine_experiments_skipped_count integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted integer := 0;
  v_already_complete integer := 0;
  v_skipped integer := 0;
  v_deleted jsonb;
  -- Rows retired by this plan. See the capture block below for why.
  --
  -- `meme_ai_background` is deliberately NOT here. It looks like a dead row —
  -- its only *reader* was an unreachable gate in render.ts — but the capability
  -- is real and reachable: the AI Background Picker's generate button hits four
  -- `requireLegendary` routes in memes.ts. That is the inline-role-check
  -- category this plan moves INTO the grid, not out of it.
  v_retired_keys text[] := ARRAY['meme_upload_photo'];
BEGIN
  -- Features already carrying a complete four-row set, measured BEFORE this
  -- run's inserts. This count legitimately RISES on a second run: the features
  -- the first run repaired are, by definition, complete on the second.
  SELECT count(*)::integer INTO v_already_complete
  FROM feature_flags f
  WHERE f.key <> 'engine_experiments'
    AND (
      SELECT count(*) FROM tier_feature_permissions p
      WHERE p.feature_key = f.key
        AND p.tier IN ('unregistered', 'registered', 'legendary', 'admin')
    ) = 4;

  -- How many rows the deliberate exception costs us. `engine_experiments` is
  -- left alone on purpose: backfilling a feature Plan 3 is about to retire is
  -- wasted work.
  -- Guarded on the feature actually existing: if `engine_experiments` is not a
  -- feature at all, the backfill would never have wanted those rows, and
  -- reporting 4 skipped would claim an exception that did no work.
  IF EXISTS (SELECT 1 FROM feature_flags WHERE key = 'engine_experiments') THEN
    SELECT greatest(0, 4 - count(*))::integer INTO v_skipped
    FROM tier_feature_permissions p
    WHERE p.feature_key = 'engine_experiments'
      AND p.tier IN ('unregistered', 'registered', 'legendary', 'admin');
  ELSE
    v_skipped := 0;
  END IF;

  -- Capture the vestigial row-sets before removing them, so recovery reads
  -- from the database. Only populated on the run that actually deletes
  -- something.
  --
  -- Only `meme_upload_photo` retires here — it encoded only the
  -- registered-vs-unregistered distinction authentication already enforces.
  -- `meme_ai_background` looked like the same shape (its only reader was the
  -- unreachable render.ts gate) but is deliberately KEPT, not retired: see
  -- the note above `v_retired_keys`.
  SELECT jsonb_build_object(
           'feature_flags', (
             SELECT coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
             FROM feature_flags f WHERE f.key = ANY(v_retired_keys)
           ),
           'tier_feature_permissions', (
             SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
             FROM tier_feature_permissions p WHERE p.feature_key = ANY(v_retired_keys)
           )
         )
    INTO v_deleted;

  IF v_deleted->'feature_flags' = '[]'::jsonb
     AND v_deleted->'tier_feature_permissions' = '[]'::jsonb THEN
    v_deleted := NULL;
  END IF;

  -- Children first, then the parent. Both are no-ops on a re-run and on an
  -- already-clean database.
  DELETE FROM tier_feature_permissions WHERE feature_key = ANY(v_retired_keys);
  DELETE FROM feature_flags WHERE key = ANY(v_retired_keys);

  -- Fill only the gaps. `false` is the correct default: it is exactly what the
  -- resolver already infers from a missing row, so filling a gap changes no
  -- behaviour.
  WITH wanted AS (
    SELECT f.key AS feature_key, t.tier
    FROM feature_flags f
    CROSS JOIN (VALUES ('unregistered'), ('registered'), ('legendary'), ('admin')) AS t(tier)
    WHERE f.key <> 'engine_experiments'
  ),
  missing AS (
    SELECT w.tier, w.feature_key
    FROM wanted w
    LEFT JOIN tier_feature_permissions p
      ON p.tier = w.tier AND p.feature_key = w.feature_key
    WHERE p.feature_key IS NULL
  ),
  ins AS (
    INSERT INTO tier_feature_permissions (tier, feature_key, enabled)
    SELECT tier, feature_key, false FROM missing
    ON CONFLICT (tier, feature_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_inserted FROM ins;

  INSERT INTO feature_permissions_migration_log (
    migration_name, inserted_count, already_complete_count,
    engine_experiments_skipped_count, deleted_rows
  ) VALUES (
    p_migration_name, v_inserted, v_already_complete, v_skipped, v_deleted
  );

  RETURN QUERY SELECT v_inserted, v_already_complete, v_skipped;
END;
$$;
--> statement-breakpoint

SELECT * FROM backfill_feature_permissions('0099_admin_permissions_core');
