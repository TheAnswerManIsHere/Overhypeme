# Stripe payments integration — audit brief

> **Purpose.** David is commissioning a full review of the payment platform
> integration. It was originally built by Replit with no external code review;
> this brief is the starting point so a fresh session doesn't re-derive what
> one session already established. Written 2026-07-28, after a Stripe
> catalog-display investigation that ran four Codex review rounds.
>
> **Read this first, then read the code.** Everything below marked **verified**
> was read in the source at the cited line; everything marked **unexamined** is
> honest ignorance, not a clean bill of health.
>
> **The audit this brief commissioned has since run.** Its results are in
> [`stripe-payments-audit-findings.md`](./stripe-payments-audit-findings.md).
> **Read the findings first** — they correct five things below, listed in that
> document's *Corrections to the brief* section and flagged inline here. This
> brief remains useful as the scope map and the history; it is no longer the
> current picture of risk.

---

## The one-paragraph history

A customer-facing bug — *"the upgrade page only shows the $99 Forever option"* —
was "fixed" twice without being fixed. **PR #255** correctly changed plan
classification to read each price's own `recurring` field; **PR #260**
correctly centralised the membership predicate. Both were real improvements to
the wrong thing. The actual cause was a **silently failed Stripe sync**: the
sandbox held three products, the synced catalog held one, and re-running the
sync fixed it in 1.3 seconds. It stayed invisible because the admin Billing
page rendered sync errors only *during* a run — after a reload the persisted
error was fetched and discarded, leaving a display that read like success.
**PR #276** fixes that visibility defect. Everything else remains open.

The important lesson for the audit: **two correct fixes to a real defect can
both miss the cause, and the system will not tell you.** Assume that pattern
recurs elsewhere in this integration.

---

## Scope check — how much of the payments surface has actually been reviewed

| Area | Lines | Reviewed? |
|---|---|---|
| `routes/stripe.ts` (14 endpoints) | 658 | **~2 endpoints.** `/stripe/plans` and `/stripe/checkout` only |
| `artifacts/api-server/src/lib/webhookHandlers.ts` | 1,197 | **No.** Largest single payments file, entirely unexamined |
| `artifacts/api-server/src/lib/stripeSyncRunner.ts` | 558 | Mostly — lock, status, `cleanStaleAccountData` |
| `artifacts/api-server/src/lib/membershipGrant.ts` | 355 | **No.** Signatures only |
| `artifacts/api-server/src/lib/stripeStorage.ts` | 172 | `listProductsWithPrices` only |
| `artifacts/api-server/src/lib/stripeClient.ts` | 114 | Yes |
| `artifacts/api-server/src/lib/membershipPricing.ts` | 106 | Yes — the allowlist |
| `artifacts/api-server/src/lib/checkoutIdempotency.ts` | 33 | **No.** |

**Roughly 15% of the payment code has been read.** The reviewed part is the
*catalog display* path. **The money path — webhooks, grants, refunds, portal,
cancellation, receipts — is essentially unaudited**, and it is where
unreviewed Replit-built logic is most consequential.

### Endpoints, and their review status

`routes/stripe.ts`:

| Line | Endpoint | Auth | Reviewed |
|---|---|---|---|
| 23 | `GET /stripe/config` | public | no |
| 34 | `GET /stripe/plans` | **public** | **yes** |
| 45 | `GET /stripe/subscription` | authed | no |
| 82 | `POST /stripe/checkout` | authed | **yes** |
| 209 | `GET /stripe/payment-history` | authed | no |
| 222 | `GET /stripe/invoice/:invoiceId/receipt` | authed | **no — check IDOR** |
| 253 | `GET /stripe/membership` | authed | no |
| 265 | `GET /stripe/access-revocation-notice` | authed | no |
| 290 | `POST /stripe/checkout/confirm` | authed | **no — grant surface** |
| 344 | `POST /stripe/portal` | authed | no |
| 390 | `POST /stripe/subscription/cancel` | authed | no |
| 441 | `POST /stripe/subscription/reactivate` | authed | no |
| 496 | `GET /stripe/subscription/switch-preview` | authed | partly |
| 581 | `POST /stripe/subscription/switch-plan` | authed | partly |

Plus admin routes in `routes/admin.ts` (`/admin/stripe/summary`, `/sync`,
`/full-sync`, `/sync/status`, `/sync/_test/simulate`, `/test-event`) and the
webhook endpoint.

### Tables (`lib/db/src/schema/memberships.ts`)

`subscriptions`, `lifetime_entitlements`, `membership_history`,
`stripe_processed_events`, `stripe_webhook_audit`,
`stripe_checkout_request_ledger` — plus the entire `stripe.*` schema owned by
the sync library. **Only the last was examined.** The presence of
`stripe_processed_events` and a checkout request ledger suggests idempotency
was thought about; whether it is *correct* is unverified.

---

## What is verified good

Worth stating plainly, because an audit should know where not to spend effort.

**The membership grant gate is well designed.** `membershipPricing.ts` is a
positive allowlist on the Stripe **product**'s `overhype_membership=true`
metadata, and it **fails closed** on every ambiguous input — unexpanded id
string, deleted product, missing metadata, non-`"true"` value. It is enforced
at all three grant surfaces (checkout, the confirm endpoint, the webhook)
rather than at checkout alone, and cancellation is symmetric so a future
non-membership subscription can't downgrade a real member. 21 tests in
`stripe.checkout.security.test.ts` cover the fail-closed paths.

The design rationale is already documented in
[`security-model.md`](./security-model.md)'s *Payment trust — membership grants
(C6)* section, including why the confirm endpoint reads Checkout Session line
items rather than the mutable PI metadata stamp. **Do not "simplify" this.**
It is the strongest part of the integration.

---

## Verified defects, open and unfixed

Each was read in the source. All except the last were surfaced during the
plan-review loop on **PR #274** (closed unmerged); the full specification for
fixing them, with four rounds of Codex findings resolved, is preserved at
commit `07983fa` on branch `plan-review/stripe-billing-catalog-legibility`.

### Customer-visible

1. **`/api/stripe/plans` is not scoped to the connected Stripe account.**
   `listProductsWithPrices` (`stripeStorage.ts:122-169`) filters on `active` and
   `livemode` only, never `_account_id`. `cleanStaleAccountData`
   (`stripeSyncRunner.ts:247`) purges other accounts' rows **only after a fully
   successful sync** and is skipped entirely if any resource throws. So between
   a key switch and the next clean sync, the pricing page can advertise a
   previous account's prices.

   **The harm is a dead CTA, not a wrongful grant.** `POST /stripe/checkout`
   calls `stripe.prices.retrieve()` at `:120` — *before* the membership
   predicate at `:136` — so a cross-account price throws `resource_missing`
   into the generic catch. The customer clicks and gets an opaque failure. The
   grant layer's fail-closed design does not cover this, because the failure
   happens earlier.

2. **The plan selector can only ever express three plans.**
   `selectPlanPrices` (`pricingPlans.ts:24-31`) does three `.find()` calls over
   a flattened price list. Consequences: duplicate one-time prices → one
   renders; `interval_count` ignored, so **quarterly** (`interval: "month",
   interval_count: 3`) collides with the monthly slot and can beat it; any
   other cadence (weekly) matches nothing and vanishes.

3. **Both money formatters divide by 100 unconditionally**
   (`Pricing.tsx:132-134`, `subscriptionHelpers.ts:33-35`). A zero-decimal
   currency renders 100× wrong — ¥500 as ¥5.

4. **`switch-preview` / `switch-plan` hardcode monthly→annual**
   (`routes/stripe.ts:622-626`), and the persisted plan value is hardcoded
   `annual`. Members already on any other cadence cannot use the flow at all.

5. **`Pricing.tsx:328` renders a hardcoded `"$3.99"`** when no monthly and no
   annual price exists. The card header is not gated on `plansLoading`, so it
   shows on **every** page load during the fetch, and persists whenever the
   fetch fails or only a lifetime price exists. A price that exists in no
   catalog, shown to customers.

6. **`getAnnualSavingsPercent` and `findAnnualPriceId` disagree.** The former's
   fallback takes the **last** match, the latter's the **first**, so on a
   two-product catalog the savings badge can be computed from a different
   product than the price being offered. Both treat `unit_amount: 0` as
   missing.

### Operational / admin

7. **The mode toggle can leave "mode switched, nothing synced."**
   `routes/admin.ts:2313-2344` writes the config row, then calls
   `runFullSync(sync)` and **discards its return value**. If a sync already
   holds the in-process lock, `alreadyRunning` comes back, is dropped, and no
   target-mode sync is ever queued. A pre-check on `isSyncRunning()` does not
   fix it — that's a read, and the config write is an `await`, so a sync can
   take the lock in between. **Sharpened by the audit, corrected in round 2 of
   PR #278's review:** the call is also not `await`ed, but this does **not**
   produce an unhandled rejection — `runFullSync` is synchronous and its
   actual work runs in a `void` async IIFE that swallows and logs its own
   failures internally, so it can never reject and the enclosing `try/catch`
   was never at risk. See the findings doc's Finding 7 for the corrected
   mechanism.

8. **The admin Billing page classifies prices with no membership filter**
   (`billing.tsx:480-483`), and the Setup Checklist's *"Membership prices
   available"* row is an **OR** across three slots. One lifetime price — or a
   future merch SKU — makes it read green on a catalog the upgrade page can't
   sell.

9. **The membership tag is invisible in the app.** Nothing renders it and
   nothing in the codebase *writes* it — it is hand-set in the Stripe
   dashboard, so a mis-tagged product is indistinguishable from a correct one.

10. **`GET /stripe/plans` swallows every error into `{ plans: [] }`**
    (`routes/stripe.ts:38-40`, bare `catch`), so a DB failure and a genuinely
    empty catalog are indistinguishable — to customers *and* to admin.

11. **The e2e spec's locators had silently rotted.** It filtered on
    `span.font-medium.w-20` while the page renders `w-32`, so `progressRow`
    matched nothing and `statusTextFor` returned `""` rather than failing.
    Fixed in PR #276 by anchoring on `data-testid`. **Treat this as a signal
    about class-signature locators generally**, not a one-off.

---

## Things the audit should check that nobody has looked at

Ordered by my guess at risk. All are **unverified** — these are the questions,
not findings.

1. **Webhook handling (1,197 lines, unread).** Signature verification on every
   path? Is `stripe_processed_events` actually consulted before granting, and
   is the check atomic against concurrent deliveries of the same event? What
   happens on out-of-order delivery — `customer.subscription.deleted` arriving
   before `.created`? Are unhandled event types logged or silently dropped?
   Does a handler throw *after* a partial DB write?

2. **`POST /stripe/checkout/confirm` (`:290`).** A synchronous grant surface
   that races the webhook for the same purchase. Both can grant. Is that
   idempotent, and does it converge if they interleave?

3. ~~**`GET /stripe/invoice/:invoiceId/receipt` (`:222`).** An id in the path
   returning a financial document. **Verify the ownership check** — this is the
   classic IDOR shape.~~ **Resolved by the audit — not a defect.**
   `receiptHandler.ts:29-49` compares the invoice's customer against the
   caller's `stripeCustomerId` and returns 403 on mismatch. This item was
   over-ranked at #3.

4. **`POST /stripe/portal` (`:344`).** The Stripe Customer Portal can let users
   cancel, switch plans, and update payment methods *outside* our flows,
   bypassing the `overhype_membership` allowlist entirely. What is the portal
   configuration, and does the webhook correctly reconcile changes made there?

5. **Cancel / reactivate (`:390`, `:441`).** Is access revoked at period end or
   immediately? Does `lifetime_entitlements` correctly survive a subscription
   cancellation? Can reactivate resurrect an entitlement it shouldn't?

6. **`checkoutIdempotency.ts` (33 lines) and the request ledger.** The
   `resolveCheckoutRequestKey` scheme keys on `userId + priceId +
   clientRequestId`, and the checkout route reuses an existing session's URL if
   found. Can a client force a new session by varying `clientRequestId`, and
   does that matter? What happens if the stored session has expired?

7. **Refunds and disputes.** There is an admin page (`admin/refundsDisputes.tsx`)
   and none of it was examined. Does a refund or chargeback revoke Legendary?
   **Partly answered by the audit.** The webhook side is not a void —
   `handleChargeRefunded:321` plus four dispute handlers exist and a refund
   *does* revoke. The real defect is that it revokes too eagerly: see finding 2
   in the findings doc. The admin page remains unread.

8. **Money handling generally.** Currency is stored per price but no code path
   reviewed treats it as meaningful. Proration on plan switch. Tax — is any
   configured? SCA / 3DS — does the confirm path handle
   `requires_action`?

9. **The sync library itself.** `stripe-replit-sync@1.0.0` is a **pinned
   third-party package that runs DB migrations at boot**
   (`api-server/src/index.ts:72`) and owns the entire `stripe.*` schema. It is
   not in our repo and not covered by our tests. Who maintains it? What is the
   upgrade story? A migration it ships runs against production automatically.
   **Re-ranked #1 by the audit.** This is understated at #9: the package also
   performs the *only* webhook signature verification
   (`webhookHandlers.ts:1122` delegates to `sync.processWebhook`), so the trust
   boundary gating every membership grant lives inside it. Still the largest
   unexamined area.

10. **Test coverage gaps.** `Pricing.tsx` and `SubscriptionPanel.tsx` have **no
    component tests**. No e2e covers the customer `/pricing` page at all. The
    only payments e2e is the admin sync panel.

---

## Facts worth not re-deriving

Small things that cost time to establish.

- **`hashApiKey` is exported by `stripe-replit-sync`**
  (`dist/index.d.ts:383-385`) — a plain SHA-256 hex digest. Don't reimplement.
- **`stripe.accounts` has one writable column, `_raw_data`.** `id`,
  `business_name`, `email`, `country`, `default_currency`, `charges_enabled`,
  `payouts_enabled`, `details_submitted` are all **generated**. Insert via
  `_raw_data` only.
- **`api_key_hashes`** is a GIN-indexed `TEXT[]`, union-appended, so test and
  live keys for one account coexist. It makes "which account does this key
  belong to?" answerable **without a Stripe API call** — but note
  `getAccountId()` caches **only on success** and coalesces nothing, so exposing
  it on an unauthenticated path needs single-flight and a negative cache.
- **A Stripe Sandbox is a separate account, not a mode.** Live and test here
  are genuinely different accounts.
- **`readSyncStatus` maps over `SYNC_RESOURCES`** and defaults every absent row
  to `idle`, so a fresh install returns eight idle resources. **All-idle is the
  never-synced state** — any gate keyed on "has a non-idle resource" hides it.
- **`startedAt` / `finishedAt` / `durationMs` come from an in-process lock**
  and are `null` after a restart. Derive "last synced" from per-resource
  `lastSyncedAt` instead.
- **`MEMBERSHIP_PRODUCT_METADATA_KEY` is deliberately duplicated** —
  `membershipPricing.ts:21` (backend) and `lib/stripePlans.ts:28` (frontend),
  because the frontend can't import backend code. Both are documented as
  mirrors. Not a bug.

---

## How to run this audit

Recommended shape, based on what worked and what didn't last time:

1. **Read the money path before touching anything.** `webhookHandlers.ts`,
   `membershipGrant.ts`, and the confirm endpoint, in that order. That's
   ~1,600 lines and it is where the risk is.
2. **Audit first, plan second.** Last session's mistake was planning a fix
   before the surface was understood; the plan then tripled across four review
   rounds, largely from discovering things an audit would have found up front.
   Produce a findings list, get David's call on which findings are worth
   fixing, *then* plan.
3. **Use the Codex loop on the findings, not on a big plan.** It was
   excellent at finding real defects — 19 findings, all real — and poor as a
   scope advisor. Give it small, concrete artifacts.
4. **Expect the phase-boundary trap.** Three of round 4's five findings on
   PR #274 were caused by a restructuring made in response to round 3. When
   splitting work, check that each piece is safe if the others never land.
5. **Security review belongs on Opus** per the tier table, and this is
   payments — the deciding question ("would Codex's review or David's product
   testing catch this?") answers *no* for most of what's listed above.

## Related reading

- [`security-model.md`](./security-model.md) — *Payment trust — membership
  grants (C6)*, the authoritative description of the grant gate.
- [`decisions.md`](./decisions.md) — the PR #255/#260 plan-classification
  decision, and the entry recording that the real cause was a failed sync.
- [`known-failure-patterns.md`](./known-failure-patterns.md) — *Stripe plan
  selection: classify by price identity, not product identity*, and the
  admin-progress-panel visibility pattern.
- **PR #274** (closed unmerged) — plan file at `07983fa` on
  `plan-review/stripe-billing-catalog-legibility`, with all 19 findings and
  their resolutions. The best available specification for defects 1–10 above.
- **PR #276** — the visibility fix that shipped.
