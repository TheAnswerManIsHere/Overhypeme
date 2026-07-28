# Plan — Derive membership from entitlements, don't assign it per-event

> **Scope note for reviewers.** This document is a *redacted* slice of a larger
> remediation plan. Parts are withheld from this public channel under the
> repository's disclosure rule and reviewed privately. What is here is complete
> and self-contained as a specification of the **entitlement model, its
> ingestion, its schema, its concurrency model, its rollout, and its
> reconciliation path**. Where a withheld item constrains the design, the
> constraint is stated abstractly (W1a/W1b).
>
> **Revision 3.** Incorporates Codex rounds 1–2 (13 findings, all accepted) and
> a second private reviewer. Three of those findings invalidated designs this
> plan had already recorded as resolved; those reversals are stated explicitly
> rather than quietly patched.

## Context

`users.membership_tier` is a **derived** value maintained by hand, by whichever
code path happens to run, each with its own disagreeing guards.

**Scope discovery across two rounds.** Revision 1 named 2 writers. Round 1
found 7. Searching the **source tables** rather than the derived field finds
**15 mutation sites** — the correct search, because what changes entitlement is
a source mutation, not a tier write:

| Site | Note |
|---|---|
| `membershipGrant.ts:102,134` | Grant paths |
| `webhookHandlers.ts:148,362,583,722` | Subscription upsert, refund, dispute, payment-failed |
| `routes/stripe.ts:423,478,641` | Cancel / reactivate / switch-plan write local state |
| `admin.ts:561` | Admin lifetime grant |
| `admin.ts:601` | **Admin revoke-lifetime** — deletes the row (Codex round 2) |
| `admin.ts:306-307` | User purge deletes both tables |
| `dataLifecycle.ts:24,28` | Data-lifecycle updates to both tables |

Plus the 7 direct tier writers from round 1 (`webhookHandlers.ts:81`,
`membershipGrant.ts:144`, `index.ts:151`, `admin.ts:569`, `admin.ts:159-160`,
`admin.ts:188`, `admin.ts:623-654`).

**The boot reconciler is itself a defect.** `reconcileMembershipTiers()`
(`index.ts:127-160`, invoked at `:399`) upgrades any user to `legendary` where a
joined `subscriptions` row is `active` — **with no membership-allowlist check**,
upgrade-only and unconditional. It would undo a correct revocation on every
deploy while logging "Reconciled membership tier → legendary".

## Product intent

Membership access must reflect what the user is actually entitled to, at all
times, regardless of which event arrives, **in what order**, or whether it
arrives at all.

## Must not change

- The `overhype_membership=true` allowlist stays the *product qualification*
  boundary, failing closed (`membershipPricing.ts`,
  `docs/ai-context/security-model.md`).
- Admin-granted memberships keep working — but stop masquerading as payments.
- History is append-only (`membership_history`, `stripe_webhook_audit`).
- No change to pricing, checkout UX, or the catalog-display path.

## Settled decisions

1. **Membership is derived, never assigned.** One module owns the write.
2. **Bounded grace (David, 2026-07-28): 14 days from first failure.** See the
   status table below — `past_due` qualifies *only within* that window.
3. **Full entitlement-table normalisation (David, 2026-07-28)** with an explicit
   source discriminator. Chosen over a narrower `entitlement_source` column.
4. Idempotency claim and domain processing share one transaction.
5. Reconciliation is **automated**, bounded, and circuit-broken.
6. A partial refund does not revoke a full entitlement.
7. **Per-user serialization** with an unconditional version guard.

## Constraints W1a / W1b

Revision 2 stated a single W1 requiring type-level un-forgeability. **That was
wrong and is withdrawn** — TypeScript cannot express provenance (a type
assertion defeats any brand), and more importantly a validator taking
caller-supplied Stripe-shaped objects proves only that its two arguments agree
with each other, not that either came from Stripe.

> **W1a — paid entitlement provenance.** A durable *paid* entitlement may be
> created only from authoritative payment-provider state retrieved **inside**
> the trusted fulfillment boundary. The boundary accepts **identifiers only**;
> no caller may supply payment-shaped objects.

> **W1b — non-payment entitlement authorization.** A durable *non-payment*
> entitlement may be created only through an explicitly authorized source type,
> recording actor, reason, timestamp, and revocation semantics. It must never
> masquerade as a provider payment.

**Trust boundary shape.** A module-private verifier takes a Checkout Session id,
retrieves the session and PaymentIntent from Stripe itself, and establishes:
session belongs to the expected user/customer; mode is `payment`; session and
PaymentIntent identifiers correspond; `payment_status === "paid"` **and**
`pi.status === "succeeded"`; line items contain an allowlisted membership
product **with full pagination**; amount and currency taken from the
authoritative objects. A brand on the result remains, demoted to an
accidental-misuse guardrail — it is no longer the security boundary.

**Acceptance:** no exported production API accepts caller-supplied `status`,
`amount`, `currency`, or PaymentIntent-like proof and creates a paid
entitlement. A test fabricating matching Session/PI objects cannot reach
persistence without passing through the mocked retrieval boundary. A succeeded
PaymentIntent for a different customer, session, product, or amount cannot mint
an entitlement.

## The model

### Derivation

```
deriveEffectiveMembership(sources, now) -> {
  tier, qualifyingSourceIds, graceExpiresAt, reason
}
```

Pure, no I/O, time-parameterised so grace is testable. **Set union, not
priority** — Legendary if *any* valid source qualifies; no source's state can
override another's.

### Source qualification is three separate concepts

Revision 2 used one column named `qualifies_for_membership`, which conflated
*product identity* with *current entitlement validity*. Split:

- **`is_membership_product`** — is this a membership product? (allowlist result,
  snapshotted at ingestion; reconciliation may deliberately refresh it)
- **provider lifecycle status** — Stripe's status
- **grace validity** — `grace_expires_at`, for delinquency

Effective qualification derives from all three.

### Status policy

| Status | Qualifies |
|---|---|
| `active`, `trialing` | yes |
| `past_due` | **only while `now < grace_expires_at`** (14 days from first failure) |
| `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused` | no |

Grace starts on first entry to `past_due` for a delinquency episode; duplicate
events **do not** extend it; recovery to `active` clears it; a later episode
starts a new window. `paused` is the trial-without-payment-method status, not
`pause_collection` (which leaves `status` unchanged; unused here).

**Expiry needs its own trigger.** No Stripe event arrives when grace lapses, so
the scheduled reconciliation is what revokes. This is a hard dependency, not an
optimisation.

### Concurrency — retrieval outside, guard inside

Codex round 2 found revision 2's two mechanisms composed ambiguously, and it is
right: retrieval *after* `FOR UPDATE` holds a row lock across network I/O;
retrieval *before* lets two handlers read `active` and `canceled` then acquire
the lock in reverse order, so the older snapshot wins.

**Specification:**

1. Stripe retrieval happens **outside** any transaction. No lock is ever held
   across network I/O.
2. Then open a short transaction, take `SELECT … FOR UPDATE` on the user row,
   and apply.
3. **Every source write carries an unconditional monotonic guard** — persist the
   authoritative object's version/timestamp and reject any write not newer than
   the stored value. This is *not* a fallback for when retrieval is
   unavailable; it is how ordering is enforced in all cases.
4. Define **lock-timeout and retry** behaviour.
5. Notification emission only **after** a committed tier transition.

**Acceptance:** concurrent cancellation, recovery, lifetime purchase, and refund
converge to the same tier as serial processing of the final states; a stale
event delivered after a newer one cannot regress the stored source.

## Rollout — staged, because the naive order revokes everyone

Codex round 2: adding the column makes every existing row unclassified, and
deploying fail-closed derivation before classification completes **downgrades
every subscription-only member**. Ordering is a correctness property here.

1. **Expand** — add columns/tables nullable, no default. Old writers unaffected.
2. **Deploy dual-write** — new writes populate classification; derivation not
   yet enabled; old behaviour still governs.
3. **Backfill** — observable, resumable classification from authoritative Stripe
   state. Ambiguous rows surfaced, never defaulted to qualifying.
4. **Verify** — durable count of unclassified rows is acceptably zero.
5. **Enable derivation** (read path) — still no automated downgrades.
6. **Enable automated downgrades** last, behind the bounds below.

Rollback defined after each phase. Unclassified never qualifies.

## Reconciliation

**It must reconcile sources, not just recompute from them.** Codex round 2:
`reconcileMembershipTiers` reads only local `subscriptions`, and the shared
derivation also reads local sources — so converting the loop **cannot detect an
omitted cancellation webhook**, which is the entire acceptance criterion.

**Specification:** enumerate and retrieve **authoritative Stripe** subscriptions,
handling pagination, deletions, rate limits, and partial failure; update the
source row; **then** recompute. Cadence: boot plus a recurring schedule.

**Bounds on automated downgrades** — it now revokes where before it only
upgraded:

- **Pre-apply comparison** — compute and report the intended change set before
  mutating.
- **Configurable batch and rate limits.**
- **Circuit breaker** — abort on downgrade / ambiguity / error counts exceeding
  a threshold, leaving the run **visibly failed** for investigation rather than
  completing partially.
- Counts reported per the repo's row-state matrix; history never deleted.

## Webhook transaction boundary

Wrap the idempotency claim (`webhookHandlers.ts:1172`) and domain processing in
one transaction (precedent: `admin.ts:~560`), so a handler throw rolls the claim
back and Stripe's retry can succeed.

Audit writes stay **outside** that transaction so a `failed` record survives
rollback — and the **post-commit** case is specified too: if the domain
transaction commits and the `processed` audit insert then fails, the trail shows
only `received` despite a successful mutation. Recovery is a reconciliation query
for claims lacking a terminal audit row, surfaced not silently repaired.

## Phasing (David, 2026-07-28)

Two review rounds grew this past what one pull request should carry. It ships
as **four phases, each its own PR**, plus one independent fix ahead of them.

**Ahead of Phase 1 — one item from the withheld portion ships standalone.** It
is small, independent of this model, and does not need the schema. Landing it
first means it is not gated on a multi-PR programme. Details are private.

- **Phase 1 — schema.** Entitlement-table normalisation with an explicit source
  discriminator, grace fields, and the classification backfill. **No behaviour
  change**: nothing reads the new shape yet. Corresponds to rollout steps 1–4.
- **Phase 2 — derivation, read-path only.** `deriveEffectiveMembership`, the
  per-user locking, the version guard. Wired for reads; **no path writes the
  tier through it yet**. Rollout step 5.
- **Phase 3 — cutover.** All 15 source-mutation sites move onto the model,
  including the trust boundary and the bounded-grace policy. This is where
  behaviour actually changes.
- **Phase 4 — reconciliation.** The Stripe-enumerating reconciler, automated
  downgrades, and the circuit breaker. Rollout step 6.

**Each phase must be safe if the later ones never land.** That is a hard
requirement, not an aspiration — this repository has been bitten before by a
restructuring whose pieces were only correct in combination (three of five
findings in one prior review round came from exactly that). Concretely: Phase 1
must leave current behaviour untouched; Phase 2 must not revoke anything;
Phase 3 must not depend on the reconciler existing; Phase 4 must be revertable
without stranding the model.

## Open product questions

Two, both surfaced by review rather than decided by me:

1. **Generic admin PATCH of tier** (`admin.ts:159-160`) — incoherent under a
   derived model; the next recomputation overwrites it. Retire in favour of
   grant/revoke writing an entitlement row (recommended), or add an explicit
   admin-override source.
2. **Admin user creation with `legendary`** (`admin.ts:623-654`) — accepts the
   tier while creating no entitlement, so the reconciler will later undo it.
   Either remove Legendary from creation, or atomically create an admin
   entitlement. Recommended: the latter, so the capability survives.

## External-claim verification

Stripe subscription lifecycle and dunning outcomes checked 2026-07-28
(https://docs.stripe.com/billing/subscriptions/overview) — the sole authority
behind the status table, and the source of the correction that terminal
`past_due` is a permitted Dashboard outcome, which is why grace must be
code-owned rather than inferred from status.

Claims relevant only to the withheld portion are recorded there.

## Verification

- **Pure derivation** — no sources; one active; multiple with one canceled;
  lifetime plus canceled subscription; admin grant plus refunded lifetime;
  past-due within grace; past-due after grace; unpaid after past-due; recovered;
  revoked admin grant with another active source; unclassified product.
- **Compile-time / boundary** — fabricated Stripe-shaped values cannot reach
  persistence; wrong customer/session/product/amount fails closed; paginated
  line items handled.
- **Concurrency** — barrier-interleaved removal against grant, asserting
  sources, tier, history, **and notification count**; stale event after newer;
  duplicate workers; reconciliation racing webhook processing.
- **Rollout** — interrupted and repeated backfill; deploying at each phase does
  not revoke incorrectly; rollback at each phase.
- **Reconciliation** — omitted cancellation webhook detected *and the source row
  repaired*; pagination; rate-limit backoff; partial failure; circuit breaker
  trips and leaves the run failed; idempotent repeated apply.
- **Gates** — `pnpm run check:codegen-drift`, migration-snapshot validator,
  `node scripts/check-docs-accuracy.mjs` run bare.

## Findings ledger

| # | Round | Finding | Status |
|---|---|---|---|
| 1 | 1 | Payment proof authority-created | **Superseded** — the branded-type resolution was wrong; replaced by W1a's retrieval-by-identifier boundary. |
| 2 | 1 | Serialize per-user mutations | **Superseded** — resolution incomplete; see round-2 finding 8. |
| 3 | 1 | Route every tier write centrally | **Resolved** — 15 source-mutation sites now enumerated (source search, not field search). |
| 4 | 1 | Backfill from current truth | **Superseded** — three-valued column was necessary but not sufficient; see round-2 finding 10. |
| 5 | 1 | Terminal audit handling | **Resolved** — five ordering cases; recovery query. |
| 6 | 1 | Authoritative ingestion | **Superseded** — retrieval alone is not monotonic; see round-2 finding 8. |
| 7 | 1 | Automate reconciliation | **Superseded** — local-only recomputation cannot repair a missed webhook; see round-2 finding 11. |
| 8 | 2 | Retrieval vs lock composition | **Resolved** — retrieval outside; unconditional version guard inside; lock timeout/retry. |
| 9 | 2 | Bound automated downgrades | **Resolved** — pre-apply diff, batch/rate limits, circuit breaker, visibly-failed runs. |
| 10 | 2 | Stage classification before fail-closed | **Resolved** — six-phase expand/deploy/backfill/verify/enable/enable-downgrades with rollback. |
| 11 | 2 | Reconcile sources before recomputing | **Resolved** — enumerate from Stripe with pagination/rate limits, update source, then recompute. |
| 12 | 2 | Lifetime-revoke in serialization | **Resolved** — `admin.ts:601` in the inventory; covered by the contention test. |
| 13 | 2 | Legendary at admin creation | **Escalated** — concrete disposition needed; routed to David. |

| Round | Lens |
|---|---|
| 1 | Correctness of the derivation model + W1 compliance |
| 2 | Failure modes of the newly-added machinery |
| 3 | **Phase-boundary safety** — is each of the four phases genuinely safe if the later ones never land? Plus rollout reversibility and the normalisation migration's blast radius. |
