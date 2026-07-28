# Plan — Derive membership from entitlements, don't assign it per-event

> **Scope note for reviewers.** This document is a *redacted* slice of a larger
> remediation plan. Parts of that plan are withheld from this public channel
> under the repository's disclosure rule and are reviewed privately. What is
> here is complete and self-contained as a specification of the **entitlement
> model, its schema change, its transaction boundary, and its reconciliation
> path** — that is what this review is for. Where a withheld item constrains
> the design, the constraint is stated abstractly (see *Constraint W1*).

## Context

`users.membership_tier` is a **derived** value — a user is Legendary if they
hold at least one qualifying entitlement — but it is currently **maintained by
hand**, assigned directly by whichever Stripe webhook handler happens to fire.
Each assignment carries its own ad-hoc guards, and they disagree:

- `handleChargeRefunded` (`webhookHandlers.ts:352-380`) checks two other
  sources before downgrading — `userHasLifetimeEntitlement` and
  `userHasActiveSubscription`.
- `handleSubscriptionCancelled` (`webhookHandlers.ts:219-226`) checks one —
  lifetime only.
- The grant paths (`membershipGrant.ts:205`, `:250`) check none; they assign
  `legendary` unconditionally.
- `routes/stripe.ts:396-403` asks the same "does this user hold a lifetime
  entitlement?" question a fourth way, and gets a **different answer** —
  it omits the `status = 'active'` filter that `webhookHandlers.ts:84-94`
  applies, so a *refunded* entitlement still counts. This is published finding
  3 in `docs/ai-context/stripe-payments-audit-findings.md`.

Any handler that forgets a source corrupts the tier. That is one defect, not
four, and the fix is to derive the value in one place.

This plan also folds in published findings 1 and 2 from the same audit
document, because both live in the handlers being restructured and fixing them
separately would touch the same code twice.

## Product intent

Membership access must reflect what the user is actually entitled to, at all
times, regardless of which Stripe event arrives, in what order, or whether it
arrives at all. A user who has paid keeps access; a user whose sole entitlement
ends loses it; a user with two entitlements keeps access when one ends.

## Must not change

- **The membership allowlist stays the qualification boundary.** A positive
  check on the Stripe product's `overhype_membership=true` metadata, failing
  closed on every ambiguous input (`membershipPricing.ts`). It is the
  strongest part of this integration and is documented in
  `docs/ai-context/security-model.md` (*Payment trust — membership grants*).
  This plan changes what happens with the answer, never how it is computed.
- **Admin-granted lifetime entitlements keep working.** `admin.ts:~560-577`
  writes a `lifetime_entitlements` row with a synthesized payment-intent id,
  `stripeCustomerId: "admin_grant"`, and `amount: 0`. These are durable
  entitlements and must count as qualifying sources.
- **History is append-only.** `membership_history` and
  `stripe_webhook_audit` are never deleted or rewritten.
- No change to pricing, checkout UX, or the catalog-display path.

## Settled decisions

1. **Membership is derived, never assigned.** One function owns the write to
   `users.membership_tier`; every handler calls it instead of setting the tier.
2. **Qualifying-status policy** — retain access through Stripe's retry window,
   revoke when Stripe gives up:

   | Stripe subscription status | Qualifies |
   |---|---|
   | `active`, `trialing` | yes |
   | `past_due` | **yes** — retain during dunning |
   | `unpaid`, `canceled` | no |
   | `incomplete`, `incomplete_expired` | no |
   | `paused` | no |

   `paused` here is Stripe's *subscription status* — a trial ending with no
   default payment method under
   `trial_settings.end_behavior.missing_payment_method = pause`. It is **not**
   `pause_collection`, which leaves `status` unchanged and keeps generating
   invoices ([Stripe docs](https://docs.stripe.com/billing/subscriptions/overview)).
   This repository does not use `pause_collection` anywhere.
3. **`subscriptions` gains `qualifies_for_membership`** (boolean, not null,
   default true), written on every upsert from the allowlist result.
4. **The idempotency claim and domain processing share one transaction**, so a
   failed handler does not permanently consume the claim.
5. **Reconciliation ships in this round**, dry-run by default.
6. **A partial refund does not revoke a full entitlement.**

## Constraint W1 (from the withheld portion)

The model must satisfy this, and reviewing it against this constraint is
explicitly in scope:

> **A grant of a durable entitlement must be derivable only from authoritative
> Stripe state. No caller may be able to synthesize, fabricate, or partially
> construct the payment-proof input that a grant helper validates — the
> validated type must be un-forgeable at the type level, not merely
> un-forged by current callers.**

Concretely: a helper whose signature accepts a structurally-valid but
caller-constructed proof object is considered non-compliant, even if every
present-day caller passes a genuine one. Please review the proposed interfaces
against this.

## The design

### New module — `artifacts/api-server/src/lib/membershipState.ts`

```
deriveTier(sources) -> "registered" | "legendary"          // pure, no I/O
recomputeEffectiveMembership(userId, deps) -> { tier, changed }
```

`deriveTier` is pure over `{ hasActiveLifetime, hasQualifyingSubscription }`,
so the policy table above is unit-testable with no database.

`recomputeEffectiveMembership` reads the durable sources, and writes
`users.membership_tier` **only when the derived value differs from the stored
one**. History rows and the access-revoked notification fire **only on an
actual transition** — which makes the existing duplicate-email suppression
(`webhookHandlers.ts:371-379`, currently a local `wasLegendary` flag) a
structural property instead of a per-handler precaution.

Every current tier write is replaced by a call to it:
`setMembershipTier` (`webhookHandlers.ts:80`) and
`setMembershipTierToLegendary` (`membershipGrant.ts:143-145`).

**A non-qualifying source stops meaning "do nothing."** Today
`subscriptionGrantsMembership === false` causes an early return
(`webhookHandlers.ts:185-188`, `:210-215`). Under this model it means *this
source does not qualify* — persist that fact, then recompute, because another
source may still qualify the user and the answer is no longer local.

### Schema change

`subscriptions` (`lib/db/src/schema/memberships.ts:5-16`) has no column
recording whether a subscription qualifies. The table is membership-only *by
construction* today — the activate and cancel handlers both return before
writing for non-membership plans — but that invariant is undocumented and
already breaks in one case: a plan switch to a non-membership price fires
`customer.subscription.updated`, the handler returns early, and the row
**keeps `status: "active"`**. A recomputation reading status alone would count
it.

Adding `qualifies_for_membership` makes recomputation a pure database read and
retires the invariant. Backfill `true` — correct, since every existing row is a
membership subscription under the old construction.

Migration ceremony per `docs/engineering/` and the repo's snapshot validator.

### Transaction boundary (published finding 1)

`webhookHandlers.ts:1172` claims the idempotency row with a bare auto-committed
insert; `processDomainSwitch` then runs outside any transaction. A handler
throw leaves the claim committed, so Stripe's retry is discarded as a duplicate
and the event is permanently lost.

Wrap the claim and the domain processing in one `db.transaction()`, matching
the precedent already in this codebase at `admin.ts:~560`.

**The audit writes must stay outside that transaction.** A `failed` row in
`stripe_webhook_audit` that rolls back with the claim destroys the only
evidence the failure occurred — the reviewer should check this specifically,
since it is the easy mistake in this change.

### Reconciliation — `scripts/reconcile-memberships.ts`

Compares local membership against authoritative Stripe state and recomputes.
**Dry-run by default**, `--apply` to mutate. Reports counts for examined /
unchanged / upgraded / downgraded / ambiguous / failed / skipped, per the
repo's migration row-state matrix. Never deletes history; surfaces ambiguous
records rather than guessing. Must define its Stripe pagination, rate-limit,
and partial-failure behavior.

This is the repair path for events already lost to finding 1.

## Open product questions

None. The `past_due` policy was David's call and is settled in decision 2.

## External-claim verification

Checked against current Stripe documentation on 2026-07-28:

- **Subscription statuses and dunning outcomes** —
  https://docs.stripe.com/billing/subscriptions/overview. Confirms `paused` is
  the trial-without-payment-method state, that `pause_collection` leaves status
  unchanged, and that exhausted retries leave a subscription `past_due`,
  `unpaid`, or `canceled` per Dashboard configuration. This is the sole
  authority behind decision 2's policy table, and it corrected an earlier draft
  of that table which had wrongly grouped `paused` with dunning outcomes.

Claims relevant only to the withheld portion were verified against current
Stripe documentation on the same date and are recorded there.

## Verification

- **Unit** — `deriveTier` across zero, one, and multiple sources, and every
  status in the policy table; an admin-granted lifetime; a
  lifetime-plus-subscription user.
- **Integration** — complete event sequences, asserting the user's effective
  tier *and* durable rows at the end, not helper return values in isolation:
  duplicate delivery; out-of-order delivery; the synchronous confirm path
  racing the webhook; a handler throwing mid-transaction and the retry then
  succeeding (finding 1's regression test); partial versus full refund;
  a plan switch to a non-membership price.
- **Reconciliation** — dry-run accuracy, repeated runs converge, a
  deliberately dropped webhook is detected and repaired.
- **Gates** — `pnpm run check:codegen-drift`, the migration-snapshot validator,
  `node scripts/check-docs-accuracy.mjs` run bare.

## Findings ledger

Maintained by me across rounds.

| # | Round raised | Finding | Status |
|---|---|---|---|
| — | — | *(none yet — round 1 not returned)* | — |

| Round | Lens |
|---|---|
| 1 | Correctness of the derivation model + Constraint W1 compliance |
