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

**W1a needs two verifiers, and revision 21 specified one.** The verifier below
requires a Checkout Session with `mode = payment` and a PaymentIntent — so it
cannot create or refresh a **`stripe_subscription`** source at all, and those
arrive through subscription webhooks, the Stripe-mutating routes, and
reconciliation. W1a says *every* paid entitlement; one of the two paid source
types had no verifier.

**Specification: an identifier-only subscription verifier**, same shape and same
boundary. It takes a **subscription id**, retrieves the subscription itself, and
binds: subscription↔customer↔user; the subscription's current product is
**allowlisted** (full pagination); lifecycle status; and the values written to
the source row come from the retrieved object rather than any caller-supplied
one. The existing confirm flow already binds session owner and customer *before*
validating the subscription, so this preserves an ordering the code has today
rather than inventing one.

**Acceptance:** a valid subscription belonging to **another customer** cannot be
applied to the requested user; a subscription for a non-allowlisted product
creates no qualifying source.

**The one-time-payment verifier** takes a Checkout Session id, retrieves session
and PaymentIntent itself, and binds: session↔user/customer; mode is `payment`;
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

Four separate concepts, not one flag: **`is_membership_product`** (allowlist
result, snapshotted — see below), **access holds**, **terminal dispute loss**,
and **provider lifecycle status** (of which grace validity is a sub-case).
Rounds 20 and 22 each found a concept named here and then absent from the rule
below, so the two lists are kept deliberately parallel.

**"Snapshotted at ingestion" is ambiguous on refresh, and the two source types
need opposite answers.** Leave a subscription's original value untouched and a
portal plan-switch to a non-membership price **retains access forever**; re-read
mutable product metadata for a completed lifetime purchase and a later metadata
edit **retroactively revokes or grants** something already paid for.

**Specification, per source type:**

| Source | Snapshot moment |
|---|---|
| `stripe_subscription` | **Re-evaluated on every authoritative refresh**, against the subscription's *current* product. It describes what the user is subscribed to *now*, and that changes. |
| `stripe_lifetime_payment` | **Frozen at creation**, from the verified checkout classification. It describes what was bought, which is a completed fact that later metadata edits cannot alter. |
| `admin_grant` | Not applicable — qualification comes from W1b authorization. |

**Acceptance:** switch a subscription to a non-membership price and assert
access drops on the next refresh; edit product metadata after a lifetime
purchase and assert the entitlement is unaffected in **both** directions.

**Qualification is a conjunction of all four concepts, and revision 21 only
encoded one of them.** The table below is the *lifecycle* term. It was written
as though it were the whole rule, which made **every `active` subscription
qualify — including one for a product outside the allowlist.** That is the
positive-allowlist boundary this plan calls a *Must not change*
(`membershipPricing.ts`, `security-model.md`), defeated by the model meant to
protect it, and it becomes live the moment reconciliation persists an active
non-membership subscription. Naming `is_membership_product` as a separate
concept and then never using it in the rule is the whole defect.

**A source qualifies only if all of these hold:**

1. **Allowlist** — `is_membership_product = true`, required for **both** Stripe
   source types. `admin_grant` sources qualify independently of it: they are
   authorized by W1b, not by a product.
2. **No access hold** — no non-terminal row in `entitlement_source_disputes`
   for this source — the hold is **only** this query; there is no hold column.
   See *Disputes* below.
3. **No terminal dispute loss** — `dispute_loss_revoked_at IS NULL`. Separate
   from the hold because it is permanent and, unlike the hold, must survive
   every subsequent authoritative refresh. Folding it into the hold would have
   let a won-then-lost sequence, or a refresh, clear a chargeback revocation.
4. **Lifecycle** — the table:

| Status | Qualifies |
|---|---|
| `active`, `trialing` | yes |
| `past_due` | only while `now < grace_expires_at` |
| `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused` | no |

**Acceptance:** an active non-membership subscription qualifies **alone**
(user is not Legendary) and **alongside** a valid membership source (the valid
one alone carries the tier, and removing it drops the user).

**Disputes need a state the provider lifecycle cannot express.** Today
`charge.dispute.created` **immediately revokes** access
(`webhookHandlers.ts:462-515`), deliberately — its own comment says *"Disputes
can take weeks to resolve; we don't give paid features to users actively
chargebacking us."* Under revision 21's schema an open dispute leaves a lifetime
source `active` and a subscription on its ordinary Stripe status, so
**recomputation would re-qualify the source and hand access back** — the model
would silently delete a live product behaviour, which is exactly the failure a
derived model is supposed to make impossible.

**Specification: a durable, source-local dispute record, plus a terminal
revocation the provider cannot undo.** Revision 23 modelled this as two columns
on the source row and Codex round 22 showed that shape cannot express three
things it has to: every terminal outcome Stripe defines, a loss that survives an
authoritative refresh, and a dispute that is *already terminal* when a delayed
open event arrives. All three are fixed by making the dispute an object rather
than an array element.

**`entitlement_source_disputes`** — one row per (source, dispute):

| Column | Note |
|---|---|
| `source_id` | FK to the entitlement source |
| `stripe_dispute_id` | **Primary key.** One row per dispute, ever |
| `status` | The Stripe dispute status, as re-fetched under the lease |
| `is_terminal` | Derived from `status`; once true it never returns to false |
| `first_seen_at`, `resolved_at` | Observability |

**The hold is a query, not a flag:** a source is held while a row exists for it
whose status is in the open set. **Both** revision 23 columns are deleted —
`open_dispute_ids` (an array pretending to be a state machine) and
`access_hold_reason`. Revision 24 kept the latter "as the reason discriminator"
and specified **no writer that synchronizes it**, which is this plan's most
persistent mistake in its purest form: a control named in one place and wired up
in none. Concretely it permitted an open dispute with a null reason, and a
source whose disputes are all terminal still reading `dispute` — two answers to
"is this source held", which is one more than a derived model may have. The
reason is **derived from `entitlement_source_disputes`** when anything needs to
display it.

### Every terminal shape, enumerated from the pinned types

Revision 23 said "resolving removes the id" and modelled exactly two outcomes.
The pinned Stripe 20.0.0 `Dispute.Status` union (`Disputes.d.ts:508-516`) has
**eight** values and **four** of them are terminal — and the existing handler
already has a branch for the ones the plan omitted
(`webhookHandlers.ts:601-609`, `warning_closed or other terminal
non-won/non-lost statuses — record only`). So the plan was silent on a path the
code takes today.

| Status | Terminal | Holds access | On entry |
|---|---|---|---|
| `needs_response` | no | **yes** | Open the hold |
| `under_review` | no | **yes** | Hold continues |
| `warning_needs_response` | no | **yes** | Open the hold |
| `warning_under_review` | no | **yes** | Hold continues |
| `won` | **yes** | no | Clear — source qualifies on its ordinary lifecycle |
| `warning_closed` | **yes** | no | Clear — the warning closed without becoming a chargeback |
| `prevented` | **yes** | no | Clear — no chargeback occurred |
| `lost` | **yes** | no | **Write the terminal revocation first**, then clear |

Three of the four terminal shapes are access-*restoring* and one is
access-*revoking*, which is why "resolving removes it" was unsafe in both
directions at once: it would have restored access on `lost` and, for an
implementer who read the hold as permanent, held forever on `warning_closed`.

Whether an early-fraud warning (`warning_*`) should hold access at all is a
product question, not a technical one. It is answered **yes** here to preserve
today's behaviour — `charge.dispute.created` revokes immediately, deliberately —
rather than silently loosening it inside an architecture change. Flagged for
David as a deliberate carry-forward, not a decision this plan is making.

### The loss must live where a provider refresh cannot reach it

Revision 23 had a lost subscription dispute write `lifecycle_status =
'canceled'` on the source. **That field is a mirror of the provider's
subscription status**, and this plan's own snapshot rule (entry 119) says a
subscription source is **re-evaluated on every authoritative refresh**. A
chargeback does not cancel the Stripe subscription, so the very next webhook,
route-triggered refresh or reconciliation pass restores `active` and re-qualifies
the source. The fix for "no terminal writer exists" was a writer aimed at the one
field guaranteed to be overwritten.

**Specification:** a lost dispute sets **`dispute_loss_revoked_at`** on the
source — source-local, set once, never cleared by any refresh — and the
qualification conjunction gains it as a disqualifier. The source stops
qualifying permanently regardless of what Stripe later reports about the
subscription's lifecycle.

**General invariant this generalises to, stated once so it binds every future
field:** an authoritative refresh writes **only** provider-mirror fields
(`lifecycle_status`, `is_membership_product`, the version/fence, amounts). It
**never** writes or clears source-local state — `dispute_loss_revoked_at`, or anything added later. A field's category is
recorded in the schema section, and a new field must declare one. This is the
class the finding belongs to, not just the instance.

### A terminal dispute absorbs a late open event

`charge.dispute.closed` can be processed before a delayed
`charge.dispute.created` for the **same** dispute. Under revision 23 the close
removed the id and the create put it back — a permanent hold on a dispute that
Stripe has already settled. The per-source lease and the version guard do not
help: they serialize the two writes in arrival order, which is precisely the
wrong order, and neither is a statement about the dispute's own state. Revision
23's acceptance covered ordering between **two** disputes and never two events
for **one**.

**Specification, two mechanisms, both required:**

1. **Re-fetch the dispute under the lease.** Every transition applies the
   authoritative status retrieved inside the target source's lease, never the
   status carried on the event. A late `created` therefore observes the dispute
   as already `won`/`lost`/`warning_closed`/`prevented`.
2. **Terminal is absorbing.** `is_terminal` never returns to false, and no
   transition may move a row out of a terminal status. Mechanism 1 is the
   common path; mechanism 2 is what holds when retrieval fails or the row is
   reached by any path that did not re-fetch. Either alone leaves a gap.

### One transition writer, and all three dispute events route through it

Revision 24 said "every transition re-fetches and persists authoritative status"
and never said **which handlers** perform a transition. Reading
`processDomainSwitch`, `charge.dispute.updated` (`webhookHandlers.ts:991-1023`)
does **only** deadline-alert work — and its own comment says Stripe sends it for
"evidence updates, **status transitions**, etc." So the event that most often
carries a non-terminal status change was not assigned to the writer, and
`needs_response → under_review` or `warning_under_review →
warning_needs_response` would leave the table stale until reconciliation
happened to sweep it.

**Specification:** `charge.dispute.created`, `.updated` and `.closed` all invoke
**one** state-transition function — map to source, acquire the lease, re-fetch
the authoritative dispute, apply through the conditional upsert, recompute. The
`.updated` handler's existing alert behaviour is **preserved alongside** it, not
replaced: the evidence-deadline alert is a separate concern that happens to ride
the same event, and dropping it would be an unrelated regression.

**Acceptance:** non-terminal transitions in **both** directions
(`needs_response ↔ under_review`, and the `warning_*` pair) reach the table from
an `.updated` event alone, with no reconciliation pass; and the deadline alert
still fires on the same event under its existing predicate.

### The source mapping, unchanged from revision 23

- **The hold attaches to the *exact* source.** `resolveUserForDispute`
  (`webhookHandlers.ts:407-460`) resolves a **user** — its three lookups all
  terminate at a user id — which is all tier-level revocation ever needed. A
  source-local hold needs the source:
  - **lifetime** — `payment_intent` → the `stripe_lifetime_payment` source;
  - **subscription** — charge → invoice → subscription → the
    `stripe_subscription` source.
  The mapping runs **before** any write, under the target source's lease.
- **If the source cannot be resolved, nothing is held**, and the event is
  reported as unmapped for human review. Holding every source for the user would
  revoke an unrelated entitlement; holding none silently would lose the dispute.

The hold is per-source, so **the union still governs**: a user with an unrelated
active entitlement keeps Legendary throughout, which is the behaviour today's
tier-level revocation cannot express.

**Acceptance.** Per-outcome: **each of the eight statuses** reaches persistence,
and each of the four terminal ones produces the disposition in the table above —
including `warning_closed` and `prevented` clearing the hold, and `lost` writing
`dispute_loss_revoked_at` **before** clearing it. Ordering: **closed-before-created
for one dispute** leaves the source unheld and terminal; **two overlapping disputes
on one subscription with win/loss arriving in both orders** keep the source held
until the last resolves. Durability: the hold **survives a restart and an
authoritative refresh**; a lost subscription dispute **still disqualifies after a
refresh that reports the subscription `active`** — the case revision 23 would have
failed. Scope: a dispute on one of two qualifying Stripe sources holds only that
one; an unresolvable dispute holds nothing and is reported; every single-dispute
case runs again with a second unrelated entitlement present, asserting the user
stays Legendary throughout.

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
current delinquency, matched by "contiguous run of unpaid invoices ending at the
present" so a *previous, resolved* delinquency does not backdate a new one.

**But "that invoice's timestamp" is not a field, and the obvious candidates are
wrong.** Verified against the pinned Stripe 20.0.0 types rather than the docs:

- `Invoice.created` is **object creation**, and the type's own comment warns
  *"An invoice is not attempted until 1 hour after the `invoice.created`
  webhook"* — so it is explicitly not the attempt time.
- `Invoice.attempted` is a **boolean**, carrying no timestamp at all.
- `Invoice.status_transitions` has `finalized_at`, `paid_at`, `voided_at`,
  `marked_uncollectible_at` — and **no failed-attempt time**.
- `next_payment_attempt` is the *next* attempt, not the first failure.

Anchoring to `created` would start the window up to an hour early, and — more
importantly — I had written a rule over a field that does not exist.

**Specification, in priority order:**

1. **The failed payment attempt's own timestamp**, resolved from the invoice's
   associated PaymentIntent/charge. The pinned `Invoice` type exposes no
   top-level `charge` or `payment_intent`, so this is an explicit lookup rather
   than a field read — which is precisely why it must be specified rather than
   assumed.
2. **If no attempt is resolvable, no deadline is derived.** The source keeps
   qualifying and the case is **reported**. Revisions up to 23 specified a
   `status_transitions.finalized_at` fallback here, bounded as "under 0.3% of a
   14-day window"; **both the bound and the fallback are withdrawn** (ledger
   125). The pinned type's ≥1-hour note is a *lower* bound on
   `created`→attempt and says nothing about `finalized_at`→attempt, so the
   error was never bounded at all — and an unbounded-early start revokes a
   paying customer. Ledger 129: the withdrawal reached the ledger and not this
   paragraph, so the body still instructed an implementer to use it.
3. **Never `invoice.created`.**

A run that could not resolve an attempt **says so in its output**, so an
unbounded episode is visible rather than silently treated as expired.

**Acceptance:** a delayed first attempt — invoice finalized, first attempt an
hour later, failure webhook never delivered — yields a deadline anchored to the
**attempt**, not to invoice creation; and with the attempt unresolvable, **no
deadline is derived, the source keeps qualifying, and the case is reported** —
asserting specifically that no revocation occurs.

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

**The primitive is an expression, not a predicate.** Revision 12 specified
`effectiveTierPredicate` as `membership_tier = $1 AND (membership_valid_until
IS NULL OR membership_valid_until > now())`, which is correct **only when
`$1 = 'legendary'`**. Instantiate it with `'registered'` and a lapsed
Legendary user matches nothing: the raw column still says `legendary`, so the
first conjunct is false — and that user is then in *neither* count. The admin
dashboard reads **both** tiers (`admin.ts:2547-2556`: one `count(*)` for
`legendary`, one for `registered`), so revision 12 fixed the over-count and
introduced an under-count in the row directly below it.

The mistake was shape, not arithmetic: an *expiry filter* answers "is this user
still X", while the readers ask "**what is this user's tier**". Only the second
question has an answer for every user.

**Specification:** the effective tier is expressed **twice, from one
definition** —

- **`effectiveTierExpr`** — a reusable SQL expression evaluating to the
  effective tier for any row:

  ```sql
  CASE WHEN membership_tier = 'legendary'
            AND membership_valid_until IS NOT NULL
            AND membership_valid_until <= now()
       THEN 'registered'
       ELSE membership_tier
  END
  ```

  The `membership_tier = 'legendary'` conjunct is not redundant: without it a
  stale `membership_valid_until` on an `unregistered` row would silently
  *promote* that row to `registered`. Expiry may only demote, and only from
  the tier the horizon describes.

  Set readers select, group or filter on **this**, never on the raw column —
  `WHERE effectiveTierExpr = 'legendary'` for the mailing list, and the same
  expression instantiated at `'registered'` for the second dashboard count. A
  convenience `effectiveTierPredicate(tier)` may wrap it, but it is defined
  *from* the expression rather than hand-written per tier.
- **`getEffectiveMembership(userId | userRow)`** — the row helper, for
  request-path consumers, **defined from the same expression**.

The expression is the primitive and everything else is derived from it, so they
cannot drift. It also matches what the model actually says: expiry is a
*demotion to `registered`*, not a disappearance.

**One expression is not one instant.** Sharing the expression makes the two
dashboard counts *agree on the rule* and not on *when*: `admin.ts:2547-2556`
runs them as two statements in a `Promise.all`, and `now()` in PostgreSQL is
the **transaction** timestamp, so two implicit transactions get two different
timestamps. A user crossing the horizon between them is counted **twice or not
at all** — which is exactly the sum-preservation property the acceptance below
claims, so the claim would have failed against the very query it was written
for.

**Specification:** comparisons that must agree evaluate at **one instant**.

- The dashboard becomes **one statement** with conditional aggregation —
  `count(*) FILTER (WHERE effectiveTierExpr = 'legendary')` and the same for
  `'registered'` — so both buckets see a single transaction timestamp.
- Where one statement is not possible, the caller **binds a shared `asOf`**
  and passes it to every surface, rather than each surface calling `now()`.
  `effectiveTierExpr` and `getEffectiveMembership` therefore both take an
  optional evaluation instant, defaulting to `now()` / the request clock.

This is a general rule for the read path, not a dashboard fix: any claim that
two effective-tier surfaces agree is meaningless unless they are evaluated at
the same instant.

**Acceptance:** at and after the horizon, a lapsed Legendary user appears in
neither the mailing list nor the `legendary` count **and does appear in the
`registered` count**, and all three agree with the row helper for that user
**at a bound `asOf`**; the two counts sum to the same total before and after
the horizon lapses, **including when the horizon is crossed between what used
to be the two separate queries**; `unregistered` rows are unaffected by expiry.

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
5. ~~Notification emitted only after a committed tier transition.~~ **Withdrawn at revision 20** — notifications are out of scope; see *Notifications are out of scope*. They now fire after the commit, which orders them correctly but guarantees nothing about delivery, and a half-true invariant is worse than none.

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

  **An expiring lease must be fenced, and the version guard cannot do it.**
  Revision 12 gave `source_state_as_of` the job of rejecting a holder that lost
  its lease to expiry and came back late. That does not work, and the reasoning
  was circular: holder A stalls past expiry, B acquires the lease and is still
  retrieving, so B **has not written anything yet** — the stored token is still
  the old one, and A's late write passes the guard unchanged. If B then crashes,
  A's stale write is the permanent state; if B succeeds, there is still a window
  in which canceled access is resurrected. The guard can only fence A against a
  write that has already happened, which is exactly the case where fencing was
  not needed.

  **Specification: a fencing token, validated inside the apply transaction.**

  - The lease row carries a **`fence`** value from a database sequence, taken
    fresh on **every** acquisition (including one that steals an expired lease).
    Acquisition returns the holder its fence.
  - The apply transaction **begins** by taking the lease row with
    `SELECT … FOR UPDATE` and requiring `holder = me`, `fence = my_fence` and
    `expires_at > now()`. If any fails, the transaction **aborts** and the write
    is abandoned.
  - Release is compare-and-release — `WHERE scope = $1 AND fence = $2` — so a
    late holder cannot release a lease that now belongs to its successor.

  The row lock is what makes this airtight, and it is worth naming because a
  time-based lease alone is not: once A holds the lease row's lock and has seen
  it unexpired, B cannot acquire until A commits or rolls back, so A's write and
  its ownership check are atomic. The lease TTL therefore does **not** have to
  exceed the apply transaction's duration — a property a bare "check the clock,
  then write" scheme cannot offer.

  `source_state_as_of` **stays as defence in depth**, not as the fence: it
  still rejects an out-of-order write arriving from any path that somehow
  bypasses the lease. Revision 12's claim that it fences expired holders is
  **withdrawn**.

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
stored; **a holder whose lease expired while a successor is still retrieving
(so no newer token has been stored) has its apply transaction aborted by the
fence check, not admitted by the version guard**; the successor then crashing
leaves the *pre-existing* state, never the expired holder's stale write; a late
holder's release does not release its successor's lease; **a delayed route
response applied after a newer webhook does not resurrect stale state**. The
claim is now *under the lease and its fence, an older snapshot cannot win* —
earlier revisions asserted that unconditionally, which is what rounds 11 and 12
disproved in turn.

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
| `dispute_loss_revoked_at` | **source-local.** Nullable timestamp, **set once, never cleared.** A lost dispute disqualifies the source permanently; it is not written into `lifecycle_status`, which a provider refresh would overwrite — see *Disputes* |
| `granted_by_admin_id`, `granted_by_admin_label`, `grant_reason` | W1b grant provenance, admin-grant only — see *actor durability* |
| `revoked_by_admin_id`, `revoked_by_admin_label`, `revoked_reason`, `revoked_at` | W1b **revocation** provenance |
| `source_state_as_of` | the ordering token above |
| `created_at`, `updated_at` | local row timestamps |

### Field ownership is per (column, source type, writer) — not per column

Revision 24 asserted a **column-global** split into provider mirrors and
source-local state. That is wrong, and wrong in a way this plan already
contradicts elsewhere: `is_membership_product` is re-evaluated on every refresh
for a subscription and **frozen at creation** for a lifetime purchase (entry
119, in this same document); `lifecycle_status` comes from Stripe for a
subscription and is written locally for admin grants; `source_state_as_of` is
allocated by every local writer and mirrors nothing. A refresh helper built from
the global list would reclassify a completed lifetime purchase after a metadata
edit, and collide with the admin grant/revoke transactions.

Two axes, because one was not enough:

| Origin | Meaning |
|---|---|
| **provider-derived** | the value comes from the retrieved provider object |
| **locally-derived policy** | computed by *our* policy from provider facts plus local rules — the refresh owns it, but Stripe does not supply it |
| **locally-authored** | authored here, not derivable from the provider at all |
| **operational** | lease/ordering metadata, allocated locally by every writer by protocol |

| Refresh discipline | Meaning |
|---|---|
| **re-evaluated** | the authoritative refresh recomputes it every time |
| **frozen** | written once at creation; no refresh may change it |
| **maintained** | the refresh may open, extend or clear it in the **same fenced apply**, while preserving every field it does not own |
| **untouched** | no refresh writes it, ever |

**The matrix.** A writer may write only the cells its (source type, origin) owns:

| Column | `stripe_subscription` | `stripe_lifetime_payment` | `admin_grant` |
|---|---|---|---|
| `is_membership_product` | provider-derived, **re-evaluated** | provider-derived, **frozen** | n/a — W1b authorizes |
| `lifecycle_status` | provider-derived, re-evaluated | locally-authored (`active`/`refunded`), untouched | locally-authored (`active`/`revoked`), untouched |
| `current_period_end`, `cancel_at_period_end` | provider-derived, re-evaluated | n/a | n/a |
| `amount`, `currency` | provider-derived, re-evaluated | provider-derived, frozen | n/a |
| `grace_started_at`, `grace_expires_at` | **locally-derived policy, maintained** | n/a | n/a |
| `dispute_loss_revoked_at` | locally-authored, **untouched, set-once** | same | n/a |
| W1b provenance columns | n/a | n/a | locally-authored, untouched |
| `source_state_as_of` | **operational** | operational | operational |

**Why grace is its own category, and why revision 24 broke it.** Classifying the
window as source-local-and-never-touched contradicts two writers this plan
requires: reconciliation must **open** a window when it discovers a missed
`invoice.payment_failed`, and a refresh to a recovered `active` must **clear**
the episode. Under revision 24's boundary the first is forbidden — so a missed
failure never gets its 14-day deadline — and the second is forbidden too, so
stale grace timestamps survive recovery. *Maintained* is the category that was
missing: the subscription refresh owns the window, updates it in the same fenced
apply, and touches nothing else.

**Acceptance for the matrix itself**, since it is now a load-bearing invariant:
a lifetime refresh **preserves** `is_membership_product` across a product
metadata edit while a subscription refresh **re-evaluates** it; an admin
grant/revoke writes `lifecycle_status` without any refresh contesting it; a
missed `invoice.payment_failed` discovered by reconciliation **opens** a window
with the correct deadline; a recovery to `active` **clears** it; and a refresh in
every case leaves `dispute_loss_revoked_at` and the W1b provenance columns
byte-identical.

Revision 23 lost a chargeback revocation by writing it into a mirror field, and
revision 24 fixed that instance with a rule too coarse to be true. The matrix is
the version that survives contact with all three source types.

**`entitlement_source_disputes`** — one row per dispute, per *Disputes*:

| Column | Note |
|---|---|
| `source_id` | FK → the entitlement source, **`ON DELETE CASCADE`**, indexed |
| `stripe_dispute_id` | **PK.** One row per dispute, ever — which is what makes a late `created` an upsert rather than a re-open |
| `status` | the Stripe `Dispute.Status`, as re-fetched under the source's lease |
| `is_terminal` | derived from `status`. **Absorbing — enforced by a conditional upsert and a trigger, not a CHECK** (see below) |
| `first_seen_at`, `resolved_at` | observability |

A source is held while a row exists for it with a non-terminal status. The
partial index `(source_id) WHERE NOT is_terminal` makes that a cheap existence
check on the qualification path.

**Absorption is enforced by an executable rule, because a `CHECK` cannot express
it.** A `CHECK` validates only the row being proposed, so updating
`('won', true)` to `('needs_response', false)` satisfies any status↔flag
consistency check — it is a perfectly consistent *new* row. Verified by
execution on this repo's PostgreSQL 16.13: that exact update **succeeds** under
such a constraint. Revision 24's "a CHECK forbids any transition out of a
terminal status" was not implementable as written.

**Specification:**

1. **The writer is a conditional upsert**, whose `DO UPDATE` carries a `WHERE`
   on the *existing* row:
   `... ON CONFLICT (stripe_dispute_id) DO UPDATE SET status = EXCLUDED.status,
   is_terminal = EXCLUDED.is_terminal, resolved_at = ... WHERE NOT
   entitlement_source_disputes.is_terminal`.
   A terminal row is therefore a **silent no-op, not an error** — and
   `RETURNING` yields no row, which is the signal that the anomaly occurred.
2. **A `BEFORE UPDATE` trigger** rejects a terminal→non-terminal transition
   reaching the table by any path that did not use the upsert. This is the
   backstop for a writer I have not enumerated, which this loop's record says to
   assume exists.
3. **The `CHECK` stays for what it can actually do** — `is_terminal` agreeing
   with `status` on the proposed row. It is a consistency constraint, not a
   transition constraint, and the plan no longer claims otherwise.

**Resolving the instruction revision 24 left contradictory.** It said both
"apply the retrieved status" and "never leave terminal", with no disposition
when a re-fetch returns non-terminal for a terminal row. The answer is: **the
terminal row is retained, the write is a no-op, and the anomaly is reported.**
It is explicitly **not** an error — raising one would roll back the claim/domain
transaction, Stripe would retry, and the same anomaly would recur indefinitely,
turning an observation into a stuck event.

**Acceptance:** a terminal→non-terminal re-fetch leaves the row terminal and
emits the anomaly report **without failing the transaction**; a writer that
bypasses the upsert is rejected by the trigger; and a normal non-terminal
progression still applies.

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
   listens (`index.ts:271`). There is no data to preserve — the membership
   tables hold nothing real (David, 2026-07-28) — so this is a create-and-drop,
   not a backfill.
   **The same change must retire the legacy seed DDL, or the app cannot boot.**
   `ensureSchema()` runs immediately after `runMigrations()` (`index.ts:274`),
   **before the port binds**, and `seed.ts:562-565` still executes
   `ALTER TABLE lifetime_entitlements ADD COLUMN IF NOT EXISTS status …`. The
   `IF NOT EXISTS` guards the **column, not the table**, so once the table is
   dropped that statement raises `42P01` outside the migration runner's
   `SAVEPOINT` recovery and **aborts startup**. Removing that seed entry (and
   any sibling referencing a dropped table) is part of this migration, not
   follow-up work.
   This is the plan's single highest-risk change and the defect would have
   stopped the deploy dead — found in **round 20**, by finally pointing a review
   at the core instead of at the machinery around it.
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
a no-op on a second run; **the boot test exercises the real
`runMigrations()` → `ensureSchema()` sequence** rather than the migration alone,
and the process reaches the point of binding its port; reconciliation populates
entitlements from Stripe; a webhook delivered during the rollout is retried by
Stripe and applied afterwards.

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

**Notifications are out of scope from revision 20 (David, 2026-07-29).** The
apply transaction contains **domain writes only**. Every notification call —
`sendEmail` at `webhookHandlers.ts:778`, `:841`, `:888`, and the fire-and-forget
`notifyUserAccessRevoked` / `notifyAdminsOfDispute` / `notifyAdminsOfFraudWarning`
at `:378`, `:487`, `:513`, `:598`, `:925`, `:1014`, `:1039` — moves **after the
commit** and keeps exactly today's semantics: best-effort, unguaranteed, lost on
a crash. See *Notifications are out of scope* below for what that costs and why
it is deliberate.

That move is not optional housekeeping: those calls sit inside the region this
section wraps in a transaction, and `email.ts:19` / `userNotify.ts:14` /
`adminNotify.ts:13` all import the global `db`. Left where they are, an awaited
`sendEmail` would commit an outbox row **independently** of the claim (so a
rollback leaves a queued email for a grant that never happened), and a
fire-and-forget call could **outlive** the transaction and notify on state that
rolled back moments later. Moving them past the commit is the minimum required
to make the transaction boundary mean anything — and it is all this plan does
about them.

**"Move them after the commit" is not yet a mechanism, and one detail makes it
non-trivial.** Notification eligibility is decided from **pre-mutation** state
inside the domain switch — `wasLegendary` at `webhookHandlers.ts:370-378` is
read before `setMembershipTier` and gates the email. Lifting the calls out
without carrying that decision would mean recomputing it after apply, which
reads the *post*-mutation state and **changes behaviour**: the refund email
would stop being sent at all, because by then the user is already `registered`.

**Specification:** the apply phase returns a **transient list of notification
actions**, decided from the locked pre-state at the moment the transition is
applied, and the caller executes them **after the transaction commits** and only
if it committed. In memory, not persisted; **lost on a crash between commit and
execution, and that loss is accepted** — see *Notifications are out of scope*.

Two consequences worth stating explicitly rather than leaving to inference:

- **This is the mechanism revision 14 deleted** as option 2, and ledger entry 78
  is superseded accordingly. The reversal is deliberate, not an oversight: then
  it was carrying obligations the plan claimed to *guarantee*, and losing them
  silently was a defect. Now it carries best-effort courtesy emails whose loss
  is documented. **The mechanism did not become correct; the requirement it
  serves became weaker.**
- **`processDomainSwitch` has two callers** — `processWebhook` (`:1189`) and
  `processEventDirectly` (`:1096-1101`, test-mode QA). Both execute the returned
  actions after their domain work succeeds. Returning a value from a function
  with a second caller is exactly how a behaviour silently disappears from the
  path nobody was thinking about, and test-mode QA quietly ceasing to send
  notifications would be discovered slowly and confusingly.

**Invariant 5 is withdrawn.** *"Notification emitted only after a committed tier
transition"* has been in this plan since round 2 and was never true of the code;
after this change it is true of *ordering* and still not a delivery guarantee. A
half-true invariant is worse than none, so it is struck rather than reworded.

#### Notifications are out of scope (David, 2026-07-29)

**Rounds 13 through 17 produced twenty findings and every one of them was in
machinery built to guarantee notification delivery** — the transactional outbox,
the `membership_side_effects` manifest, its five state markers, three writers,
recovery, key-mode isolation, stranded detection, critical-alert retention and
acknowledgement. Nothing in that stretch touched the entitlement model. Each
round's fix produced the next round's defects, and by revision 19 the delivery
guarantee was a more intricate system than the thing it notified about.

**David's decision: cut all of it. The email system is being rebuilt in its own
session.**

| Cut | Kept |
|---|---|
| The `membership_side_effects` manifest and every marker on it — `job_id`, `delivered_at`, `abandoned_at`, `acknowledged_at` — and `obligations_derived_at` on the claim | The **prepare/apply split** and the transaction boundary: claim + every domain write in one short transaction, provider retrieval outside it, no Stripe call between `BEGIN` and `COMMIT` |
| Obligation derivation under the lock, side-effect keys, provider idempotency keys, at-least-once delivery semantics | **Domain writes take the transaction executor** — a handler that cannot reach the global `db` cannot write outside the claim's transaction |
| Recovery and re-enqueue of lost notifications; the both-directions job/manifest reconciliation | The **audit-trail half** of that recovery, which is about the *entitlement* record rather than email: a claim with no terminal audit row is still detected, and `ignored_duplicate` is still **not** treated as terminal for the original outcome |
| Unconditional enqueue, key-mode discriminator, stale-mode/stranded detection, drain path | Notification calls **move after the commit** — the minimum that makes the boundary real |
| Critical-alert classification, retention past purge, bulk-delete exclusion, operator acknowledgement, the admin indicator | Everything about the entitlement model: derivation, W1a/W1b, leases and fences, read-path expiry, reconciliation, the schema, the migration |

**What this costs, stated plainly rather than buried.** These defects are real,
they are **live in the code today**, and this plan leaves them exactly as it
found them:

- a notification lost to a crash after commit is **lost permanently**, because
  Stripe's retry is discarded as a duplicate (`webhookHandlers.ts:1170-1179`);
- notification helpers **swallow** their own failures (`userNotify.ts:36-55`,
  `adminNotify.ts:174-197`), so a failure to alert is invisible;
- an alert that exhausts its retries leaves a `failed` row that is purged after
  30 days and can be cleared by the admin bulk-delete endpoint
  (`admin.ts:3058-3078`);
- `sendEmail` skips the enqueue entirely when Resend is unconfigured or the key
  is a test key (`email.ts:121-147`).

**The distinction that makes this acceptable is worth naming:** every one of
those is a failure to *tell someone* about a state change. **None of them makes
the state wrong.** A user's entitlement is correct because the derivation, the
leases and reconciliation make it correct — not because an email arrived. The
product requirement this plan exists to satisfy is unaffected by all of it.

**Handed to the email-system rebuild**, with evidence, so nothing found here is
lost:

1. the four defects above;
2. `asyncJobs` finalizers update by id with **no claim predicate**
   (`asyncJobs.ts:435-465`), so a worker whose row was reclaimed by
   `recoverStuckProcessing` can overwrite the reclaimer's terminal state;
3. the queue has **no skipped/deferred handler outcome** (`HandlerResult`,
   `:49-52`), so a worker cannot decline a row it should not process;
4. **abandonment is not atomic** — the exhausted-attempt transaction updates
   `async_jobs` only, then calls `onAbandon` *after* commit as best-effort and
   catches its failure, so any durable record of abandonment can be lost while
   the job stays `failed`;
5. **`POST /admin/email-queue/:id/retry` exists** (`admin.ts:3086-3105`) and
   resets a `failed` email row to `pending` with `attempts: 0`. Any future
   design that records delivery state *outside* `async_jobs` has to account for
   this path, which can restart an attempt behind a record that believes it is
   closed. Found in round 18 — a surface nobody in this review had enumerated
   until then, including me.
6. `deferEmailWhileDeliveryDisabled` records **no durable deferral evidence** —
   it touches `updated_at` and nothing else, so "how long has this been
   deferred, and how often" is not answerable from the schema today.

This is the third and largest scope cut on this plan, and the same distinction
governs all three: **shed what is adjacent, keep what is load-bearing for
correctness.**

#### The audit trail, and what recovery still checks

Audit writes stay **outside** the transaction so a `failed` record survives
rollback. The post-commit case is specified too: a committed mutation whose
`processed` audit insert fails leaves the trail showing only `received`.

**But that only holds if the two failures are told apart, and today they are
not.** `processWebhook` puts the domain call and the `processed` audit insert in
**one `try`**, whose `catch` appends `failed` (`webhookHandlers.ts:1188-1195`).
So after the domain transaction commits, a one-shot failure of the `processed`
insert lands in that catch and writes **`failed`** — a terminal row. Recovery
then reads the claim as terminal and never reports it, while the mutation it
describes did commit and its outcome was never recorded. Excluding
`ignored_duplicate` does not help here: the row genuinely says `failed`.

**Specification: the `processed` audit insert gets its own error handling,
outside the domain `try`.** A domain failure writes `failed`; a post-commit
audit-write failure writes **nothing**, leaving the trail at `received` — which
is precisely the state recovery already looks for. `failed` then means *the
domain work failed*, and nothing else, which is what every consumer of that
value already assumes.

**A retry can forge terminality, and that survives the notification cut**
because it is about the *entitlement* record rather than about email. After a
committed mutation whose `processed` insert failed, Stripe's retry hits the
duplicate branch and appends `ignored_duplicate` (`webhookHandlers.ts:1176-1179`)
— so the claim now *has* a terminal audit row while the original outcome was
never recorded. **`ignored_duplicate` is therefore not treated as terminal for
the original processing outcome; only `processed` or `failed` is**, and recovery
queries for claims lacking a genuinely terminal row.

**Acceptance:** inject a failure after a source write inside apply and prove
**both** the mutation and the idempotency claim roll back, so Stripe's retry
succeeds; assert **no Stripe call occurs between `BEGIN` and `COMMIT`**; assert
**no notification is emitted before the commit**, and that a rolled-back apply
emits none at all; commit a mutation, fail its `processed` audit insert, and assert the
trail shows **`received` and not `failed`**, that recovery reports the event as
lacking a recorded outcome, and that it still does so after Stripe's retry
appends `ignored_duplicate`; and assert **both** callers of the domain switch
execute the returned notification actions after a successful commit, and neither
executes them after a rollback.

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

**Enumeration returns provider state before any lease is held, and staging it
defeats every fence.** Account-wide enumeration necessarily hands back objects
before reconciliation knows which per-source lease to take. If it stages what
the list returned: a webhook acquires that source's lease, stores a newer
cancellation, and releases; reconciliation then acquires the lease with a
**valid, newer fence** and overwrites the row with the older enumerated `active`
snapshot. **Every commit-time fence and version check passes**, because the
fence proves who holds the lease *now* and says nothing about when the data was
read. Access is resurrected — the exact outcome three rounds of ordering work
exist to prevent, reached by the one path that never acquires a lease before
reading.

**Specification: enumeration yields identities only.** List pages are used for
*which sources exist*, never for their state. Each source is **re-retrieved
after acquiring its lease**, so the snapshot applied is always one taken while
the lease was held. That restores the invariant the leases were built on —
*retrieval and apply are serialized per source* — which enumeration had been
quietly exempt from.

**Auxiliary collections need the same rule, and the completeness rule needs
extending.** Refunds and disputes are states of **charge** and **dispute**
objects, which are not present on a re-retrieved `Subscription` or
`PaymentIntent` — so identity-only re-retrieval of the *source* does not by
itself yield current refund or dispute state. And finding 65's completeness rule
does not reach them: after a dispute page fails, an unseen dispute **cannot yet
be mapped** to a user "with a source in that collection", because the mapping
from dispute to source is precisely what the missing page would have supplied.

**Specification:**

- Charge, refund and dispute **identities** come from enumeration; each is
  **re-fetched and correlated to its source while that source's lease is held**,
  the same discipline as the source itself.
- **Every auxiliary collection relevant to a source must be complete before that
  source is staged as unheld or unrefunded.** Absence of a dispute is evidence
  only if the dispute collection was fully enumerated.
- A failed middle dispute page therefore **preserves every potentially affected
  source** — not merely those already known to have a dispute, which is exactly
  the set the failed page would have expanded.

**Acceptance:** interleave a webhook between the list-page retrieval and the
per-source acquisition, and assert reconciliation commits the **webhook's**
newer state, not the enumerated older one; and **fail a middle dispute page and
assert every potentially affected source is preserved rather than staged as
unheld.**

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

**The run lease carries the same fence as the per-source leases** (see
*Concurrency*), and for the same reason: expiry alone lets a paused run A be
superseded by run B and then **commit its whole staged change set anyway** while
B is still staging. The per-source version guards cannot fence that — B has not
committed newer tokens yet — so the single-flight and guard-once guarantees are
both lost at once, and a stale full-account change set is the largest blast
radius in this plan.

**Specification:** the guard-once **commit transaction opens** by taking the run
lease row `FOR UPDATE` and requiring the run's own fence, still held and
unexpired. If it does not hold, the transaction aborts, **nothing is written**,
and the run reports as superseded — a distinct outcome from `failed`, because
nothing went wrong except elapsed time. Staging remains side-effect-free, so an
abandoned run costs only the enumeration it already did.

**The run fence is not enough — every staged *source* must be fenced too.**
Reconciliation also holds **per-source** leases while it prepares, and revision
13 validated only the run lease at commit. The hole is the same shape as the
two it just closed: reconciliation stages source S under source-fence 1; that
source lease expires; a webhook acquires fence 2 and is **still retrieving**,
so no newer `source_state_as_of` exists; reconciliation's commit passes the run
fence and the version guard, and writes its stale snapshot of S. If the webhook
then crashes, the stale state is permanent. Third instance of "a lease without
a fence", and the second time I have fixed one lease and left another.

**Specification:** the commit transaction validates **every staged source's
lease** — holder, fence and unexpired — the same check the webhook apply path
performs, before it touches any user row.

A source that fails its fence check does **not** abort the run. It is dropped,
and so is every user whose staged tier depended on it — the same disposition
the version-guard rejection already gets, since a staged tier computed from
superseded source state is invalid for exactly the same reason. Aborting the
whole run instead would be worse than heavy-handed: under steady webhook
traffic a single stolen source lease would fail every run, and reconciliation
would **livelock**, never committing anything.

**Locks are taken with `SKIP LOCKED`, because blocking re-creates the livelock
this design exists to avoid.** Revision 14 said a failed source fence drops that
source and its dependent users — but a fence can only be *inspected* if the row
can be *locked*, and a plain `FOR UPDATE` against a row a webhook holds
**blocks**. It then hits `lock_timeout`, which aborts the statement and the
transaction. So in the contended case the per-source drop is unreachable: the
whole run rolls back, and with many lease and user locks that repeats under
steady traffic — precisely the livelock the drop rule was introduced to prevent.
The rule was correct about a *stale* lease and silent about a *held* one.

**Specification: contention is the same outcome as a stale fence, not an
error.**

- Staged lease rows are taken with `SELECT … FOR UPDATE SKIP LOCKED`. A lease
  held by another transaction is simply **absent from the result**, and absence
  is read as "someone else owns this source" — that source and its dependent
  users are dropped from the run, exactly as a failed fence check drops them.
  No waiting, no timeout, no aborted transaction.
- User rows are taken the same way; a user whose row is held by a webhook's
  apply transaction is dropped from the run and picked up next time.
- **Contention is reported as its own outcome category**, alongside
  incompleteness, so a run that skipped many users is visibly partial rather
  than quietly so.

`SKIP LOCKED` is not a novelty here — the job queue already claims work with
`FOR UPDATE SKIP LOCKED` (`asyncJobs.ts:14`, `:531-573`), so this is the
repo's existing idiom for "take what is free, leave what is busy."

Because nothing waits, **deadlock is impossible**, and the ordering rule below
becomes belt-and-braces rather than load-bearing. It stays anyway, since it
costs nothing and keeps the intent legible: **all lease rows first, ordered by
scope key; then user rows, ordered by user id.** The webhook apply path takes
its single source lease then its single user row — the same relative order.

The webhook path deliberately does **not** use `SKIP LOCKED`: it has exactly one
source and one user, nothing to skip to, and abandoning its write on contention
would drop a real event. It blocks with a lock timeout and lets Stripe retry.
Reconciliation can skip because it re-runs over everything; a webhook cannot,
because it is the only carrier of its event.

**Acceptance:** pause run A past its **run** lease expiry, let run B acquire and
stage, then resume A — A commits **nothing** and reports superseded; B's commit
succeeds; the entitlement table matches B's change set exactly, with no
interleaving of A's. Separately, expire one **source** lease under a staged run
while a webhook holds the successor fence and is still retrieving — that
source and its dependent users commit nothing, the rest of the run commits
normally, and the webhook then crashing leaves the pre-existing state rather
than reconciliation's stale snapshot. **Hold a lease in the *middle* of a
staged run from another transaction and assert the run commits everything else,
drops only that source and its dependent users, reports the contention, and
neither blocks nor rolls back** — then assert the next run picks up what was
skipped, so progress is defined rather than merely non-fatal. Run reconciliation
and a webhook concurrently against overlapping sources and assert no deadlock.

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
| 4 | 1 | Backfill from current truth | **Superseded by scope decision 57** (migration machinery deleted). The transactional disposability assertion and its DDL abort are **not built** — the migration is a plain create-and-drop. Do not implement the guard this row describes. |
| 5 | 1 | Terminal audit handling | **Resolved.** |
| 6 | 1 | Authoritative ingestion | **Resolved** via the unconditional version guard. |
| 7 | 1 | Automate reconciliation | **Resolved** — sources reconciled before recompute. |
| 8 | 2 | Retrieval vs lock composition | **Resolved.** |
| 9 | 2 | Bound automated downgrades | **Resolved** (supersession overturned in round 4) — restored as a permanent runtime guard; the pre-launch premise covered only the cutover, not a reconciler that runs forever. |
| 10 | 2 | Stage classification | **Superseded by scope decision 57** (migration machinery deleted). Stage classification is **not built**; there are no stages. |
| 11 | 2 | Reconcile sources before recomputing | **Resolved.** |
| 12 | 2 | Lifetime-revoke in serialization | **Resolved.** |
| 13 | 2 | Legendary at admin creation | **Resolved** — David settled it: both admin surfaces become entitlement grants; create-user atomically writes an `admin_grant`. |
| 14 | 3 | Enforceable monotonic version | **Resolved** — token is a DB-issued `source_state_as_of`, taken at retrieval for Stripe-sourced writes and under lock for local ones. Stripe exposes no usable version; ours does. |
| 15 | 3 | Specify the normalisation migration | **Resolved** — target DDL, keys and constraints stated; dual-write/backfill dropped as unnecessary given no live data. |
| 16 | 3 | Phase 2 authorization in shadow mode | **Resolved** — no read-only phase exists in the two-phase split; the per-request authorization path is documented so one is never added naively. |
| 17 | 3 | Ship grace expiry with the cutover | **Resolved** — local expiry sweep moved into Phase 1. My "known gap" framing was wrong. |
| 18 | 3 | Recover the original grace start | **Resolved** — episode start resolved from the earliest unpaid invoice, not the subscription. |
| 19 | 4 | Sequence token, not a clock | **Resolved** — `clock_timestamp()` is not unique under concurrency; a sequence is required. |
| 20 | 4 | Guard the empty cutover | **Superseded by scope decision 57** (migration machinery deleted). No cutover predicate is asserted — there is no cutover to guard. |
| 21 | 4 | Reconcile lifetime sources too | **Resolved** — enumeration covers one-time payments, refunds and disputes, not only subscriptions. |
| 22 | 4 | Restore downgrade bounds | **Resolved** — permanent pre-apply threshold and abort. |
| 23 | 4 | Move missed-event repair to Phase 1 | **Resolved** — authoritative refresh moves into Phase 1; the sweep alone could not start a grace window that was never opened. |
| 24 | 4 | Admin revocation provenance | **Resolved** — `revoked_at` plus a status-conditional constraint. |
| 25 | 5 | Schedule authoritative refresh in Phase 1 | **Resolved** — phasing collapsed; cadence ships with the model. |
| 26 | 5 | Downgrade bounds around every refresh | **Resolved** — the guard ships with the first mutating refresh. |
| 27 | 5 | Lock source tables before the disposability check | **Superseded by scope decision 57** (migration machinery deleted). **No `ACCESS EXCLUSIVE` lock is taken**, because there is no disposability check to protect. |
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
| 38 | 8 | Bridge trigger cannot write constraint-valid legacy admin rows | **Superseded by scope decision 57** (migration machinery deleted). **No bridge trigger exists**; nothing described here is built. |
| 39 | 8 | Legacy `DELETE` conflates revoke with user purge | **Superseded by scope decision 57** (migration machinery deleted). **No bridge trigger exists.** (39's *separate* discovery survives on its own: the purge deletes `membership_history`, which David formally exempted — see *Must not change*.) |
| 40 | 8 | Mirrored writes leave `membership_valid_until` stale | **Superseded by scope decision 57** (migration machinery deleted). **No bridge trigger exists**; nothing described here is built. |
| 41 | 8 | Row trigger is not a commit-time fence | **Superseded by 42, then by scope decision 57** — no gate, no trigger, nothing to fence. |
| 42 | 8 | A quiet period cannot prove old binaries are gone | **Superseded by scope decision 57** (migration machinery deleted). **No compatibility views exist** — and they were also unbuildable: a view cannot serve `INSERT … ON CONFLICT (col) DO UPDATE` (verified on 16.13). |
| 43 | 8 | Marker cardinality unenforced — revert fails **open** | **Superseded by scope decision 57** (migration machinery deleted). **No cutover marker exists.** |
| 44 | 8 | Whole-second Stripe timestamps vs sub-second boundary | **Superseded by scope decision 57** (migration machinery deleted). **No revert boundary exists**, so there is no timestamp comparison to bias. |
| 45 | 8 | Legacy history rows remain unreplayable | **Superseded by scope decision 57** (migration machinery deleted). **No bridge trigger exists**; nothing described here is built. |
| 46 | 8 | Stale expiry demotes users during reconstruction | **Superseded by scope decision 57** (migration machinery deleted). **No phase 0 exists**; nothing clears `membership_valid_until` in bulk. |
| 47 | 8 | `membership_valid_until` undefined over a source union | **Resolved** — null when any indefinitely-valid source qualifies, otherwise the max of the grace-bound deadlines; coexistence tests added. |
| 48 | 8 | Permission and spending readers bypass expiry | **Amended by 70/76/79** — the chokepoint stands, but the primitive is the SQL **expression**, the row helper is defined from it, and agreeing surfaces share one instant. **Resolved** — one shared `getEffectiveMembership` helper; `createMemeRecord.ts:149-179` and `budgetGate.ts:77-98` confirmed as real authorization readers, and the full reader inventory is built by searching the column, not the middleware. |
| 49 | 9 | Aborted recovery leaves expiry permanently disabled | **Superseded by 60** — this row's own resolution ("recovery is redeploy the previous build") was **disproved** in round 10: `migrate.ts` skips applied hashes, so the old build never recreates the dropped tables. Recovery is **roll-forward-only**. Do not implement or rely on a redeploy rollback. |
| 50 | 9 | Bridge would launder D1's fabricated payment status | **Superseded by 57** — no bridge exists. The principle it established survives as an invariant: no path creates a qualifying paid entitlement from a caller-supplied status. |
| 51 | 9 | A view cannot serve the legacy `ON CONFLICT` upsert | **Superseded by 57** — verified on PostgreSQL 16.13; the view-based contract is deleted rather than fixed. |
| 52 | 9 | Revert precondition used `>` against a `>=` rule | **Superseded by 57** — the precondition is deleted. |
| 53 | 9 | Views cannot round-trip legacy-only columns | **Superseded by 57** — the views are deleted. |
| 54 | 9 | `legacy_bridged` qualified while exempt from W1b | **Superseded by 57** — the exemption existed only for bridged rows; with no bridge, W1b holds unscoped for every row the new path writes. |
| 55 | 9 | Purge policy wrongly called non-blocking | **Resolved** — settled by David: the purge is formally exempted, *Must not change* states the scoped invariant, and it is on the launch revisit list. |
| 56 | 9 | Verification still demanded the removed contract gate | **Resolved** — acceptance criteria re-derived from the sections they belong to; orphaned items removed. |
| 57 | — | **Scope decision (David, 2026-07-29): maintenance window.** | The zero-downtime overlap requirement is withdrawn. Findings 29–54 that existed only to serve it are superseded *by the requirement going away*, not by a better mechanism — recorded honestly so nobody rebuilds them believing they were solved. |
| 58 | 10 | Sequence token taken *after* retrieval is not causal | **Superseded by 66** — token-before-retrieval was the *second* failed ordering scheme. Ordering over provider state cannot be derived from any locally-allocated number. The mechanism is **per-source leases with a fencing token** (73); `source_state_as_of` survives only as defence in depth. |
| 59 | 10 | Downgrade guard ran after sources were persisted | **Resolved** — the recovery-only phase split is removed; a run stages source *and* tier changes with no mutation, guards once, then commits. Also closes the piecemeal-downgrade path that evaded the bound. |
| 60 | 10 | "Redeploy the previous build" is not an executable rollback | **Resolved** — verified in `migrate.ts`: applied hashes are skipped, so the old build never recreates the tables. Declared **roll-forward-only**, with the mitigation moved before the migration rather than after. |
| 61 | 10 | Destructive migration not specified as idempotent | **Resolved** — guarded DDL plus a **second-run no-op** acceptance case. `migrate.ts` already rescues `42P07`/`42P01` via `SAVEPOINT`, but depending on error-code recovery for an expected condition is fragile. |
| 62 | 10 | The maintenance gate does not exist | **Resolved by deletion** — confirmed no maintenance control exists anywhere in the repo. Rather than build one, the plan states plainly that old instances will error during the rollout and that this costs nothing pre-launch. I had written a runbook step for a control I never checked for. |
| 63 | 10 | Actor FK breaks when a *grantor* is purged | **Amended by 71** — the twice-recorded actor (id `ON DELETE SET NULL`, label `NOT NULL`) stands, but the label is **not immutable**: it is overwritten with a stable opaque token on hard delete, per the retention matrix. |
| 64 | 11 | Staged tier can be committed against a source set a webhook has superseded | **Resolved** — a version-guard rejection invalidates that user's staged tier; re-derive under the lock or drop the user from the run. A hole in round 10's own fix. |
| 65 | 11 | Incomplete enumeration is indistinguishable from deletion | **Resolved** — completeness tracked per collection; users with a source in an unproven collection are skipped with rows preserved, reported as its own category rather than folded into `failed`. |
| 66 | 11 | Token-before-issuance still is not causal | **Superseded by per-source leases (73)** — Codex was right and my own text contradicted itself. **Two token schemes both failed**; ordering over *provider state* cannot be derived from any locally-allocated number, so retrieval-and-apply is serialized per source by a committed lease **with a fencing token validated inside the apply transaction**. `source_state_as_of` is **not** a lease-expiry backstop — 73 proved it cannot fence an expired holder while the successor is still retrieving. It survives only as **defence in depth** against a write from a path that bypasses the lease entirely. |
| 67 | 11 | Webhook transaction would span Stripe I/O | **Resolved** — prepare/apply split; provider retrieval happens before the transaction opens, and every domain write takes a transaction executor so it cannot reach the global `db`. Two long-standing sections that contradicted each other and had never been read together. |
| 68 | 11 | Reconciliation is not a cross-process singleton | **Resolved** — DB-backed single-flight lease with expiry. Resumable staging and per-item durable status **explicitly deferred** as scale controls, recorded rather than omitted. |
| 69 | 11 | Two active admin grants possible; revoke marks only one | **Resolved** — partial unique index on one active `admin_grant` per user. The main constraint excluded them because `provider_ref` is null. |
| 70 | 11 | `getEffectiveMembership` cannot serve set-based readers | **Amended by 76** — the shared SQL definition stands, but the primitive is an **expression** (`effectiveTierExpr`), not a predicate; a predicate has no answer for `registered`. Per 79, surfaces that must agree are also evaluated at **one instant**. |
| 71 | 11 | Immutable actor label conflicts with the retention matrix | **Resolved by existing policy** — `data-lifecycle-retention-matrix.md` already requires anonymization of direct identifiers in payment records, so the label is overwritten with a stable opaque token on hard delete rather than kept forever. Not escalated: the repo had already decided it. |
| 72 | 11 | No create-time control for a comped account | **Resolved** — explicit "Grant membership" checkbox plus required reason replaces the removed tier selector; the atomic-create capability would otherwise have been silently lost. |
| 73 | 12 | An expired per-source lease holder is not fenced | **Resolved** — a fence value from a sequence, validated inside the apply transaction under `SELECT … FOR UPDATE`, with compare-and-release. Revision 12 gave that job to `source_state_as_of`, which cannot do it: a successor still retrieving has stored no newer token, so the late write passes the guard. **Third failure of the ordering design**, and the first one whose fix does not depend on a number meaning something it does not. |
| 74 | 12 | An expired reconciliation holder can still commit its staged run | **Resolved** — the same fence, taken by the guard-once commit transaction; a superseded run commits nothing and reports as its own outcome. Same defect as 73 in the second lease, which I built without carrying the mechanism across. |
| 75 | 12 | Apply reaches the global `db` transitively (#67 Still Open) | **Partly superseded by 104** — the transaction boundary stands: every **domain write** takes the executor and cannot reach the global `db`. The notification half is cut; those calls move after the commit and keep today's best-effort semantics rather than becoming transactional. |
| 76 | 12 | The tier predicate has no answer for `registered` (#70 Still Open) | **Resolved** — the primitive becomes an effective-tier `CASE` **expression**; predicates derive from it. Revision 12 fixed the dashboard's over-count and introduced an under-count in the adjacent query (`admin.ts:2555`), because an expiry *filter* answers "is this user still X" while the readers ask "what is this user's tier". |
| 77 | 13 | Reconciliation's commit fences the run but not each staged **source** | **Resolved** — the commit validates every staged source's lease before touching any user row; a failed fence drops that source and its dependent users rather than aborting the run (a whole-run abort would **livelock** under steady webhook traffic). Lock ordering fixed: leases by scope key, then users by id — the same relative order the webhook path uses. **Third instance of "a lease without a fence", and the second time I fixed one lease and left another.** |
| 78 | 13 | The post-commit action list loses required notifications on crash | **Superseded by scope decision 104** — the post-commit action list is **reinstated**, deliberately. Entry 78's reasoning was sound *for guaranteed obligations*: the claim commits, the process dies, Stripe's retry is discarded as a duplicate, and the work is lost. Under 104 the actions are best-effort courtesy emails and that loss is an accepted, documented cost rather than a defect. **The mechanism did not become correct; the requirement became weaker.** |
| 79 | 13 | One shared expression is not one shared instant | **Resolved** — `now()` is the *transaction* timestamp, and the dashboard runs its two counts as two statements in a `Promise.all`, so a user crossing the horizon between them is counted twice or not at all. One conditional-aggregation statement, or a bound `asOf` passed to every surface. The acceptance criterion I wrote (the counts sum to the same total) would have failed against the very query it was written for. |
| 80 | 14 | The outbox row is not actually guaranteed | **Superseded by scope decision 104** (notifications out of scope). Enqueue is neither unconditional nor transactional — notification calls simply move after the commit and keep today's best-effort semantics. **Not built.** |
| 81 | 14 | Audit and outbox cannot be correlated | **Partly superseded by 104** — the outbox correlation is cut with the manifest. What survives is the **audit half**, which is about the entitlement record rather than email: recovery still detects a claim with no terminal audit row, and `ignored_duplicate` is still **not** terminal for the original outcome. |
| 82 | 14 | A permanently failed payment alert is invisible | **Superseded by scope decision 104** (notifications out of scope). No critical-alert classification, retention override, or admin indicator. A failed payment alert stays as invisible as it is today. **Not built** — handed to the email rebuild. |
| 83 | 14 | A *held* lease blocks; the per-source drop is unreachable (#77 Still Open) | **Resolved** — locks taken with `SKIP LOCKED`, so contention becomes the same outcome as a stale fence rather than a `lock_timeout` that aborts the run. My drop rule was correct about a *stale* lease and silent about a *held* one, which reinstated the exact livelock it was written to prevent. The webhook path deliberately still blocks: it is the only carrier of its event and cannot skip. |
| 84 | 14 | "Exactly once" delivery was never true | **Superseded by scope decision 104** (notifications out of scope). No provider idempotency key and no delivery-semantics claim; the plan makes none. **Not built.** |
| 85 | 14 | Ledger entry 75 still offered the deleted post-commit option | **Resolved** — entry 75 rewritten. A resolution row is an implementation instruction, so a superseded one contradicts the section that superseded it. First finding in this review against the ledger itself rather than the plan body. |
| 86 | — | **Scope decision (David, 2026-07-29): the notification subsystem stops at revision 15.** | Rounds 11–14 produced 22 findings and **none against the entitlement model** — each round moved one subsystem outward, ending in the async-job queue's adequacy as a payment-alert transport. Entries 80–85 are frozen as specified; further queue-capability findings are recorded as separate work rather than absorbed. See *Scope boundary* for the in/out table. Same shape as 57, and the same governing distinction from round 4: **shed what is adjacent, keep what is load-bearing for correctness.** |
| 87 | 15 | Moving the enqueue decision breaks disabled-delivery and test-key isolation (#80 Still Open) | **Superseded by scope decision 104** (notifications out of scope). No enqueue change, so no disabled-delivery or test-key regression to contain. **Not built.** |
| 88 | 15 | The owed side-effect set cannot be recomputed (#81 Still Open) | **Superseded by scope decision 104** (notifications out of scope). No manifest. The owed set is neither persisted nor recomputed, because nothing recovers a lost notification. **Not built.** |
| 89 | 15 | `side_effect_key` uniqueness is not achievable on `async_jobs` | **Superseded by scope decision 104** (notifications out of scope). No `side_effect_key`, so no uniqueness contract to satisfy anywhere. **Not built.** |
| 90 | 15 | Fourteen ledger rows still instruct withdrawn mechanisms | **Resolved** — entries 4, 10, 20, 27, 38–46 marked **superseded by scope decision 57** with an explicit "not built"; 49's own resolution was disproved by 60 and now says roll-forward-only; 58, 63, 70 and 48 amended to point at 66/73, 71, and 76/79. Round 14 established a resolution row is an implementation instruction; this is that principle applied to the whole ledger rather than one row. |
| 91 | 15 | Bulk-delete erases the critical-failure evidence (#82 Still Open) | **Superseded by scope decision 104** (notifications out of scope). No acknowledgement and no bulk-delete exclusion; the endpoint keeps its current behaviour. **Not built.** |
| 92 | 16 | Obligations still derived in prepare, outside the lock (#81 Still Open) | **Superseded by scope decision 104** (notifications out of scope). No obligation derivation at all, so nothing to move under the lock. **Not built.** (The finding's *reasoning* survives as a caution: state read before a lock is not the state the lock acts on.) |
| 93 | 16 | Entry 66 still called `source_state_as_of` a lease-expiry backstop (#90 Still Open) | **Resolved** — rewritten to match the body: 73 proved it cannot fence an expired holder while the successor is still retrieving, so it survives only as defence in depth against paths that bypass the lease. My own fourteen-row audit missed a row that contradicted the section the audit was checking against. |
| 94 | 16 | The manifest cannot rebuild a job — identity is not the payload | **Superseded by scope decision 104** (notifications out of scope). No stored payload, because there is no re-enqueue. **Not built.** |
| 95 | 16 | A wrong-mode worker consumes the row (#87 Still Open) | **Superseded by scope decision 104** (notifications out of scope). No key-mode discriminator, so no wrong-mode claim. **Not built** — the missing skipped/deferred handler outcome is handed to the email rebuild. |
| 96 | 16 | An empty obligation set is indistinguishable from a skipped write | **Superseded by scope decision 104** (notifications out of scope). No `obligations_derived_at`. **Not built.** |
| 97 | 16 | "Job vanished → re-enqueue" would resend every delivered notification | **Superseded by scope decision 104** (notifications out of scope). No recovery of notifications, so no resend loop to gate. **Not built.** |
| 98 | 17 | Recovery does not serialize against itself | **Superseded by scope decision 104** (notifications out of scope). No recovery component to serialize. **Not built.** (The *lesson* stands and is stated in the plan: a component that can run twice needs its own answer for racing itself.) |
| 99 | 17 | A row deferred for a retired key mode is stranded and invisible | **Superseded by scope decision 104** (notifications out of scope). No deferral hook change, so nothing strands. **Not built.** |
| 100 | 17 | `delivered_at`-only gating re-sends abandoned and dismissed alerts | **Superseded by scope decision 104** (notifications out of scope). No terminal dispositions, because there is no obligation record to dispose of. **Not built.** |
| 101 | 17 | A stale finalizer can overwrite the terminal pair | **Superseded by scope decision 104** (notifications out of scope). No `delivered_at` to be contradicted. **Not built** — the finalizer claim-predicate gap is handed to the email rebuild, where it was already going. |
| 102 | 17 | Ledger entry 81 still instructed prepare-time derivation | **Resolved, then largely superseded by 104** — entry 81 was rewritten to apply-time derivation, and the derivation itself is now cut. The finding's real value is the third class of stale ledger row it identified: a surviving mechanism described at the **wrong point in the sequence**, where every noun is still real and only the ordering is wrong. |
| 103 | 17 | A frozen `to` sends to an address the user may no longer own | **Superseded by scope decision 104** (notifications out of scope). No frozen payload, so no stale address. **Not built.** |
| 104 | — | **Scope decision (David, 2026-07-29): notifications are out of scope.** | Rounds 13–17 produced **20 findings and every one was in notification-delivery machinery**; nothing in that stretch touched the entitlement model, and each round's fix generated the next round's defects. The outbox, the manifest, its five markers, three writers, recovery, key-mode isolation, stranded detection, retention and acknowledgement are all **cut**. Notification calls move after the commit and keep today's best-effort semantics; their existing defects are documented and handed to the email-system rebuild. **What is kept is the transaction boundary itself** — claim plus domain writes in one transaction, retrieval outside it, executor-only domain writes — because that is entitlement correctness rather than delivery. Third and largest scope cut; same governing distinction as 57 and 86. |
| 105 | 18 | Stale-mode evidence cannot be evaluated | **Superseded by scope decision 104** — correct, and in machinery that no longer exists. The *fact* survives as handoff item 6: `deferEmailWhileDeliveryDisabled` records no durable deferral state, so "how long, how often" is unanswerable from the schema **today, by any design**. I specified a predicate over state that does not exist. |
| 106 | 18 | The undeliverable disposition was never named | **Superseded by scope decision 104** — correct, and in machinery that no longer exists. I named a state in prose and gave it no column; neither handler outcome could express it — success writes a false delivery record, terminal failure leaves the row eligible for recovery forever. Lesson kept: **an unnamed state is one nobody checks** — which I had written into that same round's review request. |
| 107 | 18 | Abandonment is not atomic | **Superseded by scope decision 104** — correct, and in machinery that no longer exists. Handoff item 4, and a defect in the **queue as it exists**: the exhausted-attempt transaction updates `async_jobs` only, then calls `onAbandon` post-commit as best-effort with its failure caught. Any future design recording delivery state outside `async_jobs` inherits it. |
| 108 | 18 | Delivery and abandonment have no precedence rule | **Superseded by scope decision 104** — correct, and in machinery that no longer exists. Set-once delivery does not prevent a *later* `abandoned_at`, so a row could read delivered **and** failed. Lesson kept: **adding a marker obliges you to state its precedence against every existing marker**, not only the one the finding named — I added two markers and specified each only against recovery. |
| 109 | 18 | The admin retry endpoint is missing from the state machine | **Superseded by scope decision 104** — correct, and in machinery that no longer exists. **The most valuable of the round.** `POST /admin/email-queue/:id/retry` (`admin.ts:3086-3105`) resets a `failed` email row to `pending` with `attempts: 0` — a surface **seventeen rounds of review had not enumerated**, including my own audits of what mutates these rows. Handoff item 5, stated as a constraint on any future design. |
| 110 | 18 | Ledger entry 97 still gated recovery on `delivered_at` alone | **Superseded by scope decision 104** — correct, and in machinery that no longer exists. Fourth consecutive round with a stale ledger row, and a fourth class: noun right, position right, **condition** out of date. Rule strengthened to its final form — *when a finding changes a mechanism's shape, position **or condition**, every row mentioning that mechanism is in scope for revision.* |
| 111 | 19 | "Move the calls after the commit" was not yet a mechanism | **Resolved** — eligibility is decided from **pre-mutation** state (`wasLegendary`, `webhookHandlers.ts:370-378`), so lifting the calls out without carrying that decision would recompute it post-mutation and **stop sending the refund email entirely**. Apply now returns a transient notification-action list decided from the locked pre-state, executed after commit by **both** callers — `processDomainSwitch` has a second one in `processEventDirectly` that a returned value would silently bypass. Entry 78 superseded: the post-commit list is reinstated because the requirement weakened, not because the mechanism improved. |
| 112 | 19 | An audit-write failure masquerades as a domain failure | **Resolved** — the domain call and the `processed` insert share one `try` whose catch writes `failed` (`:1188-1195`), so a post-commit audit failure produces a **terminal** row and recovery never reports a committed mutation whose outcome went unrecorded. Excluding `ignored_duplicate` was insufficient because the row genuinely says `failed`. The audit insert gets its own error handling; `failed` now means the domain work failed and nothing else. **The surviving half of the recovery check was incoherent on its own** — exactly what the round's lens asked. |
| 113 | 20 | Disputes have no representation in source qualification | **Resolved** — `charge.dispute.created` revokes access **today**, deliberately (`webhookHandlers.ts:462-515`), but an open dispute leaves a lifetime source `active` and a subscription on its ordinary status, so recomputation would have **handed access back**. The model would have silently deleted a live product behaviour. A source-local `access_hold`, distinct from provider lifecycle: set on open, cleared on a win, terminal on a loss — and per-source, so an unrelated entitlement still carries the union. |
| 114 | 20 | `is_membership_product` never gated qualification | **Resolved** — the qualification rule is a **conjunction**: allowlist, no access hold, then lifecycle. I named the allowlist as one of three separate concepts and then wrote a rule using only one of them, so **every `active` subscription qualified, including a non-membership one** — the positive-allowlist boundary this plan lists under *Must not change*, defeated by the model built to protect it. Live the moment reconciliation persists an active non-membership subscription. |
| 115 | 20 | Grace was anchored to a field that does not exist | **Resolved** — verified against the pinned Stripe 20.0.0 types: `Invoice.created` is object creation (*"not attempted until 1 hour after"*, per the type's own comment), `attempted` is a boolean, and `status_transitions` carries no failed-attempt time. Anchor is the **failed attempt's own timestamp** via explicit PaymentIntent/charge lookup; never `invoice.created`. (The `finalized_at` fallback this row originally specified was **withdrawn at entry 125** — an unresolvable attempt now derives no deadline.) |
| 116 | 20 | Enumeration stages provider state read before any lease | **Resolved** — a webhook can store a newer cancellation between the list page and the per-source acquisition; reconciliation then commits the older enumerated snapshot with a **valid newer fence**, and every check passes. **The fence proves who holds the lease now and says nothing about when the data was read.** Enumeration yields identities only; each source is re-retrieved after acquiring its lease. Fourth ordering defect, and the one path that never took a lease before reading. |
| 117 | 20 | The migration cannot boot — legacy seed DDL survives the drop | **Resolved** — `ensureSchema()` runs immediately after `runMigrations()` and **before the port binds** (`index.ts:271-274`), and `seed.ts:562-565` still runs `ALTER TABLE lifetime_entitlements …`. `IF NOT EXISTS` guards the **column, not the table**, so the drop makes it raise `42P01` outside the runner's `SAVEPOINT` recovery and **abort startup**. Retiring that seed entry is part of the migration; the boot acceptance now exercises the real `runMigrations() → ensureSchema()` sequence. **The plan's highest-risk change, dead on arrival, found in round 20.** |
| 118 | 20 | W1a had no verifier for subscription sources | **Resolved** — the specified verifier requires a `mode = payment` Checkout Session and a PaymentIntent, so it cannot create or refresh a `stripe_subscription` source, which is how subscription webhooks, the routes and reconciliation all arrive. An identifier-only **subscription** verifier binds subscription↔customer↔user, allowlisted product with pagination, and lifecycle — one of the two paid source types had no trust boundary at all. |
| 119 | 20 | "Snapshotted at ingestion" is ambiguous on refresh | **Resolved** — the two source types need opposite answers: a subscription's snapshot is **re-evaluated on every authoritative refresh** (or a portal switch to a non-membership price retains access forever), while a lifetime purchase's is **frozen at creation** (or later metadata edits retroactively revoke a completed purchase). |
| 120 | 21 | `access_hold` existed only in prose | **Resolved** — no column, so a dispute would not survive a restart and the first authoritative refresh would restore access to someone actively charging back. Persisted on the source row. (**Fully superseded at 126/128/134** — both columns are gone; the hold is an existence query over `entitlement_source_disputes`.) I specified a state that participates in **every** qualification decision and never added it to the schema section three hundred lines below. |
| 121 | 21 | The hold cannot reach the right source | **Resolved** — `resolveUserForDispute` (`webhookHandlers.ts:407-460`) resolves a **user**; all three of its lookups terminate at a user id, which is all tier-level revocation ever needed. A source-local hold needs charge → invoice → subscription (or payment-intent → lifetime). Mapping runs before any write, under that source's lease; an unresolvable dispute **holds nothing and is reported**, because holding every source would revoke an unrelated entitlement. |
| 122 | 21 | A boolean hold clears while another dispute is open | **Resolved** — keyed by dispute id (`open_dispute_ids`), held while non-empty. Also: **the subscription loss writer did not exist** — today's handler only marks a *lifetime* entitlement `refunded`, so revision 22's "the subscription's own resulting status" described code that is not there. Named a writer — but aimed at the wrong field, **superseded at 127**: `lifecycle_status` is a provider mirror a refresh overwrites, so the loss now sets source-local `dispute_loss_revoked_at`. |
| 123 | 21 | Identity-only re-retrieval does not reach charges and disputes | **Resolved** — refunds and disputes are states of objects **not present** on a re-retrieved `Subscription` or `PaymentIntent`, and finding 65's completeness rule could not map an *unseen* dispute to a source, since the missing page is what supplies the mapping. Auxiliary identities are re-fetched under the source's lease, and every relevant collection must be complete before a source is staged as unheld. |
| 124 | 21 | The subscription verifier's ownership input was undefined | **Resolved** — its acceptance said "the **requested** user", but reconciliation has no requester, so the enumerator would have supplied the association it was iterating. Ownership is resolved through the unique local `users.stripe_customer_id` mapping; an expected user may be passed and mismatches rejected; **no path accepts a caller-asserted association**. The boundary is now identical on all three paths. |
| 125 | 21 | My "under 0.3%" grace bound was unfounded | **Resolved by withdrawing it** — the pinned type's ≥1-hour note is a *lower* bound on `created`→attempt, **not an upper bound on `finalized_at`→attempt**, so it cannot bound the error at all. An unresolvable attempt now derives **no deadline**: the source keeps qualifying and the case is reported, because a guessed start can only be early and early means revoking a paying customer. **I quantified a reassurance I had not derived**, which is worse than leaving it unquantified. |
| 126 | 22 | Only two of four terminal dispute shapes were modelled | **Resolved** — the pinned `Dispute.Status` union (`Disputes.d.ts:508-516`) has **eight** values, four terminal: `won`, `lost`, `warning_closed`, `prevented`. Revision 23's "resolving removes the id" covered two and was unsafe in **both** directions — restoring access on `lost`, holding forever on `warning_closed`. The existing handler already branches on this (`webhookHandlers.ts:601-609`), so the plan was silent on a path the code takes today. Full status/outcome table, with `warning_*` holding access as a deliberate carry-forward of current behaviour flagged for David. |
| 127 | 22 | The dispute-loss writer aimed at a field refreshes overwrite | **Resolved** — 122 fixed "no terminal writer exists" by naming `lifecycle_status = 'canceled'`, which is a **provider mirror**, and this plan's own entry-119 rule re-evaluates subscription sources on **every authoritative refresh**. A chargeback does not cancel the Stripe subscription, so the next refresh restores `active` and re-qualifies. Loss is now source-local `dispute_loss_revoked_at`, set once, never cleared — plus a **general invariant**: refreshes write provider mirrors only, every column declares a category, and a new field must too. Two rounds to get one writer right, because I fixed the *absence* without checking the *destination*. |
| 128 | 22 | A terminal dispute could be re-opened by a late event | **Resolved** — `closed` processed before a delayed `created` for the **same** dispute: the close removes the id, the late create adds it back, permanent hold on a settled dispute. The lease and version guard only serialize arrival order, which is exactly the wrong order, and neither says anything about the *dispute's* state. Revision 23's acceptance covered ordering between **two** disputes, never two events for **one**. Fixed with both mechanisms: authoritative status re-fetched under the lease, **and** `is_terminal` absorbing under a CHECK — either alone leaves a gap. |
| 129 | 22 | The withdrawn `finalized_at` fallback still governed the body | **Resolved** — entry 125 withdrew it and I corrected only the **ledger row**, leaving the plan body still specifying the fallback *and* the disproven "under 0.3%" bound. An implementer reads the body. Removed from the body, its acceptance case inverted to assert **no revocation occurs**, and the ledger/body pair checked for agreement rather than assumed. **The correction was less complete than the record of it**, which is the failure mode a ledger is supposed to prevent. |
| 130 | 23 | A `CHECK` cannot enforce an absorbing transition — **128 was Still Open** | **Resolved** — a `CHECK` validates only the *proposed* row, so `('won', true)` → `('needs_response', false)` is a perfectly consistent new row and passes. **Verified by execution on PostgreSQL 16.13: that update succeeds.** Revision 24's "a CHECK forbids any transition out of a terminal status" was not implementable. Now a conditional upsert (`DO UPDATE … WHERE NOT existing.is_terminal`) with a `BEFORE UPDATE` trigger as backstop; the CHECK is demoted to the status↔flag consistency it can actually enforce. **The first Still Open in 23 rounds**, and it was mine — I asserted a database behaviour without running it, in a plan whose whole method is checking claims against the pinned artifact. |
| 131 | 23 | The field-ownership taxonomy was column-global and therefore false | **Resolved** — ownership is per **(column, source type, writer)**: `is_membership_product` is re-evaluated for a subscription and **frozen** for a lifetime purchase (which entry 119 says *in this same document*); `lifecycle_status` is provider-derived for subscriptions and locally authored for admin grants; `source_state_as_of` mirrors nothing. A refresh helper built from the global list reclassifies a completed purchase after a metadata edit. Replaced with a two-axis matrix (origin × refresh discipline) across all three source types, with its own acceptance. **127's fix was correct about the instance and too coarse to be true as a rule.** |
| 132 | 23 | "Source-local, never touched" forbids the grace writers the plan requires | **Resolved** — reconciliation must **open** a window on discovering a missed `invoice.payment_failed`, and a refresh to recovered `active` must **clear** it; revision 24's boundary forbade both, so a missed failure would never get its 14-day deadline and stale timestamps would survive recovery. Grace is **locally-derived policy, maintained** — the subscription refresh owns it in the same fenced apply while preserving every field it does not own. The missing category, not a missing exception. |
| 133 | 23 | `charge.dispute.updated` was never assigned to the transition writer | **Resolved** — it does only deadline-alert work (`webhookHandlers.ts:991-1023`) while its own comment says Stripe sends it for "evidence updates, **status transitions**, etc." So the event most likely to carry a non-terminal change had no writer, and `needs_response → under_review` would sit stale until a reconciliation sweep. All three dispute events now route through one transition function; the `.updated` alert is preserved alongside, not replaced. |
| 134 | 23 | `access_hold_reason` was a second, unsynchronized answer to "is this held" | **Resolved by deletion** — the hold is the existence query; the column was kept "as the reason discriminator" with **no writer specified to synchronize it**, permitting an open dispute with a null reason and an all-terminal source still reading `dispute`. The reason is derived from `entitlement_source_disputes` when displayed. **Recurring pattern, fourth instance: a control named in one place and wired up in none** — and this time I introduced it in the very revision that fixed the previous instance. |

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
| 12 | The mechanisms round 11 introduced — per-source leases, the prepare/apply split, the reconciliation lease and the SQL tier predicate — plus the interactions *between* them: leases and transactions, staging and webhooks, predicate and helper. Round 11 found two long-standing sections that contradicted each other; look for more of those rather than for defects inside any one section — **4 findings, and two of round 11's resolutions were graded Still Open rather than accepted. Both leases lacked a fence; the boundary was drawn at signatures instead of the call graph** |
| 13 | The **fences themselves**, and the boundary they are supposed to make airtight: the per-source fence, the reconciliation fence, the "no un-transacted side effect in apply" rule and the effective-tier expression. Each was written this round in response to a defect in its own predecessor, so the question is whether the *replacement* holds — lock ordering and deadlock between the two lease scopes and the user row; whether the post-commit action list can lose an action a crash should not lose; whether the `CASE` expression and the row helper can still disagree at the horizon instant; and whether anything now depends on a lease TTL it should not — **3 findings, and it answered all three questions in the affirmative: a third unfenced lease, the post-commit list losing required work, and one expression evaluated at two instants** |
| 14 | **Durability and recovery of the outbox now that everything is transactional.** Round 13 moved every required side effect into `async_jobs` rows written on the claim's transaction and deleted the only escape hatch, so the outbox is now load-bearing for refund, dispute and fraud alerts. Attack that: whether the async-job worker's retry/failure semantics match what a *payment* alert requires, whether a job enqueued on the claim transaction can be orphaned or duplicated, what happens when a job permanently fails, and whether the audit trail (still deliberately outside the transaction) can now disagree with the outbox about what happened. Also: the reconciliation commit now holds many lease locks plus many user locks in one transaction — press on its duration and on what a lock timeout mid-commit does — **6 findings, five of them P1: the largest round since 8. The outbox was adopted for its crash behaviour without anyone reading the worker that drains it, and the lock question was the right one — a *held* lease blocks rather than failing a fence, so the per-source drop was unreachable and the livelock came straight back** |
| 15 | **Everything round 14 touched is specified against code I read for the first time this round** — the async-job worker, the email helpers' swallow behaviour, `SKIP LOCKED`. So: does each new specification actually match what that code does, or have I described a mechanism that does not behave as assumed, a second time? Specifically — moving the Resend-unconfigured early return out of `sendEmail` changes behaviour for **every other caller in the app**, not just the payment paths; `side_effect_key` uniqueness has to sit inside the existing `enqueueJob` shape and survive redelivery; `SKIP LOCKED` on a *user* row can skip for reasons other than lease contention; and the critical-alert admin indicator is a new read path over `async_jobs` nobody has checked against its indexes. **Blast radius outside the payment paths is the lens** — this remains the right question under the scope boundary below, because containing the blast radius of *my own* changes is explicitly in scope even though deepening the queue is not |
| 16 | The scope boundary's **first live test**, plus the ledger audit — **5 findings, all five inside the boundary and none needing the boundary invoked. Three were defects in revision 15's own new specifications; one was the ledger instructing 14 withdrawn mechanisms** |
| 17 | **The manifest's second pass.** Round 16 hit it from six angles at once and every one landed; the fixes are correspondingly interlocking — derivation moved under the lock, a stored payload, a claim-time mode check, `obligations_derived_at`, `delivered_at` gating recovery. So: do those five agree with *each other*? Specifically — apply now does fence check, user lock, source write, tier write, claim insert, obligation derivation, manifest insert and enqueue, in one transaction whose duration matters; the worker now writes to a table this plan owns; and `obligations_derived_at` plus `delivered_at` plus `job_id` are three nullable state markers that can disagree. **Look for the pair that contradicts, not the single mechanism that fails** |
| 18 | **The obligation state machine.** Rounds 16 and 17 have grown the manifest to five state markers — `job_id`, `delivered_at`, `abandoned_at`, `acknowledged_at`, plus `obligations_derived_at` on the claim — and three writers: apply, the worker's finalizer, and recovery. Treat it as a state machine and look for the transition nobody owns: which marker combinations are reachable, which writer sets each, what happens when two fire concurrently, and whether `stranded` (99) is a sixth state or a view over `pending`. **The manifest was one column wide two rounds ago; it is now the most stateful object in the plan** |
| 19 | **The plan after the notification cut** — the same question round 10 asked after the migration machinery was deleted, and it found six defects then. Did anything load-bearing go with it? Specifically: does the transaction boundary still mean anything now that the only side effects inside it are domain writes; is the surviving audit-half recovery coherent on its own; and is there a section still written as though the manifest exists. Round 10's lesson was that a large cut leaves *dangling references*, not holes |
| 20 | **The narrowest lens yet, because the surface is now small.** Round 19 dropped to two findings — the first decline since round 13 — and both were dangling references from the cut rather than defects in the model. So: attack the **entitlement model itself**, which has had no finding against it since round 11 and has therefore been reviewed least recently. The derivation and its set-union semantics, W1a/W1b and the identifier-only verifier, the per-source leases and fences, read-path expiry and the effective-tier expression, the schema and its constraints, the migration, reconciliation's stage-guard-commit. **Nine rounds is long enough that "stable" may mean "unexamined"** |
| 21 | **The core again, immediately — round 20 changed what this loop believes about itself.** Seven findings, four P1, on the part I had called stable since round 11, including an allowlist bypass and a migration that could not boot. The correct response to that is not to move on but to **stay on the core for a second pass**, now that revision 22 has added an `access_hold` state, a three-term qualification conjunction, a second verifier, per-source-type snapshot semantics, a re-retrieval rule in enumeration and a seed-DDL retirement. Every one of those is new and unreviewed, and this plan's most reliable pattern is that a round's fixes are the next round's defects |
| 22 | **Disputes, third pass.** Rounds 20 and 21 both landed hardest on dispute handling — a state that did not exist, then a state that was not persisted, not keyed, and could not find its own source. Revision 23 adds `open_dispute_ids`, a charge→invoice→subscription mapping, a named subscription loss writer, auxiliary-collection re-fetch under lease, and locally-resolved ownership. **Every one of those is new.** Attack the dispute path end to end as a single story — open, concurrent, won, lost, unresolvable, arriving out of order, racing a cancellation — and check whether the mapping and the completeness rule can disagree about the same source |
| 23 | **The dispute record as a state machine, and what round 22 moved.** Round 22 replaced two columns with a table, added an absorbing terminal state, a source-local permanent revocation, a fourth conjunction term and a provider-mirror/source-local field taxonomy. **All of it is new.** Two angles not yet applied: (a) treat `entitlement_source_disputes` as a state machine — which of the eight statuses can follow which, which transitions have no writer, what a re-fetch returning a *non-terminal* status after a terminal one must do, and whether the CHECK and the re-fetch can deadlock or disagree; (b) the field taxonomy is a **new global invariant** asserted over a schema written before it existed — check every column's declared category against every writer in the plan, not just the dispute ones. Round 20's lesson applies: the taxonomy looks obviously correct, which is the condition under which it has never been tested |
| 24 | **The writers, not the state.** Rounds 20–23 kept finding that a state existed but nothing wrote it, or the wrong thing wrote it — 120 (no column), 122 (no writer), 127 (wrong destination), 133 (unassigned handler), 134 (no synchronizer). That is one failure repeating in five costumes, and it is a **writer-enumeration** failure, not a modelling one. So: take the revision-25 schema and, for **every column × source type cell** in the new matrix, name every code path in this plan and in the existing codebase that writes it, and identify the cells with **zero** writers or **more than one**. Then the reverse sweep: take every handler in `processDomainSwitch` and every route in `routes/stripe.ts` and `admin.ts` and check each writes only cells its category owns. The matrix (131) and the transition writer (133) are both brand-new and both assert completeness over a codebase neither has been checked against exhaustively |
| — | **Scope boundary applied (David, 2026-07-29).** From round 15 on, findings about the async-job queue's *capability* — retry policy, escalation, retention, delivery guarantees beyond entry 84 — are **recorded as separate work rather than fixed here**. Findings about the entitlement model, about the claim-transaction boundary, and about regressions this plan's changes introduce in non-payment callers remain fully in scope. See *Scope boundary: the notification subsystem stops here* |
