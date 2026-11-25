-- Credits, part 1 (launch Phase 7, increment 1; plan
-- docs/plans/PLAN_PHASE7_IMAGE_OFFERING.md §1, approved by David 2026-11-25,
-- Issue #1295). EXPAND only: a new table, two triggers and a backfill. Nothing
-- the previous release reads or writes changes.
--
-- credit_ledger: one row per change to an account's credits. The balance is
-- the sum of an account's rows. A GRANT row is a lot (lot_id NULL, credits
-- > 0); a row that draws on or restores a lot names it in lot_id. So the
-- ledger can always say how many of a lot's credits are unspent, which a
-- purchase refund needs (plan §1; Astra, concern C2).
--
-- Kinds this migration admits (later increments add their own):
--   free_grant   one credit when an account is first verified; ref = user id
--   admin_grant  an admin's positive adjustment, its own lot; ref = request id
--   admin_debit  an admin's negative adjustment, one row per lot drawn on;
--                ref = request id
-- (kind, ref, lot) is unique, so a retried write is a no-op, never a second
-- row.
--
-- Append-only, by trigger: an UPDATE is refused, and so is a DELETE unless it
-- is the cascade from the account's own deletion (the account purge removes
-- its payment history; plan §1, Astra C12). Measured on PostgreSQL 16: a
-- direct DELETE runs the guard at pg_trigger_depth() = 1, the cascade from
-- users at 2. No other trigger or function writes this table; one added later
-- would run at depth 2 too, and must not delete.
--
-- actor_id carries no foreign key, so an admin's own deletion changes no row
-- here: actor_label is the provenance that is read, and actor_id is a record
-- of who it was. lot_id's foreign key does not cascade either: a lot never
-- goes alone, and the account's deletion removes all its rows in one
-- statement.
--
-- The free credit is granted by a trigger on users, so every way an account
-- becomes verified grants it (email link, email change, a provider that vouches
-- for the address, an admin's "verify email", and any path added later),
-- once: the unique key makes a second verification a no-op.
--
-- Row-state matrix for the backfill (counts are RAISEd as a NOTICE):
--   verified, no free grant         -> granted
--   verified, free grant present    -> no-op (a re-run, or the trigger got there)
--   verified and suspended          -> granted (spending is blocked elsewhere;
--                                      Astra C14)
--   unverified                      -> no row; granted when verified
--   deleted                         -> no user row, so no ledger row
-- An account verified while this release deploys is granted by the trigger
-- once it exists; one verified by the previous release after this ran is
-- granted by running the same idempotent backfill again.
--
-- Recovery: restore the previous application code and leave the table; that
-- code never reads it.

CREATE TABLE IF NOT EXISTS "credit_ledger" (
  "id"          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id"     varchar NOT NULL,
  "kind"        varchar(32) NOT NULL,
  "credits"     integer NOT NULL,
  "ref"         varchar(128) NOT NULL,
  "lot_id"      bigint,
  "note"        text,
  "actor_id"    varchar,
  "actor_label" text,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"credit_ledger"'::regclass AND conname = 'credit_ledger_user_id_users_id_fk') THEN
    ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"credit_ledger"'::regclass AND conname = 'credit_ledger_lot_id_credit_ledger_id_fk') THEN
    ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_lot_id_credit_ledger_id_fk"
      FOREIGN KEY ("lot_id") REFERENCES "credit_ledger"("id");
  END IF;
  -- The kinds, and their shape: a grant is a lot of positive credits; a debit
  -- draws on a named lot. A kind not named here is refused.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"credit_ledger"'::regclass AND conname = 'credit_ledger_lot_shape_check') THEN
    ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_lot_shape_check"
      CHECK (((("kind")::text = ANY (ARRAY[('free_grant'::character varying)::text, ('admin_grant'::character varying)::text])) AND ("lot_id" IS NULL) AND ("credits" > 0))
          OR ((("kind")::text = 'admin_debit'::text) AND ("lot_id" IS NOT NULL) AND ("credits" < 0)));
  END IF;
  -- An admin's change names who made it and why.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"credit_ledger"'::regclass AND conname = 'credit_ledger_admin_provenance_check') THEN
    ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_admin_provenance_check"
      CHECK ((("kind")::text = 'free_grant'::text) OR (("actor_label" IS NOT NULL) AND ("note" IS NOT NULL) AND (length(btrim("note")) > 0)));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_credit_ledger_kind_ref_lot" ON "credit_ledger" ("kind", "ref", (COALESCE("lot_id", 0)));
CREATE INDEX IF NOT EXISTS "IDX_credit_ledger_user" ON "credit_ledger" ("user_id", "id");
CREATE INDEX IF NOT EXISTS "IDX_credit_ledger_lot" ON "credit_ledger" ("lot_id") WHERE "lot_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION credit_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'credit_ledger is append-only: a row is never updated' USING ERRCODE = 'check_violation';
  END IF;
  -- Depth 1 is a statement aimed at this table; the cascade from the
  -- account's deletion runs one level deeper.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'credit_ledger is append-only: rows go only with their account' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "credit_ledger_append_only" ON "credit_ledger";
CREATE TRIGGER "credit_ledger_append_only" BEFORE UPDATE OR DELETE ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();

CREATE OR REPLACE FUNCTION credit_ledger_grant_free_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO credit_ledger (user_id, kind, credits, ref)
  VALUES (NEW.id, 'free_grant', 1, NEW.id)
  ON CONFLICT ("kind", "ref", (COALESCE("lot_id", 0))) DO NOTHING;
  RETURN NULL;
END $$;

-- Fired only when an account is created verified, or becomes verified; the
-- unique key makes a second verification after an unverify a no-op.
DROP TRIGGER IF EXISTS "users_grant_free_credit" ON "users";
DROP TRIGGER IF EXISTS "users_grant_free_credit_on_insert" ON "users";
CREATE TRIGGER "users_grant_free_credit_on_insert" AFTER INSERT ON "users"
  FOR EACH ROW WHEN (NEW.email_verified_at IS NOT NULL) EXECUTE FUNCTION credit_ledger_grant_free_credit();
DROP TRIGGER IF EXISTS "users_grant_free_credit_on_verify" ON "users";
CREATE TRIGGER "users_grant_free_credit_on_verify" AFTER UPDATE OF "email_verified_at" ON "users"
  FOR EACH ROW WHEN (OLD.email_verified_at IS NULL AND NEW.email_verified_at IS NOT NULL) EXECUTE FUNCTION credit_ledger_grant_free_credit();

DO $$
DECLARE
  v_verified integer;
  v_granted integer;
BEGIN
  SELECT count(*) INTO v_verified FROM users WHERE email_verified_at IS NOT NULL;
  INSERT INTO credit_ledger (user_id, kind, credits, ref)
  SELECT u.id, 'free_grant', 1, u.id FROM users u WHERE u.email_verified_at IS NOT NULL
  ON CONFLICT ("kind", "ref", (COALESCE("lot_id", 0))) DO NOTHING;
  GET DIAGNOSTICS v_granted = ROW_COUNT;
  RAISE NOTICE '[0172] verified accounts=% free credits granted=% already present=%', v_verified, v_granted, v_verified - v_granted;
END $$;
