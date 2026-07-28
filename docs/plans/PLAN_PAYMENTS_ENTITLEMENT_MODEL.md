# Plan — Derive membership from entitlements, don't assign it per-event

> **Scope note for reviewers.** This document is a *redacted* slice of a larger
> remediation plan. Parts of that plan are withheld from this public channel
> under the repository's disclosure rule and are reviewed privately. What is
> here is complete and self-contained as a specification of the **entitlement
> model, its ingestion, its schema change, its transaction boundary, and its
> reconciliation path**. Where a withheld item constrains the design, the
> constraint is stated abstractly (see *Constraint W1*).
>
> **Revision 2** — incorporates all seven findings from Codex round 1. All
> seven were accepted; none were rebutted. Two of them found things the audit
> behind this plan had missed outright.

## Context

`users.membership_tier` is a **derived** value — a user is Legendary if they
hold at least one qualifying entitlement — but it is **maintained by hand** by
whichever code path happens to run, each with its own guards, and they
disagree.

**Round 1 established the real scope of that problem.** The first draft named
two writers. A repo-wide search finds **seven**:

| # | Writer | Disposition |
|---|---|---|
| 1 | `webhookHandlers.ts:81` (`setMembershipTier`) | Replace with recomputation |
| 2 | `membershipGrant.ts:144` (`setMembershipTierToLegendary`) | Replace with recomputation |
| 3 | `index.ts:151` (boot reconciler) | **Convert — see below, it has its own defect** |
| 4 | `admin.ts:569` (admin lifetime grant) | Writes an entitlement row already; drop the direct tier write, recompute instead |
| 5 | `admin.ts:159-160` (generic admin PATCH) | **Retire — needs David's decision, see *Open product questions*** |
| 6 | `admin.ts:188` (`resolveUserTierOnReinstatement`) | Replace with recomputation |
| 7 | `admin.ts:623-654` (admin user creation) | Initial creation only; out of scope, but must not contradict the derived value |

### The boot reconciler is itself a defect

`reconcileMembershipTiers()` (`index.ts:127-160`, invoked at `:399`) runs on
every start. It upgrades any user to `legendary` where a joined
`subscriptions` row has `status = 'active'` and the tier is not already
`legendary`.

Two problems, both live today and neither previously recorded:

1. **It has no membership-qualification check.** It keys on
   `subscriptions.status` alone, never the `overhype_membership` allowlist. Any
   `active` row qualifies — which is the *exact* fail-open this plan's new
   column exists to close.
2. **It is upgrade-only and unconditional.** It would fight the derived model
   directly: a correct revocation would be undone at the next deploy, silently,
   with a log line reading "Reconciled membership tier → legendary".

It must be converted to call the shared recomputation rather than deleted —
it is also the natural home for finding 7's automation requirement.

## Product intent

Membership access must reflect what the user is actually entitled to, at all
times, regardless of which Stripe event arrives, **in what order**, or whether
it arrives at all.

## Must not change

- **The membership allowlist stays the qualification boundary** — the positive
  `overhype_membership=true` check, failing closed on ambiguous input
  (`membershipPricing.ts`), documented in `docs/ai-context/security-model.md`.
  This plan changes what happens with its answer, never how it is computed.
- **Admin-granted lifetime entitlements keep working** (`admin.ts:~560-577`) —
  a durable qualifying source backed by no Stripe state.
- **History is append-only.** `membership_history` and `stripe_webhook_audit`
  are never deleted or rewritten.
- No change to pricing, checkout UX, or the catalog-display path.

## Settled decisions

1. **Membership is derived, never assigned.** One module owns the write.
2. **Qualifying-status policy** — retain through Stripe's retry window, revoke
   when Stripe gives up. All eight SDK statuses are enumerated:

   | Status | Qualifies |
   |---|---|
   | `active`, `trialing` | yes |
   | `past_due` | **yes** — grace during dunning |
   | `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused` | no |

   `paused` is the trial-ended-without-payment-method state, **not**
   `pause_collection` (which leaves `status` unchanged and keeps invoicing).
   This repository uses `pause_collection` nowhere.
3. `subscriptions` gains `qualifies_for_membership` — **three-valued, no
   fail-open default** (finding 4).
4. The idempotency claim and domain processing share one transaction.
5. Reconciliation is **automated**, not operator-triggered (finding 7).
6. A partial refund does not revoke a full entitlement.
7. **Per-user serialization** of all source mutations (finding 2).

## Constraint W1 (from the withheld portion)

> A grant of a durable entitlement may be derived **only** from authoritative
> Stripe state. No caller may synthesize, fabricate, or partially construct the
> proof a grant helper validates. The validated type must be **un-forgeable at
> the type level**, not merely un-forged by present callers.

**Round 1 correctly found that stating W1 is not implementing it**, and that
the constraint applies to the *subscription* proof as much as the payment one.
Both grant helpers currently accept structurally-satisfiable inputs
(`Stripe.Subscription`, `Pick<Stripe.PaymentIntent, …>`), so an object literal
compiles.

**Specification:**

- An opaque proof type whose brand symbol is **not exported** from its module,
  so no code outside can construct or widen into it.
- Its **only** constructor is a module-private factory that performs the
  authoritative Stripe retrieval itself and validates the result. Callers pass
  **identifiers**, never proof-shaped objects.
- Two proof types, one per grant path — payment and subscription.
- **Admin grants stay on a distinct, permissioned command** that writes an
  entitlement row directly. They are not Stripe-backed and must not be forced
  through a Stripe-retrieval factory.

**Acceptance:** a compile-time negative fixture (a `tsd`/`@ts-expect-error`
test) proving an object literal cannot call either grant operation, plus an
integration test proving the factory actually retrieves and validates.

## The design

### `artifacts/api-server/src/lib/membershipState.ts`

```
deriveTier(sources) -> "registered" | "legendary"          // pure, no I/O
recomputeEffectiveMembership(userId, tx) -> { tier, changed }
```

`deriveTier` is pure over `{ hasActiveLifetime, hasQualifyingSubscription }`,
so the policy table is unit-testable with no database.

`recomputeEffectiveMembership` **takes a transaction-scoped client** and is
never called outside one.

### Concurrency (finding 2)

Read-compare-conditional-write is not race-safe merely because each event owns
a transaction. Under `READ COMMITTED` two events for one user can each observe
the other's pre-state; one skips its write as apparently unchanged and the
other commits a stale result.

**Specification:** every source mutation and its recomputation run in **one
transaction**, which **first** takes a per-user lock — `SELECT … FOR UPDATE` on
the user row (equivalently a transaction-scoped advisory lock keyed on user id)
— **before** reading any source. All reads and writes use that same
transaction-scoped client.

`SERIALIZABLE` with explicit `40001` retry is an acceptable alternative but is
not the recommendation: this codebase has no existing retry harness, and the
lock ordering here is trivially simple.

**Acceptance:** a barrier-interleaved test running a sole-entitlement removal
against a concurrent new grant, asserting sources, final tier, history row
count, **and notification count** after both commit.

### Ingestion and event ordering (finding 6)

Persisting "every status" is not enough — Stripe does not guarantee delivery
order, so a delayed older `active` event can overwrite a later cancellation.

**Specification:** on an authentic subscription event, **re-retrieve the
subscription from Stripe** and persist that state, rather than trusting the
event payload. This makes ingestion naturally monotonic: whatever Stripe says
now is current. Where a retrieval is not possible, apply an explicit
monotonic guard — persist the event's `created` and reject any write whose
event is older than the row's last applied event.

Persist the allowlist result and the status on **every** subscription event,
then recompute.

**Acceptance:** all eight SDK statuses reach persistence and recomputation, and
a cancellation followed by a delayed older `active` update leaves the user
revoked.

### Schema (finding 4)

The first draft proposed `qualifies_for_membership boolean not null default
true`, backfilled `true`. Round 1 correctly found this **self-defeating**: the
paragraph justifying the column describes a stale row that is `active` on a
non-membership price, and a blanket `true` backfill preserves exactly that
false entitlement. A `true` default also makes any omitted write fail *open*.

**Specification:**

- The column is **three-valued** — `qualifies` / `does_not_qualify` /
  `unknown` — with **no default**; every write states it explicitly.
- Existing rows backfill to **`unknown`**, not `true`.
- **`unknown` does not qualify.** Fail closed.
- An **observable, resumable** classification pass resolves `unknown` rows
  against authoritative Stripe state, reporting counts per the repo's
  row-state matrix.

**Acceptance:** seed the stale plan-switch row and an interrupted-then-repeated
backfill; verify neither grants access incorrectly and that re-running is
convergent.

Migration ceremony per the repo's snapshot validator.

### Webhook transaction boundary (published finding 1 in the audit)

`webhookHandlers.ts:1172` claims the idempotency row with a bare auto-committed
insert; `processDomainSwitch` then runs outside any transaction. A handler
throw leaves the claim committed, so Stripe's retry is discarded as a duplicate
and the event is permanently lost.

Wrap the claim and domain processing in one transaction, matching the existing
precedent at `admin.ts:~560`.

**Audit-trail handling (finding 5).** Audit writes stay *outside* the domain
transaction so a `failed` record survives rollback — but that alone leaves the
post-commit case undefined: if the domain transaction commits and the
`processed` audit insert then fails, Stripe sees a failure, the retry meets the
committed claim, and the trail shows only `received`/`ignored_duplicate`
despite a successful mutation.

**Specification:** define ordering and recovery across all five cases —
`received`, duplicate, rollback, commit, and terminal-audit failure. The
recovery mechanism is a **reconciliation query for claims lacking a terminal
audit row**, surfaced rather than silently repaired.

**Acceptance:** inject a failure into the post-commit audit write; prove the
event is not reprocessed and its successful outcome remains observable.

### Reconciliation (finding 7)

A dry-run-by-default script repairs state only when an operator runs it, which
does not satisfy "regardless of whether the event arrives at all."

**Specification:** convert the existing boot reconciler (`index.ts:127`) to
call the shared recomputation — fixing its two defects in the same move — and
define:

- **Cadence** — on boot plus a recurring schedule, not boot alone (a
  long-running instance would otherwise never re-check).
- **Locking / overlap** — the per-user lock above, plus a guard so two
  instances do not reconcile concurrently.
- **Reporting** — examined / unchanged / upgraded / downgraded / ambiguous /
  failed / skipped, per the repo's row-state matrix.
- **Ambiguous records are surfaced, never guessed.** History is never deleted.

An operator-invoked `--dry-run`/`--apply` script remains available for
inspection and bulk repair, but is not the mechanism that satisfies intent.

**Acceptance:** deliberately omit a webhook after deployment; the automated
path detects and repairs both the durable sources and the effective tier with
no manual intervention.

## Open product questions

**One, raised by finding 3.** A derived tier means the **generic admin PATCH**
(`admin.ts:159-160`), which lets an admin set any tier directly, becomes
incoherent — the next recomputation overwrites it. Options: retire it in favour
of admin grant/revoke writing a durable entitlement row (the mechanism
`grantedByAdminId` already provides), or add an explicit admin-override
entitlement source. **This is a behaviour change for the admin UI and is
David's call**, not the reviewer's or mine. Flagged, not decided.

## External-claim verification

Stripe's subscription lifecycle documentation was checked directly on
2026-07-28 (https://docs.stripe.com/billing/subscriptions/overview) and is the
sole authority behind decision 2's status table. It corrected an earlier draft
that had wrongly grouped `paused` with dunning outcomes.

Claims relevant only to the withheld portion were verified against current
Stripe docs on the same date and recorded there.

## Verification

- **Unit** — `deriveTier` across zero/one/multiple sources and all eight
  statuses; the proof factory rejecting non-succeeded states.
- **Compile-time** — negative fixture proving object literals cannot reach the
  grant operations.
- **Integration** — complete event sequences asserting effective tier *and*
  durable rows: duplicate delivery; **out-of-order delivery**; confirm racing
  the webhook; **concurrent same-user mutations under barriers**; a handler
  throwing mid-transaction with the retry then succeeding; post-commit audit
  failure; partial vs. full refund; the stale plan-switch row.
- **Reconciliation** — an omitted webhook repaired with no manual step;
  repeated runs converge; interrupted backfill resumes safely.
- **Gates** — `pnpm run check:codegen-drift`, the migration-snapshot validator,
  `node scripts/check-docs-accuracy.mjs` run bare.

## Findings ledger

| # | Round | Finding | Status |
|---|---|---|---|
| 1 | 1 | Make payment proof authority-created (P1) | **Resolved** — W1 now specifies unexported brand + module-private retrieving factory, extended to the subscription proof, with a compile-time negative fixture. |
| 2 | 1 | Serialize each user's source mutations (P1) | **Resolved** — per-user `FOR UPDATE` lock taken before any source read; one transaction-scoped client throughout. |
| 3 | 1 | Route every production tier write centrally (P1) | **Resolved** — all seven writers enumerated with dispositions; the boot reconciler's own fail-open defect recorded; admin PATCH escalated to David. |
| 4 | 1 | Backfill qualification from current truth (P1) | **Resolved** — three-valued column, no default, backfill to `unknown`, `unknown` does not qualify. |
| 5 | 1 | Specify durable terminal audit handling (P2) | **Resolved** — all five ordering cases specified; recovery via a query for claims lacking terminal audit rows. |
| 6 | 1 | Ingest authoritative subscription state (P1) | **Resolved** — re-retrieve from Stripe on each authentic event; explicit monotonic guard as fallback; all eight statuses. |
| 7 | 1 | Automate reconciliation for missing events (P1) | **Resolved** — the existing boot reconciler is converted and scheduled; cadence, locking, and reporting specified. |

| Round | Lens |
|---|---|
| 1 | Correctness of the derivation model + Constraint W1 compliance |
| 2 | Failure modes of the new machinery: migration/backfill safety, lock behaviour under contention and failure, and reconciler blast radius |
