-- A member's AI picture (launch Phase 7, increment 2; plan
-- docs/plans/PLAN_PHASE7_IMAGE_OFFERING.md §2, approved by David 2026-11-25,
-- Issue #1299). EXPAND only: two credit kinds, three nullable columns, two
-- unique indexes and two guard triggers. Nothing the previous release reads or
-- writes changes meaning; the previous release never writes the new kinds or
-- columns.
--
-- 1. credit_ledger gains two kinds, both naming the lot they move:
--      picture_spend   one credit drawn for a picture; ref = 'picture:<attempt id>'
--      picture_return  the same credit restored to the same lot; same ref
--    (kind, ref, lot) is already unique, so a retried spend or return is a
--    no-op. Both are system writes, so the admin provenance check exempts them.
--
-- 2. image_prompt_attempts.member_request_id: the stable identity of a
--    member's "make a picture" command. Unique per account, so a resent
--    command finds the picture it already made instead of making another.
--    A row with it set is a member's picture; every other attempt
--    (moderation, comparison) has it NULL and is untouched.
--    member_request_fingerprint is a hash of everything the command asked
--    for, so the same request id sent with a different fact, gag, photo, look
--    or subject is refused instead of answered with the first picture.
--
-- 3. user_ai_images gains attempt_id (the picture it delivers; unique, so a
--    picture is delivered once), gag_id and look_style_id (what it drew).
--    Nullable: rows that predate them have none. No backfill: an old row's
--    attempt, gag and look are not recorded anywhere to copy from. gag_id
--    carries no foreign key, as image_prompt_attempts.gag_id does not: a
--    picture outlives its gag's removal, and migration 0139's reverse script
--    drops fact_gags.
--
-- 4. A picture is delivered or returned, never both (plan §2, Astra C7). The
--    application serialises the two on a lock of the attempt row; these two
--    triggers refuse the second one whichever order they come in, so a bug in
--    that path fails loudly instead of handing a member a free picture or
--    taking a credit for nothing.
--
-- 5. user_generation_costs: a cost recorded for an engine request
--    (job_reference_id 'genreq:<image_generation_requests id>') is recorded
--    once, however often the request is collected (plan §2, Astra C10); so is
--    a picture's paid check ('check:<what>:<attempt id>'). The index is
--    partial: no existing row uses either prefix (the gate had no
--    caller before this release), so it cannot fail to build.
--
-- 6. The per-account spend cap becomes a backstop that follows the credits an
--    account was granted (plan §2): one setting, budget_per_credit_ceiling_usd,
--    replaces the per-tier monthly budget_limit_registered_usd,
--    budget_limit_legendary_usd and budget_period, which are deleted. The
--    previous release reads them with code defaults when they are missing.
--
-- Row-state matrix: there is no backfill. Old rows (every existing attempt,
-- user_ai_images row and cost row) keep NULL in the new columns and match no
-- new index predicate; new rows are written only by this release.
--
-- Recovery: restore the previous application code and leave all of this in
-- place; that code neither reads nor writes any of it. The triggers fire only
-- on the new kinds and on rows with attempt_id set.

DO $$ BEGIN
  ALTER TABLE "credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_lot_shape_check";
  ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_lot_shape_check"
    CHECK (((("kind")::text = ANY (ARRAY['free_grant'::text, 'admin_grant'::text])) AND ("lot_id" IS NULL) AND ("credits" > 0))
        OR ((("kind")::text = ANY (ARRAY['admin_debit'::text, 'picture_spend'::text])) AND ("lot_id" IS NOT NULL) AND ("credits" < 0))
        OR ((("kind")::text = 'picture_return'::text) AND ("lot_id" IS NOT NULL) AND ("credits" > 0)));
  ALTER TABLE "credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_admin_provenance_check";
  ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_admin_provenance_check"
    CHECK ((("kind")::text = ANY (ARRAY['free_grant'::text, 'picture_spend'::text, 'picture_return'::text]))
        OR (("actor_label" IS NOT NULL) AND ("note" IS NOT NULL) AND (length(btrim("note")) > 0)));
END $$;

ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "member_request_id" varchar(64);
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "member_request_fingerprint" varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ipa_member_request" ON "image_prompt_attempts" ("user_id", "member_request_id")
  WHERE "member_request_id" IS NOT NULL;

ALTER TABLE "user_ai_images" ADD COLUMN IF NOT EXISTS "attempt_id" bigint;
ALTER TABLE "user_ai_images" ADD COLUMN IF NOT EXISTS "gag_id" bigint;
ALTER TABLE "user_ai_images" ADD COLUMN IF NOT EXISTS "look_style_id" varchar(64);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"user_ai_images"'::regclass AND conname = 'user_ai_images_attempt_id_fk') THEN
    ALTER TABLE "user_ai_images" ADD CONSTRAINT "user_ai_images_attempt_id_fk"
      FOREIGN KEY ("attempt_id") REFERENCES "image_prompt_attempts"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_uai_attempt" ON "user_ai_images" ("attempt_id") WHERE "attempt_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ugc_generation_request" ON "user_generation_costs" ("job_reference_id")
  WHERE "job_reference_id" LIKE 'genreq:%' OR "job_reference_id" LIKE 'check:%';

CREATE OR REPLACE FUNCTION member_picture_refuse_return_after_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- ref is 'picture:<attempt id>'; parsed so the lookup uses UQ_uai_attempt.
  IF NEW.ref ~ '^picture:[0-9]+$' AND EXISTS (
    SELECT 1 FROM user_ai_images u WHERE u.attempt_id = substring(NEW.ref FROM 9)::bigint
  ) THEN
    RAISE EXCEPTION 'a delivered picture''s credit is never returned (%)', NEW.ref USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "credit_ledger_member_picture_return_guard" ON "credit_ledger";
CREATE TRIGGER "credit_ledger_member_picture_return_guard" BEFORE INSERT ON "credit_ledger"
  FOR EACH ROW WHEN (NEW.kind = 'picture_return') EXECUTE FUNCTION member_picture_refuse_return_after_delivery();

CREATE OR REPLACE FUNCTION member_picture_refuse_delivery_after_return() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM credit_ledger c WHERE c.kind = 'picture_return' AND c.ref = 'picture:' || NEW.attempt_id::text
  ) THEN
    RAISE EXCEPTION 'a returned picture is never delivered (attempt %)', NEW.attempt_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "user_ai_images_member_picture_delivery_guard" ON "user_ai_images";
CREATE TRIGGER "user_ai_images_member_picture_delivery_guard" BEFORE INSERT ON "user_ai_images"
  FOR EACH ROW WHEN (NEW.attempt_id IS NOT NULL) EXECUTE FUNCTION member_picture_refuse_delivery_after_return();

INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public)
VALUES ('budget_per_credit_ceiling_usd', '0.30', 'float', 'Engine spend allowed per credit granted (USD)',
        'The backstop on what one account can cost in AI engine charges on record (cost records are kept 13 months): this many dollars for every credit the account has ever been granted. Leaves room for a fallback and a redraw; a returned credit adds nothing.',
        0, 100, false)
ON CONFLICT (key) DO NOTHING;
DELETE FROM admin_config WHERE key IN ('budget_limit_registered_usd', 'budget_limit_legendary_usd', 'budget_period');
