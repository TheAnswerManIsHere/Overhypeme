# Stripe account identity is embedded in API keys and object IDs

Stripe embeds an account-identifying fragment inside both API keys
(`pk_test_51TGbDF...`, `pk_live_51TGk96...`) and every object ID it issues for
that account (`price_...`, `prod_...`, `cus_...`, etc.), visible as a shared
substring. Two keys, or a key and an object ID, that don't share that fragment
belong to different Stripe accounts; two that do share it belong to the same
one.

This resolved a live/test-account mismatch question during the 2026-07-28
"lifetime-only upgrade" investigation (see
[`decisions.md`](../../docs/ai-context/decisions.md#2026-07-28--the-lifetime-only-upgrade-bugs-real-root-cause-was-a-silently-failed-stripe-sync-not-plan-selection-logic))
without a Stripe API call or a dashboard account-ID lookup: a price ID
surfaced by the app (`price_1TQalNBoYd2wqzWnemSG666D`) shared its
`BoYd2wqzWn` fragment with `STRIPE_PUBLISHABLE_KEY_TEST`
(`pk_test_51TGbDF...`), confirming the app's test key and that price
genuinely belonged to the same Stripe account before trusting any other
diagnosis.

**Related fact, same investigation:** a Stripe **Sandbox** is a fully
separate Stripe account — its own account ID, catalog, and API keys — not a
"mode" toggle within one account the way live/test is elsewhere in this app.
A product of the same name existing in two different Sandboxes (or a Sandbox
vs. the main account's classic test mode) is not the same product. Matching
*names* is not evidence of matching accounts; matching key/ID fragments is.

**Caution:** this is an observed pattern in Stripe's current ID/key format,
not a documented guarantee — reverify if it ever changes.
