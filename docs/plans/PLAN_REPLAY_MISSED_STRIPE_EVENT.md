# Plan — an admin can replay one missed Stripe event by its id (Issue #1244)

```plan-oracle
# Oracle — replay a missed Stripe event (Issue #1244)

Agreed with David on 2026-11-24 (scope banner in session; his reply: "Approved"). Q39: 1 chose this work over waiting for the stuck event to age out.

**Direction:** the reconciliation runbook in `docs/plans/PLAN_GET_TO_LAUNCH.md`, Phase 10 (*Membership and money*); launch inventory F13 requires an "operator-run reconciliation runbook for undelivered webhooks". This is its narrowest first piece.

**Product intent:** when Stripe sent the live site an event that never got processed, an admin can see it and replay it from the admin Billing page, with exactly the effect the original webhook would have had (membership changes, emails, records — the same as live), so the payment alert clears honestly instead of by anyone faking a record.

**Now (this build):**
- A "Missed Stripe events" list on the admin Billing page: the events the payment alert is counting as unprocessed (id, type, when), each with a Replay button.
- Replay fetches the event straight from Stripe with the site's verified Stripe connection for its current mode (so it is genuine without a webhook signature), then runs it through the same processing a live webhook gets.
- Replaying is safe to repeat: an event already processed is reported as such and changes nothing.
- Admin-only, and each replay is recorded in the admin audit log.
- Then the 2026-11-22 event (`evt_1UejZRBoYd2wqzWnwrUPw27K`) is replayed on production after merge and David's publish.

**Must not change:** how live webhooks are processed (the signature check, the "process each event only once" guarantee); the account guard; the payment alert's own rules.

**Next (not now):** the rest of the runbook — payers with no local record, access wrongly kept, a scheduled job.

**Never:** marking an event processed without processing it; replaying an event from the other mode or another Stripe account.

**Ceremony:** full feature ceremony (payments is a sensitive subsystem): plan with Astra, David's approval, code review, UAT section, David's publish.
```

## Problem

The payment alert (`/api/health/alerts`, `payments` part) counts Stripe events of a
subscribed type, created in the active mode in the last seven days (from 2026-11-19),
older than fifteen minutes, that have no row in `stripe_processed_events`. One such event,
`evt_1UejZRBoYd2wqzWnwrUPw27K` (`invoice.upcoming`, test mode, 2026-11-22), was addressed
to a webhook endpoint that Issue #1220's shared-sandbox bug deleted. Stripe resends an
event only to the endpoint it was addressed to, so it will never be delivered again, and
the alert stays red until the event leaves the seven-day window (2026-11-29). There is no
way today to process a known-genuine event that never arrived, which is also the first
gap the reconciliation runbook (F13) has to close before launch.

## Prerequisite found in planning: the mirror cannot take an upcoming invoice

Stripe's `invoice.upcoming` carries a preview invoice **with no id** — measured on the
production event itself (Stripe connector, `GET /v1/events/evt_1UejZRBoYd2wqzWnwrUPw27K`
on `acct_1TGbDFBoYd2wqzWn`: `data.object` has no `id` key; `billing_reason: "upcoming"`).
The sync library mirrors it through `handleInvoiceEvent` → `upsertInvoices`
(`node_modules/stripe-replit-sync/dist/index.js:770, 911-918`), and `stripe.invoices.id`
is `GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED` and the primary key
(`.../migrations/0050_rename_id_to_match_stripe_api.sql:121-122`), so the insert gets a
null primary key. `unable to verify: the exact database error by execution — the local
database was not running; a fake-driver test in increment 1 settles it.` Because the
library mirrors inside `sync.processWebhook`, before our code gets the event, a **live**
`invoice.upcoming` delivery fails the same way: the route answers an error, Stripe retries
for three days and gives up, no renewal reminder is ever sent, and the alert counts it.
So the replay cannot recover its named event, and every future renewal reminder would
trip the alert, until this is repaired (raised by Astra in the scope exchange, ledger C1).

**Increment 1 (its own PR, before the replay):** an `invoice.upcoming` event whose
invoice has no id is not mirrored into `stripe.invoices` — a preview invoice is not a
persistent object — and goes on to the app's own processing unchanged. Every other event
keeps the library's processing exactly, including those whose object has no top-level id
but whose handler mirrors nested objects (`entitlements.active_entitlement_summary.updated`,
`node_modules/stripe-replit-sync/dist/index.js:1078`; ledger C6). The adaptation sits where
the sync instance is built, so webhook delivery and replay share it. The signature check stays in the library, untouched; the account
guard, the claim-in-one-transaction and the audit rows are untouched; no id is invented.
It applies to the webhook and, later, to replay alike. This changes how a live webhook is
processed for this one shape, which the scope listed as must-not-change, so it is Q40.

## Repo Context Inspected

- `artifacts/api-server/src/lib/webhookHandlers.ts` — `WebhookHandlers.processWebhook`
  (route `app.ts:197`) runs: library sync + signature verification
  (`sync.processWebhook`), `getUncachableStripeClient()`, parse, `received` audit row,
  `prepareDomainEvent` (retrievals, no writes), retryable-noop refusal, one transaction
  that inserts the `stripe_processed_events` claim and applies the domain writes,
  `processed` audit row, after-commit work (emails); a claim's own primary-key
  violation (`stripe_processed_events_pkey`) is the only thing read as "duplicate"
  (`ignored_duplicate` audit row). `processEventDirectly` (`admin.ts:2020`, the
  test-event route) runs prepare/apply with **no claim and no audit** by design.
- `artifacts/api-server/src/lib/operationalHealth.ts:144` — `compareStripeEvents`
  computes `missing` (the unprocessed events) but returns only counts; the verdict is
  cached 20 s (`VERDICT_CACHE_MS`) and the payments part 2 min (`PAYMENTS_CACHE_MS`).
- `artifacts/api-server/src/routes/admin.ts:1633-1902` — the admin Stripe routes, all
  behind `requireAdmin`; `recordAdminAction` from `lib/adminActions.ts`.
- `lib/api-zod/src/adminActions.ts` — `ADMIN_ACTION_VALUES`, the hand-written list an
  admin action must be on.
- `artifacts/overhype-me/src/pages/admin/billing.tsx` — the admin Billing page; it calls
  the admin Stripe routes with `fetch`, and those routes are not in `openapi.yaml`.
- `stripe-replit-sync` — `StripeSync.processEvent(event: Stripe.Event): Promise<void>`
  (`node_modules/stripe-replit-sync/dist/index.d.ts:244`), the mirror sync without
  signature verification.

**Affected-surface inventory (Settled Decision).** The class is "a path that processes
a Stripe event for its domain effect". Oracle:
`git grep -n "prepareDomainEvent(\|processEventDirectly(\|WebhookHandlers.processWebhook(" -- artifacts lib`
excluding tests, run on this revision: three hits — the webhook route (`app.ts:197`),
the test-event route (`admin.ts:2020` → `processEventDirectly`), and the two internal
calls in `webhookHandlers.ts` (lines 1050, 1168). Replay becomes the third caller; the
test-event route is untouched.

**Settled decisions the replay inherits unchanged:** 2026-08-01 (*Dispute alerts fire
on every delivery attempt, accepting duplicates*, `decisions.md`) — a replay racing a
delivery may duplicate a dispute warning exactly as two deliveries can. "Same as live"
means processing a delayed delivery now, with current-state retrieval and the existing
email rules; it does not reconstruct historical state or add guaranteed email delivery.

## Source-of-Truth Analysis

- **Whether an event is genuine**: today, the webhook signature. For a replay it is
  Stripe itself — the event is read by id from Stripe's API with the active mode's
  verified client, never taken from the request body. The admin supplies only an id.
- **Whether an event was processed**: `stripe_processed_events`, and only that. The
  replay writes its claim in the same transaction as the domain writes, exactly as the
  webhook does; there is no second "replayed" flag anywhere.
- **Which events are missing**: `compareStripeEvents`, the function the alert already
  uses. The admin list is that function's own `missing` set, not a second query, so the
  list and the alert cannot disagree about which events count.
- **What processing does**: the code the webhook runs after verification, moved into
  one shared function both callers use (below), so there is one implementation to drift.

## Proposed Design

1. **One shared "process a genuine event" path.** The webhook's post-verification
   phases (the `received` audit row through after-commit work, with the duplicate
   handling and the retryable-noop refusal) become one function taking a parsed,
   already-authenticated `Stripe.Event` and a Stripe client, returning an outcome:
   `processed` or `already_processed`; failures throw as today. The webhook calls it
   after `sync.processWebhook` and the client acquisition, with behaviour unchanged.
   Replay calls it too. The audit rows carry which path delivered the event (webhook or
   replay), so the webhook audit log shows a replay for what it is.
2. **The missing list.** `compareStripeEvents`'s ok result additionally carries the
   missing events as `{ id, type, created }` (bounded by the existing page cap). The
   public summary is unchanged — it never exposes ids.
3. **Two admin routes**, both `requireAdmin`:
   - `GET /admin/stripe/missed-events`: the active mode and the missing list, from an
     uncached comparison (an admin page must not show an event already replayed).
     An unjudgeable comparison is returned as such, with its reason.
   - `POST /admin/stripe/missed-events/:eventId/replay`: takes one mode for the whole
     replay from `getVerifiedStripeClient()` (its returned `liveMode`, with the client
     whose account the guard has just verified); retrieves the event with that client;
     refuses unless `event.livemode` equals that mode, its type is one the managed
     webhook subscribes to (`getSupportedEventTypes()`), and the sync instance it is
     about to mirror with is built for that same mode; **then, before any mirror or
     domain work, checks for a committed claim on the event and, if there is one,
     returns `already_processed` having done nothing else** (replay only; the webhook
     path is unchanged, and the transactional claim stays the concurrency guarantee;
     ledger C7); mirrors with
     `sync.processEvent(event)` under increment 1's rule, as the webhook's library step
     does; then calls the shared path with the same client. An id Stripe does not hold for this
     account/mode is a not-found refusal. Responses: `processed`,
     `already_processed`, or a refusal/failure with a plain reason. After any outcome
     the payment caches are cleared so the alert re-reads.
4. **Audit.** Every replay writes append-only `admin_actions` rows, action
   `stripe_event_replayed` (added to `ADMIN_ACTION_VALUES`), the acting admin as actor,
   neither fact nor review: an **attempt** row (`{ phase: "attempt", eventId }`) before
   any mirror or domain write — if it cannot be written the replay refuses and does
   nothing — and an **outcome** row (`{ phase: "outcome", eventId, eventType, liveMode,
   outcome }`) afterwards. A replay interrupted after its domain commit therefore still
   names who started it (ledger C8). Written directly, as `contentTakedown.ts:40-48` writes its own, because
   `recordAdminAction`'s target type requires a fact or a review
   (`adminActions.ts:20-22`).
5. **Admin UI.** A "Missed Stripe events" panel on the Billing page: the list (type,
   id, created, age), a Replay button per row behind a confirm that names the event
   type and says the replay has the same effect as the original delivery (including
   any email to the member, in live mode). While a replay runs its button shows
   progress; the result is shown on the row (processed / already processed / the
   refusal reason) and the list re-reads. An empty list says the alert counts nothing
   unprocessed; an unjudgeable comparison says why. (Async status:
   `docs/ai-context/async-ui-status.md`; the request is synchronous, so the row-level
   pending state is the status.)

## Data Model and Migration Impact

None. No table or column changes; `admin_actions.action` is `varchar(48)` and the new
value fits. `stripe_processed_events` and `stripe_webhook_audit` gain rows only by the
existing writes. The audit "path" marker goes in the existing `detail` text column, not
a new column.

## Security, Permissions, and Validation

- **Authenticity without a signature**: the event body is never accepted from the
  client. Only the id is, validated as a Stripe event id (`evt_` prefix, bounded
  length) before any Stripe call. Construct: the route has no code path that reads an
  event body from the request.
- **Other account / other mode (Never)**: the retrieval uses the active mode's client,
  whose key belongs to the account the boot guard verified; an event of another account
  is not retrievable with it (Stripe returns not found). The `livemode` comparison is a
  cheap second refusal against our own mistake, not a defence.
- **Marking without processing (Never)**: the claim is inserted only inside the shared
  path's apply transaction, with the domain writes. Replay has no other write to
  `stripe_processed_events`.
- **Once only (Must not change)**: the claim's primary key is the guarantee for replay
  and webhook alike; a webhook and a replay racing on one event resolve exactly as two
  concurrent webhook deliveries do today.
- **Admin-only**: both routes behind `requireAdmin`, server-side.
- No secret, key or customer detail beyond what the Billing page already shows is
  returned; the list carries id, type and time.

## Testing Plan

Test support this needs and the checkout lacks (ledger C9): `events.retrieve` on the
Stripe interface and `processEvent` on the sync interface (`stripeApi.ts:27`), with fake
support; signature cases use the real verifier with a test signing secret, since the fake
deliberately refuses `webhooks.constructEventAsync` (`stripeFakeDriver.test.ts:474`).
The existing webhook suite proves classification and failure reporting, not end-to-end
effects, so the parity tests below are the evidence for the extraction.


Runner: `bash scripts/run-test.sh <file>` in `artifacts/api-server` (docs/tests/TESTING.md),
with the Stripe fake driver for Stripe calls; frontend tests in `artifacts/overhype-me`.

- **Replay processes exactly like the webhook**: for a supported event retrievable from
  the fake, replay produces the same domain writes and the same claim row as the
  webhook path does for the same event (one assertion shared across the two paths, over
  at least two event types with different effects).
- **Once only**: replaying a processed event returns `already_processed` and writes
  nothing but its audit rows — including a committed subscription event whose downstream
  retrieval is set to fail (no retrieval, no mirror attempted); webhook-then-replay,
  replay-then-webhook and an overlapping webhook/replay pair each process once.
- **Notification parity**: using doubles, an applicable live-mode fixture produces the
  same after-commit notification through webhook and replay; repeat processing does not
  duplicate it; test-mode renewal reminders stay suppressed.
- **Attribution survives**: with the outcome write forced to fail after a committed
  replay, the attempt row names the admin and the event; with the attempt write forced
  to fail, nothing is processed.
- **Refusals** (negative cases): unknown id (not found), malformed id (no Stripe call),
  wrong-mode event, unsupported type, retryable prepare failure (error, no claim).
- **Never marked without processing**: a domain failure during replay leaves no claim
  row and a `failed` audit row.
- **Admin-only**: non-admin and signed-out callers are refused on both routes.
- **Id-less event (increment 1)**: an `invoice.upcoming` with no invoice id, delivered
  with a valid signature, is processed (claim, `processed` audit, `renewal_reminder`
  history for a resolved user) and writes no `stripe.invoices` row; red before the fix,
  green after. A forged signature on the same payload is still refused. An
  `entitlements.active_entitlement_summary.updated` event still reaches its mirror
  handler.
- **Missing list = the alert's count**: the list endpoint's length equals the
  comparison's `unprocessed`, and a replayed event leaves both.
- **Webhook unchanged**: the existing webhook suite passes unmodified.
- **Admin action recorded** with the new action value.
- **UI**: the panel renders the list, the confirm, the per-row pending and result
  states, and the empty and unjudgeable states.

## UAT (for the PR)

Judgement residue only: David opens the Billing page on the dev app, reads the panel,
and replays a test-mode event created for the purpose. Live: after publish, the
2026-11-22 event is listed on production, replayed, and the alert's `payments` part reads
healthy (`live` lane, through the connector).

## Implementation Steps

0. Increment 1, own PR: the mirror skips an `invoice.upcoming` whose invoice has no id;
   its tests.
1. Extract the shared processing path; webhook switched to it; webhook suite green
   unchanged.
2. `compareStripeEvents` returns the missing set; tests.
3. The two admin routes, the admin action value, cache clearing; tests.
4. The Billing page panel; frontend tests.
5. Docs: `membership-entitlements.md` (replay is the way back for an undelivered event),
   and the runbook section of the launch plan notes this piece as built.

## Risks and Mitigations

- **Refactor of the webhook path regresses live processing.** Mitigation: the existing
  suite runs unchanged against the extracted function; the extraction moves code
  without changing order (audit → prepare → refusal → claim+apply → audit →
  after-commit).
- **A late customer email.** A replayed `invoice.upcoming` in live mode sends the
  renewal reminder when replayed, which may be after the renewal. That is the agreed
  intent (the same effect as live); the confirm states it, and the event's age is on
  the row. Test-mode events send no member email.
- **Stripe retains events for 30 days**; the alert's window is seven, so every listed
  event is retrievable. Replay accepts any event id, not only listed ones, so the named
  event stays recoverable after it leaves the list on 2026-11-29, until about
  2026-12-22. Past that, the named recovery outcome comes back to David.

## Taken as next, not in this plan

The rest of the reconciliation runbook (payers with no local record, access wrongly
kept, a scheduled job) — per the agreed scope.

## Questions for David

**Q40 — May increment 1 change live webhook processing for one shape: a renewal-reminder
event (`invoice.upcoming`) whose preview invoice has no id skips the library's local
invoice copy, and is then processed as usual?**
1. Yes — renewal reminders start working, the named event becomes replayable, and the
   alert stops counting every future reminder. Signature check, account guard and
   "once only" untouched.
2. No — the replay ships, but `invoice.upcoming` events can't be replayed or delivered;
   the alert clears on 2026-11-29 only by ageing out, and turns red again at every
   member's renewal reminder.
Recommendation: 1 (Astra concurs). The scope said live processing must not change; this
is the narrowest change that lets the scope's own named outcome happen.

The one other user-facing consequence (a late reminder email in live mode) is covered by
the agreed intent's "exactly the effect the original webhook would have had".

## Definition of Done

- [ ] The Billing page lists exactly the events the payment alert counts as unprocessed.
- [ ] Replay processes a listed event with the webhook's own processing, once only.
- [ ] Wrong mode, wrong account, unsupported type and malformed ids are refused.
- [ ] Each replay has an attempt row before any processing and an outcome row after;
      the webhook audit log marks replays.
- [ ] Replaying an already-processed event reports so without attempting processing.
- [ ] The live webhook's behaviour is unchanged (its suite passes unmodified).
- [ ] A live `invoice.upcoming` delivery is processed (increment 1).
- [ ] On production, after David's publish, `evt_1UejZRBoYd2wqzWnwrUPw27K` is replayed:
      its claim row and `processed` audit row exist, a `renewal_reminder` history row
      exists if its customer resolves to a local user (no email: test mode), and the
      alert's `payments` part is healthy (the whole alert's 200 also needs its other,
      independent parts).
- [ ] An unavailable or incomplete comparison shows as such on the Billing page, never
      as an empty list.
