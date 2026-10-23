-- Launch Phase 4, removal 8: Debug mode is deleted (#744; plan
-- docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
--
-- Debug mode was a second value per setting (admin_config.debug_value, with a
-- display label in debug_value_label) that every config getter preferred while
-- the debug_mode_active setting read "true". The getters, the config route's
-- debug fields, the config screen's Debug column and toggle, and the two boot
-- seeds that recreated the columns and the toggle row are gone from the code in
-- the same PR. After this migration `value` is the only value a setting has.
--
-- THE REFUSAL. If debug_mode_active is "true" here, dropping the columns would
-- silently change the live value of every setting that has a debug value, the
-- membership timing settings on the payments path among them. So the migration
-- stops instead, naming those keys; turning Debug mode off (or promoting the
-- debug values into `value`) and re-running is the way through. Dev and
-- production both seed it "false" and dev read "false" on 2026-10-23.
--
-- CAPTURED BEFORE DELETING (the rule from 0105): every setting with a debug
-- value or debug label, as a whole row, and the debug_mode_active row itself,
-- go into feature_permissions_migration_log.deleted_rows. A row is written only
-- when there is something to capture, so a re-run logs nothing.
--
-- Also: the stripe_live_mode description seeded as "...This is independent from
-- debug mode." loses that sentence, where it still reads exactly as seeded.
--
-- ORDERING: runs after the old processes are stopped (the stop-first cutover),
-- because the old config reader selects the debug columns and falls back to
-- every default once they are gone. Every read of a debug column checks the
-- column exists first, because a schema push run before migrate (the
-- test-database sequence) has already dropped them.
DO $$
DECLARE
  v_has_debug_value boolean;
  v_has_debug_label boolean;
  v_flag text;
  v_keys text;
  v_overrides jsonb := '[]'::jsonb;
  v_flag_row jsonb;
  v_flag_deleted integer := 0;
  v_stripe_desc integer := 0;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'admin_config' AND column_name = 'debug_value')
    INTO v_has_debug_value;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'admin_config' AND column_name = 'debug_value_label')
    INTO v_has_debug_label;

  SELECT value INTO v_flag FROM admin_config WHERE key = 'debug_mode_active';

  IF v_has_debug_value THEN
    EXECUTE $q$
      SELECT string_agg(key, ', ' ORDER BY key) FROM admin_config
      WHERE key <> 'debug_mode_active' AND debug_value IS NOT NULL AND debug_value <> ''
    $q$ INTO v_keys;
  END IF;

  IF v_flag = 'true' THEN
    RAISE EXCEPTION '[0108] refusing to remove Debug mode: debug_mode_active is "true", so dropping admin_config.debug_value would change the live value of: %. Turn Debug mode off (or copy the debug values you want into value) and re-run.',
      coalesce(v_keys, '(no setting has a debug value)');
  END IF;

  IF v_has_debug_value OR v_has_debug_label THEN
    EXECUTE format(
      'SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.key), ''[]''::jsonb) FROM admin_config c WHERE %s',
      concat_ws(' OR ',
        CASE WHEN v_has_debug_value THEN '(c.debug_value IS NOT NULL AND c.debug_value <> '''')' END,
        CASE WHEN v_has_debug_label THEN 'c.debug_value_label IS NOT NULL' END))
      INTO v_overrides;
  END IF;

  SELECT to_jsonb(c) INTO v_flag_row FROM admin_config c WHERE c.key = 'debug_mode_active';

  IF v_overrides <> '[]'::jsonb OR v_flag_row IS NOT NULL THEN
    INSERT INTO feature_permissions_migration_log (migration_name, deleted_rows)
      VALUES ('0108_retire_debug_mode',
              jsonb_build_object('debug_overrides', v_overrides, 'debug_mode_active', v_flag_row));

    WITH gone AS (
      DELETE FROM admin_config WHERE key = 'debug_mode_active' RETURNING 1
    )
    SELECT count(*)::integer INTO v_flag_deleted FROM gone;
  END IF;

  WITH changed AS (
    UPDATE admin_config
      SET description = 'When enabled, Stripe uses live credentials and charges real cards. Disable to use test mode.'
      WHERE key = 'stripe_live_mode'
        AND description = 'When enabled, Stripe uses live credentials and charges real cards. Disable to use test mode. This is independent from debug mode.'
      RETURNING 1
  )
  SELECT count(*)::integer INTO v_stripe_desc FROM changed;

  RAISE NOTICE '[0108] debug values captured: % (keys: %), debug_mode_active rows deleted: %, stripe_live_mode descriptions updated: %',
    jsonb_array_length(v_overrides), coalesce(v_keys, 'none'), v_flag_deleted, v_stripe_desc;
END $$;
--> statement-breakpoint

ALTER TABLE admin_config DROP COLUMN IF EXISTS debug_value;
--> statement-breakpoint
ALTER TABLE admin_config DROP COLUMN IF EXISTS debug_value_label;
