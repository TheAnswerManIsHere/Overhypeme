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
  payment, and not by setting a tier.
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

- Every source row carries `source_state_as_of` — a value from a **database
  sequence**, never a wall clock on an app instance. **Not `clock_timestamp()`**:
  two concurrent calls can return the *same* timestamp, and under a "strictly
  newer" guard that rejects a genuinely newer snapshot and never converges. The
  guard needs strict uniqueness as well as monotonicity, which only a sequence
  (or equivalent unique counter) gives. Acceptance includes simultaneous token
  allocation yielding distinct ordered values.
- A path that retrieves from Stripe takes the token **at retrieval time**,
  before the transaction, and carries it into the write. Two snapshots of the
  same subscription are then ordered by when they were *observed*, which is the
  ordering that actually matters — `Subscription.created` cannot provide this
  and neither can `Event.created` for route-side writes.
- **Admin** writes (grant / revoke) take the token inside the lock: they
  originate locally and are authoritative when they execute.
- **Stripe-mutating routes do not write provider state at all.** Cancel,
  reactivate and switch-plan (`routes/stripe.ts:419-425`, `:474-480`,
  `:634-643`) each complete their Stripe call *before* their local write, so a
  token minted after the lock orders **database application, not provider
  state**: a stalled route response can acquire the lock after a newer webhook
  has stored `canceled`, mint the highest token, and overwrite it with stale
  `active`. Instead, after mutating Stripe these routes invoke the **same
  authoritative-refresh path the webhook uses** — retrieve current state, take
  the token at retrieval, apply under the guard. That removes the special case
  rather than trying to order it.
- Inside the lock, a write whose token is not strictly newer than the stored
  `source_state_as_of` is rejected.

**Acceptance:** two retrievals of one subscription applied in reverse order
leave the newer state stored; **a delayed route response applied after a newer
webhook does not resurrect stale state**; an older snapshot can never win.

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
| `granted_by_admin_id`, `grant_reason` | W1b grant provenance, admin-grant only |
| `revoked_by_admin_id`, `revoked_reason`, `revoked_at` | W1b **revocation** provenance |
| `source_state_as_of` | the ordering token above |
| `created_at`, `updated_at` | |

Constraints: `UNIQUE (source_type, provider_ref)` where `provider_ref` is not
null (preserving today's two unique constraints and keeping idempotency);
`CHECK` that payment-backed rows have a `provider_ref` and admin grants have an
actor and reason; plus a **status-conditional** `CHECK` requiring
`revoked_by_admin_id`, `revoked_reason` **and** `revoked_at` on any admin grant
whose `lifecycle_status = 'revoked'`. Without that second constraint a row could
reach `revoked` with null provenance, which satisfies the letter of W1b's grant
clause while defeating its revocation clause. **No column has a fail-open
default** — qualification is always written explicitly.

**Because the membership tables hold no real data (David, 2026-07-28)**, the
migration creates the new table, drops the old two, and does **not** need a
dual-write boundary, a row-by-row mapping, or a resumable backfill. Rows are
rebuilt from authoritative Stripe state on first reconciliation.

Note what this does **not** remove: the reconciler's bounded-downgrade guard is
a permanent runtime control, not migration scaffolding, and is specified under
*Reconciliation*. An earlier revision listed it here among things the
pre-launch scope made unnecessary — that was wrong, and round 4 caught it.

**Rollback** is symmetric: recreate the two old tables from the snapshot
validator's prior state. This is only safe while the disposability assumption
holds.

**The migration itself must enforce this, not a human check beforehand.** A
re-verification performed before running the migration is not atomic with the
`DROP`: an old app instance can insert a payment row in between, and "the staged
approach comes back" is a sentence, not an executable fallback.

**A transaction alone is not enough.** Migrations run under an ordinary
`BEGIN` (`lib/db/src/migrate.ts:161`), and the advisory lock around them
serializes *migration runners*, not application inserts — so an old instance can
insert and commit after the assertion and before `DROP TABLE` takes its own
lock, losing a real payment row while the check reports success.

**Specification:** the migration takes an explicit `ACCESS EXCLUSIVE` lock on
**both** old tables *before* evaluating the predicate, so no insert can
interleave between the check and the `DROP`; asserts the disposable-row
predicate; and **aborts before any DDL** if it fails. Acceptance: a
barrier-tested insert racing the check/drop either blocks or fails, and in the
non-empty case both old tables and all rows survive intact.

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
detect a webhook that never arrived.

**Every Stripe-backed source type, not just subscriptions.** Revision 4 said
"enumerate subscriptions", which leaves a missed one-time checkout, refund or
dispute permanently unrepairable — a lifetime source could never be created or
corrected, breaking the same convergence invariant for the *other* half of the
model. Enumeration covers **subscriptions and one-time payments** (checkout
sessions / payment intents, plus charges for refunds and disputes), each with
pagination, deletions, rate limits and partial-failure handling. Acceptance adds
missed-lifetime-grant and missed-refund fixtures.

Runs on boot plus a schedule. Reports examined / unchanged / upgraded /
downgraded / ambiguous / failed / skipped. Ambiguous surfaced, never guessed;
history never deleted. It is also the grace-expiry trigger.

**Bounded downgrades — a permanent runtime guard, not migration scaffolding.**
Revision 4 dropped this as superseded by the pre-launch scope. That was wrong:
the no-live-members premise covers the *initial cutover only*, while this
reconciler runs forever. Once the database is populated, a bad classification, an
account mismatch, or a broad provider-state error can revoke every member, and
post-apply counts describe the damage rather than preventing it.

**Specification:** a DB-configured threshold on downgrade / ambiguity / error
counts, evaluated against the **pre-apply** change set, aborting **before any
mutation** and leaving the run visibly failed. Acceptance: an over-threshold run
changes no tiers and reports as failed.

### Portal configuration (D3)

Provision one explicit configuration per Stripe account via a controlled script
— not at boot, not in a request path. Store the id per environment; pass
`configuration` on every `billingPortal.sessions.create`; **fail closed** when
absent rather than falling back to the default. Deployment verification
retrieves it and confirms its feature/product allowlist. Recommend disabling
plan switching outright rather than restricting the price list.

## Phasing — collapsed to one model PR plus portal

**Three consecutive review rounds found the same class of defect**: something
Phase 1 needed had been left in Phase 2, so its stated "safe if Phase 2 never
lands" condition was false. Round 3 found the grace policy without an expiry
trigger. Round 4 found the expiry trigger with nothing to fire on, because the
refresh that opens a grace window was deferred. Round 5 found the refresh
present but **boot-only**, and the downgrade guard still deferred.

Each time I moved one component earlier and re-asserted the claim. The pattern
is the diagnosis: **the split was drawn in the wrong place.** Everything Phase 2
held turns out to be load-bearing for Phase 1's correctness — the recurring
cadence (a long-lived process never re-checks without it) and the
bounded-downgrade guard (Phase 1's own refresh can mass-revoke on a restart).

**So it ships as one model PR, plus one small independent PR:**

- **The model PR.** Normalised schema and migration, derivation, locking and the
  sequence token, trust boundary, bounded grace with its expiry sweep,
  authoritative source refresh **with its recurring cadence**, the
  **bounded-downgrade guard around every mutating refresh**, and all 15 mutation
  sites moved onto it. D1 and D2 close here.
- **Portal configuration.** D3 — genuinely independent of the entitlement
  model, touching only `billingPortal.sessions.create` and a provisioning
  script. Safe in either order.

The guard ships with the first mutating refresh, not after it: a boot-time
refresh on a populated database is exactly the mass-revocation risk the guard
exists to bound, and shipping them apart recreates the defect in a new place.

**A note on why this is not simply "one big PR".** The diff is large, but it is
one coherent change — a derived value and every writer of it — and the review
rounds have shown that carving it produces *incorrect* intermediate states
rather than smaller safe ones. Given no live data, a single cutover is also
cheaper to verify than a sequence of partial ones.

**A note on request authorization.** Authorization is rebuilt from
`membership_tier` on every request (`authMiddleware.ts:98-134`,
`tierMiddleware.ts:69-84`), so the cutover is instantaneous at deploy. Any
future attempt to stage this must be **shadow comparison only** — logging
derived-vs-stored while authorization continues to use the stored tier — with a
test asserting request authorization is unchanged.

## Admin grants replace admin tier-setting (David, 2026-07-28)

**Settled: both admin surfaces become entitlement grants.** An admin grants or
revokes an *entitlement*; the tier follows by derivation. No admin surface sets
`membership_tier` directly.

The product already concedes these are two disconnected mechanisms. After
revoking a lifetime entitlement, `users.tsx:299` tells the admin:

> *"Legendary for Life revoked. Tier not changed — use the tier selector above
> if needed."*

That sentence is the defect stated in the UI: revoking the entitlement leaves
the access it conferred in place, and a human is asked to remember the second
step. Under a derived model it stops being possible to get wrong.

**What changes:**

- **`admin.ts:159-160`** — `membershipTier` leaves the PATCH-editable field set.
- **`admin.ts:623-654`** — create-user stops accepting a tier. Creating a comped
  account **atomically writes an `admin_grant` entitlement** in the same
  transaction as the user, so the capability survives rather than being removed.
- **`admin.ts:188`** (`resolveUserTierOnReinstatement`) — reinstatement
  recomputes instead of resolving a tier itself.
- **`admin.ts:601`** (revoke-lifetime) — **marks the entitlement revoked rather
  than deleting the row**, per W1b's revocation semantics, recording revoking
  admin and reason; then recomputes. Deleting destroyed the provenance that W1b
  requires.
- **Grants require a reason** (W1b), which today's grant path does not collect.
- **`artifacts/overhype-me/src/pages/admin/users.tsx`** — the three-button tier
  selector is removed from both the edit panel (`:1111-1121`) and the add-user
  form (`:799-809`). Grant/revoke stay and become the only levers. The message
  at `:299` goes away because the condition it describes cannot occur.

**This is a visible admin-UI change**, not an internal refactor — it is the one
place in this plan where David will see something different. Tier becomes
*displayed* state everywhere in the admin UI, never *editable* state.

**Acceptance:** an admin grant keeps the user Legendary through a subscription
cancellation, a refund, and a reconciliation pass; revoking it recomputes rather
than unconditionally downgrading, so a user with another valid source keeps
access; reconciliation never attempts to validate an admin grant against Stripe;
and no admin surface can produce a tier that contradicts the entitlements.

## Open product questions

None. The `past_due` window (14 days), the normalisation depth, and the admin
grant model are all settled above.

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
| 4 | 1 | Backfill from current truth | **Resolved** (supersession overturned in round 4) — the migration now transactionally asserts disposability and aborts before DDL. |
| 5 | 1 | Terminal audit handling | **Resolved.** |
| 6 | 1 | Authoritative ingestion | **Resolved** via the unconditional version guard. |
| 7 | 1 | Automate reconciliation | **Resolved** — sources reconciled before recompute. |
| 8 | 2 | Retrieval vs lock composition | **Resolved.** |
| 9 | 2 | Bound automated downgrades | **Resolved** (supersession overturned in round 4) — restored as a permanent runtime guard; the pre-launch premise covered only the cutover, not a reconciler that runs forever. |
| 10 | 2 | Stage classification | **Resolved** (supersession overturned in round 4) — subsumed by the transactional migration guard above. |
| 11 | 2 | Reconcile sources before recomputing | **Resolved.** |
| 12 | 2 | Lifetime-revoke in serialization | **Resolved.** |
| 13 | 2 | Legendary at admin creation | **Resolved** — David settled it: both admin surfaces become entitlement grants; create-user atomically writes an `admin_grant`. |
| 14 | 3 | Enforceable monotonic version | **Resolved** — token is a DB-issued `source_state_as_of`, taken at retrieval for Stripe-sourced writes and under lock for local ones. Stripe exposes no usable version; ours does. |
| 15 | 3 | Specify the normalisation migration | **Resolved** — target DDL, keys and constraints stated; dual-write/backfill dropped as unnecessary given no live data. |
| 16 | 3 | Phase 2 authorization in shadow mode | **Resolved** — no read-only phase exists in the two-phase split; the per-request authorization path is documented so one is never added naively. |
| 17 | 3 | Ship grace expiry with the cutover | **Resolved** — local expiry sweep moved into Phase 1. My "known gap" framing was wrong. |
| 18 | 3 | Recover the original grace start | **Resolved** — episode start resolved from the earliest unpaid invoice, not the subscription. |

| 19 | 4 | Sequence token, not a clock | **Resolved** — `clock_timestamp()` is not unique under concurrency; a sequence is required. |
| 20 | 4 | Guard the empty cutover | **Resolved** — migration asserts the predicate transactionally. |
| 21 | 4 | Reconcile lifetime sources too | **Resolved** — enumeration covers one-time payments, refunds and disputes, not only subscriptions. |
| 22 | 4 | Restore downgrade bounds | **Resolved** — permanent pre-apply threshold and abort. |
| 23 | 4 | Move missed-event repair to Phase 1 | **Resolved** — authoritative refresh moves into Phase 1; the sweep alone could not start a grace window that was never opened. |
| 24 | 4 | Admin revocation provenance | **Resolved** — `revoked_at` plus a status-conditional constraint. |
| 25 | 5 | Schedule authoritative refresh in Phase 1 | **Resolved** — phasing collapsed; cadence ships with the model. |
| 26 | 5 | Downgrade bounds around every refresh | **Resolved** — the guard ships with the first mutating refresh. |
| 27 | 5 | Lock source tables before the disposability check | **Resolved** — explicit `ACCESS EXCLUSIVE` lock on both tables before the predicate; an ordinary `BEGIN` does not block application inserts. |
| 28 | 5 | Route tokens minted after provider I/O | **Resolved** — Stripe-mutating routes stop writing provider state and go through the authoritative-refresh path instead. |

| Round | Lens |
|---|---|
| 1 | Correctness of the derivation model + W1 compliance |
| 2 | Failure modes of the newly-added machinery |
| 3 | Implementability — is every mechanism buildable from what the pinned SDK and schema actually expose? |
| 4 | Whether the pre-launch simplification cut anything load-bearing — **it had: two of three supersessions were overturned** |
| 5 | Phase-boundary safety as a state space — **found the boundary wrong for the third time; the split has been removed** |
| 6 | The collapsed single-PR shape: does removing the boundary introduce anything the split was accidentally protecting? |
