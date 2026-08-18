# PR214 — Stripe Membership Price Allowlist (C6) — UAT

In-app acceptance test for David. This makes **only real membership purchases
grant Legendary**. Before, the server would hand out Legendary for *any*
successful payment — so once you start selling things that aren't membership
(render credits, merch), someone could buy the cheap thing, or craft a request
for any active price, and still get upgraded. Now the server checks that the
product you paid for is explicitly marked as a membership product.

The transient engineering checklist was deleted after execution; see the
[checklist handoff](./CLAUDE_CHECKLIST_HANDOFF_2026-08-09.md) for its recorded
result.

## What changed, in plain terms

"This purchase makes you Legendary" is now decided by a **tag on the product in
Stripe**, not by "did any payment succeed." A product grants Legendary **only**
if it has the metadata **`overhype_membership = true`**. Anything without that
tag is just a normal payment — it takes the money and does **not** upgrade the
tier.

This is enforced everywhere a purchase can grant Legendary: starting checkout,
switching plans, the instant-upgrade on the success page, and the Stripe
webhook.

## One-time setup in Stripe (do this first)

For each **membership** product in Stripe — your monthly plan, annual plan, and
Legendary-for-Life — open the **product** (not the price) in the Stripe
dashboard and add metadata:

```
overhype_membership = true
```

Do this in **both test and live mode** (they're separate catalogs). If a
membership product is missing the tag, buying it will **not** grant Legendary —
so verify all three before considering this live. (This is the intended
fail-closed behavior: no tag = not membership.)

## How to check it (Stripe **test mode**)

1. **Membership still works.** As a registered account, buy your monthly (or
   annual, or Legendary-for-Life) plan with a Stripe test card
   (`4242 4242 4242 4242`). → You land on the profile page as **Legendary**,
   just like today.
2. **Plan switch still works.** As a monthly member, switch to the annual plan.
   → Succeeds and stays Legendary.
3. **A non-membership product does NOT upgrade.** In Stripe test mode, make a
   throwaway product **without** the `overhype_membership` tag (a $1 "test
   item"). Try to check out with its price. → Checkout is **refused** ("not a
   membership plan"); if a payment somehow completes for it, the account stays
   at its current tier — **not** Legendary.
4. **Refund / dispute behavior unchanged.** Refunding a membership purchase
   still downgrades to registered; disputes still revoke — exactly as before.

## What you should NOT see

- A non-membership purchase upgrading anyone to Legendary.
- A membership purchase (with the tag set) **failing** to upgrade — if that
  happens, the product is missing its `overhype_membership = true` tag; add it.
- Any change to refunds, disputes, cancellations, or renewal emails.

## Regression smoke table

| Action (test mode) | Expect |
|--------------------|--------|
| Buy monthly / annual / lifetime (tagged) | Legendary granted, as today |
| Switch monthly → annual (tagged) | Succeeds, stays Legendary |
| Check out an **untagged** product | Refused ("not a membership plan") |
| Untagged payment somehow completes | Tier unchanged (no Legendary) |
| Refund a membership purchase | Downgrade to registered, as today |
| Open a dispute | Legendary revoked, as today |

## Known non-bugs / limitations

- **The `MEMBERSHIP_PRICE_IDS` value in your Replit config is now unused.**
  Nothing reads it anymore — this PR uses the Stripe product tag instead. It's
  harmless to leave, but you may want to **delete it** so it doesn't look like a
  live setting. I left your `.replit` untouched; removing it is your call.
- **Render credits / merch aren't buyable yet.** `POST /stripe/checkout` is
  membership-only for now by design. When we build non-membership purchases,
  they'll get their own flow — and because the tag check lives at the grant
  layer, those purchases will never accidentally grant Legendary.
- **The tag is the source of truth.** Adding a new membership price later just
  means tagging its product `overhype_membership = true` in Stripe — no code
  change, no redeploy.

## If something's wrong

Tell me: which step, what you expected, what happened, and (if a purchase) the
Stripe **test-mode** checkout/session id from the dashboard so I can trace it.
Don't paste live-mode payment ids into chat.
