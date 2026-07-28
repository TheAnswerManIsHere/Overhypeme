# Stripe payments integration — audit findings

> **What this is.** The findings pass commissioned after
> [`stripe-payments-audit-brief.md`](./stripe-payments-audit-brief.md). The brief
> established *what had not been looked at*; this document records *what was
> found when it was*. Written 2026-07-28 against `main` at `3a7d0c0`.
>
> **This is a findings list, not a fix plan.** Nothing here has been fixed.
> David decides which findings are worth fixing; the fix plan comes after.
>
> **Update 2026-07-28: the private annex has been folded in.** Three findings
> were originally withheld from this public repository. Overhype is pre-launch
> with **no real payment data**, so that protection was guarding a harm that
> does not exist, and the fixes land before launch. They are now published
> below as findings 9, 10 and 11. Nothing is held back.

---

## Scope of this document

**Complete as of 2026-07-28.** The disclosure split that originally withheld
three findings is closed — see the note above.

| | Count |
|---|---|
| Findings published here | 11 |
| Findings withheld | 0 |
| Areas confirmed correct | 7 |
| Areas still unexamined | see the last section |

---

## How this audit was run

Method: read the tests for a surface first to map what is *asserted*, then read
the source hunting for what the tests do not cover. That ordering mattered —
the brief estimated the payments code was largely untested, but there are
~3,000 lines of payments tests (`webhookHandlers.integration.test.ts` alone is
1,033). The defects below survived *because* of where the tests stop, not
because tests are absent. Finding 1 is the clearest example: a unit test proves
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
   *structural* risk remains, as finding 7.
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

Stripe retries on any non-2xx. On the retry the insert hits the unique
constraint, the handler logs `ignored_duplicate` and **returns without
processing**. So the event is gone permanently.

**Failure scenario.** A customer buys Legendary. `checkout.session.completed`
arrives. `handleSubscriptionActivated` calls `stripe.products.retrieve()` to
check the membership tag (`webhookHandlers.ts:183`) and that call times out.
The claim row is already committed. Stripe retries three more times over the
next days; each retry is discarded as a duplicate. **The customer has paid and
is never granted membership**, and the only trace is a `failed` row in
`stripe_webhook_audit` that nothing alerts on.

This is the brief's own lesson recurring: the system does not tell you.

**Fix effort:** small. Either wrap the claim and the processing in one
transaction, or delete the claim row in the catch before rethrowing. The claim
primitive itself is right — see *Confirmed correct* — the bug is only the
missing rollback.

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

### 3. `POST /stripe/subscription/cancel` is permanently blocked by a refunded lifetime entitlement — MEDIUM

`artifacts/api-server/src/routes/stripe.ts:397-403`

The lifetime-user guard queries `lifetimeEntitlementsTable` filtered on
`userId` only — **no `status` filter**. Compare `userHasLifetimeEntitlement`
(`webhookHandlers.ts:84-94`), which correctly filters `status = "active"`. Two
lifetime predicates, two different answers.

**Failure scenario.** A user buys lifetime, is refunded (row → `refunded`,
tier → `registered`), later subscribes monthly. They can never cancel: the
endpoint returns *"Legendary for Life members do not have a recurring
subscription to cancel."* Their only route out is the Stripe portal or support.

This is precisely the defect class PR #260 centralised the membership predicate
to prevent; this call site was not migrated.

**Fix effort:** trivial — reuse the existing active-filtered predicate.

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

### 5. 71 of 88 subscribed event types arrive unhandled, and we log none of them — MEDIUM

`artifacts/api-server/src/lib/webhookHandlers.ts:613-1086`

We subscribe to everything `stripe-replit-sync` supports (88 types) and handle
17. The library logs an `unhandled` warning for its own dispatch, but
`processDomainSwitch` has **no `default:` case** — an event reaching our domain
switch with no matching case falls straight through to `break` with no record
that it happened.

Business-relevant types currently arriving and being silently ignored include
`checkout.session.async_payment_succeeded` / `async_payment_failed`,
`customer.subscription.paused` / `resumed`, `invoice.marked_uncollectible`,
`refund.created` / `updated` / `failed`, and `review.opened` / `closed`.

Several are load-bearing: `async_payment_failed` is the correction that would
undo finding 9's premature grant, and `marked_uncollectible` is Stripe saying it
has written a debt off — relevant to finding 10.

**Fix effort:** small for the `default:` logging case; the individual handlers
are separate decisions for David.

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

### 7. The mode toggle's full sync is unawaited, so failures vanish — MEDIUM

`artifacts/api-server/src/routes/admin.ts:2333-2343`

Confirms and sharpens the brief's defect 7. `runFullSync(sync)` at `:2340` is
called **without `await`**. Two consequences, not one:

- Its return value is discarded, so an `alreadyRunning` short-circuit is never
  seen and no target-mode sync is queued.
- Because it is not awaited, a rejection escapes the enclosing `try/catch`
  entirely as an unhandled rejection — despite that catch's log message reading
  *"Stripe full sync error after mode toggle."* **The error handler that appears
  to cover this cannot fire.**

**Fix effort:** small, but it needs a decision about whether the HTTP response
should wait on the sync or the work should move to a queue.

### 9. The webhook grants lifetime membership without verifying payment — CRITICAL

`artifacts/api-server/src/lib/webhookHandlers.ts:300-305` and `:660-665`

Two guards exist for one-time (lifetime) purchases. The confirm endpoint applies
both. **The webhook applies neither.**

`handleOneTimePayment` builds the object it hands to the grant helper as a
literal:

```ts
{ id: paymentIntentId, status: "succeeded", amount, currency }   // ← hardcoded
```

The real PaymentIntent was retrieved six lines earlier in the switch and its
status is discarded. The switch also never checks `session.payment_status`. So
the guard at `membershipGrant.ts:239` — whose docstring advertises *"Throws with
`httpStatus: 400` when `pi.status !== 'succeeded'`"* — is **structurally dead on
this path**: it compares a literal against itself.

The confirm path does it correctly, checking `session.payment_status !== "paid"`
(`membershipGrant.ts:331`) and passing the real PaymentIntent through. The two
grant paths disagree.

**Why it survived review.** `checkoutConfirm.test.ts:626` proves the guard works
— it calls the helper directly with `{ status: "processing" }` and asserts a
400. Nothing tests that the *webhook caller* supplies a real status. The passing
unit test and the defect are entirely compatible.

**Failure scenario.** For delayed-notification payment methods, Stripe fires
`checkout.session.completed` as soon as the customer finishes the flow, with
`payment_status: "unpaid"` and the PaymentIntent still `processing`. Money has
not moved and may never move. The webhook writes a `lifetime_entitlements` row
and sets `legendary` permanently. `checkout.session.async_payment_failed` — the
correction — is unhandled (finding 5), so nothing revokes it.

**Exposure: latent.** None of the 12 methods enabled on the live account is on
Stripe's documented delayed-notification list (ACH, SEPA, Bacs, boleto, OXXO,
Konbini, Pay by Bank, bank transfers, Canadian PADs). Enabling one makes it
live — and enabling a payment method is not a change anyone would route through
security review. **Pix** and **Stablecoins/Crypto** are enabled and settle
out-of-band; neither is on the delayed list, and the documentation does not
settle their Checkout event sequence. To be resolved by capturing the sequence
in sandbox.

**Fix effort:** small in code; the design work is the trusted verification
boundary.

### 10. A delinquent subscription can retain access indefinitely — HIGH

`artifacts/api-server/src/lib/webhookHandlers.ts:669-679` and `:702-729`

`customer.subscription.updated` acts on exactly three statuses — `active`,
`trialing`, `canceled`. Everything else falls through: `past_due`, `unpaid`,
`paused`, `incomplete_expired`. Separately `invoice.payment_failed` sets the
**local** row to `past_due` but never touches `users.membership_tier`.

Stripe permits three terminal dunning outcomes, configured in the Dashboard:
cancel, mark unpaid, or **leave as `past_due`**. Under the last two, a
permanently failing card never reaches a handled status.

**Failure scenario.** A member's card starts failing. Stripe exhausts its retry
schedule. If the account is set to cancel, `customer.subscription.deleted` fires
and access is correctly revoked. If it is set to mark unpaid — or to leave the
subscription `past_due` — **the member keeps Legendary forever without paying**,
and `invoice.marked_uncollectible` (the event saying Stripe wrote the debt off)
is also unhandled.

**Fix effort:** small in code, but it needs the grace policy decided first —
"revoke when Stripe gives up" is not implementable from status alone, because
terminal `past_due` never says so.

### 11. The Customer Portal runs on the account default configuration — MEDIUM

`artifacts/api-server/src/routes/stripe.ts:357-360`

Portal sessions are created with no `configuration` parameter, so whatever the
account default permits is offered.
[Stripe documents](https://docs.stripe.com/api/customer_portal/sessions/create)
that omitting it uses the default configuration — a Dashboard setting nothing in
this repository constrains, versions, or reviews.

Every deliberate grant path enforces the `overhype_membership` allowlist. The
portal is outside all of it. If the default configuration has plan-switching
enabled, a member can move to a non-membership price; the resulting
`customer.subscription.updated` reaches `handleSubscriptionActivated`,
`subscriptionGrantsMembership` returns false, and the handler treats it as a
**no-op** (`webhookHandlers.ts:185-188`) rather than a downgrade. That no-op is
correct for its intended case and wrong here — the user keeps `legendary` while
paying for something cheaper.

Portal *cancellation* is fine: it fires `customer.subscription.deleted`, which is
handled.

**Fix effort:** small. Provision an explicit configuration per environment, pass
its id on every session create, fail closed when absent.

### 12. Carried forward: the 11 defects from PR #274

Unchanged and unfixed. Full specification with four rounds of Codex findings
resolved is at commit `07983fa` on `plan-review/stripe-billing-catalog-legibility`.
Not re-derived here. Two of them (the hardcoded `"$3.99"` at `Pricing.tsx:328`
and the unconditional `/100` in both money formatters) are the cheapest
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
2. **The idempotency primitive.** Claiming via a unique-constraint insert and
   treating `23505` as "already processed" (`:1172-1186`) is the correct
   concurrency-safe pattern — it is atomic against simultaneous deliveries of
   the same event. Finding 1 is about the missing rollback, not this design.
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
