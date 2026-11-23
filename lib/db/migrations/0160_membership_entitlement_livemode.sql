-- Record the Stripe mode on every provider-backed entitlement source (Issue #454).
--
-- A provider-backed source stored only the Stripe object id, so a membership
-- created in test mode kept granting Legendary after the site switched to live
-- payments, and no live-mode refresh could repair it (the test object does not
-- exist in the live account). Each source now carries the `livemode` of the
-- Stripe object it was verified from; the derivation ignores a source recorded
-- under the other mode. Null for admin grants, which have no Stripe object.
--
-- Existing provider rows are marked test mode (livemode = false): David's
-- launch-plan call that all pre-existing rows are treated as test-mode ("There
-- are no real purchases"; launch-feature-inventory.md F19, PLAN_GET_TO_LAUNCH.md),
-- confirmed 2026-11-23 (Q10, Issue #628: do the cheapest thing). No Stripe re-check.
--
-- Additive and idempotent: the column is added only if missing, and only rows
-- still null are filled, so a second run changes nothing.

ALTER TABLE membership_entitlements ADD COLUMN IF NOT EXISTS livemode boolean;

DO $$
DECLARE
  v_total integer;
  v_filled integer;
  v_already integer;
  v_grants integer;
BEGIN
  SELECT count(*) INTO v_total FROM membership_entitlements;
  SELECT count(*) INTO v_already FROM membership_entitlements
   WHERE provider_ref IS NOT NULL AND livemode IS NOT NULL;
  SELECT count(*) INTO v_grants FROM membership_entitlements WHERE provider_ref IS NULL;

  UPDATE membership_entitlements SET livemode = false
   WHERE provider_ref IS NOT NULL AND livemode IS NULL;
  GET DIAGNOSTICS v_filled = ROW_COUNT;

  RAISE NOTICE '[0160] entitlement sources %: provider rows marked test mode %, already marked (no-op) %, admin grants left null %, failed 0',
    v_total, v_filled, v_already, v_grants;
END $$;
