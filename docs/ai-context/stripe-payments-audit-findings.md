# Stripe payments integration — audit findings

> **What this is.** The findings pass commissioned after
> [`stripe-payments-audit-brief.md`](./stripe-payments-audit-brief.md). The brief
> established *what had not been looked at*; this document records *what was
> found when it was*. Written 2026-07-28 against `main` at `3a7d0c0`.
>
> **This is a findings list, not a fix plan.** Nothing here has been fixed.
> David decides which findings are worth fixing; the fix plan comes after.
>
> **A private annex exists.** Findings that describe an exploitable, unfixed
> path are not published in this public repository — they were delivered to
> David directly. This document is complete for everything else, and says so
> where an item is held back. See *Scope of this document* below.

---

## Scope of this document

This repository is public. Per `CLAUDE.md`'s disclosure rule, findings that
would function as an exploit description before a fix ships do not go in the
public channel. **Three findings are held in the private annex** — they are
counted in the totals below so this file cannot be mistaken for the whole
picture, but not described here.

| | Count |
|---|---|
| Findings published here | 8 |
| Findings in the private annex | 3 |
| Areas confirmed correct | 6 (1 originally listed here was retracted during review — see *Confirmed correct* item 2) |
| Areas still unexamined | see the last section |

---

## How this audit was run

Method: read the tests for a surface first to map what is *asserted*, then read
the source hunting for what the tests do not cover. That ordering mattered —
the brief estimated the payments code was largely untested, but there are
~3,000 lines of payments tests (`webhookHandlers.integration.test.ts` alone is
1,033). The defects below survived *because* of where the tests stop, not
because tests are absent. Finding 4 is the clearest example: a unit test proves
the guard works, and nothing tests that the caller passes it a real value.

Every finding was read at the cited line. Line references are against `3a7d0c0`.

---

## Corrections to the brief

Five things the brief got wrong or under-weighted, found while scoping. They
are recorded here rather than silently fixed, because the brief's value is that
its confidence levels are honest.

1. **Signature verification is not our code.** `app.ts:147` mounts the webhook
   with `express.raw()` before `express.json()`; `WebhookHandlers.processWebhook`
   (`webhookHandlers.ts:1122`) delegates to `sync.processWebhook(payload,
   signature)` inside `stripe-replit-sync@1.0.0`. **The trust boundary gating
   every membership grant lives in a pinned third-party package that is not in
   this repo and not covered by our tests.** The brief ranked this dependency
   #9 by risk; it belongs first.
2. **The handler↔subscription coupling is currently satisfied.** I diffed the
   library's `getSupportedEventTypes()` (88 event types) against our
   `processDomainSwitch` cases (17). **All 17 are subscribed** — no handler is
   orphaned today. This was worth checking and it came back clean. The
   *structural* risk remains, as finding 6.
3. **Test coverage is far better than the brief implies** — see *How this audit
   was run*.
4. **The receipt IDOR the brief ranked #3 is already closed.**
   `receiptHandler.ts:29` compares `invoice.customer` against
   `user.stripeCustomerId` and returns 403 on mismatch.
5. **Refunds and disputes are not a void.** `handleChargeRefunded:321`,
   `handleDisputeCreated:468`, `handleDisputeClosed:524`, plus
   `funds_withdrawn`/`funds_reinstated` all exist. The question was
   correctness, not existence — and finding 2 is the answer.

---

## Findings

Ranked by severity. Each carries the file, the concrete failure scenario, and
an effort estimate for the fix.

### 1. A transient handler failure permanently drops the webhook event — HIGH

`artifacts/api-server/src/lib/webhookHandlers.ts:1172-1195`

The idempotency claim is a bare insert, auto-committed, with no surrounding
transaction and **no rollback path anywhere in the file** —
`stripeProcessedEventsTable` is referenced exactly twice: the import and this
insert.

```
insert stripe_processed_events(event.id)   ← committed here
await processDomainSwitch(stripe, event)   ← throws
audit "failed"; rethrow                    ← app.ts:157 returns HTTP 400
```

Stripe retries on any non-2xx.

**Correction (Codex round 1, confirmed independently against the
`drizzle-orm@0.45.2` error-wrapping code — the version `pnpm-lock.yaml`
resolves at the audited `3a7d0c0`; the wrapping behavior is unchanged from the
0.45.1 locally installed in this sandbox): the duplicate-detection check at
`:1173-1175` does not actually work.** It reads `(err as {code?}).code ===
"23505"`, but `drizzle-orm/pg-core`'s `queryWithCache` wraps every driver error
as `throw new DrizzleQueryError(query, params, cause)` — the real Postgres
error, with its `code`, lands on `.cause`, not on the thrown object itself.
`stripe_processed_events.eventId` is also a bare `.primaryKey()` with no
constraint named "unique," so the message-substring fallback never matches
either. **Every retry of an already-claimed event is therefore misclassified
as a fresh DB failure** — audited `idempotency_claim_failed`, not
`ignored_duplicate` — and returns HTTP 400, same as the original failure. The
end result below (the event never succeeds) is unchanged, but the mechanism is
not "silently discarded as a duplicate"; it is "every retry independently
re-fails the same broken check, indefinitely." This also means the claim
primitive is not concurrency-safe as implemented — see the *Confirmed correct*
correction below.

**Failure scenario.** A customer buys Legendary. `checkout.session.completed`
arrives. `handleSubscriptionActivated` calls `stripe.products.retrieve()` to
check the membership tag (`webhookHandlers.ts:183`) and that call times out.
The claim row is already committed. Stripe retries three more times over the
next days; each retry independently fails the same broken duplicate check and
returns 400. **If the customer returns through the checkout success page**,
`Profile.tsx`'s `runConfirmFlow` independently re-verifies and grants
membership via `POST /stripe/checkout/confirm`, entirely outside this webhook
— so the common redirect flow recovers on its own. Outside that path (tab
closed before redirect, a non-redirect purchase flow, or the confirm call
failing for the same underlying reason as the webhook), **the customer has
paid and is never granted membership**, and the only trace is a `failed` row
in `stripe_webhook_audit` that nothing alerts on.

This is the brief's own lesson recurring: the system does not tell you.

**Fix effort:** small–medium, and it is **two independent fixes, not one.**

1. **The rollback bug.** Wrap the claim and the processing in one transaction.
   **Correction (Codex round 2): this does not also fix detection.** A
   transaction only repairs the *failed-first-delivery* case — after a
   *successful* first delivery, the claim row still commits and stays
   committed, so any later, legitimate Stripe redelivery of that same event
   still hits the unique constraint and still hits the same broken detection
   below. **Do not** delete the claim row in the catch before rethrowing,
   even as a smaller interim fix: under overlapping deliveries of the same
   event, a second delivery can observe the first's already-committed claim,
   be acknowledged as a duplicate (Stripe stops retrying it), and then the
   first delivery's catch deletes the claim after that 2xx has already gone
   out — permanently losing the event with no delivery left to retry it. A
   transaction closes this hole; deleting in the catch does not.
2. **The detection bug**, needed regardless of (1): inspect `err.cause` (or
   walk the cause chain) for the real Postgres `code`, or switch to an insert
   primitive whose result distinguishes a conflict directly (e.g.
   `onConflictDoNothing()` plus checking whether a row was actually inserted)
   instead of catching and pattern-matching an error.

### 2. A partial refund revokes the entire membership — HIGH

`artifacts/api-server/src/lib/webhookHandlers.ts:321-390`

`charge.refunded` fires for *any* refund, including partial. The handler's
destructured `charge` parameter (`:322-329`) takes `amount_refunded` but **not
`amount`** — so it structurally cannot compare the two. It unconditionally sets
the lifetime entitlement to `status: "refunded"` (`:360-364`), downgrades the
user to `registered`, and emails them that access was revoked (`:377`).

**Failure scenario.** A Legendary for Life customer paid $99 and has a billing
complaint. Support issues a $10 goodwill partial refund. The customer
immediately loses their lifetime membership and receives an access-revoked
email. Their entitlement row now reads `refunded` with $89 still paid.

**Fix effort:** small–medium. Needs `charge.amount` threaded into the handler
and a policy decision from David on what partial refund, if any, should revoke.

### 3. The same unfiltered lifetime-row query blocks or mislabels a refunded user at five call sites — MEDIUM

`artifacts/api-server/src/routes/stripe.ts:52-60, 397-403, 447-451, 503-508, 603-608`

**Correction (Codex round 3): originally scoped to the cancel endpoint only —
that undersold it.** The same query —
`db.select().from(lifetimeEntitlementsTable).where(eq(..., userId)).limit(1)`,
**no `status` filter** — is copy-pasted across five sites, three of which say
so in their own comments ("same guard as switch-plan/cancel/reactivate"):
`cancel` (`:397-403`), `reactivate` (`:447-451`, comment: *"same guard as
cancel"*), `switch-preview` (`:503-508`), `switch-plan` (`:603-608`), and
`GET /stripe/subscription` (`:52-60`, no guard — just reports `isLifetime`).
Compare `userHasLifetimeEntitlement` (`webhookHandlers.ts:84-94`), which
correctly filters `status = "active"`. Two lifetime predicates, six call
sites, one right answer.

**Failure scenario.** A user buys lifetime, is refunded (row → `refunded`,
tier → `registered`), later subscribes monthly. **All four mutating
endpoints reject them** with a variant of *"Legendary for Life members do not
have a recurring subscription to \<cancel/reactivate/switch\>."* Their only
route out is the Stripe portal or support. Independently, **`GET
/stripe/subscription`'s `isLifetime: true`** (`:72`) reaches
`SubscriptionPanel.tsx:313-357`, which sets `isLegendary = true` and
`showSubscriptionControls = isLegendary && !isLifetime && !!sub` — `false`,
since `isLifetime` is true — so the frontend hides subscription controls
entirely and labels a refunded, actively-paying-monthly user "Legendary for
Life." This is a second, independent symptom of the same root cause, not a
consequence of the four blocks above.

This is precisely the defect class PR #260 centralised the membership predicate
to prevent; none of these five call sites were migrated.

**Fix effort:** small — replace all five with the existing active-filtered
predicate (`userHasLifetimeEntitlement` or equivalent), not just the one at
`:397-403`.

### 4. The admin test-event route always reports success it did not achieve — MEDIUM

`artifacts/api-server/src/routes/admin.ts:2772-2887`

The synthetic event's product is `{ id: "prod_test", metadata: {} }`
(`:2836-2841`). The membership allowlist is a positive check on
`overhype_membership === "true"` and fails closed on missing metadata, so
`handleSubscriptionActivated` correctly **skips the grant** and logs
*"Subscription is not a membership plan."* The route then returns, unaffected:

> `success: true, message: "Test webhook processed — user ${userId} upgraded to legendary…"` (`:2881`)

**Failure scenario.** An admin uses the test-event button to verify the grant
pipeline before a launch. It reports the user was upgraded. The user was not
upgraded. The admin concludes the webhook path is healthy.

The grant gate is behaving correctly here — the defect is entirely in the
reporting. Note the shape: **an admin surface reporting success over a silent
no-op** is the same failure that made the original catalog bug invisible for
two release cycles (PR #276).

**Fix effort:** trivial — tag the synthetic product, and report the handler's
actual outcome rather than a fixed string.

### 5. 71 of 88 subscribed event types reach our domain switch with no case, and nothing distinguishes that from "not modeled on purpose" — MEDIUM

`artifacts/api-server/src/lib/webhookHandlers.ts:613-1086`

We subscribe to everything `stripe-replit-sync` supports (88 types) and handle
17. **Correction (Codex round 1): the original title's "we log none of them"
was wrong.** `stripe-replit-sync`'s own `processEvent` logs `Received webhook
${event.id}: ${event.type} for ${entityId}` for every event in its 88-type map
*before* our domain switch ever runs (confirmed reading the library's dist
source) — a generic arrival record does exist for all 88. What's actually
missing is narrower: `processDomainSwitch` **does have** a `default:` case
(`webhookHandlers.ts:1082-1083`), but it is `default: break;` — an event that
reaches it with no matching `case` falls through to an existing branch that
records nothing. The fix is to instrument that branch, not to add one; nothing
distinguishes "we looked at this and decided not to model it" from "this fell
through unnoticed."

Business-relevant types currently falling through unclassified include
`checkout.session.async_payment_succeeded` / `async_payment_failed`,
`customer.subscription.paused` / `resumed`, `invoice.marked_uncollectible`,
`refund.created` / `updated` / `failed`, and `review.opened` / `closed`.

Several of these are load-bearing. The consequences of two of them are in the
private annex.

**Fix effort:** small for the `default:` classification/warning case; the
individual handlers are separate decisions for David.

### 6. Nothing enforces that a handler's event type is actually subscribed — MEDIUM (latent)

`artifacts/api-server/src/index.ts:87-94`

The endpoint subscribes to `getSupportedEventTypes()` from the library. Add a
handler in `processDomainSwitch` for an event that list does not contain and
**it silently never fires** — the code reviews as correct and the behavior is
simply absent. The comment at `index.ts:88-93` documents the coupling and asks
future authors to remember it.

It is satisfied today (correction 2 above). A `known-failure-patterns.md` entry
plus a comment is the weakest available guard, and `CLAUDE.md`'s standing rule
is that a recurring failure shape becomes a deterministic CI check.

**Fix effort:** small. A test that asserts every `case` in `processDomainSwitch`
appears in `getSupportedEventTypes()` makes the class impossible.

### 7. The mode toggle discards `runFullSync`'s result, so an in-flight sync silently blocks the new one — MEDIUM

`artifacts/api-server/src/routes/admin.ts:2333-2343`,
`artifacts/api-server/src/lib/stripeSyncRunner.ts:341-413`

Confirms and narrows the brief's defect 7. `runFullSync(sync)` at `:2340` is
called and its return value discarded. **Correction (Codex round 1): the
original claim that this also produces an unhandled promise rejection was
wrong.** `runFullSync` is synchronous — it returns a plain `RunScopedSyncResult`
object, not a Promise — and the actual sync work runs inside a fire-and-forget
`void` async IIFE (`stripeSyncRunner.ts:351-392`) whose own
`try`/`catch`/`finally` swallows and logs every internal failure itself. It
cannot reject, so the enclosing `try/catch` in `admin.ts` was never at risk of
being bypassed, and `await`ing the call would change nothing.

The real bug is narrower: discarding the return value means an `alreadyRunning`
short-circuit is never observed, so if a sync is already holding the lock when
the mode toggle fires, **no target-mode sync is ever queued**, and nothing
reports that.

**Fix effort:** small — check the returned `alreadyRunning` flag and queue a
follow-up sync (or surface it) when it's true. No `await`/promise-handling
change needed.

### 8. Carried forward: 10 of the 11 defects from PR #274 remain unfixed

**Correction (Codex round 1): item 11 (the e2e spec's rotted `w-20` locator)
was already fixed by PR #276 and is present in this checkout** — `git
merge-base --is-ancestor 3a7d0c0 HEAD` confirms PR #276 is an ancestor, and
`billing.tsx` / `adminBillingSync.spec.ts` both anchor on `data-testid` here.
It should not have been counted as still open. The other 10 are unchanged and
unfixed. Full specification with four rounds of Codex findings resolved is at
commit `07983fa` on `plan-review/stripe-billing-catalog-legibility`. Not
re-derived here. Two of them (the hardcoded `"$3.99"` at `Pricing.tsx:328` and
the unconditional `/100` in both money formatters) are the cheapest
customer-visible wins on this list.

---

## Confirmed correct

An audit that only lists defects tells you nothing about where not to spend
effort. These were examined and are sound.

1. **Webhook transport.** Raw body registered before `express.json()`
   (`app.ts:146-148`), rejection when the `stripe-signature` header is absent,
   CSRF exemption correct for a signature-verified endpoint (`app.ts:22`), and
   a genuinely useful error message if body-parser ordering ever regresses
   (`webhookHandlers.ts:1107-1112`).
2. ~~The idempotency primitive.~~ **Retracted (Codex round 1) — not confirmed
   correct.** The unique-constraint-insert *design* is the right pattern, but
   the `23505` detection at `:1173-1175` does not actually work as
   implemented. Struck through rather than deleted so the correction stays
   visible; see Finding 1, which now covers both the missing rollback and this
   detection bug.
3. **The membership allowlist.** Positive check on the product's
   `overhype_membership=true`, fail-closed on every ambiguous input, enforced at
   all three grant surfaces, symmetric on cancellation
   (`handleSubscriptionCancelled:205-215` will not let a non-membership
   cancellation downgrade a real member). As the brief says: do not "simplify"
   this.
4. **Lifetime entitlements survive subscription cancellation**
   (`webhookHandlers.ts:219-226`), with an explicit guard and comment.
5. **The confirm endpoint verifies payment twice over** — `session.payment_status
   !== "paid"` (`membershipGrant.ts:331`) *and* the real PI status via
   `grantLegendaryViaOneTimePayment` (`:239`). This path is correct. That it is
   correct here is what makes finding 1 in the private annex worth reading.
6. **Receipt ownership check** — `receiptHandler.ts:29-49`, 403 on mismatch.
7. **The admin test-event route is properly gated** — `requireAdmin` plus an
   explicit `stripe_live_mode` check returning 403 (`admin.ts:2778-2781`), read
   via `getConfigStringRaw` so debug-mode resolution cannot weaken it. Finding 4
   is about its reporting, not its access control.

---

## Still unexamined

Stated explicitly so this file cannot be mistaken for completeness the way "we
looked at Stripe" was.

- **The dispute handlers were read only structurally**, not line by line —
  `resolveUserForDispute:414`, `handleDisputeCreated:468`, `handleDisputeClosed:524`,
  and the `funds_withdrawn`/`funds_reinstated` cases (~200 lines). The
  three-tier user resolution and the dispute-vs-refund interaction are the open
  questions.
- **`stripe-replit-sync@1.0.0` internals beyond the event map and
  `getSupportedEventTypes`.** Its signature verification was confirmed to exist
  and to be the sole verification pass, but not audited. Its `runMigrations` at
  boot (`index.ts:72`) — a third-party package running DDL against production on
  every start — was not examined at all. **This is the single largest remaining
  unknown**, and it sits on the trust boundary.
- **`switch-preview` / `switch-plan`** beyond the hardcoded monthly→annual
  constraint already known from PR #274.
- **`GET /stripe/subscription`, `/payment-history`, `/membership`,
  `/access-revocation-notice`, `/config`** — read only for auth posture, not
  for response correctness.
- **`admin/refundsDisputes.tsx` (439 lines)** — not read.
- **Proration, tax, and multi-currency** — no code path examined treats currency
  as meaningful beyond the two formatter bugs already known.
- **Frontend test coverage** — confirmed absent for `Pricing.tsx` and
  `SubscriptionPanel.tsx`, and there is still no e2e for the customer
  `/pricing` page. Not investigated further.

---

## Related reading

- [`stripe-payments-audit-brief.md`](./stripe-payments-audit-brief.md) — the
  scope and history this audit started from.
- [`security-model.md`](./security-model.md) — *Payment trust — membership
  grants (C6)*, the authoritative description of the grant gate.
- [`known-failure-patterns.md`](./known-failure-patterns.md) — the
  admin-progress-panel visibility pattern, which finding 4 is another instance
  of.
- [`decisions.md`](./decisions.md) — the PR #255/#260 history.
