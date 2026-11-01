-- Launch Phase 5, increment 3 (#795; plan docs/plans/PLAN_PHASE5_ACCOUNT_IDENTITY.md,
-- 0114). EXPAND: one onboarding screen, run once per account after its email
-- is verified, records the account's date of birth, its pronouns and its
-- marketing-consent decision; a half-finished form is kept as a draft.
--
-- Row states:
--   * existing rows — every new column is null, which reads as "not onboarded
--     yet": the account is asked once at its next sign-in. No backfill: a
--     stored `pronouns` value is kept and shown for confirmation, never
--     assumed (plan S22), and no consent is inferred for anyone.
--   * new rows — `pronouns` no longer defaults to 'he/him'. A null means "not
--     chosen yet"; the onboarding screen fills it. The boot DDL that created
--     the column with the same default (artifacts/api-server/src/lib/seed.ts)
--     drops it in the same change (plan S11), or a database whose column was
--     missing would get the default back at boot.
--
-- Idempotent: every column is ADD COLUMN IF NOT EXISTS, the CHECK is added
-- only when absent, and DROP DEFAULT is a no-op on a column without one.
-- `captcha_verified` stays: nothing reads or writes it from this increment,
-- and increment 7 (0119) drops it once this release is the published one.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_draft" jsonb;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "date_of_birth" date;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "marketing_consent_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "marketing_consent_method" varchar(20);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "marketing_consent_wording_version" varchar(40);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_marketing_consent_method_check' AND conrelid = 'users'::regclass) THEN
    -- Every row is null here (the column is new), so the constraint validates.
    ALTER TABLE "users" ADD CONSTRAINT "users_marketing_consent_method_check"
      CHECK ("marketing_consent_method" IS NULL OR "marketing_consent_method" IN ('default_checked', 'ticked', 'declined'));
  END IF;
END $$;

ALTER TABLE "users" ALTER COLUMN "pronouns" DROP DEFAULT;

DO $$
DECLARE
  total bigint;
BEGIN
  SELECT count(*) INTO total FROM users WHERE onboarding_completed_at IS NULL;
  RAISE NOTICE '[0114] accounts to be asked once at next sign-in: %', total;
END $$;
