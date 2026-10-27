-- Launch Phase 3, increment 2 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
-- §1, approved by David 2026-10-27).
--
-- Brings the three object names the long-lived databases inherited from their
-- history into line with the names the schema declares (lib/db/src/schema), so a
-- database built from the baseline and one that grew migration by migration end
-- with the same catalog. Found by comparing dev's real schema with a CI-built one
-- (#770, 2026-10-27): every table and column matched; only these names differed.
--   * async_jobs was created as email_outbox and later renamed; its primary key
--     and identity sequence kept the old names (email_outbox_pkey,
--     email_outbox_id_seq). The schema names them async_jobs_pkey and
--     async_jobs_id_seq.
--   * tier_feature_permission_audit's actor foreign key carries PostgreSQL's
--     automatic name (…_actor_id_fkey); the schema names it
--     …_actor_id_users_id_fk.
--
-- Renames only: no data, no column, no constraint's meaning changes. Each step
-- acts only when the old name is present and the new one is absent, so it is a
-- no-op on a database that already has the declared names, and a re-run does
-- nothing. No snapshot: the Drizzle snapshot already carries the declared names
-- (see 0045, the same shape).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'async_jobs' AND t.relnamespace = current_schema()::regnamespace
      AND c.conname = 'email_outbox_pkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'async_jobs' AND t.relnamespace = current_schema()::regnamespace
      AND c.conname = 'async_jobs_pkey'
  ) THEN
    ALTER TABLE async_jobs RENAME CONSTRAINT email_outbox_pkey TO async_jobs_pkey;
    RAISE NOTICE '[0111] async_jobs primary key renamed from email_outbox_pkey';
  END IF;

  IF to_regclass('email_outbox_id_seq') IS NOT NULL AND to_regclass('async_jobs_id_seq') IS NULL THEN
    ALTER SEQUENCE email_outbox_id_seq RENAME TO async_jobs_id_seq;
    RAISE NOTICE '[0111] async_jobs identity sequence renamed from email_outbox_id_seq';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'tier_feature_permission_audit' AND t.relnamespace = current_schema()::regnamespace
      AND c.conname = 'tier_feature_permission_audit_actor_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'tier_feature_permission_audit' AND t.relnamespace = current_schema()::regnamespace
      AND c.conname = 'tier_feature_permission_audit_actor_id_users_id_fk'
  ) THEN
    ALTER TABLE tier_feature_permission_audit
      RENAME CONSTRAINT tier_feature_permission_audit_actor_id_fkey
      TO tier_feature_permission_audit_actor_id_users_id_fk;
    RAISE NOTICE '[0111] tier_feature_permission_audit actor foreign key renamed';
  END IF;
END $$;
