# PR #214 — Stripe Membership Price Allowlist — UAT

This makes **only real membership purchases grant Legendary**. Before, the
server would hand out Legendary for *any* successful payment — so once we
start selling things that aren't membership (render credits, merch),
someone could buy the cheap thing, or craft a request for any active
price, and still get upgraded. Now the server checks that the product you
paid for is explicitly marked as a membership product.

"This purchase makes you Legendary" is now decided by a **tag on the
product in Stripe**, not by "did any payment succeed." A product grants
Legendary **only** if it has the metadata **`overhype_membership = true`**.
Anything without that tag is just a normal payment — it takes the money
and does **not** upgrade the tier. This is enforced everywhere a purchase
can grant Legendary: starting checkout, switching plans, the
instant-upgrade on the success page, and the Stripe webhook.

## Setup

- [david] In the Stripe dashboard, open each membership product (monthly
  plan, annual plan, Legendary-for-Life) — not the price — and add the
  metadata `overhype_membership = true`. Do this in both **test** and
  **live** mode; they're separate catalogs. A membership product missing
  the tag will not grant Legendary when bought.

## Steps

### 1. Membership purchase still works

**Do:** As a registered account, buy your monthly (or annual, or
Legendary-for-Life) plan with the Stripe test card `4242 4242 4242 4242`.

**Expect:** you land on the profile page as **Legendary**, just like
today.

### 2. Plan switch still works

**Do:** As a monthly member, switch to the annual plan.

**Expect:** the switch succeeds and you stay Legendary.

### 3. A non-membership product refuses checkout

**Do:** In Stripe test mode, create a throwaway product **without** the
`overhype_membership` tag (a $1 "test item") and try to check out with
its price.

**Expect:** checkout is **refused** ("not a membership plan").

### 4. A non-membership payment that completes anyway does not upgrade

**Do:** If a payment for the untagged test item from step 3 somehow
completes, check that account's tier.

**Expect:** the account stays at its current tier — **not** Legendary.

### 5. Refund still downgrades

**Do:** Refund a membership purchase.

**Expect:** the account downgrades to registered, exactly as before.

### 6. A dispute still revokes

**Do:** Open a dispute on a membership purchase.

**Expect:** Legendary is revoked, exactly as before.

## Regression

### R1. Buy a tagged membership product

**Do:** Buy monthly, annual, or lifetime (tagged with
`overhype_membership = true`).

**Expect:** Legendary granted, as today.

### R2. Switch between tagged membership plans

**Do:** Switch monthly → annual (both tagged).

**Expect:** succeeds, stays Legendary.

### R3. Check out an untagged product

**Do:** Check out a product without the `overhype_membership` tag.

**Expect:** refused ("not a membership plan").

### R4. An untagged payment somehow completes

**Do:** Let an untagged payment complete outside the normal checkout
flow.

**Expect:** tier unchanged (no Legendary).

### R5. Refund a membership purchase

**Do:** Refund a membership purchase.

**Expect:** downgrade to registered, as today.

### R6. Open a dispute

**Do:** Open a dispute on a membership purchase.

**Expect:** Legendary revoked, as today.

## Not bugs

- **The `MEMBERSHIP_PRICE_IDS` value in your Replit config is now
  unused.** Nothing reads it anymore — this PR uses the Stripe product
  tag instead. It's harmless to leave, but you may want to **delete it**
  so it doesn't look like a live setting. `.replit` was left untouched;
  removing it is your call.
- **Render credits / merch aren't buyable yet.** `POST /stripe/checkout`
  is membership-only for now by design. When non-membership purchases are
  built, they'll get their own flow — and because the tag check lives at
  the grant layer, those purchases will never accidentally grant
  Legendary.
- **The tag is the source of truth.** Adding a new membership price later
  just means tagging its product `overhype_membership = true` in Stripe —
  no code change, no redeploy.
- **If a tagged membership purchase fails to upgrade,** the product is
  missing its `overhype_membership = true` tag — that's a setup gap in
  Stripe, not a code bug. Add the tag.
