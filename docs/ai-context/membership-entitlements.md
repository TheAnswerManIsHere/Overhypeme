# Membership & Entitlements

> **Source of truth:** `artifacts/api-server/src/lib/membershipState.ts`
> (derivation), `membershipSources.ts` (writes), `membershipRefresh.ts`
> (Stripe-facing refresh), `entitlementVerification.ts` (trust boundary),
> `membershipLease.ts` (concurrency), `webhookHandlers.ts` (event entry),
> `membershipGraceSweep.ts` + `membershipSchedules.ts` (the background sweep).
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

**A tier read is not an entitlement check when admins are meant to qualify.**
`membership_tier` is only ever `unregistered | registered | legendary` — admin
is an orthogonal boolean, so an admin's stored tier is `registered` unless they
separately hold a paid entitlement. `tier_feature_permissions` is keyed by
tier, and its `admin` rows (seeded by migrations `0028`/`0029`) are therefore
unreachable through `hasFeature(membershipTier, …)`: no caller ever passes
`'admin'`. Any gate that should treat admin as legendary must resolve from the
**role** — `isAtLeastLegendary(deriveUserRole(tier, isAdmin))` — either instead
of, or OR-ed with, the feature lookup (`facts.ts`'s captcha bypass and
`createMemeRecord`'s private-visibility gate both do the latter). Getting this
wrong is silent by construction: the admin simply doesn't get the feature, and
because most legendary gates in the codebase *are* role-based, the one that
isn't looks like it works. It cost a private meme being published — see
[`known-failure-patterns.md`](known-failure-patterns.md). The remaining
tier-only lookups (`meme_rate_limit_high`, `meme_ai_background`,
`video_generation`) still deny admins by this mechanism; each fails closed, so
none is a leak, but none has been deliberately adjudicated either.

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
