-- Launch Phase 14, increment 4 (Issue #1030; plan PLAN_PHASE14_COMPLIANCE.md,
-- Data Model "Acceptance record" and "Age refusal").
--
-- 1. users.age_refused_at: when an account submitted set-up with a date under
--    18. The date itself is not stored. Nullable, no default, no backfill:
--    no account has refused yet, and an onboarded account's age stays derived
--    from date_of_birth.
-- 2. legal_acceptances: one row per (account, document, version), with its
--    time, for each version of the Terms an account agreed to or the Privacy
--    page it acknowledged. Append-only
--    by convention (the code has no update path); removed with the account by
--    cascade. No backfill: no existing account has accepted anything, and each
--    is asked once.
--
-- Row states: users rows are untouched (the new column is null for all of
-- them, which is the correct state: no one has refused); legal_acceptances is
-- new and empty. A second run is a no-op at each statement. Rollback: revert
-- the code; the previous release neither reads nor writes either object.
--
-- Additive (expand only): the previous release neither reads nor writes either,
-- so it runs unchanged on this schema. Idempotent: every statement is guarded,
-- so a second run, or a run after Replit's publish applied the DDL, changes
-- nothing.

ALTER TABLE users ADD COLUMN IF NOT EXISTS age_refused_at timestamp with time zone;

CREATE TABLE IF NOT EXISTS legal_acceptances (
  id serial PRIMARY KEY,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document varchar(20) NOT NULL,
  version varchar(40) NOT NULL,
  accepted_at timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'legal_acceptances_document_check'
       AND conrelid = 'legal_acceptances'::regclass
  ) THEN
    -- Written in the form PostgreSQL prints back, so a dump and restore
    -- (production adoption, phase3.productionAdopt.test.ts) compares equal to
    -- a migrated database (0156's practice).
    ALTER TABLE legal_acceptances
      ADD CONSTRAINT legal_acceptances_document_check
      CHECK (((document)::text = ANY (ARRAY[('terms'::character varying)::text, ('privacy'::character varying)::text])));
  END IF;
END $$;

-- Unique: accepting the same version twice adds nothing (a double click, a
-- retry); a new version is a new row beside the old one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_acceptances_user_document
  ON legal_acceptances (user_id, document, version);

DO $$
DECLARE
  v_refused integer;
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_refused FROM users WHERE age_refused_at IS NOT NULL;
  SELECT count(*) INTO v_rows FROM legal_acceptances;
  RAISE NOTICE '[0162] users with an age refusal % (expected 0 on first run), acceptance rows % (expected 0 on first run), backfilled 0, failed 0',
    v_refused, v_rows;
END $$;
