# Stripe billing: make the catalog legible, and sell every plan in it

*Two phases. Phase 1 is admin legibility plus one data-scoping fix. Phase 2 is
customer-facing.*

---

## Context

The upgrade page showed only the $99 "Forever" option for months. It was "fixed"
twice — PR #255 (classify prices by their own `recurring` field) and PR #260
(centralise the membership predicate) — and the symptom survived both, because
neither was the cause.

**The cause was a silently failed sync.** The Stripe sandbox held all three
products; the app's synced catalog held one. Re-running the sync pulled all three
in 1.3 s with no other change. Credentials were correct throughout.

**Why it stayed invisible for four rounds of investigation — the core defect:**
`readSyncStatus` (`stripeSyncRunner.ts:485-558`) always returns all eight
resources with their persisted `status` and `errorMessage`, `'error'` included,
and `billing.tsx` already fetches it on mount (`:304-310`). But the progress panel
renders only when `syncing || syncFinalMessage || syncStatus?.inProgress`
(`billing.tsx:685`). After a page reload all three are false, so **a failed sync's
error is fetched into component state and then discarded unrendered.** What
remains on screen — *"1 product found · Last synced: 10m ago"* — reads exactly
like success. The failure was recorded, retrievable, and unshown.

Three further gaps compound it:

1. **The Setup Checklist reports green on a one-plan catalog.** The row
   *"Membership prices available (monthly, annual, or legendary for life)"*
   (`billing.tsx:779-782`) is an **OR** across three slots computed at `:480-483`
   from the **entire** catalog — the admin page imports neither copy of the
   `overhype_membership` allowlist. One lifetime price satisfies it, and a
   non-membership SKU would satisfy it too.
2. **The membership tag is invisible.** The Plans list (`:741-764`) renders name,
   description, and prices but no metadata, and nothing in the codebase *writes*
   the tag — it is hand-set in the Stripe dashboard, so a mis-tagged product is
   indistinguishable from a correct one.
3. **`selectPlanPrices` can only ever express three plans**, and silently drops
   anything else — see Phase 2.

### What exploration corrected in the draft

Recorded because each changes the work, and Phase 1's riskiest assumptions are
now verified rather than assumed:

- **`hashApiKey` must not be re-implemented.** `stripe-replit-sync` **exports**
  it (`dist/index.d.ts:383-385`; `createHash("sha256").update(key).digest("hex")`
  at `dist/index.js:522-526`). Import it. The draft's "duplicate it locally with a
  pointer comment" would have added a needless copy of a security-relevant
  primitive.
- **`api_key_hashes` migration 0047 is the *library's*, not the app's.** It ships
  in `stripe-replit-sync/dist/migrations/0047_api_key_hashes.sql` and runs at boot
  (`api-server/src/index.ts:72`). The app's own `lib/db/migrations/0047_*` is an
  unrelated index fix. **No app migration is part of this work.**
- **`stripe.accounts`' writable column is `_raw_data` only.** `id` is a generated
  column (library migration `0050`), as are `business_name`, `email`, `country`,
  `charges_enabled`, `payouts_enabled`, `details_submitted`. Reads are cheap;
  writes are the library's job.
- **`listProductsWithPrices` has exactly one call site**
  (`routes/stripe.ts:37`) — the draft's "all four consumers go through it" meant
  the four *frontend* consumers of `/api/stripe/plans`. Still a single choke
  point, which is what §1.6 depends on.
- **`/stripe/plans` swallows all errors into `{ plans: [] }`**
  (`routes/stripe.ts:38-40`, bare `catch`). This is a live hazard for §1.6: a
  throw in new account-resolution code would blank the public pricing page
  *silently*. §1.6 must handle this explicitly.
- **`readSyncStatus`'s `startedAt`/`finishedAt`/`durationMs` are null after a
  server restart** — they come from the in-process lock (`:551-557`), not the DB.
  §1.1's summary line must be built from per-resource `lastSyncedAt`.
- **The e2e spec is brittle by construction** — `adminBillingSync.spec.ts` anchors
  on Tailwind class signatures (`div.flex.items-center.gap-2.text-xs.flex-wrap`,
  `span.font-medium.w-20`) with no `data-testid` anywhere, and asserts the exact
  banner copy `/^Sync complete —/` and the plans-header layout. §1.1 and §1.4
  change precisely that region.
- **The pure-module exemplar is wrong.** `taxonomyHealthCards.ts` has **no test
  file**. The real pattern is
  `components/admin/moderationQueueState.ts` + `.test.ts`.
- **Two more Phase 2 defects than the draft names**, both in
  `subscriptionHelpers.ts`: `getAnnualSavingsPercent`'s fallback takes the **last**
  match while `findAnnualPriceId` takes the **first**, so on a two-product catalog
  the badge can be computed from a different product than the price being offered;
  and its `if (!monthlyAmount || !annualAmount)` guard treats a legitimate
  `unit_amount: 0` as missing.
- **The savings math exists twice.** `Pricing.tsx:127-130` reimplements
  `getAnnualSavingsPercent`'s formula in dollars where the helper uses cents.
- **The `"$3.99"` fallback is worse than described.** Its card header
  (`Pricing.tsx:314-332`) is **not** gated on `plansLoading` (unlike the picker at
  `:353`), so `$3.99/month` renders on every page load during the fetch, and
  persists whenever the fetch fails or only a lifetime price exists.

---

## Phase 1 — Make billing state legible, and scope the catalog to its account

### 1.1 Always render persisted sync status *(the core defect)*

Change the `billing.tsx:685` gate so the per-resource panel renders whenever
`syncStatus` has any non-idle resource, not only during a run. The data is
already in state from the mount fetch — this is a render-condition fix plus an
honest summary line, not new plumbing.

- An errored resource shows its `errorMessage` on load, using the existing label
  ladder at `:711-721`.
- The summary line distinguishes *"synced N minutes ago, all green"* from *"last
  run failed — N products may be stale"* from *"never synced."* Built from
  per-resource `lastSyncedAt` (the existing `Math.max` IIFE at `:643-656`), never
  from `finishedAt`, which is null after a restart.
- Per [`async-ui-status.md`](../ai-context/async-ui-status.md): failed, partial,
  and never-ran are distinct states, never collapsed into one quiet line, and
  never rendered as a spinner.

**Add `data-testid` hooks to the sync panel and plans header as part of this**,
and migrate the e2e spec's class-signature locators onto them. §1.1 and §1.4
rewrite the region the spec grips by Tailwind class; re-anchoring it is cheaper
than re-deriving the selectors, and it stops being brittle.

### 1.2 Connected-account identity

Account ID, business name, email, country, and the three
capability booleans (`charges_enabled`, `payouts_enabled`, `details_submitted`)
for the account the **current secret key** resolves to — plus whether the synced
catalog belongs to that account (match / mismatch / not-yet-resolved).

Resolved with **no Stripe API call**: `hashApiKey(secretKey)` from
`stripe-replit-sync`, looked up against `stripe.accounts.api_key_hashes`
(GIN-indexed, union-appended by the library's `upsertAccount`, so test and live
keys for one account coexist). This is what makes two Stripe environments
distinguishable from inside the app — live and test here are genuinely different
accounts, because the test key is a Sandbox key.

> **Not-yet-resolved is a first-class state, not a spinner.** No account row
> exists until a sync has run once; render it as an actionable amber "run a sync."
> Also note `_raw_data` is only refreshed on the library's Stripe-API fallback
> branch, so the panel labels these fields as *last synced* values, not live ones.

### 1.3 What customers can actually buy

Enumerate **every** membership price in the catalog — not three fixed slots — via
`selectMembershipOffers` (§2.1), and flag any the pricing page cannot render.
Each entry resolves to one of:

| State | Meaning | Action named |
|---|---|---|
| `sellable` | tagged product, renderable by the pricing page | none |
| `untagged_product` | price exists, product lacks `overhype_membership=true` | "tag *&lt;product&gt;* in Stripe" |
| `unrenderable` | tagged and valid, but the pricing page drops it | resolved by Phase 2 |

`untagged_product` is derived by classifying the **unfiltered** catalog and then
asking whether the owning product passed the allowlist — the case the current UI
cannot express at all.

`unrenderable` is deliberately built even though Phase 2 removes it (David,
2026-07-28): between the two PRs it is the only thing that stops admin reporting
a quarterly or duplicate one-time price as `sellable` while the pricing page
silently drops it. Phase 2 deletes one branch and its test case.

### 1.4 Prominent warning + per-product badges

An amber banner naming what customers will actually see and the specific next
action, and a `membership` / `not sellable` badge on each product in the existing
Plans list (`billing.tsx:741-764`) — the first time the tag is visible anywhere.

### 1.5 Honest Setup Checklist

Replace the OR-across-slots row (`:779-782`) with allowlist-filtered coverage
derived from §1.3, so it cannot read green on a catalog the upgrade page can't
sell. This also removes the admin page's unfiltered `:480-483` classification,
whose only remaining consumer is the Active Price Mapping block (`:986-1018`) —
repoint it at the offer list.

### 1.6 Scope `/api/stripe/plans` to the connected account

`listProductsWithPrices` filters only on `active` + `livemode`, never
`_account_id`. `cleanStaleAccountData` purges other accounts' catalog rows only
**after a fully successful sync** (`stripeSyncRunner.ts:386`, skipped entirely if
any resource throws) — so between a key switch and the next success, the public
pricing page can advertise a previous account's prices, which checkout then
rejects at the grant layer. Add the `_account_id` filter at its single call site's
choke point.

Two hazards this must not create:

> **Deliberate deviation, flagged for review.** When the account can't be resolved
> (no `stripe.accounts` row — possible on a catalog synced before the library
> added `api_key_hashes`), serve **unfiltered** and surface a red "catalog not
> account-scoped" state in admin, rather than blanking a working public pricing
> page on an unknown-but-not-wrong condition.

> **The silent catch must not swallow this.** `routes/stripe.ts:38-40` currently
> turns *any* throw into `{ plans: [] }`. Account resolution goes in its own
> `try`/`catch` that degrades to unfiltered, and the outer bare `catch` gains a
> `logger.error` so a blanked pricing page is diagnosable at all. Without this,
> a resolution bug is a silently blank pricing page — the same invisible-failure
> class this plan exists to fix.

---

## Phase 2 — Sell every plan in the catalog

`selectPlanPrices` (`pricingPlans.ts:24-31`) uses `.find()` across three fixed
slots over a flattened price list. Three consequences, all the same failure class
as the original bug — a correctly-tagged price that never reaches the customer:

- **Duplicates are dropped.** Two one-time prices ($99 Life, $79 promo) → one
  renders, whichever the `ORDER BY p.id, pr.unit_amount` SQL returns first.
- **`interval_count` is ignored.** Quarterly is `interval: "month",
  interval_count: 3`, so it matches the *monthly* slot and can beat the real
  monthly depending on product-id ordering.
- **Other cadences vanish.** `interval` is typed as a loose `string`; a weekly
  price is not `month`, not `year`, and has a truthy `recurring`, so it misses all
  three slots.

### 2.1 `selectMembershipOffers` — replaces the three-slot model

Returns an **ordered list** of offers, each carrying price id, amount, cadence
(`interval` + `interval_count`), a normalised **monthly-equivalent** amount, and a
display label. Keeps the `overhype_membership` allowlist unchanged, imported from
`@/lib/stripePlans`.

- **Ordering:** ascending monthly-equivalent, one-time last. Deterministic —
  tie-break on price id, never on SQL row order.
- **Labels:** derived from cadence (`1/month` → "Monthly", `3/month` →
  "Quarterly", `1/year` → "Annual", one-time → "Forever"), with a generic
  fallback ("Every 6 months", "Weekly") so no cadence is ever unlabelled.
- **Savings badge:** against the highest monthly-equivalent recurring offer,
  replacing both today's hardcoded monthly-vs-annual comparisons —
  `Pricing.tsx:127-130` and `getAnnualSavingsPercent`. Treats `unit_amount: 0` as
  a real amount, not as missing.
- **Featured:** best monthly-equivalent recurring offer; one-time stays visually
  distinct as it is today.

**`selectPlanPrices` is deleted, not kept as a wrapper.** The draft proposed
keeping it "until callers migrate," but Phase 2 migrates both of its callers, so
the wrapper would survive with zero production consumers, kept alive only by its
own tests — dead code that `/simplify` and Codex would both flag. Its four
regression cases (product carrying all three prices; a product named "forever"
not swallowing its recurring prices; non-membership products ignored) are ported
into `membershipOffers.test.ts` as equivalent assertions, so the regression net is
preserved rather than dropped.

### 2.2 Pricing page renders N offers

Desktop (`Pricing.tsx:194-253`, three bespoke buttons) and mobile
(`:356-397`, `PricingCard`) both become offer-driven `.map()`s. Mobile keeps the
sticky CTA, repointed at the featured offer — its current `monthly ?? annual ??
lifetime` order (`:411`) is documented as "the cheapest checkout" but is a fixed
preference, not a comparison. Beyond ~4 offers the list scrolls rather than
shrinking cards below a legible size. The dead `md:grid-cols-*` classes at `:356`
(inside an `md:hidden` wrapper) and the triple `.filter(Boolean).length`
recomputation go with the rewrite.

### 2.3 Mobile layout — remove the duplicated offer *(David, observed in-app)*

With all three plans finally rendering, the mobile layout repeats itself. Fixed as
part of the same rewrite, since it is the same code:

- **The price is stated three times in one viewport** — the Legendary comparison
  card header (`:323-330`), the Monthly `PricingCard` (`:357-366`), and the sticky
  CTA (`:410-430`).
- **The Legendary card and the plan picker sell the same thing twice.** The card
  carries a price plus the five `LEGENDARY_FEATURES`; "Choose Your Plan" directly
  below re-states the prices. Desktop is already correct — its left column is
  pitch-only and the picker appears once. Bring mobile to that shape: the
  comparison card states the *value proposition* (Free vs Legendary), the picker
  owns *price*, the sticky CTA owns the *action*.
- **Kill the hardcoded `"$3.99"` fallback** (`:328`). It renders on every page
  load during the fetch (the header, unlike the picker, is not gated on
  `plansLoading`), and persists whenever the fetch fails, only a lifetime price
  exists, or every product failed the membership filter — displaying a price that
  exists in no catalog. Same failure family as the bug that started this: UI
  asserting something the data doesn't support. Render the value proposition
  without a price. The mirrored `$0/forever` on the Free card (`:301`) is
  genuinely static and stays.

### 2.4 `SubscriptionPanel` switch flow

`findAnnualPriceId` / `getAnnualSavingsPercent` (`subscriptionHelpers.ts:41-90`)
become offer-based, so "switch to annual" generalises to "switch to a
longer-cadence offer" and can't be silently wrong when a quarterly plan exists.
This also closes the first-vs-last asymmetry between the two helpers' fallback
paths and the `unit_amount: 0` guard, both noted above. `SubscriptionPanel.tsx`'s
locally re-declared `PlanPrice`/`PlanProduct` (`:45-58`) are replaced with the
shared types from `@/lib/stripePlans`, which they duplicate structurally today.

---

## Files

**New (pure + unit-tested — mirroring `components/admin/moderationQueueState.ts`
+ `.test.ts`, the actual pure-module-with-test exemplar):**
- `artifacts/overhype-me/src/lib/membershipOffers.ts` + `.test.ts` — §2.1.
  Imports `filterMembershipPlans` from `@/lib/stripePlans`; declares no membership
  logic of its own.
- `artifacts/overhype-me/src/pages/admin/stripeHealth.ts` + `.test.ts` — §1.3.

**Backend:**
- `stripeStorage.ts` — `getConnectedAccount()`; `_account_id` filter in
  `listProductsWithPrices`. Imports `hashApiKey` from `stripe-replit-sync`.
- `routes/stripe.ts` — §1.6's scoped resolution and the `logger.error` in the
  previously-bare catch.
- `routes/admin.ts` — extend `/admin/stripe/summary` (`:2543-2596`) with
  `connectedAccount` + `catalogAccountMatch`. **Identity and booleans only —
  never echo a key value**, matching the endpoint's existing `stripeEnv`
  precedent at `:2558-2567`. No new route, so the `routes.admin.auth.test.ts`
  matrix needs no new row.
- `__tests__/routes.admin.test.ts`, `__tests__/stripeSyncRunner.test.ts`

**Frontend:**
- `pages/admin/billing.tsx` — §1.1-1.5, plus `data-testid` hooks.
- `pages/Pricing.tsx`, `components/SubscriptionPanel.tsx`,
  `components/subscriptionHelpers.ts` — Phase 2.
- `pages/pricingPlans.ts` + `.test.ts` — deleted; cases ported (§2.1).
- `e2e/adminBillingSync.spec.ts` — re-anchored onto the new test ids, extended per
  Verification below.

**Not touched:** `membershipPricing.ts`, `membershipGrant.ts`,
`webhookHandlers.ts`, and the grant layer. The allowlist is reused, never
reimplemented. No app database migration.

---

## Verification

- **Unit:** `membershipOffers.test.ts` — quarterly not displacing monthly,
  duplicate one-time prices both surviving, unlabelled-cadence fallback, ordering
  determinism under equal monthly-equivalents, `unit_amount: 0`, plus the four
  ported `pricingPlans.test.ts` regressions. `stripeHealth.test.ts` —
  `untagged_product` mirroring the real catalog's shape, and `unrenderable` for a
  quarterly price.
- **Backend:** `routes.admin` — the new summary fields, and that no key value
  appears in the response body. Account-scoped plans returns only the connected
  account's rows; an unresolvable account falls back to unfiltered **and** reports
  the red state; a throw inside account resolution still returns a populated
  catalog rather than `{ plans: [] }`.
- **e2e:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts` must still pass
  after re-anchoring, extended so a **failed** sync's error is still visible
  **after a page reload** — the §1.1 regression, driven through the existing
  dev-only `POST /admin/stripe/sync/_test/simulate` endpoint with
  `{ failResource: "plans" }`.
- **Gates:** `pnpm --filter @workspace/overhype-me run test`,
  `... run typecheck`, api-server tests via `run-test.sh`, and
  `pnpm run check:codegen-drift`. **No `lib/api-zod` exposure:** the admin Stripe
  routes are absent from `lib/api-spec/openapi.yaml`, so the codegen-allowlist
  trap is not in play — but the drift check runs regardless, since that trap has
  already bitten twice.
- **In-app (the real gate):** add a quarterly price in the sandbox → it appears on
  the pricing page and in the admin readout, and does **not** displace Monthly.
  Un-tag a product → admin flags it `untagged_product` and it disappears from the
  pricing page. Force a sync failure → the error is still on screen after a reload.

---

## Must not change

- The grant layer — checkout, confirm, and webhook membership checks are untouched.
- The `overhype_membership` allowlist semantics.
- The public pricing page must not go blank on an unresolvable account, or on any
  throw inside the new account-resolution path (§1.6).
- No secret or key value is ever returned by an endpoint or rendered.
- Customer/subscription/invoice rows stay un-scoped — only the three catalog
  tables are account-filtered, matching `cleanStaleAccountData`'s existing
  deliberate boundary.

---

## Sequencing

1. This plan → Codex plan-review loop (`[PLAN REVIEW]` draft PR) → David's approval.
2. Phase 1 PR, then Phase 2 PR. Both on Opus (payments-adjacent), each with a UAT
   doc. Phase 1's UAT now includes a customer-facing check because §1.6 stays in
   Phase 1 (David, 2026-07-28); Phase 2 is fully customer-facing, so its UAT is
   the real gate.

## Public-disclosure check

Passes. No unpatched-vulnerability details, secrets, auth-bypass specifics,
fraud-enabling paths, or private customer data. The §1.6 account-scoping gap is a
data-hygiene/UX defect, not a membership bypass — the grant layer fails closed
independently at all three surfaces (`membershipPricing.ts`'s
`productGrantsMembership` returns false for anything not explicitly tagged), and
the allowlist design is already public in
`docs/ai-context/security-model.md`. Real account, product, and price identifiers
are excluded from this document.

## External-claim verification

No network-dependent claim is load-bearing here. Every third-party claim concerns
**`stripe-replit-sync@1.0.0`** as pinned in this repo, and was verified against
the installed package's own source rather than documentation or model memory:
`hashApiKey`'s export and implementation (`dist/index.d.ts:383-385`,
`dist/index.js:522-526`); `api_key_hashes`' column, GIN index, and union-append
upsert (`dist/migrations/0047_api_key_hashes.sql`, `dist/index.js:204-223`);
`stripe.accounts`' effective column shape after migrations `0046`, `0048`, and
`0050`; and `getAccountId`'s DB-hit-before-API-call path
(`dist/index.js:577-603`), which is what makes §1.2 free of Stripe API calls.
Stripe's own API version in play is `2025-08-27.basil`
(`lib/stripeClient.ts`), but no claim in this plan depends on Stripe API
behaviour — only on the local synced tables.
