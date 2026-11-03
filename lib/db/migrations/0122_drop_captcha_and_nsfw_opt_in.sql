-- Launch Phase 5, increment 7b (plan docs/plans/PLAN_PHASE5_ACCOUNT_IDENTITY.md,
-- S23 and S13): the contract step. Drops two users columns nothing reads or
-- writes any more:
--
-- 1. users.captcha_verified — retired by Increment 3 (PR #801): the
--    submit-review and tokenize-fact bypass reads onboarding_completed_at,
--    since every onboarded account passed a challenge at onboarding.
-- 2. users.nsfw_mode_enabled — the NSFW opt-in withdrawn by Increment 6b
--    (PR #836): every classifier caller passes false, and the field left the
--    API, the admin editor and the auth middleware.
--
-- CONTRACT, NOT EXPAND (migrations-and-backfills.md, *Expand, then
-- contract*): it runs only once the release that stopped using both columns
-- is the published one. That release is main at 61a2d8b, published by David
-- on 2026-11-03; its code neither reads nor writes either column.
--
-- Row states: every users row loses the two values. captcha_verified carries
-- nothing a later release needs (onboarding replaced it). nsfw_mode_enabled
-- records a choice the product withdrew; adult content, when it ships, builds
-- on users.adult_verified_at and the audience columns (0121), not on this
-- flag. The counts of true values are reported before the drop, so the run
-- says what was discarded.
--
-- Idempotent: each column is read and dropped only if it still exists, so a
-- second run, or a run after Replit's publish already dropped them, changes
-- nothing and reports nothing.
DO $$
DECLARE
  v_count bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'captcha_verified') THEN
    EXECUTE 'SELECT count(*) FROM users WHERE captcha_verified' INTO v_count;
    RAISE NOTICE '[0122] dropping users.captcha_verified (% rows held true)', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'nsfw_mode_enabled') THEN
    EXECUTE 'SELECT count(*) FROM users WHERE nsfw_mode_enabled' INTO v_count;
    RAISE NOTICE '[0122] dropping users.nsfw_mode_enabled (% rows held true)', v_count;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "captcha_verified";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "nsfw_mode_enabled";
