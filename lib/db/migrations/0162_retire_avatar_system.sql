-- Your own photo is your picture; the avatar system is removed (plan
-- docs/plans/PLAN_PHOTO_IS_YOUR_PICTURE.md, approved by David 2026-11-23,
-- Issue #849; Q1 and Q11 on Issue #628). Expand and contract in one release,
-- which the policy allows before Seed (docs/engineering/migrations-and-backfills.md).
--
-- 1. The custom_avatar feature (the Legendary photo-avatar perk), captured
--    whole into feature_permissions_migration_log.deleted_rows under
--    '0162_retire_avatar_system', then deleted (tier rows first).
-- 2. A picture that is not a first-party upload (a Google or Apple picture URL
--    copied in by sign-in before this change) is cleared: a member's picture is
--    only ever a photo they uploaded. Their next Google sign-in copies the
--    picture in as a real upload.
-- 3. users.avatar_style and users.avatar_source are dropped. Individual style
--    choices are not kept: each was a generated icon made from the user id.
--
-- Row-state matrix (counts are RAISEd as a NOTICE):
--   custom_avatar flag / tier rows present  -> captured, then deleted
--   already gone (a re-run)                 -> nothing captured or deleted
--   profile_image_url first-party / null    -> untouched
--   profile_image_url anything else         -> cleared
--   avatar columns present / absent         -> dropped / no-op
-- A second run captures nothing, clears nothing and drops nothing.
--
-- Recovery: the tag pre-cut/avatar-system restores the code but not these
-- columns. Restoring it takes a forward migration re-adding avatar_style
-- (varchar(30) DEFAULT 'bottts') and avatar_source (varchar(10) DEFAULT
-- 'avatar'), and re-inserting the captured feature_flags and
-- tier_feature_permissions rows from the log entry. Cleared provider URLs are
-- not restored (none was shown publicly, and there is no real member data).
DO $$
DECLARE
  v_deleted jsonb;
  v_pictures integer := 0;
  v_columns integer := 0;
BEGIN
  SELECT jsonb_build_object(
           'feature_flags', (
             SELECT coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
             FROM feature_flags f WHERE f.key = 'custom_avatar'
           ),
           'tier_feature_permissions', (
             SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
             FROM tier_feature_permissions p WHERE p.feature_key = 'custom_avatar'
           )
         )
    INTO v_deleted;

  IF v_deleted->'feature_flags' <> '[]'::jsonb
     OR v_deleted->'tier_feature_permissions' <> '[]'::jsonb THEN
    DELETE FROM tier_feature_permissions WHERE feature_key = 'custom_avatar';
    DELETE FROM feature_flags WHERE key = 'custom_avatar';
    INSERT INTO feature_permissions_migration_log (migration_name, deleted_rows)
      VALUES ('0162_retire_avatar_system', v_deleted);
    -- The grid changed shape, so clients holding the old revision refetch.
    UPDATE entitlement_grid_revision SET revision = revision + 1 WHERE id = 1;
  END IF;

  UPDATE users SET profile_image_url = NULL
    WHERE profile_image_url IS NOT NULL
      AND (profile_image_url NOT LIKE '/api/storage/objects/%' OR profile_image_url LIKE '%..%');
  GET DIAGNOSTICS v_pictures = ROW_COUNT;

  SELECT count(*)::integer INTO v_columns
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users'
      AND column_name IN ('avatar_style', 'avatar_source');
  ALTER TABLE users DROP COLUMN IF EXISTS avatar_style;
  ALTER TABLE users DROP COLUMN IF EXISTS avatar_source;

  RAISE NOTICE '[0162] features retired: %, tier rows retired: %, provider pictures cleared: %, avatar columns dropped: %, failed 0',
    coalesce(jsonb_array_length(v_deleted->'feature_flags'), 0),
    coalesce(jsonb_array_length(v_deleted->'tier_feature_permissions'), 0),
    v_pictures, v_columns;
END $$;
