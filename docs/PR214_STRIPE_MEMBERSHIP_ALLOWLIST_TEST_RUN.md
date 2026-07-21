# PR214 — Stripe Membership Price Allowlist (C6) — TEST_RUN

Engineering / automated checklist for Replit (the technical safety net). This
PR closes a **price/tier-tampering** hole: checkout accepted any active Stripe
price and the grant paths handed out **Legendary** for any succeeded payment,
never checking *which product* was bought. The fix is a positive allowlist keyed
on the product metadata tag **`overhype_membership=true`**, enforced at every
grant surface (checkout, subscription switch, sync confirm, webhook), single-
sourced in `lib/membershipPricing.ts`, and **fail-closed**.

Sibling doc: [`PR214_STRIPE_MEMBERSHIP_ALLOWLIST_UAT.md`](./PR214_STRIPE_MEMBERSHIP_ALLOWLIST_UAT.md).

## Commands

From `artifacts/api-server`:

```bash
# 1. Full typecheck gate (tsc project refs + import-cycle + no-console guards)
pnpm run typecheck

# 2. The security + grant tests for this change
node --import tsx/esm --test \
  src/__tests__/stripe.checkout.security.test.ts \
  src/__tests__/checkoutConfirm.test.ts \
  src/__tests__/webhookHandlers.integration.test.ts \
  src/__tests__/routes.stripe.test.ts
```

Expected: `typecheck` exits 0 (`[check-cycles] OK`, `[check-no-console] OK`).
The four test files pass with **0 failures** (locally: 41 + 63 across the
security/confirm pair and the webhook/routes pair — counts may shift as sibling
tests evolve; the requirement is **0 fail**).

> Replit owns the DB connection — the `*.integration` and `routes.stripe` files
> run against your test database. Apply migrations as usual; no new schema in
> this PR (this is pure application logic + Stripe product metadata). Dummy
> `STRIPE_*_TEST` keys satisfy the credential guard — none of these tests make a
> live Stripe network call.

## What the tests prove

**`stripe.checkout.security.test.ts`** — the decision predicates, exhaustively:

- `productGrantsMembership`: tagged → grants; untagged / `"false"` / `"1"` /
  `"TRUE"` (case-sensitive) / **deleted product** / **unexpanded id string** /
  `null` / `undefined` → all **deny** (fail closed).
- `paymentIntentIsMembershipTagged`: `membership:"true"` or `plan:"lifetime"`
  → grants; everything else → deny.
- `priceGrantsMembership`: reads an inline-expanded product without a resolver
  call; resolves a bare product id via the injected resolver.
- `subscriptionGrantsMembership`: any membership line-item → grants; all
  non-membership or **empty items** → deny.

**`checkoutConfirm.test.ts`** — the confirm endpoint end-to-end (via injected
fakes, no network):

- Membership subscription / one-time payment still grant (fixtures now carry a
  tagged product / verified stamp).
- **NEW:** an active subscription to a **non-membership** product → `400`, no
  `setMembershipTierToLegendary` call.
- **NEW:** a succeeded one-time payment **not** tagged membership → `400`, no
  tier grant, no lifetime-entitlement insert.

**`webhookHandlers.integration.test.ts` / `routes.stripe.test.ts`** — regression
guard: existing refund/dispute/audit/idempotency behavior and the auth-401
matrix are unchanged.

## Manual schema / SQL checks

None — no migration in this PR. If you want to confirm the runtime boundary,
in **Stripe test mode**:

- Confirm each membership **product** (the ones behind your monthly / annual /
  Legendary-for-Life prices) has metadata **`overhype_membership = true`**.
  Prices inherit membership from their product; the tag lives on the product.
- Any non-membership product (once render credits etc. exist) must **not** carry
  that tag.

## Deliberately NOT shipped

- **No `.replit` edit.** The `MEMBERSHIP_PRICE_IDS` env var is now vestigial
  (no code reads it). Left in place so this PR touches zero deployment config;
  David can delete it at his discretion (see UAT).
- **No new checkout flow for non-membership products.** Render credits / merch
  will get their own purchase path later; `POST /stripe/checkout` is
  intentionally membership-only for now, and the **grant layer** stays the
  authoritative gate regardless of which endpoint initiates a purchase.
- **No live-Stripe route test for `POST /stripe/checkout`.** Per the repo's
  existing convention (`routes.stripe.test.ts` leaves Stripe-call checkout paths
  "as a separate batch" needing a real fixture), the checkout wiring is a
  straight-line call into the exhaustively-tested predicate; the confirm +
  webhook grants are covered end-to-end.
