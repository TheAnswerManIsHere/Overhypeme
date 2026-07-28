# Plan — Derive membership from entitlements, don't assign it per-event

> **Revision 4 — no longer redacted.** Earlier revisions withheld three
> findings from this channel under the repository's disclosure rule. Overhype
> is **pre-launch with no real payment data**, so that protection was guarding
> a harm that does not exist; the withheld material is folded in below and the
> private review channel is closed.
>
> The same fact removes most of revisions 2–3's complexity. The staged rollout,
> the three-valued classification state, the resumable backfill and the
> downgrade circuit breaker all existed to avoid revoking **real paying
> members mid-migration**. There are none. That scaffolding is gone.
>
> **What survives is the correctness work**, which is defective regardless of
> who is affected yet. Thirteen review findings across two Codex rounds plus
> seven from a second reviewer are all still honoured.

## Context

`users.membership_tier` is a **derived** value maintained by hand, by whichever
code path runs, each with disagreeing guards. Searching the **source tables**
(not the derived field) finds **15 mutation sites**:

| Site | Note |
|---|---|
| `membershipGrant.ts:102,134` | Grant paths |
| `webhookHandlers.ts:148,362,583,722` | Subscription upsert, refund, dispute, payment-failed |
| `routes/stripe.ts:423,478,641` | Cancel / reactivate / switch-plan write local state |
| `admin.ts:561` | Admin lifetime grant |
| `admin.ts:601` | Admin revoke-lifetime |
| `admin.ts:306-307` | User purge |
| `dataLifecycle.ts:24,28` | Data-lifecycle updates |

Plus 7 direct tier writers (`webhookHandlers.ts:81`, `membershipGrant.ts:144`,
`index.ts:151`, `admin.ts:569`, `admin.ts:159-160`, `admin.ts:188`,
`admin.ts:623-654`).

## The three defects this plan closes (previously withheld)

**D1 — the webhook grants lifetime membership without verifying payment.**
`handleOneTimePayment` (`webhookHandlers.ts:300-305`) constructs
`{ id, status: "succeeded", amount, currency }` — a **hardcoded literal** —
discarding the real PaymentIntent status retrieved six lines earlier in the
switch (`:660-665`). The switch also never checks `session.payment_status`.
The guard at `membershipGrant.ts:239` (`pi.status !== "succeeded"`) is
therefore structurally dead on this path: it compares a literal against itself.

The confirm endpoint does both checks correctly (`membershipGrant.ts:331`,
`:239`), so the two grant paths disagree — and `checkoutConfirm.test.ts:626`
proves the guard works while nothing tests that the webhook caller passes a
real status. That is why it survived review.

Exposure is **latent**: no delayed-notification payment method (ACH, SEPA,
Bacs, boleto, OXXO, Konbini, Pay by Bank, bank transfers, Canadian PADs) is
enabled on the live account. Enabling one makes it live, and enabling a payment
method is not a change anyone would route through security review.

**D2 — a delinquent subscription can retain access indefinitely.**
`customer.subscription.updated` (`webhookHandlers.ts:669-679`) acts only on
`active`/`trialing`/`canceled`. `invoice.payment_failed` (`:702-729`) marks the
local row `past_due` but never touches the tier. Stripe permits **"leave as
`past_due`"** as a *terminal* dunning outcome, so a permanently failing card
need never reach a handled status.

**D3 — the Customer Portal runs on the account default configuration.**
`routes/stripe.ts:357-360` creates portal sessions with no `configuration`
parameter, so whatever the Dashboard default permits is available — outside the
`overhype_membership` allowlist that every deliberate grant path enforces.
[Stripe documents](https://docs.stripe.com/api/customer_portal/sessions/create)
that omitting it uses the default configuration.

**Also live, found during review:** `reconcileMembershipTiers()`
(`index.ts:127-160`, run at `:399`) upgrades to `legendary` from
`subscriptions.status = 'active'` alone — **no allowlist check** — upgrade-only
and unconditional, on every boot.

## Product intent

Membership access must reflect what the user is actually entitled to, at all
times, regardless of which event arrives, **in what order**, or whether it
arrives at all.

## Must not change

- The `overhype_membership=true` allowlist stays the *product qualification*
  boundary, failing closed (`membershipPricing.ts`,
  `docs/ai-context/security-model.md`).
- Admins can still comp a membership — but through an entitlement, not a fake
  payment.
- History is append-only (`membership_history`, `stripe_webhook_audit`).
- No change to pricing, checkout UX, or the catalog-display path.

## Settled decisions

1. **Membership is derived, never assigned.** One module owns the write.
2. **Bounded grace: 14 days** from first failure (David). `past_due` qualifies
   only inside that window.
3. **Full entitlement-table normalisation** (David) with an explicit source
   discriminator. Cheap now — there is no live data to migrate.
4. Idempotency claim and domain processing share one transaction.
5. Reconciliation is automated.
6. A partial refund does not revoke a full entitlement.
7. Per-user serialization with an unconditional version guard.

## Constraints W1a / W1b

Revision 2 claimed a branded type made proof "un-forgeable at the type level."
**That was wrong and is withdrawn** — a type assertion defeats any brand, and a
validator taking caller-supplied Stripe-shaped objects proves only that its
arguments agree with each other.

> **W1a — paid entitlement provenance.** A durable *paid* entitlement may be
> created only from provider state retrieved **inside** the trusted boundary.
> The boundary accepts **identifiers only**.

> **W1b — non-payment entitlement authorization.** A durable *non-payment*
> entitlement may be created only through an authorized source type recording
> actor, reason, timestamp and revocation semantics, and must never masquerade
> as a payment.

The verifier takes a Checkout Session id, retrieves session and PaymentIntent
itself, and binds: session↔user/customer; mode is `payment`;
session↔PaymentIntent identity; `payment_status === "paid"` **and**
`pi.status === "succeeded"`; line items contain an allowlisted membership
product **with full pagination**; amount and currency from the authoritative
objects. A brand remains as an accidental-misuse guardrail only.

## The model

```
deriveEffectiveMembership(sources, now) -> {
  tier, qualifyingSourceIds, graceExpiresAt, reason
}
```

Pure, time-parameterised. **Set union, not priority** — Legendary if any valid
source qualifies.

Three separate concepts, not one flag: **`is_membership_product`** (allowlist
result, snapshotted at ingestion), **provider lifecycle status**, and **grace
validity**.

| Status | Qualifies |
|---|---|
| `active`, `trialing` | yes |
| `past_due` | only while `now < grace_expires_at` |
| `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused` | no |

Grace starts on first entry to `past_due` per delinquency episode; duplicate
events do not extend it; recovery clears it. `paused` is the
trial-without-payment-method status, not `pause_collection` (unused here).

**Recovering the episode start when the failure webhook was missed.** "14 days
from first failure" is unimplementable from the subscription alone — the Stripe
`Subscription` type carries no first-failure or status-transition timestamp, so
a reconciler discovering `past_due` for the first time can only revoke
immediately (null deadline) or start a *fresh* 14 days, both wrong.

The authoritative source is the **invoice**, not the subscription: the episode
began with the earliest still-unpaid invoice for that subscription in the
current delinquency. Reconciliation and any grace initialisation resolve
`grace_started_at` from that invoice's timestamp, and match episodes by
"contiguous run of unpaid invoices ending at the present" so a *previous,
resolved* delinquency does not backdate a new one.

**Acceptance:** a subscription whose `invoice.payment_failed` was never
delivered still yields the original deadline, not a fresh window.

**Grace expiry needs its own trigger** — no Stripe event fires when a deadline
lapses. This is a **local** scheduled sweep (rows where
`grace_expires_at < now()`, recompute), independent of Stripe enumeration, and
it ships in **Phase 1 with the policy it enforces**. Deferring it to the
reconciliation phase would leave bounded grace unbounded in the interim, which
is the same indefinite-access defect this plan exists to close.

### Concurrency

1. Stripe retrieval happens **outside** any transaction — no lock is held
   across network I/O.
2. Then a short transaction: `SELECT … FOR UPDATE` on the user row, then apply.
3. **Every source write carries an unconditional monotonic version guard** —
   reject any write not newer than the stored value.
4. Lock timeout and retry defined.
5. Notification emitted only after a committed tier transition.

**The ordering token, named explicitly.** Revision 3 required a guard without
saying what orders it, which is not implementable: the pinned Stripe 20.0.0
`Subscription` type exposes only `created` (object creation), **no mutation
version or update timestamp**, and the route-side writes in `routes/stripe.ts`
have no Stripe event to order by at all.

The token is **ours, not Stripe's**:

- Every source row carries `source_state_as_of` — a monotonic value obtained
  from the **database** (`clock_timestamp()` / a sequence), never a wall clock
  on the app instance, so multiple instances cannot disagree.
- A path that retrieves from Stripe takes the token **at retrieval time**,
  before the transaction, and carries it into the write. Two snapshots of the
  same subscription are then ordered by when they were *observed*, which is the
  ordering that actually matters — `Subscription.created` cannot provide this
  and neither can `Event.created` for route-side writes.
- Locally-originated writes (cancel / reactivate / switch-plan, admin
  grant/revoke) take the token inside the lock: they are authoritative at the
  moment they execute.
- Inside the lock, a write whose token is not strictly newer than the stored
  `source_state_as_of` is rejected.

**Acceptance:** two retrievals of one subscription applied in reverse order
leave the newer state stored; a route-side write concurrent with a webhook
write converges; an older snapshot can never win.

### Schema

"Normalisation" is not a specification, and the two source tables are not
trivially unionable — `subscriptions` requires `stripe_subscription_id` and
carries lifecycle fields (`status`, `current_period_end`, `cancel_at_period_end`),
while `lifetime_entitlements` requires `stripe_payment_intent_id` and carries
`amount`/`currency`/`status`. The target must be stated as DDL, not as an
intention.

**Target: one `membership_entitlements` table.**

| Column | Note |
|---|---|
| `id` | identity PK |
| `user_id` | FK → `users.id`, indexed |
| `source_type` | `stripe_subscription` / `stripe_lifetime_payment` / `admin_grant` |
| `provider_ref` | subscription id, payment-intent id, or null for admin grants |
| `is_membership_product` | allowlist result, snapshotted at ingestion |
| `lifecycle_status` | Stripe status for subscriptions; `active`/`refunded` for lifetime; `active`/`revoked` for admin grants |
| `current_period_end`, `cancel_at_period_end` | subscription-only, nullable |
| `amount`, `currency` | payment-backed only, nullable |
| `grace_started_at`, `grace_expires_at` | delinquency window, nullable |
| `granted_by_admin_id`, `grant_reason`, `revoked_by_admin_id`, `revoked_reason` | W1b provenance, admin-grant only |
| `source_state_as_of` | the ordering token above |
| `created_at`, `updated_at` | |

Constraints: `UNIQUE (source_type, provider_ref)` where `provider_ref` is not
null (preserving today's two unique constraints and keeping idempotency);
`CHECK` that payment-backed rows have a `provider_ref` and admin grants have an
actor and reason. **No column has a fail-open default** — qualification is
always written explicitly.

**Because the membership tables hold no real data (David, 2026-07-28)**, the
migration creates the new table, drops the old two, and does **not** need a
dual-write boundary, a row-by-row mapping, or a resumable backfill. Rows are
rebuilt from authoritative Stripe state on first reconciliation.

**Rollback** is symmetric: recreate the two old tables from the snapshot
validator's prior state. This is only safe while the disposability assumption
holds.

**Because the membership tables hold no real data (David, 2026-07-28), this is
an ordinary migration.** No staged rollout, no three-valued classification
state, no resumable backfill, no downgrade circuit breaker — all of which
existed solely to protect live members. Existing rows are rebuilt from
authoritative Stripe state on first reconciliation.

**This assumption is load-bearing and must be re-verified immediately before
the migration runs**, not just asserted here. If the tables have acquired real
memberships by then, the staged approach from revision 3 comes back.

### Webhook transaction boundary

Wrap the idempotency claim (`webhookHandlers.ts:1172`) and domain processing in
one transaction (precedent: `admin.ts:~560`), so a handler throw rolls the claim
back and Stripe's retry can succeed.

Audit writes stay **outside** it so a `failed` record survives rollback, with
the post-commit case specified too: a committed mutation whose `processed`
audit insert fails leaves the trail showing only `received`. Recovery is a query
for claims lacking a terminal audit row.

### Reconciliation

**Reconciles sources, then recomputes** — recomputing from local rows can never
detect a webhook that never arrived. Enumerates authoritative Stripe
subscriptions with pagination, deletions, rate limits and partial-failure
handling; updates source rows; then derives.

Runs on boot plus a schedule. Reports examined / unchanged / upgraded /
downgraded / ambiguous / failed / skipped. Ambiguous surfaced, never guessed;
history never deleted. It is also the grace-expiry trigger.

### Portal configuration (D3)

Provision one explicit configuration per Stripe account via a controlled script
— not at boot, not in a request path. Store the id per environment; pass
`configuration` on every `billingPortal.sessions.create`; **fail closed** when
absent rather than falling back to the default. Deployment verification
retrieves it and confirms its feature/product allowlist. Recommend disabling
plan switching outright rather than restricting the price list.

## Phasing

The four-phase split was premised on migration risk that no longer exists.
**Two PRs:**

- **Phase 1 — the model.** Normalised schema, derivation, locking and the
  ordering token, trust boundary, bounded grace **and its local expiry sweep**,
  and all 15 mutation sites moved onto it. D1 and D2 close here. Coherent as one
  change because the schema and its only consumers land together.
- **Phase 2 — reconciliation and portal.** The Stripe-enumerating reconciler
  and D3's portal configuration.

**Phase 1 must be safe if Phase 2 never lands.** Revision 4 initially put grace
expiry in Phase 2 and called the gap "known, not broken" — that was wrong.
Bounded grace whose bound never fires is unbounded access, which is D2 wearing
a different hat. The expiry sweep is local (no Stripe enumeration needed) and
moves into Phase 1 with the policy it enforces.

**A note on cutover timing.** Request authorization is rebuilt from
`membership_tier` on every request (`authMiddleware.ts:98-134`,
`tierMiddleware.ts:69-84`), so there is no such thing as wiring derivation "for
reads only" — the moment derivation feeds that path, effective access changes.
The two-phase split avoids this by never staging a read-only phase. If one is
ever reintroduced, it must be **shadow comparison only**, logging derived-vs-
stored while authorization continues to use the stored tier, with a test
asserting request authorization is unchanged.

D1 no longer ships standalone ahead of these (David's earlier call): with the
disclosure split closed and no real customers, its urgency was the reason for
separating it, and both premises are gone. It lands in Phase 1.

## Open product questions

**One.** Two admin surfaces set a tier directly — the user-edit PATCH
(`admin.ts:159-160`) and create-user (`admin.ts:623-654`). Both are incoherent
under a derived model; the reconciler silently undoes them. Recommend both
become entitlement grants (option 1 as put to David). Same underlying question,
so they should be answered together.

## External-claim verification

Checked 2026-07-28:
[subscription lifecycle and dunning](https://docs.stripe.com/billing/subscriptions/overview)
(source of the terminal-`past_due` correction and the `paused` semantics);
[portal session default configuration](https://docs.stripe.com/api/customer_portal/sessions/create);
[portal configuration features](https://docs.stripe.com/api/customer_portal/configurations/create)
— which has **no pause feature**, so a suggestion to model one was dropped.

**Unresolved and to be settled empirically, not from docs:** whether **Pix** or
**Stablecoins/Crypto** — both enabled on the live account, neither on Stripe's
documented delayed-notification list, both settling out-of-band — emit an
unpaid `checkout.session.completed`. Capture the event sequence in sandbox
(where both are enabled) and preserve fixtures as regression tests.

## Verification

- **Pure derivation** — no sources; one active; multiple with one canceled;
  lifetime plus canceled subscription; admin grant plus refunded lifetime;
  past-due within and beyond grace; unpaid after past-due; recovered; revoked
  admin grant with another active source.
- **Trust boundary** — fabricated Stripe-shaped values cannot reach
  persistence; wrong customer/session/product/amount fails closed; paginated
  line items handled; unpaid completed grants nothing; later async success
  grants exactly once; later async failure grants nothing.
- **Concurrency** — barrier-interleaved removal against grant, asserting
  sources, tier, history **and notification count**; stale event after newer;
  duplicate workers; reconciliation racing webhook processing.
- **Reconciliation** — omitted cancellation webhook detected *and the source
  row repaired*; pagination; rate-limit backoff; partial failure; idempotent
  repeated apply; grace expiry revokes with no Stripe event.
- **Portal** — missing/invalid configuration fails closed; sessions always
  carry the explicit id.
- **Gates** — `pnpm run check:codegen-drift`, migration-snapshot validator,
  `node scripts/check-docs-accuracy.mjs` run bare.

## Findings ledger

| # | Round | Finding | Status |
|---|---|---|---|
| 1 | 1 | Payment proof authority-created | **Resolved** via W1a (branded-type resolution superseded). |
| 2 | 1 | Serialize per-user mutations | **Resolved** via the round-2 composition fix. |
| 3 | 1 | Route every tier write centrally | **Resolved** — 15 source-mutation sites enumerated. |
| 4 | 1 | Backfill from current truth | **Superseded by scope** — no live data to backfill; re-verify before migrating. |
| 5 | 1 | Terminal audit handling | **Resolved.** |
| 6 | 1 | Authoritative ingestion | **Resolved** via the unconditional version guard. |
| 7 | 1 | Automate reconciliation | **Resolved** — sources reconciled before recompute. |
| 8 | 2 | Retrieval vs lock composition | **Resolved.** |
| 9 | 2 | Bound automated downgrades | **Superseded by scope** — no live members to protect; reporting retained. |
| 10 | 2 | Stage classification | **Superseded by scope** — staged rollout removed with the migration risk. |
| 11 | 2 | Reconcile sources before recomputing | **Resolved.** |
| 12 | 2 | Lifetime-revoke in serialization | **Resolved.** |
| 13 | 2 | Legendary at admin creation | **Escalated** — with the admin PATCH, as one question. |
| 14 | 3 | Enforceable monotonic version | **Resolved** — token is a DB-issued `source_state_as_of`, taken at retrieval for Stripe-sourced writes and under lock for local ones. Stripe exposes no usable version; ours does. |
| 15 | 3 | Specify the normalisation migration | **Resolved** — target DDL, keys and constraints stated; dual-write/backfill dropped as unnecessary given no live data. |
| 16 | 3 | Phase 2 authorization in shadow mode | **Resolved** — no read-only phase exists in the two-phase split; the per-request authorization path is documented so one is never added naively. |
| 17 | 3 | Ship grace expiry with the cutover | **Resolved** — local expiry sweep moved into Phase 1. My "known gap" framing was wrong. |
| 18 | 3 | Recover the original grace start | **Resolved** — episode start resolved from the earliest unpaid invoice, not the subscription. |

| Round | Lens |
|---|---|
| 1 | Correctness of the derivation model + W1 compliance |
| 2 | Failure modes of the newly-added machinery |
| 3 | Implementability — is every mechanism buildable from what the pinned SDK and schema actually expose? |
| 4 | Whether the pre-launch simplification cut anything load-bearing |
