-- The admin-action record and the "ever approved" record on a fact (plan
-- docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1I, 3C and the Source-of-Truth
-- Analysis; Issue #1018, increment 1.2b). Expand only: a new table, three new
-- nullable columns and a backfill. The previous release neither reads nor
-- writes any of them.
--
-- 1. admin_actions: one row per admin action on a fact or a review, written by
--    the app from now on. Nothing is backfilled into it: there is no reliable
--    record of who did what before it existed.
-- 2. facts.approved_at / approved_by_id / approval_source: whether the fact was
--    ever approved for production, separate from is_active. From now on
--    "Approve for production" records it with its approver ('moderator'). This
--    file establishes it for existing facts from legacy evidence ('legacy'),
--    and records no approver for them:
--      a. a review of the fact at production_approved: approved at that
--         review's reviewed_at (its created_at when that is empty);
--      b. otherwise, a fact that is live now: approved at its created_at.
--    Every other fact is left unapproved and counted by why: in moderation (an
--    open review stages it), rejected (a closed, unapproved review staged it),
--    or unestablished (none of these). Unestablished facts are listed by id in
--    the notice, never guessed.
--
-- Row states: never-approved fact -> unchanged (counted); legacy-approved fact
-- -> approval_source 'legacy'; already recorded (a re-run, or an approval the
-- app wrote) -> untouched (no-op). Re-running changes nothing.
--
-- Rollback: revert the code. The table and columns are additive; dropping them
-- loses only what was recorded after this ran.

CREATE TABLE IF NOT EXISTS admin_actions (
  id serial PRIMARY KEY,
  fact_id integer REFERENCES facts(id) ON DELETE SET NULL,
  review_id integer REFERENCES pending_reviews(id) ON DELETE SET NULL,
  actor_id varchar REFERENCES users(id) ON DELETE SET NULL,
  action varchar(48) NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_actions_fact_idx ON admin_actions (fact_id, created_at);
CREATE INDEX IF NOT EXISTS admin_actions_review_idx ON admin_actions (review_id);

ALTER TABLE facts ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS approved_by_id varchar REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS approval_source varchar(16);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facts_approval_recorded_whole') THEN
    ALTER TABLE facts ADD CONSTRAINT facts_approval_recorded_whole CHECK (
      (approval_source IS NULL) = (approved_at IS NULL)
      AND (approval_source IS NULL OR approval_source = 'moderator' OR approval_source = 'legacy')
    );
  END IF;
END $$;

DO $$
DECLARE
  v_from_review integer := 0;
  v_from_live integer := 0;
  v_already integer := 0;
  v_in_moderation integer := 0;
  v_rejected integer := 0;
  v_unestablished integer := 0;
  v_unestablished_ids text;
BEGIN
  SELECT count(*) INTO v_already FROM facts WHERE approved_at IS NOT NULL;

  -- a. A production approval on record.
  UPDATE facts f
     SET approved_at = a.approved_at, approval_source = 'legacy'
    FROM (
      SELECT fid, min(coalesce(r.reviewed_at, r.created_at)) AS approved_at
        FROM pending_reviews r
       CROSS JOIN LATERAL (VALUES (r.approved_fact_id), (r.staging_fact_id)) AS v(fid)
       WHERE r.workflow_stage = 'production_approved' AND v.fid IS NOT NULL
       GROUP BY fid
    ) a
   WHERE f.id = a.fid AND f.approved_at IS NULL;
  GET DIAGNOSTICS v_from_review = ROW_COUNT;

  -- b. Live now, with no review on record (imported or seeded before moderation).
  UPDATE facts SET approved_at = created_at, approval_source = 'legacy'
   WHERE is_active AND approved_at IS NULL;
  GET DIAGNOSTICS v_from_live = ROW_COUNT;

  -- Never approved: count by why.
  SELECT count(*) INTO v_in_moderation FROM facts f
   WHERE f.approved_at IS NULL
     AND EXISTS (SELECT 1 FROM pending_reviews r WHERE r.staging_fact_id = f.id AND r.status = 'pending');
  SELECT count(*) INTO v_rejected FROM facts f
   WHERE f.approved_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM pending_reviews r WHERE r.staging_fact_id = f.id AND r.status = 'pending')
     AND EXISTS (SELECT 1 FROM pending_reviews r WHERE r.staging_fact_id = f.id AND r.status = 'rejected');
  SELECT count(*), string_agg(f.id::text, ',' ORDER BY f.id) INTO v_unestablished, v_unestablished_ids FROM facts f
   WHERE f.approved_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM pending_reviews r WHERE r.staging_fact_id = f.id AND r.status IN ('pending', 'rejected'));

  RAISE NOTICE '0152_admin_actions_and_ever_approved: already recorded %, legacy from a production approval %, legacy from live status %; never approved: in moderation %, rejected %, unestablished % (ids: %)',
    v_already, v_from_review, v_from_live, v_in_moderation, v_rejected, v_unestablished, coalesce(v_unestablished_ids, 'none');
END $$;
