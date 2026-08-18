# Chapter 10 · Payments & Membership

> Free vs. [Legendary](../ai-context/glossary.md#legendary): what membership unlocks, how someone gets it, and how
> the system decides — at any moment — whether they still have it.
>
> Deep spec: [`membership-entitlements.md`](../ai-context/membership-entitlements.md).
> Rationale history:
> [`decisions.md`](../ai-context/decisions.md#2026-07-30--reconciliation-is-deferred-out-of-the-entitlement-model-pr-the-gap-is-accepted).
> The audit that started this work:
> [`stripe-payments-audit-findings.md`](../ai-context/stripe-payments-audit-findings.md).

## What it does

Overhype.me has two tiers: **[Registered](../ai-context/glossary.md#registered)** (free — the default for anyone who signs up) and
**Legendary** (paid — unlocks private memes, AI identity memes, AI video
generation, higher rate limits, and a higher generation spend budget).
Legendary can be bought as a recurring subscription or a one-time "Legendary
for Life" purchase, and an admin can comp it to someone directly.

The one thing worth understanding before anything else: **once an account
exists, nobody sets its tier.** It's computed. At any moment, a user is
Legendary if — and only if — they currently hold something that entitles
them to it: a qualifying subscription (active, in trial, or in a bounded
[grace window](../ai-context/glossary.md#grace-episode) after a failed payment), a [lifetime purchase](../ai-context/glossary.md#legendary-for-life), or an admin
grant. [Cancel](../ai-context/glossary.md#cancel) the subscription, refund the purchase, or [revoke](../ai-context/glossary.md#revoke) the grant,
and the computed answer changes on its own. There is no button, script, or
admin field that sets "Legendary" directly — with one narrow, designed
exception: [reinstating](../ai-context/glossary.md#reinstate) a [deactivated](../ai-context/glossary.md#deactivate) user whose sources can't all be
re-verified writes the tier directly rather than derive it from an
incomplete set (see below). (Account creation itself is a separate,
one-time case — a new account starts Registered or [Unregistered](../ai-context/glossary.md#unregistered) by direct
choice, never Legendary; see the deep spec for the mechanics.)

## How it works

### For the visitor / user

Buying Legendary goes through ordinary Stripe Checkout — pick a plan
(monthly, annual, or Legendary-for-Life), pay, land back on the profile page
as Legendary. From there:

- **Cancel** ends the subscription at the end of the current billing period —
  access continues until then, exactly as you'd expect.
- **[Reactivate](../ai-context/glossary.md#reactivate)** undoes a pending cancellation before it takes effect.
- **[Switch to Annual](../ai-context/glossary.md#switch-to-annual)** moves a monthly subscriber to the annual plan with a
  prorated charge shown before confirming — reliably so for the common case
  of a subscription with a single item. See *Boundaries & known limitations*
  below for the multi-item edge case.
- If a payment fails, the subscription enters a **bounded grace window**
  before access is actually lost — one missed card doesn't cut anyone off
  immediately, but it isn't meant to be indefinite either. (In the rare case
  where the system can't pin down exactly when a *fresh* failure run started,
  it keeps access rather than guessing at a deadline; a run the system had
  already pinned down before hitting this same ambiguity keeps its original
  deadline instead — see *Boundaries & known limitations* below.)
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
of the state hasn't refreshed yet. No action is needed — a scheduled recheck
clears it as soon as it observes the local record has caught up, whichever
of two things gets there first: the refresh that was already running when
the notice appeared (it isn't cancelled, just abandoned by the request that
was waiting on it) finishing on its own, or a fresh webhook for the same
change arriving. The rechecks run on a finite schedule and stop once
exhausted, so if the record catches up only after the last one, the notice
can outlive the actual fix until a remount or another mutation runs a fresh
round of rechecks. If the record never catches up at all, the notice can
persist — the same
known gap described under *Boundaries & known limitations* below.

### For the admin

**Admin → Users → a user's Membership screen** is where membership is managed
by hand. There is deliberately **no tier dropdown** — an admin cannot type
"Legendary" into a field. Instead:

- **[Grant Legendary for Life](../ai-context/glossary.md#admin-grant)** creates a recorded grant: who granted it, when,
  and why. It shows up distinctly from a real purchase (no amount, no
  payment id) so nobody mistakes a comp for revenue.
- **Revoke** ends that grant. It stays visible in the history, marked
  revoked — a revoke only ends it, never deletes it. History is retained for
  the lifetime of the account; a hard account deletion (a separate, rarer
  action from deactivation) removes the account's whole history along with
  everything else, when it completes successfully — the history is deleted
  as an early step, so a hard deletion that fails partway through can leave
  the account behind with its history already gone.
- **Reinstating** a deactivated user re-checks their actual Stripe state
  before restoring their tier, rather than trusting whatever was last stored
  — so a subscription that quietly lapsed while the account was deactivated
  doesn't come back to life just because the account did.

**Admin → Refunds & Disputes** lists refund and chargeback activity, and
carries a small status strip for the background job (below). Admin → Users
shows every user's live, current tier on a fresh list load, regardless of
that job — the strip reports the *internal* projection catching up, not a
fresh load of that screen. (Saving an unrelated field on an already-loaded
row is a narrower exception — see *Boundaries & known limitations* below.)

### The machinery

Every source of membership — a subscription, a lifetime purchase, an admin
grant — is one row in a table of **[entitlement sources](../ai-context/glossary.md#entitlement-source)**. Whenever a source
changes, the system asks, right then, whether *any* of a user's sources
currently qualifies and stores the answer: no unresolved dispute, correct
lifecycle status, and — for the two Stripe-backed source types only — an
[allowlisted product](../ai-context/glossary.md#allowlisted-product); an admin grant is authorized by the admin's own action
instead, not by a purchased product. A `membership_tier` column still
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

- **A long fal pricing outage can let generation spend drift past a member's
  ceiling, even though every individual request is still checked.** Each
  generation is priced before it runs, and that price is what gets checked
  against the member's remaining budget. When the price genuinely can't be
  looked up, the check still happens — against the engine's configured cost
  estimate rather than a real price — and if even that can't be read, the
  generation is refused rather than waved through. What is *not* yet handled
  is the running total: for an image or a video generated on the spot, one priced from an estimate
  isn't added to the member's spend record at all, because that record is only
  written when a real price was available. So while an outage lasts, recorded
  spend stops growing, and a member already under their limit can keep
  generating against a total that no longer moves. Each request is capped; the
  month isn't.
- **A spend history is a good estimate, not a bill.** Nothing recorded is an
  actual charge reconciled against the provider. Most entries are worked out
  from the provider's published rate for that job's settings, which is close.
  But some steps of a video job — the optional stylise step, the subtitling
  step, and the main step when its rate couldn't be looked up — fall back to
  our own configured cost figure instead, and nothing on the record says which
  kind an entry is — there is no provenance field on it. So a member's spend
  total is approximately right, and the record itself won't tell them how
  precise any individual entry was. Approved
  and queued work adds that distinction, and closes the gap above at the same
  time.
- **The grace window's deadline can go unset, in one rare case — but only the
  first time.** If the system can't pin down exactly when a subscription's
  failed-payment run actually started — an incomplete Stripe invoice page, an
  ambiguous episode boundary — and this is a fresh episode with no deadline
  already on file, it keeps access rather than guess at a deadline and risk
  cutting off someone who's still paying, so the window is unbounded until an
  authoritative refresh resolves it. If a deadline was already set for this
  episode, an unresolvable refresh instead leaves that deadline exactly as it
  was — which demotes the user on schedule if it has already passed, same as
  any other stored deadline. Either way, the case is logged for follow-up
  rather than silently accepted.
- **Switch to Annual assumes the membership item is the subscription's first
  item.** For the ordinary case (one item) this is exact. If a subscription
  carries a non-membership add-on listed before the membership item — a shape
  the entitlement verifier explicitly supports and is tested against — the
  switch routes inspect and mutate the *first* item rather than finding the
  actual membership one, so the switch can be rejected based on the add-on's
  interval, or can replace the add-on while leaving the membership item on
  its original plan.
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
  that never arrived), grant/revoke only create and end admin grants — they
  can't force a re-check of a Stripe source. The one indirect route is
  deactivating the account and then reinstating it, which re-verifies every
  Stripe-backed source before restoring the tier; it's disruptive (the user
  is briefly deactivated) and not a substitute for automatic repair, but it
  is a real way to force the correction by hand today. This is a known,
  accepted gap — not an oversight — recorded in
  [`deferred-work.md`](../engineering/deferred-work.md#code-level-tech-debt).
- **The stored tier column itself can lag reality between [background sweeps](../ai-context/glossary.md#entitlement-sweep)
  — a failed or delayed sweep run stretches that lag further — and it can
  surface on the admin screen, though never in a way that affects access.**
  (See the deep spec for the sweep's cadence and failure handling.) Access is
  never affected: a lapsed grace window demotes a user's access immediately,
  on every request, because the deadline check happens live regardless of
  what the stored column says. Admin → Users' own list load computes the
  same live answer, so what an admin sees there is current at load time —
  but saving an unrelated field on that user (editing a display name, say)
  returns the raw stored row in its response, and the screen replaces the
  list entry with it verbatim; if the sweep hasn't yet caught up, that
  overwrites a correctly-demoted display with the stale stored tier until
  the next full refetch. The sweep's own status strip on Admin → Refunds &
  Disputes exists specifically to report the underlying internal drift, not
  this display-level side effect of it.
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

**Next:** chapter 11 — [`11-admin-console.md`](./11-admin-console.md), the admin
surfaces and what each one is for.
