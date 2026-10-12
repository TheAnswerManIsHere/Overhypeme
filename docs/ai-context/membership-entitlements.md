# Membership & Entitlements

> **Source of truth:** `artifacts/api-server/src/lib/membershipState.ts`
> (derivation), `membershipSources.ts` (writes), `membershipRefresh.ts`
> (Stripe-facing refresh), `entitlementVerification.ts` (trust boundary),
> `membershipLease.ts` (concurrency), `webhookHandlers.ts` (event entry),
> `membershipGraceSweep.ts` + `membershipSchedules.ts` (the background sweep),
> `stripeAccountGuard.ts` + `stripeInit.ts` + `stripeVerificationErrors.ts`
> (the account guard, PR #577).
> Schema: `lib/db/src/schema/membershipEntitlements.ts`. Shipped in PR #287
> (34 commits, 11 code-review rounds, 101 findings), replacing code that had
> never had an independent review since its original build.
>
> **Human-facing narrative:** [`docs/manual/10-payments-and-membership.md`](../manual/10-payments-and-membership.md).
> **Decision history:** [`decisions.md`](./decisions.md#2026-07-30--reconciliation-is-deferred-out-of-the-entitlement-model-pr-the-gap-is-accepted).
> **Superseded:** [`stripe-payments-audit-findings.md`](./stripe-payments-audit-findings.md)
> is the audit that commissioned this rewrite — read it for history, not for
> current architecture.

## The one thing to understand before anything else

**`users.membership_tier` is derived, never assigned.** Before PR #287 it was a
column that fifteen call sites wrote by hand, each with its own idea of when to
write it and which other sources to check first — `handleChargeRefunded`
checked two other sources before downgrading, `handleSubscriptionCancelled`
checked one, the grant paths checked none. Any handler that forgot a source
corrupted the tier. Every one of those bugs was the same bug wearing different
clothes.

Now one module (`membershipSources.ts`'s `recomputeMembership`) owns the write
for every *post-creation* entitlement change, and one expression
(`effectiveTierExpr`) owns the read. This scopes to a user's tier changing
after they exist — account **creation** is a separate case: an ordinary
signup takes the column's DB default, and `POST /admin/users` (the Add User
modal) passes the admin's chosen Registered/Unregistered starting tier
straight into the insert (never Legendary — that's granted afterward through
`writeAdminGrant`, see the source-type table below). Both are one-time
auth-state initialization, not a write competing with `recomputeMembership`.
Past that point, nothing else may set `membership_tier` directly, with **one
narrow, designed exception:** admin reinstatement (`PATCH /admin/users/:id`
in `routes/admin.ts`) writes `membershipTier`/`membershipValidUntil`
directly, bypassing `recomputeMembership`, when a source refresh comes back
incomplete — it re-derives over only the sources it could verify and writes
that fail-closed result itself, rather than trusting a recompute that might
count a source it never actually re-checked. See the reader-inventory section
below for the mechanics. Any *other* post-creation code writing the column
directly is a regression.

## The entitlement model

A user's tier is derived from their **entitlement sources** —
`membership_entitlements` rows, one per durable candidate the user has ever
held. A row is **not** necessarily currently granting anything: a cancelled
subscription, a refunded purchase, a source with an open or lost dispute, or
one on a non-membership price are all retained rows that no longer (or never
did) qualify — retained deliberately, as the audit trail, and never turned
into a bare existence check. A dispute resolving as anything but **lost** —
`won`, `warning_closed`, or `prevented` — is a partial exception: it
clears the access hold (step 2 of `qualifySource`), but the source still has
to pass its own lifecycle check afterward like any other row — a subscription
cancelled or a purchase refunded while its dispute was open stays
disqualified regardless of how the dispute itself resolved, since that's a separate, later fact (see
*Refunds and disputes* below). Whether a given row currently grants
access is answered separately, below. Three source types:

| Source type | Created by | Frozen identity | Verified against |
|---|---|---|---|
| `stripe_subscription` | a subscription webhook, a Stripe-mutating route, or a refresh | `provider_ref` = the subscription id | The retrieved live `Stripe.Subscription`, plus its enumerated subscription items to inspect the purchased products against the allowlist |
| `stripe_lifetime_payment` | `checkout.session.completed` (one-time), or synchronously by `POST /stripe/checkout/confirm` if the confirm route reaches it before the webhook does | `provider_ref` = the PaymentIntent id | The retrieved live `Stripe.PaymentIntent` / its charges, plus the Checkout Session's enumerated line items to inspect the purchased products against the allowlist |
| `admin_grant` | `POST /admin/users/:id/grant-lifetime`, or `POST /admin/users` (Add User modal) when the admin selects Legendary | none (`provider_ref` is null) | Nothing — it *is* the authority |

`user_id`, `source_type`, `provider_ref` and `created_at` are **frozen** after
creation (a `BEFORE UPDATE` trigger enforces it) — nothing may repoint a source
at a different Stripe object or a different user, not a refresh, not a repair
script, not a migration backfill.

**Qualification is a conjunction, per source:** for the two Stripe-backed
source types, the allowlist (`overhype_membership=true` on the product), no
open dispute hold, no terminal dispute loss, and a lifecycle check specific to
the source type. `admin_grant` rows skip the allowlist term — they store no
product metadata (`is_membership_product` is null) and are authorized by W1b
provenance instead, not by a purchased product — but still carry the dispute-
hold and lifecycle terms like any other source. **The tier is a set union across
sources, not a priority order** — Legendary if *any* source qualifies. A user
holding both a lifetime purchase and a subscription stays Legendary if either
one alone would grant it; refunding the subscription alone does nothing.

`membership_valid_until` is the horizon over the **whole qualifying set**: null
if any qualifying source is indefinite — lifetime, admin grant, an active or
trialing subscription, or a `past_due` subscription whose grace anchor is
still unresolved (the fail-open case above) — otherwise the max of the
grace-bound sources' deadlines. This is
why a lifetime purchase alongside a `past_due` subscription keeps the user
Legendary past the subscription's own deadline — the union's horizon is
whichever source lasts longest, not whichever the code happened to check first.

## The trust boundary — W1a

> A durable *paid* entitlement may be created only from provider state
> retrieved **inside** the trust boundary. The boundary accepts identifiers
> only, never a caller-supplied object.

`entitlementVerification.ts`'s two verifiers (`verifyOneTimeMembershipPurchase`,
`verifyMembershipSubscription`) take a Stripe object id, retrieve the object
themselves, and return a verified result or a typed failure. **There is no
signature that accepts a Stripe-shaped object from a caller** — an earlier
revision tried a branded TypeScript type for this and the brand did nothing,
because a type assertion defeats any brand. The actual defect the boundary
fixes was never "missing validation"; it was a signature that *accepted* a
structurally-valid lie (a fabricated `{status: "succeeded"}` PaymentIntent
literal).

**A negative conclusion needs a complete collection.** "This purchase is not a
membership product" is a claim over a paginated line-item or subscription-item
list, so it's sound only if the whole list was seen. A pagination failure
returns `incomplete_enumeration` — never `false` — because concluding "not a
member" from a truncated list would silently deny a paying customer.
`RETRYABLE_NOOP_REASONS` (`source_busy`, `retrieval_failed`,
`incomplete_enumeration`, `source_unknown`, `grace_anchor_ambiguous`) are the
reasons that describe *our* inability to observe the object right now, not a
settled fact about it — a webhook prepare that lands on one of these throws
**before** the idempotency claim, so Stripe redelivers instead of the event
being permanently acked on a transient failure.

## The account guard — no operational Stripe client until its account verifies

Shipped in PR #577. Every deployment declares which Stripe account it expects
per mode — `STRIPE_ACCOUNT_ID_TEST` and `STRIPE_ACCOUNT_ID_LIVE`
(`stripeRawClient.ts`'s `stripeAccountVarFor`) — and **no Stripe client or
sync object is handed to any caller until the account behind that mode's
secret key has been verified against the declared id.** `stripeClient.ts` is
the only construction site, and both of its exported constructors go through
`verifyStripeAccount`, so boot, the mode toggle, checkout, webhooks and the
admin mutation routes are covered by one boundary, not by a list of callers
that has to stay complete. Withholding the client is the safety mechanism.
Everything else here is operator signal. **One client exists before
verification, and it does one thing:** `verifyStripeAccount` builds a raw
client (`createRawStripeClient`) solely to call `stripe.accounts.retrieve()`
for the lookup itself, and never hands it out. That client must stay
restricted to the account read.

**Three outcomes, kept apart** (`stripeVerificationErrors.ts`, one class each;
`isDefiniteVerificationFailure` is the single answer to "is this definite?"
for the boot phase, the retry loop and the toggle route):

| Situation | At boot | After boot |
|---|---|---|
| Credentials absent or incomplete | Boots without payments, as before the guard — Stripe configuration is not made mandatory | — |
| Credentials present, expected account id not declared (`StripeExpectedAccountMissingError`) | **Fatal**, before the port binds | Payment path refuses; process stays up |
| Stripe answered and the account is not the declared one (`StripeAccountMismatchError`) | **Fatal**, before any mutation and before the port binds | Payment path refuses; process stays up |
| Indefinite: unreachable, timeout, 5xx, key rejected, mode unreadable (`StripeUnverifiedError`) | **Boots without payments**; payment paths refuse and verification retries until it succeeds, with no restart | Same |

Fatality is a decision the boot phase makes about an error, never a property
the error carries. The governing rule is David's: a Stripe outage never takes
the site down ([`decisions.md`](./decisions.md#2026-08-26--a-wrong-stripe-account-refuses-to-boot-a-stripe-outage-never-takes-the-site-down)).

**Where the boot check sits is the requirement.** The awaited verification runs
before `app.listen()`. Hoisting a refusal out of the old detached `initStripe()`
launch was not enough: that launch ran after the port was bound, so a
mismatched deployment would have opened for traffic, passed a health check and
only then exited. `stripeBootPlacement.test.ts` asserts the port is never
bound. An "it eventually exits" assertion would pass against exactly the wrong
placement.

**Four implementation choices that are easy to undo by accident** — the module
header of `stripeAccountGuard.ts` carries the evidence for each:

1. **The account is read with `stripe.accounts.retrieve()` on a raw client,
   never with the sync library's `getAccountId()`.** That helper resolves from
   an in-memory cache or the local database by API-key hash, and on a miss it
   *writes* the account it found against that key. A first mismatched boot
   would store the wrong account, and every later boot would trust it: a guard
   built on that helper goes quiet in exactly the case it exists to catch.
2. **The mode is read strictly** (`readStripeLiveModeStrict`), selecting the
   config row directly and throwing on failure. `isLiveMode()` answers `"test"`
   both for "stored as test" and for "the lookup threw", and `adminConfig`'s
   cache can republish pre-toggle rows. Either would let the guard verify one
   mode and hand back a client for the other, stamped as verified.
3. **Only successes are memoised.** A cached rejection would keep payments off
   until restart.
4. **Retrieval is single-flight and interval-throttled**, because
   `getStripeSync()` runs before webhook signature validation on the one route
   the rate limiter exempts. The throttle records when the last attempt ran,
   and an indefinite failure leaves no verdict behind: callers inside the
   window get a fresh, non-authoritative refusal. **One deliberate exception:**
   a *confirmed* mismatch keeps its reason (`definiteMismatchReason`) for the
   throttle window, so a caller in that window gets the mismatch error rather
   than an "unverified" one. A test protects this, and it is not a cached
   rejection under point 3: the record expires with the window, and the retry
   loop passes `force`, which bypasses the throttle. Payments still recover
   on their own.

**Required initialization finishes once per mode, and only after it actually
succeeds.** Stripe schema migrations and managed-webhook registration are
retried until they succeed (so migrations can run again after a registration
failure), and once marked done for a mode they are not repeated for it
(`stripeInit.ts`). Completion is tracked **per mode** because each mode is a
different Stripe account with its own webhook: until the bugfix that followed
#577, one process-wide flag meant a switch of the active mode — a toggle on
this instance, a toggle committed by another instance, or a toggle after an
unconfigured boot — left the new account with no webhook, so payments read
"verified" while its events never arrived until a restart. Now a verified
boot, a committed toggle (`startStripeInitializationForActiveMode` in the
`stripe_live_mode` PATCH) and a successful retry pass all run setup for the
mode then stored. Completion is credited to the mode the **sync** was
verified for (`liveModeOfPublishedStripeSync`), checked before the webhook is
registered: a toggle landing mid-setup hands back a sync for the other account,
so the attempt mutates nothing, leaves its mode unmarked, and the retry
finishes whichever mode is then stored. A row re-read cannot do this job —
test → live → test passes one after registering only the live webhook. The
remote-change detector (`ensureVerificationArmedFor`) treats a mode as done
only when its setup is complete, or its account was refused or never
configured. A mode that was merely *verified* still has setup owed. It kicks an
immediate pass only when it is the one arming the retry timer, so the Billing
poll never becomes the retry cadence. The one retry timer serves both modes, so it stops
only once the mode **then stored** has its setup complete, and only if no arm
request arrived while that was being read. Stopping on a pass's own success
let a switch landing mid-pass be absorbed by the armed timer and then dropped. A recovered retry used to restore clients while
leaving the webhook unregistered. **The backfill is not part of that guarantee.** It is launched
after initialization is marked done, fire-and-forget, and a failed backfill
is logged and not retried in that process.

**A mode toggle verifies the target account before it writes**
(`refuseUnverifiedStripeModeToggle` in `routes/admin.ts`). The config write
has no compare-and-swap, so write-then-roll-back would let one admin's
rollback undo another's successful toggle. A refusal returns 409 when definite
and 503 when indefinite, with the operator-facing diagnostic. This is a
usability gate: the construction boundary refuses regardless. A toggle that
lands while a client is being built is caught by a construction-generation
counter plus a re-read of the stored mode. The superseded build is discarded
and its pool closed rather than published.

**What crosses the wire.** Every refusal carries `code:
"stripe_account_unverified"` and a client-safe message from `@workspace/api-zod`
(`STRIPE_UNVERIFIED_CLIENT_MESSAGE` before a charge,
`STRIPE_UNVERIFIED_CONFIRM_MESSAGE` on the post-redirect confirm path, which
must not claim no charge was made, and `STRIPE_UNVERIFIED_RECEIPT_MESSAGE`).
The operator diagnostic names account ids and env vars, so it is logged and
never sent on an end-user payment response. **One designed exception:** the
admin mode toggle returns the diagnostic to the authenticated admin, and
Admin → Billing displays it, because naming the account and the variable to
fix is the whole value of that refusal. The Profile page treats a 503 with that code on
confirm as terminal, not as "still processing".

**Operator visibility.** Admin → Billing shows the guard's state **per mode and
per instance** (`StripeVerificationStatus.tsx`). The value is process-local and
the deployment is autoscale, so a fleet-wide aggregate would need shared state
the guard does not have. That is a named gap, not an implied capability.

**What it does not cover.** The guard checks that the *credential's account* is
the declared one. It does not record which mode created an entitlement source,
so the test-mode-source gap under *Known, accepted gaps* below stands.

## The app database is read before the Stripe mirror

The sync library maintains `stripe.*` tables (e.g. `stripe.subscriptions`).
These are a **mirror the webhook writes**, not live Stripe data, and they lag:
on the case behind PR #600 a new subscription's mirror row appeared **eleven
minutes** after checkout. The app's own records (`membership_entitlements`
and the subscription fields the entitlement refresh writes) are written
synchronously, at checkout verification and in the same live retrieval that
handles a switch or cancel.

So **anything that displays membership state reads the app DB first and falls
back to the mirror**. `SubscriptionPanel.tsx` applies this to the
subscription-controls gate (#600), the billing interval and the renewal date
(#602), and to `cancelAtPeriodEnd`. **The status line does not follow it yet**:
`SubscriptionPanel.tsx` computes it as `sub?.status ?? appSub?.status`, mirror
first. That is either a further instance of the #600 class or a deliberate
choice nobody recorded; no fix was made in this harvest. The charged amount has
no app-DB source, so it is shown only while the mirror agrees on which plan is
active. A stale amount beside a corrected plan label would read as
authoritative, so the panel shows no amount until the mirror catches up.

The trap #602 fixed is worth knowing by shape. A comment justified preferring
the mirror's price as "live Stripe price data". It was the lagging copy, so
the guard produced the very symptom it was written to prevent: a new annual
subscriber shown as Monthly and still offered "Switch to Annual". **A value
read from `stripe.*` is never "live".** Live means retrieved from Stripe in
this request.

Showing controls from the app DB is safe because no mutation reads the mirror:
cancel, reactivate and switch-plan resolve their target through
`getMutationTarget`, which selects from the app DB, re-retrieves the
subscription live from Stripe, and refuses when it no longer qualifies.

**How the mirror behaves:**

- It is written by Stripe webhooks, by a manual or full admin sync, and by
  the full backfill (`syncBackfill({ object: "all" })`) that runs once after
  each verified boot (`stripeInit.ts`). There is no periodic reconciliation,
  so a dropped webhook leaves a mirror row stale until an admin sync or a
  later restart's backfill succeeds — and that backfill can fail silently
  (logged, not retried), so on a long-lived process the row can stay stale
  indefinitely. On the #600
  investigation, 2 of 4 users with a Stripe customer id had no row in the
  mirrored `customers` table at all.
- Out-of-order events cannot regress it. `stripe-replit-sync` upserts only
  `WHERE _last_synced_at < $2` and stamps `event.created` on webhooks
  (#602 harvest notes).
- **That only display fields read it is incidental, not designed.** A second
  mirror reader added elsewhere inherits all of the above. "Absent" and
  "stale" are different failure modes for the same mirror: a fallback that
  handles a missing row does nothing for a row that is present and wrong.
  Both #600 and #602 hit that reasoning error.

**Accepted gap — the reverse case** (David, 2026-09-28, PR #602). The app row
can be the stale one: a monthly → annual switch whose entitlement refresh did
not complete leaves the row on `monthly`, with the old renewal date, while
the mirror already says annual. The card then shows the old plan. Both
directions depend on reaching Stripe, so one Stripe outage can cause both.
The remedy is the deferred Stripe↔local reconciliation (*Known, accepted
gaps*, item 1).

## Concurrency — leases, fencing, and the prepare/apply split

This section scopes to **Stripe-backed writes** — refreshes and webhook-driven
updates to `stripe_subscription`/`stripe_lifetime_payment` sources. Admin
grants and revocations (`writeAdminGrant`/`writeAdminRevocation`) skip the
Stripe retrieval, the per-source lease, and the fencing check described below
— the admin *is* the authority for that source, so there's no provider state
to reconcile against. That doesn't mean nothing serializes them: both call
`recomputeMembership` immediately afterward in the same transaction, which
takes the user row `FOR UPDATE`, and a grant additionally waits on the partial
unique index over active grants — so a grant/revoke racing a Stripe-backed
recomputation for the same user still serializes cleanly, just via the user
row lock and that index rather than a source lease. Every Stripe-backed write
path splits into two phases:

- **prepare** — every Stripe retrieval and the per-source lease, with **no
  transaction open**. Network calls inside a transaction is the invariant this
  split exists to prevent. **One exception writes durably here, outside any
  transaction:** on a first purchase whose Stripe customer isn't linked yet,
  `bindUser` (called from both verifiers during prepare) calls
  `linkCustomerToUser`, which commits `users.stripe_customer_id`
  immediately — a write that can survive a later prepare/apply failure. It's
  narrow (fires once, only for an unlinked customer, and never re-points an
  already-linked one) but it means "prepare only retrieves" isn't literally
  true for this one field.
- **apply** — the entitlement-source domain writes, inside one transaction,
  with **no network call in it**.

A **lease** is a row-locked scope per `(source_type, provider_ref)`, released
after apply. For most prepare paths (`prepareSubscriptionRefresh`) it's
acquired **before** the Stripe retrieval, with a wait timeout, because the
provider reference that names its scope is already known going in. Two paths
invert that: `prepareOneTimeCheckout` and `prepareDisputeEvent` don't know
what to lease until they've retrieved and verified the object (a checkout
session, a dispute) — the PaymentIntent or source id the lease would be scoped
to is one of the things that retrieval discovers — so for those two, the lease
is claimed **after** identity is known and carries no retrieval deadline; a
slow read has nothing held to outlive. The lease alone doesn't make the write
atomic — a lease can expire mid-refresh under load. What actually makes it
safe is the **fencing token**: `apply` re-checks the lease is still held
(`assertFenceHeld`, a `SELECT … FOR UPDATE` inside the write transaction)
immediately before writing. A stale writer's fence check fails and its write
never lands, even if its lease technically expired moments earlier.

**Lock order matters.** Every apply path takes the **user row lock before**
touching a source row, never after — a refund and a reinstatement racing for
the same user either serialize cleanly or one waits behind the other's fully
committed result, never partially interleaved.

**The webhook's idempotency claim and its domain writes share one
transaction**, not two commits. A separate claim-then-process would survive a
handler throw, so Stripe's retry would see the event as already processed and
the work would never happen. In one transaction, a throw rolls the claim back
and the retry can succeed. **Audit writes stay OUTSIDE that transaction** —
deliberately: a `failed` audit row that rolled back with the claim would
destroy the only evidence the failure happened, which is exactly the record
needed when an event silently didn't apply. The webhook's duplicate-detection
after a rollback matches the constraint name (`stripe_processed_events_pkey`)
specifically, not a broad `code === "23505"` — a unique violation on a
*different* table during prepare (e.g. a customer-linking race) is a real
failure, not a duplicate, and must fall through to `failed` + rethrow so Stripe
redelivers it.

## Grace episodes — bounded dunning, not indefinite retry

Once its grace anchor is known, `past_due` qualifies **only** inside a 14-day
window from the first failed charge on the earliest still-unpaid invoice of
the contiguous unpaid run — a **grace episode**, not "however long Stripe
keeps retrying." (See the fail-open exception below for the case where the
anchor isn't known yet.) Precedence between
a freshly-resolved anchor and a previously-stored one: the resolved value wins
only if it is strictly newer, so a duplicate or out-of-order webhook can never
walk the deadline backward on top of a more-authoritative apply. The fail-open
exception is narrower than "any unresolvable anchor": when the first failed
attempt can't be resolved (an incomplete invoice page, an ambiguous episode
boundary) **and no grace deadline is already stored for this source**, the
source **keeps qualifying** and the case is reported rather than guessed — a
guessed start date can only ever be too early, and too early means cutting
off someone who is still paying. If a deadline **is** already stored, the
refresh instead retries as a no-op and leaves that stored deadline in force
unchanged — including if it has already passed, in which case the source
reads as expired (disqualified) rather than fail-open, since the ambiguity
here is whether a new episode has started, not whether the old one is real.

## Refunds and disputes

For a **lifetime purchase**: a partial refund does not revoke — only a full
refund does, and the distinction requires the charge amount, which earlier
code never threaded into the refund handler at all. This is specifically the
`stripe_lifetime_payment` path (`prepareLifetimeRefund` in
`membershipRefresh.ts`); a subscription refund is recorded to history but does
not itself revoke anything — a subscription's access follows its lifecycle
status (i.e. cancellation), not a refund issued against one of its invoices.
A **lost chargeback is permanent**:
`dispute_loss_revoked_at` is set-once (the same `BEFORE UPDATE` trigger that
freezes identity), so no later refresh reporting the subscription `active` can
clear it. Every other terminal outcome — `won`, `warning_closed`, `prevented`
— clears the access hold the same way: `qualifySource` no longer disqualifies
the source *for the dispute* — but access is only actually restored if the
source's own lifecycle status still qualifies on its own terms; a
cancellation or refund that happened while the dispute was open isn't undone
by any of these. Dispute terminality is absorbing — a fifth
Stripe dispute
status the SDK might someday add gets `isRecognisedDisputeStatus` guarding it
rather than silently matching nothing.

## Reader inventory

Enumerated by searching the *column*, not the middleware — an earlier revision
secured `authMiddleware`/`tierMiddleware` and reasoned as though those were all
the readers. They weren't: `createMemeRecord.ts` (private-meme visibility, rate
limits, PuLID gate) and `budgetGate.ts` (spend limit) both read
`users.membership_tier` directly and are easy to miss because neither name
suggests "membership."

| Site | Reads for |
|---|---|
| `artifacts/api-server/src/middlewares/authMiddleware.ts` | everything downstream (~20 sites) |
| `artifacts/api-server/src/lib/createMemeRecord.ts` | private visibility, rate limit, PuLID gate |
| `artifacts/api-server/src/lib/budgetGate.ts` | spend limit (period is `budget_period`-configured: monthly or rolling 30-day) |
| `artifacts/api-server/src/lib/stripeStorage.ts` | the fact-of-the-day mailing list, the revocation notice |
| `artifacts/api-server/src/routes/admin.ts` | dashboard counts, the admin user list |
| `artifacts/api-server/src/routes/users.ts`, `artifacts/api-server/src/routes/auth.ts`, `artifacts/api-server/src/routes/localAuth.ts` | login/profile payloads |

**Every product-feature permission resolves through one function.**
`artifacts/api-server/src/lib/featureAccess.ts` is the chokepoint: it is the
only module permitted to read `tier_feature_permissions`, and
`scripts/check-permission-chokepoint.mjs` (wired into `build.yml`) fails the
build if anything else references the tier-keyed lookup or reads those tables.
Route code asks `can(principal, key)` — never about a tier string.

*Why the tier-keyed lookup had to become unreachable.* `membership_tier` is
only ever `unregistered | registered | legendary` — admin is an orthogonal
boolean, so an admin's stored tier is `registered` unless they separately hold
a paid entitlement. The grid's `admin` rows (seeded by `0028`/`0029`) were
therefore unreachable by construction: no caller ever passed `'admin'`. Every
gate where an admin should qualify grew a hand-written exception, thirteen-plus
of them in three different shapes, and two of those silently denied admins by
accident. Getting it wrong is invisible: the admin simply doesn't get the
feature, and because most legendary gates *are* role-based, the one that isn't
looks like it works. It cost a private meme being published — see
[`known-failure-patterns.md`](known-failure-patterns.md).

*What replaced it.* Resolution is a **union**, never an override:
`features(tier) ∪ (isAdmin ? features('admin') : ∅)`. The Admin column is live,
so toggling it changes behaviour with no deploy, and an admin who also holds a
paid entitlement never *loses* a feature by being an admin. Every gate fails
closed on a missing row, an unknown key, or a database error.

*Principal construction normalizes explicitly.* `req.user.membershipTier` is
not toggle-aware — "view as user" flips `isAdmin` but leaves the tier at the
account's real paid tier — so a naive read would give a legendary-holding admin
in preview mode every Legendary feature. `principalFromRequest` drops the tier
to `registered` when previewing. Feature gates honour the toggle deliberately;
operational privilege never does.

*Two rails, kept apart.* Operational privileges (console access, user
management, moderation, config) stay on `requireRole` over `realUserRole` and
are **not** grid features. That separation is what makes admin lockout
impossible by configuration: nothing that grants console access lives in the
grid. `adminIdentity.ts` is the single definition of "really an admin", over
all three grant mechanisms (stored column, `ADMIN_USER_IDS`,
`BOOTSTRAP_ADMIN_EMAIL`).

*Queued work is authorized as of submission.* `video_jobs.authorization_snapshot`
persists the resolved decision alongside the principal, and background paths
read it rather than re-resolving — otherwise an admin previewing as a user
would bypass every gate through the background path, and a grid change
mid-flight would retroactively change what a running job was allowed to do.

*The client is told, never derives.* `/auth/user` ships the resolved
entitlement map as a sibling of `user` (populated for anonymous callers too),
stamped with both `gridRevision` and `principalFingerprint`.
`GET /entitlements/version` is the revalidation probe and is never
shared-cached. `roleToTier` — the PR #402 function — is deleted.

All route through `effectiveTierExpr()` / `effectiveTierPredicate()` /
`effectiveTierForRow()` — an **expression**, not a stored predicate, because a
predicate is correct only when instantiated at `'legendary'`; at `'registered'`
a lapsed member matches neither branch and silently falls out of both counts.

**`unregistered` is an auth state, not an entitlement one**, and the derivation
must never promote out of it — a brand-new account has no entitlements to
derive from, and the no-source answer is `registered`, which would silently
grant registration capabilities to someone who never signed up. Every writer
that touches a user's tier (`recomputeMembership`, and the reinstatement
fail-closed override) checks this explicitly before writing.

**Deactivating an account is not the same as it having no entitlements.**
Soft-deletion (`is_active = false`) makes a best-effort attempt to cancel the
user's Stripe subscriptions at Stripe and locally — it queries only
`active`/`trialing` rows, so a grace-bound `past_due` subscription is left
untouched at both Stripe and locally, and a Stripe API failure on an
`active`/`trialing` row is logged and swallowed rather than blocking
deactivation. It does not touch `stripe_lifetime_payment` or `admin_grant`
sources, and it doesn't set the stored tier to `unregistered`. So a lifetime
purchase, an admin grant, or a subscription the cancellation attempt missed
or failed on can all survive deactivation still qualifying, which is exactly
why reinstatement re-verifies the retained sources rather than assuming
there's nothing left to check.

## The admin surfaces are entitlements, not fake payments or a tier field

**Comping a membership writes an `admin_grant` entitlement** — actor, reason,
timestamp, revocation semantics — never a tier and never a synthesized payment.
Before PR #287, a comp was a *fake purchase*: `stripeCustomerId: "admin_grant"`,
a fabricated payment-intent id, `amount: 0`. Anyone reading payment records —
including an operator reconciling revenue — couldn't tell a comp from a real
sale. At most one **active** admin grant per user (a partial unique index), so
two concurrent grants can't leave a second qualifying row behind a later
revoke. **Revoking mutates the grant row in place** (`writeAdminRevocation`
sets `lifecycleStatus: "revoked"` plus who/when/why on the same row) — it is
never deleted, but it is not append-only either; the row transitions
active → revoked rather than being superseded by a new row.
`membership_history` is the append-only record of that transition — nothing
ever removes a history row except through account deletion, where the user's
whole trail goes with the user.

**There is no membership-tier dropdown on editing an existing user in Admin →
Users.** Setting a tier by hand is exactly what this model removes for that
surface: the next recompute would silently overwrite it. `PATCH
/admin/users/:id` doesn't accept `membershipTier` for that reason. The Add
User modal is a separate surface and still renders a tier selector — choosing
Legendary there routes through `POST /admin/users`, which writes an
`admin_grant` rather than setting the field directly (see the source-type
table above).

**Reinstating a deactivated user re-verifies every Stripe-backed source before
restoring their tier**, and fails closed only over sources it genuinely
couldn't verify — see `refreshSourcesForReinstatement` /
`loadSourceStateVersions` in `membershipSources.ts` for the mechanics (a
per-source committed-version comparison, not a sequence watermark; see the
known-failure-patterns entry on why the watermark version was wrong). A
qualifying `admin_grant` alongside an unverifiable Stripe source is never
discarded by that fail-closed path — only sources the refresh actually
couldn't stand behind are.

## Known, accepted gaps

Two are stated here rather than only in review threads, so a fresh reader finds
them without archaeology:

1. **No repair for an event Stripe never successfully delivers — and not
   every delivered event type is modeled.** Every event type this system
   handles is authoritative, fenced and idempotent. But `prepareDomainEvent`'s
   `default: break` silently no-ops any event type it doesn't recognize,
   while the event is still claimed as processed — and this is reachable
   today, not merely theoretical: the managed webhook endpoint subscribes to
   every event type the sync library supports, which includes types with no
   `prepareDomainEvent` case (e.g. `customer.updated`, `product.updated`), so
   Stripe delivers and this path silently no-ops them in production now.
   Card-only checkout narrows only one specific corner of this — the
   delayed/async-payment scenario can't occur, so that particular case stays
   theoretical until a delayed-payment method is enabled — it doesn't mean
   unmodeled events in general go undelivered. And
   if Stripe's whole retry window for a *modeled* event fails, nothing sweeps
   up afterward and finds the discrepancy — and in the direction that costs
   money, nothing on the admin surface can either (grant/revoke only touch
   admin grants). See "Stripe↔local membership reconciliation" in
   [`deferred-work.md`](../engineering/deferred-work.md#code-level-tech-debt)
   for the design constraint that makes the delivery-failure half harder than
   "write the job": it can't enumerate from local rows, because a first
   purchase whose checkout webhook never landed leaves no row to scan.
2. **Entitlement sources don't record which Stripe mode created them.** A
   test-mode membership keeps granting Legendary after an operator flips
   `stripe_live_mode` to live. See
   [`current-roadmap.md`](./current-roadmap.md#pre-launch-hardening-must-do-before-go-live)
   for the fix shape and why the backfill semantics are a product decision,
   not a mechanic.

The **grace sweep** (`membershipGraceSweep.ts`, hourly by default —
`grace_sweep_interval_seconds`, operator-configurable) is not a mitigation for
either gap — it converges the *stored* `membership_tier` toward what
`effectiveTierExpr` already enforces on every read. If the sweep died
entirely, nobody would keep access past their deadline; only the stored
column's accuracy would drift, which is why it's safe to let it fail loudly
rather than building a guarantee on top of a background job's health.
