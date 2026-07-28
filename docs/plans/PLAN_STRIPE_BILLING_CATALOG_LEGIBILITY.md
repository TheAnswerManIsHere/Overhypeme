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

Change the `billing.tsx:685` gate so the per-resource panel renders **as soon as
`syncStatus` has loaded at all** (`syncStatus !== null`), not only during a run.
The data is already in state from the mount fetch — this is a render-condition fix
plus an honest summary line, not new plumbing.

> **The gate is "loaded," not "has a non-idle resource"** (Codex round 1, P2).
> An earlier revision of this plan said non-idle, which would have hidden the panel
> on exactly the case §1.1 promises to surface: `readSyncStatus` maps over
> `SYNC_RESOURCES` and defaults every absent row to `idle`
> (`stripeSyncRunner.ts:537-549`), so a fresh install — and a missing-schema
> degrade — returns eight `idle` resources and no non-idle one. All-idle **is** the
> never-synced state and must render.

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

**Rendering the panel costs no Stripe API call:** `hashApiKey(secretKey)` from
`stripe-replit-sync`, looked up against `stripe.accounts.api_key_hashes`
(GIN-indexed, union-appended by the library's `upsertAccount`, so test and live
keys for one account coexist). This is what makes two Stripe environments
distinguishable from inside the app — live and test here are genuinely different
accounts, because the test key is a Sandbox key. Freshness of the underlying row
is a separate concern, handled by the per-sync refresh in §2.1 — one call per
sync, never per page view.

> **Not-yet-resolved is a first-class state, not a spinner.** No account row
> exists until a sync has run once; render it as an actionable amber "run a sync."

### 1.3 What customers can actually buy

Enumerate **every** price in the catalog — not three fixed slots — and classify
each one. Membership offers come from `selectMembershipOffers` (§2.1, created in
**Phase 1** per the seam note below); non-membership prices are classified from
the unfiltered catalog. Each entry resolves to one of:

| State | Meaning | Action named |
|---|---|---|
| `sellable` | tagged product, renderable by the pricing page | none |
| `not_membership` | product lacks `overhype_membership=true` | **none — stated as fact** |
| `wrong_currency` | tagged, but not in the storefront currency (§2.1) | "price it in *&lt;currency&gt;*, or expect it to be hidden" |
| `unrenderable` | tagged, valid, in-currency, but the pricing page drops it | resolved by Phase 2 |

> **`not_membership` names a fact, never an inferred intent** (Codex round 1, P1).
> An earlier revision called this `untagged_product` and paired it with the action
> *"tag &lt;product&gt; in Stripe."* That was wrong and actively hazardous: absence of
> the tag proves only that a product is **not** a membership product, and
> `/api/stripe/plans` deliberately carries non-membership SKUs — render credits,
> merch, tips (`security-model.md`'s C6 section says so explicitly, and it is the
> reason the allowlist is positive). Telling an operator to tag merch, and having
> them comply, is precisely how an unrelated purchase starts minting Legendary.
> There is no signal anywhere in the catalog for *"this was meant to be a
> membership plan,"* so the plan must not pretend to infer one. Admin shows the tag
> state of every product and lets David judge.
>
> **The alarm keys on an unambiguous condition instead.** §1.4's banner fires when
> **zero** membership offers are sellable, or when a **tagged** product's prices are
> all non-sellable — both broken regardless of anyone's intent. It does not fire
> because an untagged product exists.

`unrenderable` is deliberately built even though Phase 2 removes it (David,
2026-07-28): between the two PRs it is the only thing that stops admin reporting
a quarterly or duplicate one-time price as `sellable` while the pricing page
silently drops it. Phase 2 deletes one branch and its test case.

> **How `unrenderable` is actually computed** (Codex round 1, P1). Not from the new
> enumeration alone — that lists everything, so it cannot say what the *current*
> page drops. Phase 1 diffs the enumeration against what `selectPlanPrices`
> actually returns for its three slots; every enumerated in-currency offer absent
> from that result is `unrenderable`, by exact price id. This is why
> `selectPlanPrices` survives Phase 1 as the comparison baseline and is deleted
> only in Phase 2.

### 1.4 Prominent warning + per-product badges

An amber banner naming what customers will actually see and the specific next
action, fired on the unambiguous conditions above, plus a `membership` /
`not a membership product` badge on each product in the existing Plans list
(`billing.tsx:741-764`) — the first time the tag is visible anywhere. The badge
wording is deliberately *not* "not sellable": merch is not broken for being
unsellable as a membership, and the badge must not imply it needs fixing.

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
pricing page can advertise a previous account's prices. Add the `_account_id`
filter at its single call site's choke point.

**The harm is a dead CTA, not a wrongful grant** (Codex round 1, P1; mechanism
verified in `routes/stripe.ts:120-142`). An earlier revision of this plan defended
serving stale rows on the grounds that "the grant layer fails closed." That is
true and irrelevant: it answers *"can merch mint Legendary?"* (no) rather than
*"what happens to a customer who clicks?"* A previous account's price can be
legitimately tagged `overhype_membership=true`, so it passes the frontend
allowlist and reaches `POST /stripe/checkout` — which calls
`stripe.prices.retrieve(priceId)` on the **current** account at `:120`, *before*
the `priceGrantsMembership` predicate at `:136`. The current account doesn't own
that price, so it throws `resource_missing`, which is not one of the graceful 400s
and falls through to the generic outer catch. And because Phase 2 features the
best monthly-equivalent recurring offer, a stale price can own the **primary CTA**
while valid current-account offers sit below it. That is a broken storefront —
the same failure class as the bug that started this plan.

So the fallback is no longer "serve unfiltered when the hash lookup misses."
**Resolution escalates before it degrades:**

1. **Hash lookup** — `hashApiKey(secretKey)` against `api_key_hashes`. Free, no
   API call, the normal path (§1.2).
2. **Authoritative API fallback** — on a miss, the library's own
   `getAccountId()` already falls back to `stripe.accounts.retrieve()`
   (`dist/index.js:577-603`) and writes the row back via `upsertAccount`, which
   self-heals a catalog synced before `api_key_hashes` existed. One API call on a
   cold path only. §1.2's "no Stripe API call" claim is about the *admin readout*,
   which stays hash-only; it was never a constraint on this path.
3. **Only if both fail** — serve unfiltered, surface the red "catalog not
   account-scoped" state in admin, and log it. This remains a deliberate
   fail-open, but it is now reachable only when Stripe itself is unreachable *and*
   no account row exists, rather than on the ordinary cold-cache case.

> **Residual multi-account behavior, stated rather than left implicit.** In that
> both-failed state the catalog may still mix accounts. The pricing page stays
> populated (the invariant), but this is exactly the window where a stale CTA is
> possible, so it is a **red** admin state naming "run a sync" as the action —
> not a quiet amber one.

> **The silent catch must not swallow this.** `routes/stripe.ts:38-40` currently
> turns *any* throw into `{ plans: [] }`. Account resolution goes in its own
> `try`/`catch` that degrades to step 3, so a resolution failure can never reach
> the outer catch; and the outer bare `catch` gains a `logger.error` so a blanked
> pricing page is diagnosable at all. Without this, a resolution bug is a silently
> blank pricing page — the same invisible-failure class this plan exists to fix.

#### 1.6a Resolution is bounded — this endpoint is public

`GET /stripe/plans` has **no auth** (`routes/stripe.ts:32`). Adding a per-request
DB lookup is fine; adding a *cold-path Stripe call* without bounds is not (Codex
round 2, P2). The library's `getAccountId()` caches only **after a successful**
`accounts.retrieve()` and coalesces nothing, so during a new-key/hash-miss window
every anonymous request would trigger its own retrieve-and-retry — amplifying a
Stripe outage and burning rate limit. "One API call on a cold path" was true per
*resolution*, not per *request*, and the plan has to say which.

Parameters are **exact, not adjectival** (Codex round 3, P2 — "short TTL" and
"backoff" are not executable, and two implementations satisfying prose bullets
would behave materially differently in an outage):

| Parameter | Value | Why |
|---|---|---|
| Resolution deadline | **2 s** | A public page-load path. Past this the request stops waiting and serves step 3; single-flight alone caps *call count*, not *latency*, which is the half the previous revision missed. |
| Negative-cache TTL | **fixed 30 s** | Not exponential backoff. A fixed TTL is one number to reason about and to test; per-key exponential state on a public endpoint is a second cache to get wrong for no benefit at this scale. |
| Positive-cache TTL | **none — until invalidated** | The library already caches a resolved account; re-resolving a stable account has no value. |
| Reset conditions | a successful resolution, or `invalidateStripeSync()` | The mode toggle already calls the latter (`stripeClient.ts:111`), so a live/test switch cannot serve the previous mode's entry. |

- **Single-flight.** At most one in-flight resolution per key hash; concurrent
  requests await the same promise, and each still honours its own 2 s deadline.
- **Failure is cached exactly as success is.** Caching only success is the bug —
  it is what makes the library's own `getAccountId()` unsafe to expose here.
- **Keyed by mode + key hash**, so the two modes' entries never alias.
- Tests are **clock-controlled**, not timing-dependent: a request during a
  simulated Stripe hang returns within the deadline; concurrent cold requests
  produce **one** call; a second failure inside 30 s makes **zero** calls and the
  first after it makes one; a mode switch isolates the two keys' entries.

#### 1.6b The live/test mode transition is a defined state, not a gap

Verified at `routes/admin.ts:2334-2344`: the toggle writes the new mode, calls
`invalidateStripeSync()`, then calls `runFullSync(sync)` and **discards its return
value**. `runFullSync` returns `{ alreadyRunning }` — so if any sync already holds
the in-process lock, the mode has changed and **no target-mode sync is ever
queued**. The code comment anticipates the *opposite* direction (a manual click
short-circuiting with 409) but not this one. Adding `_account_id` scoping on top
of that turns a latent inconsistency into a visible one, so this plan must define
the transition rather than inherit it:

- **One executable contract: refuse the toggle up front.** *(Revised, Codex
  round 3, P1 — the previous "queue it, or fail loudly" offered two alternatives
  and one of them doesn't work. The config value is committed at `:2313-2324`,
  **before** `runFullSync` can report `alreadyRunning` at `:2340`, so returning an
  error afterward still leaves the forbidden "mode switched, nothing synced"
  state. An error that doesn't undo the write isn't a contract.)*
  The route checks `isSyncRunning()` **before writing the config row**, and if a
  sync holds the lock it rejects with `409` and changes nothing — persisted mode
  unchanged, no partial transition to reason about. Chosen over the queue
  alternative deliberately: queuing means new coalescing machinery in the sync
  runner (what happens on two toggles before the lock frees?) for an admin-only
  action taken rarely, where "a sync is running, try again in a moment" is a fine
  answer. The test asserts the **persisted mode is unchanged** and no sync was
  started — not "either outcome is acceptable."
- **Admin must not relabel stale rows.** During the window, retained old-mode
  `plans` are shown as *the previous mode's catalog, pending resync*, never
  badged as the new mode; and the §1.2 connected-account panel refetches, since
  the key changed. The operator sees the target run's actual terminal state.
- **The storefront during the window.** Once the mode flips, the previous
  account's prices genuinely **must not** be sold — they'd be a dead CTA per the
  finding above. So an empty target catalog renders the existing "no plans
  available" state. This is the one case where empty is *correct*, which is why
  the invariant below is scoped to an *unresolvable account*, not to a
  legitimately-empty one. It must be brief and visible in admin, never silent.
- Acceptance: toggle **while a sync is running**, and toggle **into a purged
  target catalog** — in both, no old-mode offer is ever labelled or sold as
  current, and admin shows the target run's real terminal state.

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

**Created in Phase 1**, consumed by Phase 1's §1.3 readout; Phase 2 migrates the
customer-facing surfaces onto it. See the seam note under Sequencing.

Returns an **ordered list** of offers, each carrying price id, amount, currency,
cadence (`interval` + `interval_count`), a normalised **monthly-equivalent**
amount, and a display label. Keeps the `overhype_membership` allowlist unchanged,
imported from `@/lib/stripePlans`.

- **One storefront currency, chosen from data, not assumed** (Codex round 1, P2).
  The catalog preserves each price's `currency` (`stripeStorage.ts`'s SQL selects
  it; `StripePlanPrice` carries it), so a valid tagged catalog can hold USD, EUR,
  and zero-decimal currencies like JPY at once. Comparing raw minor units across
  them is meaningless — ¥500 vs $5.00 — and a savings badge computed across two
  currencies would assert a discount that doesn't exist. So: the storefront
  currency is `stripe.accounts.default_currency`, authoritative for the connected
  account. Offers are **filtered to that currency**; tagged prices in any other
  currency are excluded from the customer surfaces and surfaced in §1.3's readout
  as `wrong_currency`, so they are hidden but never invisible.
- **How the currency reaches the customer surfaces, and how it stays fresh**
  (Codex round 2, P1 — reopened 1.5; the previous revision named the *source* and
  never specified *delivery*, so the public selectors would have had to invent a
  fallback, and the admin-only summary can't feed them):
  - **Delivery:** `GET /stripe/plans` returns `storefrontCurrency` alongside
    `plans`. It is account-level, non-secret, and already implicit in the prices
    the endpoint returns, so it does not breach the never-echo-a-key rule. Both
    public consumers — `Pricing.tsx` and `SubscriptionPanel.tsx` — read it from
    that response; **neither hardcodes a currency**. `selectMembershipOffers`
    takes it as a parameter rather than reaching for a global, which is also what
    makes the non-USD unit tests possible.
  - **Fallback:** `usd`, used **only** when no account row resolves at all, and
    reported in §1.3 as part of the red "catalog not account-scoped" state so it
    is never a silent default.
  - **Refresh:** a hash hit returns early from `getAccountId()` without touching
    Stripe, so `_raw_data` — and therefore `default_currency` — can stay stale
    indefinitely. Fix: **each successful sync refreshes the account row** with one
    `accounts.retrieve()` + `upsertAccount`. One call per sync, not per request,
    which keeps §1.6a's bound intact; and it makes §1.2's identity panel genuinely
    current rather than merely last-synced.
  - **A failed refresh must not read as a green run** *(Codex round 3, P1)*. In
    `runWithResources` every resource is marked complete **before** the post-loop
    work runs (`stripeSyncRunner.ts:351-390`), and a throw there is only logged.
    Dropping the refresh next to `cleanStaleAccountData` would therefore let all
    eight rows show green while the currency and identity panel silently went
    stale — precisely the invisible-failure class this plan exists to remove,
    reintroduced by my own fix. So the refresh gets **its own persisted status**,
    written through the existing `upsertResourceStatus` path so it renders in the
    §1.1 panel like any other resource, with its `error_message` shown and an
    actionable "re-run sync." It is **not** a `SyncResource` that gates the
    catalog — a stale account row must not fail an otherwise-good catalog sync —
    but it can never be invisible.
  - Acceptance: both public consumers render a non-USD account currency and
    observe a change to it after a sync, with no key rotation involved; and a
    **forced refresh failure** leaves the run visibly non-green with the error
    readable after a page reload.
- **Ordering:** ascending monthly-equivalent, one-time last. Deterministic —
  tie-break on price id, never on SQL row order. Since all compared offers now
  share a currency, the comparison is well-defined.
- **Labels:** derived from cadence (`1/month` → "Monthly", `3/month` →
  "Quarterly", `1/year` → "Annual", one-time → "Forever"), with a generic
  fallback ("Every 6 months", "Weekly") so no cadence is ever unlabelled.
- **Savings badge:** against the highest monthly-equivalent recurring offer,
  replacing both today's hardcoded monthly-vs-annual comparisons —
  `Pricing.tsx:127-130` and `getAnnualSavingsPercent`. `unit_amount: 0` is a real
  amount, not "missing" — which today's `if (!monthlyAmount)` guard gets wrong —
  but it cannot be a **denominator**: when the highest monthly-equivalent
  recurring offer is 0, savings is `null` and no badge renders. Never `NaN`,
  never `Infinity`, never a percentage against zero.
- **Featured:** best monthly-equivalent recurring offer; one-time stays visually
  distinct as it is today.

**`selectPlanPrices` survives Phase 1 and is deleted in Phase 2 — never kept as a
wrapper.** It has a real job in Phase 1: it *is* the definition of "what the
current page renders," so §1.3 diffs the enumeration against it to compute
`unrenderable` by exact price id. Phase 2 migrates both of its callers, at which
point keeping it would leave a function with zero production consumers alive only
by its own tests — dead code `/simplify` and Codex would both flag. So Phase 2
deletes it and ports its four regression cases (product carrying all three prices;
a product named "forever" not swallowing its recurring prices; non-membership
products ignored) into `membershipOffers.test.ts` as equivalent assertions, so the
regression net moves rather than disappearing.

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

**The member picks from all eligible offers (David, 2026-07-28).** Codex raised
this as a `[Product Decision]` and it was escalated rather than settled in the
loop: "switch to a longer-cadence offer" doesn't define behavior once monthly,
quarterly, annual, and duplicate cadences coexist — four different
implementations would satisfy that phrase. David chose the picker over a
deterministic single target, for the same reason the pricing page is being
rewritten: **code must not silently choose which plan a customer is allowed to
see.**

Concretely, replacing today's single `targetAnnualPriceId` dialog
(`SubscriptionPanel.tsx:250-291`):

- **Eligible** = every membership offer in the storefront currency whose
  monthly-equivalent is **strictly lower** than the member's current price, minus
  the current price itself. Ordered by §2.1's ordering.
- **Duplicate cadences are listed separately**, distinguished by price — they are
  genuinely different offers, and collapsing them is the original bug.
- **One-time offers are excluded** from the switch flow. Moving a subscriber to a
  lifetime price is a different transaction (`mode: "payment"`, not a subscription
  update) and the existing `switch-preview`/`switch-plan` endpoints don't model
  it. Out of scope here; noted so it's a decision rather than an oversight.
- **Downgrades are excluded** by the strictly-lower rule — this flow only ever
  offers a cheaper monthly-equivalent, as it does today.
- **Empty list → no switch UI at all**, not a disabled button.

`findAnnualPriceId` / `getAnnualSavingsPercent` (`subscriptionHelpers.ts:41-90`)
are replaced by an offer-based `selectSwitchOffers(offers, currentPriceId)`. That
also closes the first-vs-last asymmetry between the two helpers' fallback paths
and the `unit_amount: 0` guard, both noted above. `SubscriptionPanel.tsx`'s
locally re-declared `PlanPrice`/`PlanProduct` (`:45-58`) are replaced with the
shared types from `@/lib/stripePlans`, which they duplicate structurally today.

Fixture: a monthly + quarterly + annual catalog asserts the exact offer ids
listed, their order, and that the member's current price is absent.

---

## Files

Split by phase, so each PR is self-contained and independently typechecks (Codex
round 1, P1 — an earlier revision assigned `membershipOffers.ts` to Phase 2 while
Phase 1's §1.3 consumed it, leaving Phase 1 with an unimplemented dependency).

### Phase 1

**New** (pure + unit-tested — mirroring `components/admin/moderationQueueState.ts`
+ `.test.ts`, the actual pure-module-with-test exemplar):
- `artifacts/overhype-me/src/lib/membershipOffers.ts` + `.test.ts` — §2.1's
  enumeration, created here because §1.3 needs it. Imports `filterMembershipPlans`
  from `@/lib/stripePlans`; declares no membership logic of its own.
- `artifacts/overhype-me/src/pages/admin/stripeHealth.ts` + `.test.ts` — §1.3's
  classification, including the enumeration-vs-`selectPlanPrices` diff that
  computes `unrenderable`.

**Backend:**
- `stripeStorage.ts` — **two distinct entry points, not one helper** *(Codex
  round 3, P2 — a single `getConnectedAccount()` collapsed §1.2's hash-only
  contract and §1.6's escalating one, so an implementer could reasonably reuse it
  and fire a Stripe call on every cold admin page load, violating §1.2)*:
  - `lookupAccountByKeyHash()` — **hash only, never calls Stripe.** Returns the
    row or `null`. This is what `/admin/stripe/summary` uses, so a hash miss
    renders §1.2's `not-yet-resolved` state with **zero** Stripe calls.
  - `resolveConnectedAccount()` — hash lookup, then the library's API fallback,
    behind §1.6a's single-flight and negative cache. **Only** `/stripe/plans`
    calls this.

  Imports `hashApiKey` from `stripe-replit-sync`. Test asserts the split
  directly: a hash miss on the summary route makes zero Stripe calls while the
  same miss on `/stripe/plans` escalates.
- `artifacts/overhype-me/src/lib/formatMoney.ts` + `.test.ts` — **currency-minor-
  unit formatter** *(Codex round 3, P2)*. `Pricing.tsx:132-134` and
  `subscriptionHelpers.ts:33-35` both divide `unit_amount` by 100, so the JPY this
  plan explicitly admits into its fixtures would render ¥500 as **¥5**. One shared
  exponent-aware formatter, used by both consumers, with an exact zero-decimal
  assertion — the mixed-currency ordering fixture does not cover display, and a
  EUR-only acceptance test would pass straight through this bug.
- `routes/stripe.ts` — §1.6's scoped resolution, its own nested try/catch, the
  `logger.error` in the previously-bare catch, §1.6a's single-flight + bounded
  negative cache, and the new `storefrontCurrency` field on the response.
- `routes/admin.ts` (mode toggle, `:2334-2344`) — §1.6b: stop discarding
  `runFullSync`'s `alreadyRunning` result; queue or fail loudly.
- `lib/stripeSyncRunner.ts` — refresh the `stripe.accounts` row once per
  successful sync (§2.1's freshness fix), alongside the existing
  `cleanStaleAccountData` call.
- `routes/admin.ts` — extend `/admin/stripe/summary` (`:2543-2596`) with
  `connectedAccount` + `catalogAccountMatch`. **Identity and booleans only —
  never echo a key value**, matching the endpoint's existing `stripeEnv`
  precedent at `:2558-2567`. No new route, so the `routes.admin.auth.test.ts`
  matrix needs no new row.
- `__tests__/routes.admin.test.ts`, `__tests__/stripeSyncRunner.test.ts`

**Frontend:**
- `pages/admin/billing.tsx` — §1.1-1.5, plus `data-testid` hooks.
- `e2e/adminBillingSync.spec.ts` — re-anchored onto the new test ids, extended per
  Verification below.

**Unchanged in Phase 1:** `pages/pricingPlans.ts` (`selectPlanPrices` is the
comparison baseline), `pages/Pricing.tsx`, `SubscriptionPanel.tsx`. Phase 1 ships
**no customer-visible change except §1.6's account scoping.**

### Phase 2

- `pages/Pricing.tsx`, `components/SubscriptionPanel.tsx`,
  `components/subscriptionHelpers.ts` — migrated onto `membershipOffers.ts`.
- `pages/pricingPlans.ts` + `.test.ts` — deleted; cases ported into
  `membershipOffers.test.ts` (§2.1).
- `pages/admin/stripeHealth.ts` + `.test.ts` — the `unrenderable` branch and its
  test case removed, since nothing is dropped any more.

**Not touched:** `membershipPricing.ts`, `membershipGrant.ts`,
`webhookHandlers.ts`, and the grant layer. The allowlist is reused, never
reimplemented. No app database migration.

---

## Verification

- **Unit — `membershipOffers.test.ts`:** quarterly not displacing monthly,
  duplicate one-time prices both surviving, unlabelled-cadence fallback, ordering
  determinism under equal monthly-equivalents, `unit_amount: 0` treated as a real
  amount, plus the four ported `pricingPlans.test.ts` regressions (Phase 2).
  **Currency fixtures (Codex round 1):** a mixed USD/EUR/JPY tagged catalog
  asserts deterministic single-currency ordering and **no** cross-currency savings
  badge; an all-zero recurring catalog asserts savings is `null`, never `NaN` or
  `Infinity`.
- **Unit — `stripeHealth.test.ts`:** `unrenderable` for a quarterly price and for
  the second of two duplicate one-time prices, identified by **exact price id**
  (this is the diff-against-`selectPlanPrices` behavior, so it must assert *which*
  price is dropped, not just that one is). **`not_membership` acceptance (Codex
  round 1):** a catalog holding a tagged membership product *and* an untagged merch
  product asserts the merch is reported neutrally, carries **no** "tag it in
  Stripe" action, and does **not** fire §1.4's banner. Plus `wrong_currency` for a
  tagged non-storefront-currency price.
- **Backend:** `routes.admin` — the new summary fields, and that no key value
  appears in the response body. Account-scoped plans returns only the connected
  account's rows. **Resolution escalation (§1.6):** a hash miss with Stripe
  reachable resolves via the API fallback and scopes correctly; only a hash miss
  *plus* an unreachable Stripe serves unfiltered, and then reports the red state.
  A throw inside account resolution still returns a populated catalog rather than
  `{ plans: [] }`. **A mixed current/stale tagged catalog stays non-blank while
  every offer the page can select is valid for the current account** — the CTA
  finding's acceptance test.
- **Bounded public resolution (§1.6a):** concurrent cold requests to the
  unauthenticated `/stripe/plans` produce **one** `accounts.retrieve()`, not one
  per request; repeated failures do not scale Stripe calls with request count;
  a live/test switch isolates the two keys' cache entries.
- **Mode transition (§1.6b):** toggling **while a sync holds the lock** still
  results in a target-mode sync running (or a loud failure), never a silently
  switched mode with no resync; toggling **into a purged target catalog** never
  labels or sells an old-mode offer as current, and admin reports the target
  run's real terminal state.
- **Currency delivery and freshness (§2.1):** both public consumers render a
  non-USD account currency taken from the `/stripe/plans` response rather than a
  hardcoded default, and observe a change to `default_currency` after a sync with
  no key rotation involved.
- **e2e:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts` must still pass
  after re-anchoring, extended two ways: a **failed** sync's error is still visible
  **after a page reload** (the §1.1 regression, driven through the existing
  dev-only `POST /admin/stripe/sync/_test/simulate` endpoint with
  `{ failResource: "plans" }`), and an **all-idle** status response on reload
  renders the never-synced aggregate and per-resource state rather than hiding the
  panel (Codex round 1, P2).
- **Gates:** `pnpm --filter @workspace/overhype-me run test`,
  `... run typecheck`, api-server tests via `run-test.sh`, and
  `pnpm run check:codegen-drift`. **No `lib/api-zod` exposure:** the admin Stripe
  routes are absent from `lib/api-spec/openapi.yaml`, so the codegen-allowlist
  trap is not in play — but the drift check runs regardless, since that trap has
  already bitten twice.
- **In-app (the real gate):** add a quarterly price in the sandbox → it appears on
  the pricing page and in the admin readout, and does **not** displace Monthly.
  Un-tag a product → it disappears from the pricing page, and admin reports it as
  `not_membership` **without** telling David to re-tag it. Force a sync failure →
  the error is still on screen after a reload.

---

## Must not change

- The grant layer — checkout, confirm, and webhook membership checks are untouched.
- The `overhype_membership` allowlist semantics. **In particular: nothing in this
  work infers that an untagged product *should* be tagged**, and no surface
  suggests tagging one. The allowlist stays a positive, hand-set signal; a UI that
  nudges an operator toward tagging merch would undermine the whole gate.
- The public pricing page must not go blank **because the account could not be
  resolved**, or on any throw inside the new account-resolution path (§1.6).
  Scoped deliberately: an empty *target* catalog immediately after a live/test
  toggle is a different thing — there the previous account's prices must not be
  sold, so rendering the existing "no plans available" state is correct, and the
  requirement is that it be brief and visible in admin (§1.6b), not that it be
  papered over with stale offers.
- **No offer the page can select may belong to a different Stripe account** in any
  state where account resolution succeeded — checkout retrieves the price against
  the current account before the membership predicate, so a cross-account price is
  a dead CTA, not merely an ungranted one.
- No secret or key value is ever returned by an endpoint or rendered.
- Customer/subscription/invoice rows stay un-scoped — only the three catalog
  tables are account-filtered, matching `cleanStaleAccountData`'s existing
  deliberate boundary.
- **Each phase's PR typechecks and ships coherently on its own.** Phase 1 must be
  correct and complete if Phase 2 never lands.

---

## Sequencing

1. This plan → Codex plan-review loop (`[PLAN REVIEW]` draft PR) → David's approval.
2. **Three PRs, not two (David, 2026-07-28).** §1.6 grew across three review
   rounds from "add an `_account_id` filter at one choke point" into a filter
   *plus* resolution escalation *plus* request-level caching *plus* a
   mode-transition contract. Every piece was forced by a real finding, but that is
   three unrelated risk profiles in one diff, and Codex's findings have clustered
   on the newest mechanisms each round. So:

   | PR | Contents | Why separable |
   |---|---|---|
   | **Phase 1** | §1.1-1.5 admin legibility, plus §1.6's `_account_id` filter and resolution escalation (§1.6 steps 1-3) | The customer-harm fix — the dead CTA — ships first and reviews as one unit. |
   | **Phase 1b** | §1.6a bounded resolution, §1.6b mode transition | Both are hardening of a path Phase 1 establishes; neither changes what the catalog contains. Reviewable against a stable base. |
   | **Phase 2** | §2.1-2.4 offer model and customer surfaces | Unchanged. |

   All on Opus (payments-adjacent). Phase 1 carries a UAT with a customer-facing
   check, because §1.6 stays in it. Phase 1b's behavior is operational rather than
   product-visible, so it ships a written verification note unless the mode-toggle
   change proves visible in admin — in which case a UAT. Phase 2 is fully
   customer-facing, so its UAT is the real gate.

**The Phase 1 / Phase 2 seam, stated once so the two PRs can't drift.**
`membershipOffers.ts` is **Phase 1's** file — Phase 1's admin readout is its first
consumer, so it cannot be deferred to Phase 2. What Phase 2 adds is not the
module but the *migration onto it*: the customer surfaces stop calling
`selectPlanPrices` and start calling `selectMembershipOffers`, after which
`selectPlanPrices` and the `unrenderable` state both become dead and are deleted
together. Concretely, in Phase 1 both selectors coexist on purpose — the new one
enumerates what *could* be sold, the old one defines what *is* rendered, and the
gap between them is the `unrenderable` list. If Phase 2 never lands, Phase 1 is
still correct and still tells the truth; it just keeps reporting a gap nobody has
closed yet.

## Public-disclosure check

Passes. No unpatched-vulnerability details, secrets, auth-bypass specifics,
fraud-enabling paths, or private customer data. The §1.6 account-scoping gap is a
broken-storefront defect (a cross-account price is a failed checkout — see the
mechanism in §1.6), **not** a membership bypass: the grant layer fails closed
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
