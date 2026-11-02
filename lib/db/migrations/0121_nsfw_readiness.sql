-- Launch Phase 5, increment 6b (plan docs/plans/PLAN_PHASE5_ACCOUNT_IDENTITY.md,
-- "NSFW readiness", intent item 9): the data model is ready for adult content
-- and the beta overlay without shipping either.
--
-- 1. facts / memes / user_ai_images get `audience` ('general' | 'adult',
--    default 'general', CHECK). Every existing row reads 'general' through
--    the default. Read by nothing yet.
-- 2. users.adult_verified_at — a provider's adult verification, separate from
--    the date-derived 18+ (S12). Read by nothing yet.
-- 3. The `beta_overlay` feature and its four tier rows, all disabled, in
--    0099's shape; the grid revision is bumped only when the rows are new, so
--    clients refetch once.
--
-- Row states: every existing content row gains audience = 'general'; users
-- gain a null adult_verified_at; the grid gains one feature, off everywhere.
-- The CHECKs are written in the form Postgres prints after a dump and
-- restore (the form every older varchar IN-check in this database already
-- has), so production's adoption check finds the restored copy identical.
-- Idempotent: ADD COLUMN IF NOT EXISTS, constraints added only when absent,
-- inserts ON CONFLICT DO NOTHING; a second run changes nothing.

ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "audience" varchar(10) NOT NULL DEFAULT 'general';
ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "audience" varchar(10) NOT NULL DEFAULT 'general';
ALTER TABLE "user_ai_images" ADD COLUMN IF NOT EXISTS "audience" varchar(10) NOT NULL DEFAULT 'general';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "adult_verified_at" timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facts_audience_check' AND conrelid = 'facts'::regclass) THEN
    ALTER TABLE "facts" ADD CONSTRAINT "facts_audience_check" CHECK (("audience")::text = ANY (ARRAY[('general'::character varying)::text, ('adult'::character varying)::text]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memes_audience_check' AND conrelid = 'memes'::regclass) THEN
    ALTER TABLE "memes" ADD CONSTRAINT "memes_audience_check" CHECK (("audience")::text = ANY (ARRAY[('general'::character varying)::text, ('adult'::character varying)::text]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_ai_images_audience_check' AND conrelid = 'user_ai_images'::regclass) THEN
    ALTER TABLE "user_ai_images" ADD CONSTRAINT "user_ai_images_audience_check" CHECK (("audience")::text = ANY (ARRAY[('general'::character varying)::text, ('adult'::character varying)::text]));
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  v_rows int;
BEGIN
  INSERT INTO feature_flags (key, display_name, description) VALUES
    ('beta_overlay', 'Beta Overlay',
     'Access to features in beta. Off for every tier; read by nothing until a beta ships.')
  ON CONFLICT (key) DO NOTHING;

  INSERT INTO tier_feature_permissions (tier, feature_key, enabled) VALUES
    ('unregistered', 'beta_overlay', false),
    ('registered',   'beta_overlay', false),
    ('legendary',    'beta_overlay', false),
    ('admin',        'beta_overlay', false)
  ON CONFLICT (tier, feature_key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    -- The grid changed shape, so clients holding the old revision refetch.
    UPDATE entitlement_grid_revision SET revision = revision + 1 WHERE id = 1;
  END IF;

  RAISE NOTICE '[0121] beta_overlay tier rows inserted: %', v_rows;
END $$;
