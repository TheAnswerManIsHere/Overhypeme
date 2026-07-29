# Plan — Derive membership from entitlements, don't assign it per-event

> **Revision 10 — the migration machinery is deleted (David, 2026-07-29).**
> Rounds 6–9 built bridge triggers, compatibility views, a cutover marker, a
> revert precondition and a contract gate so a schema change could survive
> old and new instances overlapping during an autoscale rollout. David cut all
> of it: **Overhype is pre-launch with no real accounts, so that machinery
> protects nothing.** The migration is a plain create-and-drop.
>
> Two of those mechanisms were also unbuildable — a PostgreSQL view cannot
> serve the legacy `ON CONFLICT (col) DO UPDATE` (verified on 16.13), and no
> available signal proves an old instance has stopped serving.
>
> **What survives is the correctness work**, which is defective regardless of
> how many users exist: the derivation model, the trust boundary, per-user
> serialization, read-path expiry enforcement, the webhook transaction
> boundary, reconciliation and its bounded-downgrade guard. Round 4 established
> the line this revision applies — *shed historical-data protection, keep
> permanent runtime controls* — and the kept/cut table under **The migration
> is a plain create-and-drop** states it explicitly so the cut is auditable
> rather than assumed.
>
> The redaction was lifted at revision 4; D1/D2/D3 are described in full below.

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
- History is append-only **except account deletion** (`membership_history`,
  `stripe_webhook_audit`). The admin purge deletes a user's trail with the
  user; nothing else removes a row. Scoped this way deliberately — see
  *Open product questions*. Revisit at launch.
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
8. **Both admin surfaces become entitlement grants** (David) — the grant/revoke
   endpoints and admin user-creation write an `admin_grant` entitlement, never a
   tier and never a synthesized payment.
9. **Grace expiry is enforced on the read path**, not by a scheduled job; the
   sweep converges stored state rather than being the mechanism.

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
it ships with the policy it enforces.

**A sweep cannot be the enforcement mechanism.** Authorization reads the
*stored* `membership_tier` (`authMiddleware.ts:98-134`,
`tierMiddleware.ts:69-84`), so a deadline passing revokes nothing until the
sweep runs — and a sweep is a job that can fail. Revision 7 answered this with
an hourly cadence and a six-hour alert, which bounds the *good* case and leaves
the bad one unbounded: bounded retry eventually stops, and an alert **reports**
a wedged sweeper rather than expiring anyone. A guarantee that holds only while
a background job is healthy is not a guarantee.

**Enforcement moves to the read path; the sweep becomes convergence.**

- `users` gains **`membership_valid_until`** (nullable timestamptz), written by
  the same single derivation that writes `membership_tier`.
- Authorization applies one comparison: if `membership_valid_until` is
  non-null and `now() >= membership_valid_until`, the request is served at the
  **non-qualifying** tier regardless of the stored `membership_tier`.
- The sweep still runs **hourly** and still recomputes expired rows, but its
  job is now to make the stored tier *agree* with what authorization is already
  enforcing. If it dies, access is still revoked on the deadline; what degrades
  is the accuracy of the stored value, which the six-hour alert surfaces.

**It is the union's horizon, not one source's deadline.** `graceExpiresAt` is
singular and the model is a **set union**, so persisting "the" deadline is
undefined the moment a user has two sources. A lifetime or admin entitlement
alongside a past-due subscription is the concrete case: writing the
subscription's deadline would revoke a user who holds a source that never
expires.

`membership_valid_until` is therefore defined over the **whole qualifying set**:

| Qualifying sources | Value |
|---|---|
| Any that is indefinitely valid (`active`/`trialing` subscription, unrefunded lifetime, active admin grant) | **null** — no expiry |
| Only grace-bound sources | **max** of their deadlines — the last moment any of them still qualifies |
| None | null; the tier is already non-qualifying |

`deriveEffectiveMembership` returns this horizon rather than a per-source
deadline, so the same function answers both questions and they cannot disagree.
Acceptance covers coexistence directly: lifetime + past-due subscription stays
Legendary past the subscription deadline; two past-due subscriptions expire at
the later of the two, not the earlier.

**Every reader of the tier must apply it, not just the middleware.** I specified
this against `authMiddleware.ts:98-134` and `tierMiddleware.ts:69-84` and
reasoned as though those were the only readers. They are not, and the others
make **authorization and spending** decisions, not display:

| Site | Decision made from the stored tier |
|---|---|
| `createMemeRecord.ts:149-179` | private-visibility, high rate limit, PuLID gate |
| `budgetGate.ts:77-98` | which monthly spend limit applies |

**A row helper is not enough — some readers filter in SQL.** I specified
`getEffectiveMembership(userId | userRow)` and then found readers that cannot
call it, because they select or count *before* any row exists to pass:

| Set-based reader | What it does |
|---|---|
| `stripeStorage.ts:55-63` (`getActiveLegendarySubscribers`, used by `factOfTheDay.ts:73`) | `WHERE membership_tier = 'legendary'` — the mailing recipient list |
| `admin.ts:2543-2556` | `count(*) WHERE membership_tier = 'legendary'` — the admin dashboard |

Both would keep counting and **emailing** expired members. This is the third
time in this review I have enumerated one shape of consumer and reasoned as
though it were all of them.

**Specification:** the effective tier is expressed **twice, from one
definition** —

- **`effectiveTierPredicate`** — a reusable SQL fragment
  (`membership_tier = $1 AND (membership_valid_until IS NULL OR
  membership_valid_until > now())`) that every set-based query composes into its
  `WHERE`. Set readers use this; they do not filter on the raw column.
- **`getEffectiveMembership(userId | userRow)`** — the row helper, for
  request-path consumers.

The predicate is the primitive and the helper is defined in terms of it, so
they cannot drift. **Acceptance: a user whose grace has expired appears in
neither the mailing list nor the admin count**, and the two agree with the row
helper for the same user.

Every consumer goes through one of the two — the two middlewares, both sites above, and any
future reader. The raw column is never read for an authorization or spending
decision. Implementation begins by enumerating every reader of
`users.membership_tier` the way the mutation-site inventory was built (search
the column, not the middleware), and the inventory goes in the PR body.

This is **not** a second derivation, and that distinction is the whole reason
it is acceptable. The derivation still computes both the tier and the instant
its validity lapses in the absence of new events; the middleware evaluates a
stored timestamp against the clock. No policy — not the status table, not the
14-day window, not the episode-start rule — is duplicated in the hot path.
Synchronously *re-deriving* on every request was rejected for exactly the
reason this avoids: it would put a second copy of the policy where it can drift.

**Guarantee:** revocation at the deadline, enforced, independent of scheduler
health. Acceptance: advance a fake clock past the deadline with no Stripe event
**and with every sweep attempt failing**, and assert the request is denied
anyway; then assert a healthy sweep converges the stored tier.

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
- **Per-source serialization, because no token ordering works.** Revision 10
  moved the token to *after* retrieval; revision 11 moved it to *before*.
  **Both are wrong, and the second was wrong for a reason my own text
  admitted.** Taking the token before issuance orders *requests*, not *state*:
  request A takes token 1, stalls past a cancellation and returns `canceled`;
  request B takes token 2, is served older `active` state, and wins on the
  larger token. Access is resurrected. I wrote "a later-issued request may see
  older state" and then called the scheme fail-safe in the next sentence.

  There is no token that fixes this, because the ordering we need is over
  **provider state** and nothing available to us derives from it: the pinned
  Stripe `Subscription` exposes no version or mutation timestamp, and any
  locally-allocated number orders our own activity instead.

  **Specification: one retrieval-and-apply in flight per source at a time.**

  - Before retrieving, a path acquires a **lease** on `(source_type,
    provider_ref)` — a row in a lease table claimed in a short transaction that
    **commits immediately**, or an equivalent advisory lock taken outside any
    open transaction.
  - The Stripe retrieval happens with **no transaction open** — invariant 1 is
    unchanged, and this is the distinction that makes the lease admissible
    where a `FOR UPDATE` row lock is not. A lease is a committed row; it pins
    no connection and blocks no unrelated query.
  - The short apply transaction then runs, and the lease is released.
  - Leases carry an **expiry** so a crashed holder cannot wedge a source
    forever, and a waiter that times out **abandons its write** rather than
    proceeding unordered — reconciliation repairs it.

  With one retrieval in flight per source, completion order *is* issuance
  order *is* state order, and the guarantee finally holds rather than being
  asserted.

  `source_state_as_of` **stays**, now doing a narrower and honest job: it
  rejects a write from a lease-holder that lost its lease to expiry and came
  back late. It is a safety net against the lease's own failure mode, not the
  ordering mechanism.

  **Cost, stated plainly:** concurrent updates to the *same* subscription now
  queue instead of racing. Different subscriptions are unaffected, and the
  queue depth per source is bounded by how many events Stripe sends about one
  object at once — small.

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

**Acceptance:** the exact interleaving that defeated both token schemes — a
retrieval that stalls past a cancellation and returns `canceled`, racing a
later-issued retrieval served older `active` state — leaves **`canceled`**
stored; a lease expiring under a slow holder causes that holder's write to be
rejected rather than applied late; **a delayed route response applied after a
newer webhook does not resurrect stale state**. The claim is now *under the
lease, an older snapshot cannot win* — earlier revisions asserted that
unconditionally, which is what round 11 disproved.

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
| `user_id` | FK → `users.id` **`ON DELETE CASCADE`**, indexed — the admin purge deletes users, and entitlements should go with them |
| `source_type` | `stripe_subscription` / `stripe_lifetime_payment` / `admin_grant` |
| `provider_ref` | subscription id, payment-intent id, or null for admin grants |
| `is_membership_product` | allowlist result, snapshotted at ingestion |
| `lifecycle_status` | Stripe status for subscriptions; `active`/`refunded` for lifetime; `active`/`revoked` for admin grants |
| `current_period_end`, `cancel_at_period_end` | subscription-only, nullable |
| `amount`, `currency` | payment-backed only, nullable |
| `grace_started_at`, `grace_expires_at` | delinquency window, nullable |
| `granted_by_admin_id`, `granted_by_admin_label`, `grant_reason` | W1b grant provenance, admin-grant only — see *actor durability* |
| `revoked_by_admin_id`, `revoked_by_admin_label`, `revoked_reason`, `revoked_at` | W1b **revocation** provenance |
| `source_state_as_of` | the ordering token above |
| `created_at`, `updated_at` | local row timestamps |

Constraints: `UNIQUE (source_type, provider_ref)` where `provider_ref` is not
null (preserving today's two unique constraints and keeping idempotency);
**plus a partial unique index giving at most one *active* `admin_grant` per
user** — `UNIQUE (user_id) WHERE source_type = 'admin_grant' AND
lifecycle_status = 'active'`. The main constraint excludes admin grants
entirely, because their `provider_ref` is null, so nothing stopped two
concurrent submissions or a retry after an uncertain response from creating
**two** active grants; a later revoke would mark one and leave the other
qualifying, and the user stays Legendary after being revoked. Re-granting
after a revoke is permitted — the partial index only constrains *active* rows —
and grant/revoke run under the same per-user serialization as every other
mutation, so the index is a backstop rather than the only defence.
**Acceptance: concurrent grants, a duplicate retry, revoke, and grant-after
-revoke.**
`CHECK` that payment-backed rows have a `provider_ref` and admin grants have an
actor and reason; plus a **status-conditional** `CHECK` requiring
`revoked_by_admin_id`, `revoked_reason` **and** `revoked_at` on any admin grant
whose `lifecycle_status = 'revoked'`. Without that second constraint a row could
reach `revoked` with null provenance, which satisfies the letter of W1b's grant
clause while defeating its revocation clause. **No column has a fail-open
default** — qualification is always written explicitly.

**Actor durability — a grantor can be purged too.** `granted_by_admin_id` and
`revoked_by_admin_id` reference `users.id`, and the admin purge deletes users.
Every available FK behaviour is wrong on its own: `CASCADE` would delete a
*recipient's* entitlement because the granting admin left; `RESTRICT` would
block admin account deletion outright; `SET NULL` would satisfy the FK and then
violate W1b's own `CHECK`, which requires an actor.

So provenance does not depend on the FK surviving. Each actor is recorded
**twice**: the FK id, and a **`_label` text snapshot**. The id is
`ON DELETE SET NULL`; the label is `NOT NULL`.

**The label is anonymized on hard delete — it is not immutable.** Revision 11
said "captured at grant/revoke time and never updated", which put a purged
admin's email in another user's row forever and **contradicts this repo's own
retention policy**: `docs/data-lifecycle-retention-matrix.md` requires *full
removal on hard-delete* for profile PII, and for payment records
*"irreversible anonymization instead of deletion where financial audit
integrity is required — preserve transaction integrity while removing direct
identifiers."*

That policy already answers the question, so it is applied rather than
escalated: on hard delete the label is **overwritten with a stable
non-identifying token** (`deleted-admin-<opaque>`, derived so that two grants
by the same purged admin remain recognisably the same actor). Audit integrity
survives — you can still tell one actor from another and see that a human did
it — and the direct identifier is gone. That is exactly the trade the matrix
describes.

**David should know this changes what an audit trail shows** — a purged
admin's grants read as an opaque actor rather than a name — but it follows
existing policy, so it is not a new decision unless he wants the policy
changed. The provenance
`CHECK` requires **the label**, not the id — so purging a grantor nulls a
convenience join and leaves the attribution intact, which is what W1b actually
asks for. It also fixes a subtler problem the FK always had: an admin who is
renamed changes the meaning of every historical grant attributed to them.

**Acceptance:** purge an admin who granted and revoked another user's
entitlement; the recipient's entitlement survives, its `lifecycle_status` is
unchanged, the actor id is null, the label still names who did it, and the
provenance `CHECK` still passes.

**Because the membership tables hold no real data (David, 2026-07-28)**, no
dual-write boundary, row-by-row mapping or resumable backfill is needed. Rows
are rebuilt from authoritative Stripe state on first reconciliation.

Note what this does **not** remove: the reconciler's bounded-downgrade guard is
a permanent runtime control, not migration scaffolding, and is specified under
*Reconciliation*. An earlier revision listed it here among things the
pre-launch scope made unnecessary — that was wrong, and round 4 caught it.

#### The migration is a plain create-and-drop (David, 2026-07-29)

`.replit` sets `deploymentTarget = "autoscale"`, so old and new instances
overlap during a rollout. Revisions 6–9 tried to make the schema change survive
that overlap. **That work is deleted.** David's decision, and the reasoning
behind it, is the standing pre-launch rule in
[`agent-working-rules.md`](../ai-context/agent-working-rules.md#pre-launch-no-legacy-burden--bias-to-clean-bold-changes):
deployment-overlap compatibility protects a few seconds of requests from users
who **do not exist**, which makes it migration paranoia, not runtime
correctness.

Two of the mechanisms were also **unbuildable**, which is worth recording so
nobody re-proposes them:

- A PostgreSQL view **cannot** serve `INSERT … ON CONFLICT (col) DO UPDATE` —
  the statement fails at planning, before any `INSTEAD OF` trigger runs
  (verified on 16.13). Both `webhookHandlers.ts:148-159` and
  `membershipGrant.ts:102-113` use exactly that shape.
- No signal available to us proves an old instance has stopped serving. A
  quiet period is satisfied trivially by an **idle** instance.

**Specification — one deploy, one migration, no compatibility layer:**

1. Deploy the new build. `runMigrations()` creates `membership_entitlements`
   and drops `subscriptions` and `lifetime_entitlements` before the process
   listens (`index.ts:270`). There is no data to preserve — the membership
   tables hold nothing real (David, 2026-07-28) — so this is a create-and-drop,
   not a backfill.
2. Reconciliation rebuilds every Stripe-backed source from the provider on its
   first run.

**There is no maintenance gate, and none is being built.** Revision 10 opened
this runbook with "put the site in maintenance", which was a step I wrote
without checking whether the control exists. It does not: there is no
maintenance flag, middleware or deploy-time gate anywhere in `.replit`,
`artifacts/`, `lib/` or `scripts/` — the only `maintenance` matches in the repo
are async-job housekeeping and test scripts. Building one would be new
infrastructure whose entire job is to protect requests from users who do not
exist, which is the thing this revision exists to stop doing.

What actually happens during the rollout is therefore worth stating plainly
rather than dressing up: **old instances that are still serving will error when
they query the dropped tables, for as long as the rollout takes.** Pre-launch
that costs nothing. Stripe retries any webhook delivered in that window for up
to three days, and reconciliation would repair a permanently missed one anyway
— the same convergence the model relies on in normal operation, not a special
case for the migration.

**The migration must be re-runnable, and mostly already is.** `migrate.ts`
tracks applied migrations by SHA-256 of the file and treats DDL that fails
because the object already exists (or is already gone) as pre-applied, skipping
it via `SAVEPOINT` recovery — its `ALREADY_APPLIED` codes include `42P07`
(duplicate table) and `42P01` (undefined table), which are exactly the two
cases here. The migration still uses `CREATE TABLE IF NOT EXISTS` /
`DROP TABLE IF EXISTS` rather than relying on that recovery path, because
depending on error-code rescue for expected conditions is fragile.
**Acceptance: run the migration twice against the same database and assert the
second run is a clean no-op**, not merely that it does not throw.

**Recovery is roll-forward-only. Redeploying the previous build does not
work,** and revision 10 claimed it did. `migrate.ts` skips any journal entry
whose hash is already recorded, so the old build's startup sees the original
table-creation migration as applied and then queries relations that no longer
exist — the site stays down. Restoring the old schema would require authoring a
*new* migration (new hash, therefore applied) that recreates both tables.

That script is deliberately **not** part of this plan. Writing and testing a
restore path for tables that contain nothing is the same over-engineering the
maintenance-window decision rejected; the honest statement is that this
migration is one-way and the mitigation lives *before* it, not after:

- The migration is exercised against a copy of the live database first.
- The full test suite runs against the new schema before the deploy.
- If the new build fails, the fix is forward — and pre-launch, a period of
  downtime while that happens is an acceptable cost, not an incident.

**Acceptance:** the migration runs clean on a copy of the live database and is
a no-op on a second run; the app boots against the new schema; reconciliation
populates entitlements from Stripe; a webhook delivered during the rollout is
retried by Stripe and applied afterwards.

##### What deliberately survives the simplification

Round 4 overturned an earlier attempt to cut on pre-launch grounds, and the
distinction it drew still governs: **shed historical-data protection, keep
permanent runtime controls.** These are runtime, not migration scaffolding, and
they stay:

| Kept | Why it is not migration scaffolding |
|---|---|
| Bounded-downgrade guard | The reconciler runs forever. Once the database is populated, a bad classification or provider error can revoke every member. |
| `source_state_as_of` ordering token and version guard | Out-of-order webhooks are a permanent property of Stripe delivery. |
| Read-path expiry (`membership_valid_until`) | Grace expiry has no Stripe event; this is how the 14-day bound is enforced at all. |
| `getEffectiveMembership` chokepoint | Prevents the authorization/spending readers from diverging again. |
| Webhook transaction boundary | Dropped events are a live defect today. |
| W1a/W1b and the identifier-only verifier | The entire point of the plan. |
### Webhook transaction boundary

Wrap the idempotency claim (`webhookHandlers.ts:1172`) and domain processing in
one transaction (precedent: `admin.ts:~560`), so a handler throw rolls the claim
back and Stripe's retry can succeed.

**This collides with invariant 1 unless the handler is split, and today it
does.** `processDomainSwitch` performs Stripe retrievals *inside* the region
that would be wrapped — `stripe.subscriptions.retrieve` at
`webhookHandlers.ts:653-656` and `stripe.paymentIntents.retrieve` at `:664` —
and is invoked at `:1189`, with the helpers it calls writing through the global
`db`. Implementing "wrap the claim and all domain processing" literally either
holds a transaction across network I/O, which invariant 1 forbids, or leaves
those writes outside the transaction that is supposed to protect them. Both
sections have been in this plan for many rounds and were never read together.

**Specification: prepare, then apply.**

1. **Prepare — no transaction open.** Retrieve and verify all authoritative
   provider state for the event (the W1a verifier's retrievals live here), and
   acquire the per-source lease. Produce a plain description of the intended
   writes.
2. **Apply — one short transaction.** Claim idempotency **and** perform every
   domain write inside it. No network call occurs in this phase.

For that to be enforceable rather than aspirational, **every domain write takes
a transaction executor as a parameter** instead of importing the global `db`.
A handler that cannot reach `db` directly cannot accidentally write outside the
claim's transaction — the same reason the trust boundary takes identifiers
rather than objects.

Audit writes stay **outside** the transaction so a `failed` record survives
rollback, with the post-commit case specified too: a committed mutation whose
`processed` audit insert fails leaves the trail showing only `received`.
Recovery is a query for claims lacking a terminal audit row.

**Acceptance:** inject a failure after a source write inside apply and prove
**both** the mutation and the idempotency claim roll back, so Stripe's retry
succeeds; assert no Stripe call occurs between `BEGIN` and `COMMIT`.

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
history never deleted. It also opens grace windows for delinquencies whose
`invoice.payment_failed` never arrived — but it is **no longer the grace-expiry
mechanism**, which now lives on the read path (see *Grace expiry*).

**The phase split is removed — it was recovery-only scaffolding that outlived
its reason.** Revision 8 made source reconstruction and tier recomputation
separate steps so the revert-recovery procedure could run the first without the
second. That procedure is deleted, and leaving the split behind was actively
harmful: it persisted provider state **before** the guard ran, so a broadly
wrong snapshot corrupted the entitlement rows and the guard could only decline
to compound it. Aborting after the damage is not a guard. Worse, a later
per-user recomputation would then apply those downgrades one at a time, each
individually under the threshold — the bound defeated by arriving in pieces.

**Bounded downgrades — a permanent runtime guard, not migration scaffolding.**
Revision 4 dropped this as superseded by the pre-launch scope. That was wrong:
the no-live-members premise covers the *initial cutover only*, while this
reconciler runs forever. Once the database is populated, a bad classification, an
account mismatch, or a broad provider-state error can revoke every member, and
post-apply counts describe the damage rather than preventing it.

**Specification: stage everything, guard once, then commit.** A reconciliation
run computes the **complete** change set — source rows *and* the resulting
tier/horizon per user — **without mutating anything**. The threshold on
downgrade / ambiguity / error counts is evaluated against that staged set. Only
if it passes does the run commit, in one transaction; if it fails, nothing was
ever written and the run reports as visibly failed.

**A staged tier is computed from a source set that may be obsolete by commit
time.** A webhook can commit newer source state after staging and before the
commit transaction takes the user lock. The version guard would reject the
stale *source* write — but staging also produced a *tier*, and applying that
tier next to the surviving newer source row is precisely the source/derived
disagreement this plan exists to remove. **Specification: inside the commit
transaction, under the user lock, any source whose version guard rejects marks
that user's staged tier invalid; the user's tier is then re-derived from the
locked persisted rows before writing, or the user is dropped from the run and
picked up next time.** A rejected source write never silently leaves its
staged tier behind. **Acceptance: a webhook committing mid-staging leaves the
user's tier consistent with the newer source, not the staged one.**

**Absence must be proven before it means deletion.** The reconciler infers a
missing source from non-appearance in enumeration, and simultaneously tolerates
pagination failures below the error threshold — so a single failed page makes
its sources indistinguishable from deleted ones and stages them as removals.
**Specification: completeness is tracked per collection.** A collection whose
enumeration did not complete is **not proven**; every user with a source in it
is **skipped** — existing rows preserved, no derivation — while users whose
sources all come from completed collections proceed normally. Incompleteness is
reported as its own category, never folded into `failed`. **Acceptance: fail a
middle page and assert those users' entitlements and tiers are byte-identical
afterwards, while independently-complete users still reconcile.**

**One run at a time, across processes.** `deploymentTarget = "autoscale"`
(`.replit:11`) means several instances boot and each invokes reconciliation
(`index.ts:399`), and a scheduled tick can fire while an earlier run is still
staging — producing duplicate Stripe enumeration and overlapping all-or-nothing
commits. **Specification: a DB-backed single-flight lease with expiry**, so a
second replica or an early tick observes the run in progress and returns
without enumerating. Expiry means a crashed holder does not wedge reconciliation
permanently.

**What is deliberately *not* specified here:** resumable staging, per-item
durable run status, and bounded/streaming staging for large accounts. Those are
scale controls, and the account is pre-launch — the whole change set fits in
memory comfortably today. The lease is cheap and prevents a real correctness
problem now; the rest is deferred with this note so it is a recorded decision
rather than an oversight. **Revisit when the account has enough subscriptions
that one run's change set is no longer trivially small.**

This makes "pre-apply" mean what it always claimed to mean. The earlier wording
said the guard was evaluated pre-apply, which was true of the *tier* write and
false of the *source* writes that preceded it — a distinction that reads as
pedantic until it is the one that matters.

**Acceptance:** an over-threshold run changes **no tiers and no source rows**,
and reports as failed; a run whose provider snapshot is broadly wrong leaves the
entitlement table byte-identical; a sequence of individually-small downgrades
arising from one bad snapshot is caught as a single over-threshold change set
rather than admitted piecemeal.

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

  **This needs a replacement control, and revision 11 removed the only one.**
  `membershipTier` is currently the sole field in the create-user request that
  distinguishes a comped account (`users.tsx:363-381` sends it;
  `admin.ts:623-654` reads it). Deleting the tier selector without adding
  anything leaves nothing to select the atomic grant, and nowhere to collect
  the reason W1b requires — so the "atomic comped creation" capability would
  have been quietly lost, which is exactly what this bullet claims to prevent.

  **Specification:** the add-user form gains an explicit **"Grant membership"**
  checkbox plus a **reason** field, required when it is checked. The request
  carries `grantMembership: boolean` and `grantReason: string` instead of
  `membershipTier`. Unchecked creates an ordinary registered account and writes
  no entitlement. **Acceptance: create with the box checked and assert one
  active `admin_grant` with the reason and a derived Legendary tier; create
  unchecked and assert no entitlement row; check the box with an empty reason
  and assert the request is rejected.**
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

**None.** The `past_due` window (14 days), the normalisation depth, the admin
grant model, the maintenance-window cutover and the purge/history question are
all settled by David and recorded above.

**The purge/history resolution, for the record (David, 2026-07-29).** The admin
user-purge deletes `membership_history` (`admin.ts:305-325`, verified), which
made the plan's original *history is append-only* invariant false in shipped
code. Under the pre-launch rule David restated the same day — do not engineer
around problems that do not exist — the purge is **formally exempted** rather
than rebuilt around a tombstone: there is no real payment record to preserve,
Stripe retains its own record of every charge independently, and building
tombstone machinery to protect data that does not exist is precisely the
complexity being cut. *Must not change* now states the scoped invariant, and
this is on the pre-launch revisit list: once real payments exist, deleting the
local record of one is a retention decision that needs making again, properly.

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
  repeated apply.
- **Grace expiry** — the deadline passes with no Stripe event **and every sweep
  attempt failing**, and authorization denies anyway; a healthy sweep then
  converges the stored tier; a recovered subscription clears
  `membership_valid_until`.
- **Migration** — the migration runs clean on a copy of the live database; the
  app boots against the new schema; reconciliation populates entitlements from
  Stripe on first run; the migration is a clean no-op on a second run; a
  webhook delivered during the rollout is retried by Stripe and applied
  afterwards.
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
| 29 | 6 | Schema compatibility during the deploy cutover | **Superseded by 32/33** — expand/contract was the right shape but only covered *reads*. Reopened in round 7 for writes and for the contract gate. |
| 30 | 6 | Rollback strands post-cutover entitlements | **Superseded by 34/35/36** — roll-forward-only was right; the precondition had no way to identify a post-cutover row and the recovery it pointed at was not executable. |
| 31 | 6 | Grace-expiry latency bound undefined | **Superseded by 37** — a cadence bounds the healthy case only. Reopened in round 7 and moved off the scheduler entirely. |
| 32 | 7 | Old-instance writes lost during expansion | **Superseded by 38/39/40** — the trigger bridge was the right mechanism and wrong in three ways: it would have raised inside legacy transactions, mis-handled purge, and left the derived fields stale. |
| 33 | 7 | Contract migration not gated against reverted binaries | **Superseded by 41/42** — two of the three gate conditions were unsound. The gate is replaced by removing the need for one. |
| 34 | 7 | Revert precondition has no durable cutover marker | **Superseded by 43/44** — the marker was right; its cardinality was unenforced (failing *open*) and its comparison had a precision gap. |
| 35 | 7 | `membership_history` cannot replay valid admin grants | **Superseded by 45** — extending the schema fixed future events only, which is not the population that needs recovering. |
| 36 | 7 | Downgrade guard blocks the recovery it protects | **Superseded by 46** — staging fixed the guard's view and missed that authorization reads a *second* derived field the revert does not clear. |
| 37 | 7 | Grace bound unenforced when sweeps fail | **Superseded by 47/48** — read-path enforcement was right; the value was undefined over a source *union*, and I secured only the middleware readers. |
| 38 | 8 | Bridge trigger cannot write constraint-valid legacy admin rows | **Resolved** — `provenance_completeness` gates the provenance `CHECK`s, so a bridged row records "unknown" honestly instead of raising inside the old instance's transaction or inventing a reason. |
| 39 | 8 | Legacy `DELETE` conflates revoke with user purge | **Resolved** — `user_id` FK becomes `ON DELETE CASCADE`; the database resolves the ambiguity the trigger cannot see. **Also surfaced that the purge deletes `membership_history`, so the append-only invariant is already false in shipped code** — now an open question for David. |
| 40 | 8 | Mirrored writes leave `membership_valid_until` stale | **Resolved** — the bridge invokes the full serialized derivation, not a row copy; an old binary's recovery clears the deadline it cannot see. |
| 41 | 8 | Row trigger is not a commit-time fence | **Superseded by 42** — real, and moot once the gate it supported is gone. |
| 42 | 8 | A quiet period cannot prove old binaries are gone | **Resolved** — contract replaces the legacy tables with **updatable views** instead of dropping them. A straggler request becomes correct rather than fatal, which removes the obligation to prove absence at all. |
| 43 | 8 | Marker cardinality unenforced — revert fails **open** | **Resolved** — singleton enforced in DDL; consumers abort unless exactly one row exists, checked before any entitlement is evaluated. |
| 44 | 8 | Whole-second Stripe timestamps vs sub-second boundary | **Resolved** — boundary truncated to the second and the comparison biased so a same-second entitlement counts as post-cutover and aborts the revert. |
| 45 | 8 | Legacy history rows remain unreplayable | **Resolved** — deterministic translation table plus a fail-closed disposition; untranslatable rows are reported and refuse recovery rather than being guessed. |
| 46 | 8 | Stale expiry demotes users during reconstruction | **Resolved** — phase 0 clears `membership_valid_until` before reconstruction; the fail-open window is bounded, operator-initiated and reported. |
| 47 | 8 | `membership_valid_until` undefined over a source union | **Resolved** — null when any indefinitely-valid source qualifies, otherwise the max of the grace-bound deadlines; coexistence tests added. |
| 48 | 8 | Permission and spending readers bypass expiry | **Resolved** — one shared `getEffectiveMembership` helper; `createMemeRecord.ts:149-179` and `budgetGate.ts:77-98` confirmed as real authorization readers, and the full reader inventory is built by searching the column, not the middleware. |
| 49 | 9 | Aborted recovery leaves expiry permanently disabled | **Resolved** — the global clear is gone with the revert-recovery procedure it belonged to; recovery is now "redeploy the previous build", which touches no derived state. |
| 50 | 9 | Bridge would launder D1's fabricated payment status | **Superseded by 57** — no bridge exists. The principle it established survives as an invariant: no path creates a qualifying paid entitlement from a caller-supplied status. |
| 51 | 9 | A view cannot serve the legacy `ON CONFLICT` upsert | **Superseded by 57** — verified on PostgreSQL 16.13; the view-based contract is deleted rather than fixed. |
| 52 | 9 | Revert precondition used `>` against a `>=` rule | **Superseded by 57** — the precondition is deleted. |
| 53 | 9 | Views cannot round-trip legacy-only columns | **Superseded by 57** — the views are deleted. |
| 54 | 9 | `legacy_bridged` qualified while exempt from W1b | **Superseded by 57** — the exemption existed only for bridged rows; with no bridge, W1b holds unscoped for every row the new path writes. |
| 55 | 9 | Purge policy wrongly called non-blocking | **Resolved** — settled by David: the purge is formally exempted, *Must not change* states the scoped invariant, and it is on the launch revisit list. |
| 56 | 9 | Verification still demanded the removed contract gate | **Resolved** — acceptance criteria re-derived from the sections they belong to; orphaned items removed. |
| 57 | — | **Scope decision (David, 2026-07-29): maintenance window.** | The zero-downtime overlap requirement is withdrawn. Findings 29–54 that existed only to serve it are superseded *by the requirement going away*, not by a better mechanism — recorded honestly so nobody rebuilds them believing they were solved. |
| 58 | 10 | Sequence token taken *after* retrieval is not causal | **Resolved** — the token is taken **before** issuing the retrieval. A stalled older retrieval could otherwise take the larger token and resurrect canceled access; the new ordering fails safe (drops a fresher snapshot, repaired by reconciliation) instead of fail-open. |
| 59 | 10 | Downgrade guard ran after sources were persisted | **Resolved** — the recovery-only phase split is removed; a run stages source *and* tier changes with no mutation, guards once, then commits. Also closes the piecemeal-downgrade path that evaded the bound. |
| 60 | 10 | "Redeploy the previous build" is not an executable rollback | **Resolved** — verified in `migrate.ts`: applied hashes are skipped, so the old build never recreates the tables. Declared **roll-forward-only**, with the mitigation moved before the migration rather than after. |
| 61 | 10 | Destructive migration not specified as idempotent | **Resolved** — guarded DDL plus a **second-run no-op** acceptance case. `migrate.ts` already rescues `42P07`/`42P01` via `SAVEPOINT`, but depending on error-code recovery for an expected condition is fragile. |
| 62 | 10 | The maintenance gate does not exist | **Resolved by deletion** — confirmed no maintenance control exists anywhere in the repo. Rather than build one, the plan states plainly that old instances will error during the rollout and that this costs nothing pre-launch. I had written a runbook step for a control I never checked for. |
| 63 | 10 | Actor FK breaks when a *grantor* is purged | **Resolved** — actor recorded twice: `_id` (`ON DELETE SET NULL`) and an immutable `_label` snapshot, with the provenance `CHECK` requiring the label. Every single-FK behaviour was wrong: cascade deletes a recipient's entitlement, restrict blocks admin deletion, set-null violates W1b. |
| 64 | 11 | Staged tier can be committed against a source set a webhook has superseded | **Resolved** — a version-guard rejection invalidates that user's staged tier; re-derive under the lock or drop the user from the run. A hole in round 10's own fix. |
| 65 | 11 | Incomplete enumeration is indistinguishable from deletion | **Resolved** — completeness tracked per collection; users with a source in an unproven collection are skipped with rows preserved, reported as its own category rather than folded into `failed`. |
| 66 | 11 | Token-before-issuance still is not causal | **Superseded by per-source leases** — Codex was right and my own text contradicted itself. **Two token schemes both failed**; ordering over *provider state* cannot be derived from any locally-allocated number, so retrieval-and-apply is serialized per source by a committed lease with expiry, holding no transaction across I/O. `source_state_as_of` demoted to a lease-expiry backstop. |
| 67 | 11 | Webhook transaction would span Stripe I/O | **Resolved** — prepare/apply split; provider retrieval happens before the transaction opens, and every domain write takes a transaction executor so it cannot reach the global `db`. Two long-standing sections that contradicted each other and had never been read together. |
| 68 | 11 | Reconciliation is not a cross-process singleton | **Resolved** — DB-backed single-flight lease with expiry. Resumable staging and per-item durable status **explicitly deferred** as scale controls, recorded rather than omitted. |
| 69 | 11 | Two active admin grants possible; revoke marks only one | **Resolved** — partial unique index on one active `admin_grant` per user. The main constraint excluded them because `provider_ref` is null. |
| 70 | 11 | `getEffectiveMembership` cannot serve set-based readers | **Resolved** — a reusable SQL `effectiveTierPredicate` is the primitive and the row helper is defined from it. The mailing list (`stripeStorage.ts:55-63`) and admin counts (`admin.ts:2543-2556`) filter in SQL and would have kept emailing expired members. Third instance of the same enumeration error. |
| 71 | 11 | Immutable actor label conflicts with the retention matrix | **Resolved by existing policy** — `data-lifecycle-retention-matrix.md` already requires anonymization of direct identifiers in payment records, so the label is overwritten with a stable opaque token on hard delete rather than kept forever. Not escalated: the repo had already decided it. |
| 72 | 11 | No create-time control for a comped account | **Resolved** — explicit "Grant membership" checkbox plus required reason replaces the removed tier selector; the atomic-create capability would otherwise have been silently lost. |

| Round | Lens |
|---|---|
| 1 | Correctness of the derivation model + W1 compliance |
| 2 | Failure modes of the newly-added machinery |
| 3 | Implementability — is every mechanism buildable from what the pinned SDK and schema actually expose? |
| 4 | Whether the pre-launch simplification cut anything load-bearing — **it had: two of three supersessions were overturned** |
| 5 | Phase-boundary safety as a state space — **found the boundary wrong for the third time; the split has been removed** |
| 6 | The collapsed single-PR shape — **it did: deploy-time schema compatibility, which returns as expand/contract staging** |
| 7 | The recovery procedures themselves: are the documented rollback and reconciliation paths actually executable, or do they assume state they cannot guarantee? — **they assumed. All three round-6 resolutions superseded; six findings, the highest of any round** |
| 8 | The mechanisms round 7 introduced — triggers, markers, a read-path expiry check and a staged recovery — reviewed as new attack surface rather than as fixes — **all six round-7 resolutions superseded; 11 findings, the largest round. The bridge would have raised inside legacy transactions and the contract gate rested on two unsound conditions** |
| 9 | Whether revision 9 actually *reduced* mechanism rather than moving it — **it had not: 8 findings, and the view-based contract proved unbuildable** |
| 10 | The plan **after** the migration machinery was cut — **the cut held: nothing load-bearing went with it, and all 6 findings landed on the surviving core or the new runbook** |
| 11 | The **surviving core** on its own terms — **9 findings, up from 6; two overturned round-10 fixes, and the ordering scheme failed for the second time** |
| 12 | The mechanisms round 11 introduced — per-source leases, the prepare/apply split, the reconciliation lease and the SQL tier predicate — plus the interactions *between* them: leases and transactions, staging and webhooks, predicate and helper. Round 11 found two long-standing sections that contradicted each other; look for more of those rather than for defects inside any one section |
