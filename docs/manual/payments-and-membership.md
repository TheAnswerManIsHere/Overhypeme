# Payments & Membership

> Free vs. Legendary: what membership unlocks, how someone gets it, and how
> the system decides — at any moment — whether they still have it.
>
> Deep spec: [`membership-entitlements.md`](../ai-context/membership-entitlements.md).
> Rationale history:
> [`decisions.md`](../ai-context/decisions.md#2026-07-30--reconciliation-is-deferred-out-of-the-entitlement-model-pr-the-gap-is-accepted).
> The audit that started this work:
> [`stripe-payments-audit-findings.md`](../ai-context/stripe-payments-audit-findings.md).

## What it does

Overhype.me has two tiers: **Registered** (free — anyone with an account) and
**Legendary** (paid — unlocks private memes, AI identity memes, AI video
generation, higher rate limits, and higher daily generation budgets).
Legendary can be bought as a recurring subscription or a one-time "Legendary
for Life" purchase, and an admin can comp it to someone directly.

The one thing worth understanding before anything else: **nobody sets a
user's tier.** It's computed. At any moment, a user is Legendary if — and only
if — they currently hold something that entitles them to it: an active
subscription, a lifetime purchase, or an admin grant. Cancel the subscription,
refund the purchase, or revoke the grant, and the computed answer changes on
its own. There is no button, script, or admin field that sets "Legendary"
directly — with one narrow, designed exception: reinstating a deactivated
user whose sources can't all be re-verified writes the tier directly rather
than derive it from an incomplete set (see below).

## How it works

### For the visitor / user

Buying Legendary goes through ordinary Stripe Checkout — pick a plan
(monthly, annual, or Legendary-for-Life), pay, land back on the profile page
as Legendary. From there:

- **Cancel** ends the subscription at the end of the current billing period —
  access continues until then, exactly as you'd expect.
- **Reactivate** undoes a pending cancellation before it takes effect.
- **Switch to Annual** moves a monthly subscriber to the annual plan with a
  prorated charge shown before confirming.
- If a payment fails, the subscription enters a **bounded grace window**
  before access is actually lost — one missed card doesn't cut anyone off
  immediately, but it isn't meant to be indefinite either. (In the rare case
  where the system can't pin down exactly when the failures started, it keeps
  access rather than guessing at a deadline — see *Boundaries & known
  limitations* below.)
- A full refund of a **lifetime purchase** removes access; a **partial**
  refund does not. (A subscription refund doesn't drive this directly — a
  subscription's access follows its own cancellation, separately from any
  refund issued against it.)
- Holding **two** sources of Legendary at once (say, a lifetime purchase and a
  subscription) means cancelling one doesn't touch the other. Access is lost
  only when the *last* qualifying source goes away.

Occasionally the subscription panel shows an amber notice saying its own
records "haven't caught up yet" after a change. That's not an error — the
change went through at Stripe — it's the panel being honest that its own copy
of the state hasn't refreshed yet. Normally it corrects itself shortly, no
action needed, as soon as Stripe's webhook for that change arrives. If that
webhook never arrives, the notice can persist — the same known gap described
under *Boundaries & known limitations* below.

### For the admin

**Admin → Users → a user's Membership screen** is where membership is managed
by hand. There is deliberately **no tier dropdown** — an admin cannot type
"Legendary" into a field. Instead:

- **Grant Legendary for Life** creates a recorded grant: who granted it, when,
  and why. It shows up distinctly from a real purchase (no amount, no
  payment id) so nobody mistakes a comp for revenue.
- **Revoke** ends that grant. It stays visible in the history, marked
  revoked — a revoke only ends it, never deletes it. History is retained for
  the lifetime of the account; a hard account deletion (a separate, rarer
  action from deactivation) removes the account's whole history along with
  everything else.
- **Reinstating** a deactivated user re-checks their actual Stripe state
  before restoring their tier, rather than trusting whatever was last stored
  — so a subscription that quietly lapsed while the account was deactivated
  doesn't come back to life just because the account did.

**Admin → Refunds & Disputes** lists refund and chargeback activity, and
carries a small status strip for the background job (below). Admin → Users
already shows every user's live, current tier regardless of that job — the
strip reports the *internal* projection catching up, not anything a person is
looking at.

### The machinery

Every source of membership — a subscription, a lifetime purchase, an admin
grant — is one row in a table of **entitlement sources**. Whenever a source
changes, the system asks, right then, whether *any* of a user's sources
currently qualifies (allowlisted product, no unresolved dispute, correct
lifecycle status) and stores the answer. A `membership_tier` column still
exists on the user, but it's that computed answer, not a hand-set value — the
one exception is a stored expiry: a request checks the stored tier against a
stored deadline, so a grace window that has quietly passed still demotes the
user immediately even before the next event recomputes anything. Essentially
nothing writes the tier column directly — no request re-asks every source
from scratch just to check who's logged in — with one narrow, designed
exception: reinstating a deactivated user writes the tier directly when it
can't fully verify their sources, described below.

Every write to a Stripe-backed entitlement source — a webhook telling us a
subscription changed, a route handling a cancel/reactivate click — goes
through a lock that prevents two things from writing the same source at
once, and (for most of these paths) a retrieval of the current truth from
Stripe first, never trusting a value someone merely claims. The one
exception is a refund: Stripe signs the webhook payload itself, so the
refund amount is applied straight from that signed event rather than
re-fetched. An admin grant is different on purpose: the admin *is* the
authority for that source, so
granting or revoking one skips that lock — though it still briefly waits
behind the user's own row lock if something else is recomputing their tier at
the same moment, and behind the one-active-grant constraint if another grant
for the same user is mid-flight.

The full mechanics — the trust boundary, the locking, the grace-window
calculation, why a lost chargeback is permanent — are
[`membership-entitlements.md`](../ai-context/membership-entitlements.md); this
chapter stays at the product level.

## Why it works this way

Before this model, `membership_tier` was a plain column that roughly fifteen
different pieces of code wrote directly — a webhook handler here, a route
there — each with its own idea of what else needed checking first. A refund
handler that forgot to check for a second, still-valid subscription would
incorrectly strip access; a grant path that forgot to check for a dispute
hold would incorrectly restore it. Every bug that turned up was the same bug
in different clothes: **the tier was assigned, not derived, so it could be
assigned wrong.**

Moving to "compute it from what's actually true right now" removes the whole
category. There's nowhere left for a handler to forget a check, because no
handler decides the tier anymore — one shared calculation does, and every
handler's only job is to keep the underlying facts (the entitlement sources)
correct.

Comping via a recorded grant rather than a synthesized fake purchase exists
for the same reason David's earlier audit flagged: a comp used to be written
as a $0 payment with a made-up payment id, which meant anyone looking at
payment records — including reconciling actual revenue later — couldn't tell
a comp from a real sale.

## Boundaries & known limitations

- **The grace window's deadline can go unset, in one rare case.** If
  the system can't pin down exactly when a subscription's failed-payment run
  actually started — an incomplete Stripe invoice page, an ambiguous episode
  boundary — it keeps access rather than guess at a deadline and risk cutting
  off someone who's still paying, so the normally-bounded window is
  unbounded until an authoritative refresh resolves it. The case is logged
  for follow-up rather than silently accepted.
- **No repair for a webhook Stripe never successfully delivers, or for an
  event type membership doesn't model.** Every event type this system
  handles is applied correctly, including duplicates and events arriving out
  of order. The managed webhook endpoint is subscribed to every event type
  the sync library supports, not just the ones membership models — so an
  event type without a handler (e.g. a `customer.updated` or a
  `product.updated`) is delivered and silently ignored today, not merely a
  theoretical gap. Card-only checkout only rules out one specific corner of
  this: the *delayed/async-payment* scenario (a checkout that can't resolve
  synchronously) never occurs, so that particular path is unreachable — it
  doesn't mean unmodeled events in general go undelivered. And if Stripe's
  delivery
  attempts for a *handled* event all fail — the endpoint down for its whole
  retry window, say — nothing currently notices and fixes it afterward. In
  the direction that would cost the business money (a cancellation or refund
  that never arrived), there's also no way to fix it from the admin screen by
  hand; grant/revoke only create and end admin grants. This is a known,
  accepted gap — not an oversight — recorded in
  [`deferred-work.md`](../engineering/deferred-work.md#code-level-tech-debt).
- **The stored tier column itself can lag reality between background sweeps
  — a failed or delayed sweep run stretches that lag further — but nowhere a
  person actually looks shows that lag.** (See the deep spec for the sweep's
  cadence and failure handling.) Access is never affected: a lapsed grace
  window demotes a user's access immediately, on every request, because the
  deadline check happens live regardless of what the stored column says.
  Admin → Users and every other tier display compute the same live answer,
  so what an admin actually sees is always current. The lag is purely
  internal — the raw stored value sits stale until the next background sweep
  catches it up — and the only place it's ever surfaced is the sweep's own
  status strip on Admin → Refunds & Disputes, which exists specifically to
  report that internal drift.
- **A test-mode purchase can keep granting access after switching Stripe to
  live mode.** Entitlement sources don't currently record which Stripe
  account created them, so nothing notices a source belongs to the wrong one.
  Reachable only by an operator flipping that setting with test data still
  around — no customer path touches it. Filed as pre-launch hardening in
  [`current-roadmap.md`](../ai-context/current-roadmap.md#pre-launch-hardening-must-do-before-go-live).
- **The customer portal (managed by Stripe) still uses Stripe's default
  configuration**, not a custom-branded one. Independent of everything above;
  deliberately left for separate work.

## Going deeper

- [`membership-entitlements.md`](../ai-context/membership-entitlements.md) —
  the full model: source types, the trust boundary, concurrency, grace-episode
  math, the reader inventory.
- [`decisions.md`](../ai-context/decisions.md) — why reconciliation was
  deferred, why dispute alerts can duplicate rather than risk going missing,
  why a config write locks the whole related set.
- [`stripe-payments-audit-findings.md`](../ai-context/stripe-payments-audit-findings.md) —
  the original audit; now history, but the record of what this model replaced.
