-- A takedown is final, and "Remove my picture" (plan
-- docs/plans/PLAN_AVATAR_TAKEDOWN_AND_REMOVE.md, approved by David 2026-11-24,
-- Issue #849; Q16 and Q17). Additive.
--
-- 1. users.no_auto_picture: true means Google's sign-in picture is never copied
--    in again. The member removing their picture sets it, and so does an admin
--    taking their profile photo down; nothing clears it.
-- 2. Backfill: every owner whose profile photo was already taken down, read from
--    the audit row takeDownContent commits with the takedown
--    (action 'content_takedown', detail kind 'photo', wasProfile true).
--
-- Row-state matrix (counts are RAISEd as a NOTICE):
--   column absent / present                   -> added / no-op
--   owner of a profile takedown, flag false   -> set true
--   flag already true (any reason)            -> untouched
--   everyone else                             -> false (the default)
--   profile_image_url                         -> never touched
-- A second run adds nothing and sets nothing.
--
-- Recovery: keep the column. Dropping it would lose members' removal choices,
-- which no other record holds; pre-change code simply ignores it.
DO $$
DECLARE
  v_added integer := 0;
  v_set integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'no_auto_picture'
  ) THEN
    ALTER TABLE users ADD COLUMN no_auto_picture boolean NOT NULL DEFAULT false;
    v_added := 1;
  END IF;

  UPDATE users u SET no_auto_picture = true
    WHERE u.no_auto_picture = false
      AND EXISTS (
        SELECT 1 FROM admin_actions a
        WHERE a.action = 'content_takedown'
          AND a.detail->>'kind' = 'photo'
          AND a.detail->>'wasProfile' = 'true'
          AND a.detail->>'ownerId' = u.id
      );
  GET DIAGNOSTICS v_set = ROW_COUNT;

  RAISE NOTICE '[0164] column added: %, members set from earlier takedowns: %, failed 0', v_added, v_set;
END $$;
