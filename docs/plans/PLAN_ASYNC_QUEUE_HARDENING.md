# Plan — Async job queue hardening: guaranteed delivery + working alerts

> **Status:** draft for Codex plan review. Not approved. Not started.
> Written 2026-07-29 against `main` at `7cb197f`.

---

## Problem

An earlier review flagged that alerts may not be reaching us because of
weaknesses in the async job queue. A line-by-line read of the queue confirms
that, and the shape is worse than "weak": **the alert path is not degraded, it
is inert**, and the queue underneath it can both duplicate and silently strand
work.

Eleven findings, all verified at the cited line against `7cb197f`.

### The alert path is dead

1. **The abandoned-email admin alert has never fired.** It is gated on
   `email_admin_abandoned_alerts_enabled`, defaulting to `"false"`
   (`artifacts/api-server/src/lib/email.ts:243`). That string appears exactly
   once in the entire repository — no migration seeds an `admin_config` row for
   it. And `/admin/config` exposes only `GET` (`admin.ts:2189`) and
   `PATCH /:key` (`admin.ts:2198`), whose write is
   `db.update(adminConfigTable).where(eq(key))` — **update-only, no insert**. A
   key with no row cannot be created from the admin UI at all. The feature is
   both off and unreachable.
2. **Even switched on, the alert rides the pipe that just broke.** It is sent as
   another email, through the same `async_jobs` queue, using the same Resend
   key. The single likeliest cause of mass abandonment — an invalid or revoked
   key setting the process-wide `resendAuthDisabled` latch
   (`email.ts:169-199`) — guarantees the alert cannot be delivered either. One
   channel, no fallback, and the failure mode is perfectly correlated.
3. **Alerting is fire-and-forget, not durable state.** `onAbandon` runs
   `void import("./adminNotify").then(...)` with no `.catch`
   (`email.ts:247-254`), *after* the row has already been committed `failed`. If
   the process exits or the dynamic import rejects, nothing anywhere records
   that this row was never alerted on — there is no `alerted_at` marker and no
   sweeper that could re-derive it. The unhandled rejection is a secondary
   concern; the lost alert is the real one.
4. **Six of eleven queues never alert at all.** *(Corrected, Codex round 1. My
   first pass said "nine of eleven, only `email` and `fact_pexels`" — that came
   from a `grep … | head -30` whose output I read as complete when it was
   truncated. The enumerated registry below is the verified inventory, and the
   parameterized test in the testing plan exists so this list can never again be
   maintained by hand.)*

   The eleven registered queues, with their exact constant values:

   | Queue | Lane | `onAbandon`? |
   |---|---|---|
   | `email` | bulk | yes (`email.ts:239`) |
   | `enrichment` | bulk | yes (`enrichmentJobs.ts:454`) |
   | `fact_pexels` | pexels | yes (`factPexelsJobs.ts:215`) |
   | `fact_visual_concepts` | bulk | yes (`visualConceptJobs.ts:253`) |
   | `fact_ai_meme_backfill` | ai_meme_backfill | yes (`aiMemeBackfillJobs.ts:216`) |
   | `image_prompt_generation` | render | **no** |
   | `image_generation` | render | **no** |
   | `review_render_scenarios_prepare` | bulk | **no** |
   | `projection_repair` | fast | **no** |
   | `fact_send_back` | fast | **no** |
   | `fact_enrichment_backfill` | bulk | **no** |

   Five have a hook; **six do not** and exhaust their retries in silence. The
   proposed fix is unchanged and is in fact reinforced by the correction: making
   alerting queue-agnostic in the worker means it cannot depend on an inventory
   that a human — or an agent reading a truncated grep — has to keep accurate.
5. **Terminal failures alert never, by design.** `processClaimedJob` explicitly
   skips `onAbandon` on the `retryable: false` path
   (`asyncJobs.ts:475-486`). The reasoning in that comment is sound — a
   deterministic failure is not retry exhaustion, and existing hooks are written
   for exhaustion — but the consequence is that the failures we are *most*
   certain about are the quietest.

### The queue underneath can duplicate and strand work

6. **No fencing on finalize.** `processClaimedJob` finalizes with
   `.where(eq(asyncJobsTable.id, row.id))` and nothing else
   (`asyncJobs.ts:412-465`) — no `status = 'processing'` guard, no claim token.
   Meanwhile `recoverStuckProcessing` reclaims purely on
   `updatedAt < now() - 10min` (`asyncJobs.ts:588-597`) with no heartbeat from
   the running handler. A handler that legitimately exceeds the cutoff — and the
   code's own comment concedes the planner alone can run 180s before image
   generation starts — gets **re-claimed and run a second time concurrently**,
   after which the first run's unguarded finalize overwrites the second's
   result. Boot recovery uses a 5-minute cutoff (`asyncJobs.ts:843`, default arg
   `cutoffMinutes = 5`), so a restart during any slow job does the same thing
   with half the margin.

   **What the replayed side effect actually is, per queue** *(corrected, Codex
   round 1 — my first pass claimed a duplicate paid OpenAI call on
   `fact_ai_meme_backfill`, and that specific example was wrong)*:

   - **`email` — a genuine duplicate send.** `emailJobHandler.run` calls
     `deliverFromOutbox` unconditionally with no replay guard and no provider
     idempotency key, so a concurrent second run mails a real person twice.
     This is the example the finding rests on.
   - **`fact_ai_meme_backfill` — *not* a duplicate charge, but a corrupted
     status.** `aiMemeBackfillJobs.ts:157-180` has an explicit crash-recovery
     replay guard: a marker already at `processing` short-circuits before any
     paid call. Verified by reading it. But that guard cannot distinguish "the
     prior attempt crashed" from "another run is alive right now and about to
     succeed" — so under a concurrent reclaim it writes the fact to `failed`
     while the original run is still working, and its own comment explains it
     chose `failed` deliberately to avoid stranding the fact. The paid-call
     protection holds; the *status* is what gets corrupted. Fencing fixes this
     by removing the concurrent case the guard was never able to detect.
   - **`image_generation` / `image_prompt_generation`** are the queues to audit
     next for a genuinely replayed external call — step 17a below makes that
     audit explicit rather than assumed.
7. **Recovery never increments `attempts`.** A job whose handler hard-kills the
   worker (OOM on a large image, an unrecoverable native crash) is reset to
   `pending` with its attempt count untouched, re-claimed, and kills the worker
   again — indefinitely. There is no path to `failed`, so there is no
   abandonment, so even a working alert pipeline would never mention it.
8. **No idempotency at the provider.** `sendEmail` enqueues with no `dedupeKey`
   (`email.ts:156-159`) and `deliverFromOutbox` calls `resend.emails.send` with
   no idempotency key (`email.ts:178-185`). Any retry following a "request
   succeeded, response lost" timeout re-sends the email.
9. **Enqueue is not transactional with the caller's work.** `sendEmail` inserts
   on the module-level `db`, outside whatever transaction the domain change ran
   in. A rolled-back action can still send mail; a committed action can silently
   fail to. This is the general form of the already-parked deferred-work item
   *"Async-queue enqueue-side status write isn't transactional with
   `enqueueJob`"*, whose stated revisit trigger is "next time `asyncJobs.ts`'s
   enqueue/dedupe machinery is touched."
10. **Unconfigured email defers forever, invisibly.**
    `deferEmailWhileDeliveryDisabled` (`asyncJobs.ts:172-190`) re-arms
    `nextAttemptAt` by 5 minutes without incrementing `attempts`, so rows
    accumulate `pending` indefinitely with no age alarm and no terminal state.
11. **No queue-health surface.** `/admin/email-queue` (`admin.ts:2993`) is a
    typed projection of `async_jobs` filtered to `queue = 'email'` — useful, but
    it covers one queue of eleven. Nothing shows backlog depth, oldest-pending
    age, or failure counts for the other ten, and nothing anywhere reports
    whether the five worker lanes are still ticking.

**The shape of it:** the retry machinery is genuinely decent — `FOR UPDATE SKIP
LOCKED` claiming, per-lane isolation, exponential backoff, per-queue retention.
What is missing is the layer that tells a human when that machinery gives up.
And the one component built to do that is disabled by a default that cannot be
changed from the UI, routed through the channel most likely to be broken at the
moment it is needed.

## Product Intent

David's words: *"let's plan a hardening strategy to ensure that all jobs are
delivered properly and any issues are avoided."*

Concretely, after this work:

- **Every job either completes, or someone is told it did not.** No queue fails
  silently; no failure class is exempt from notification.
- **Alerts reach David even when email is the thing that is broken** — the alarm
  does not depend on the system it is alarming about.
- **Only one run of a job can write its outcome**, the duplicate-execution
  window is narrowed to a documented and tested minimum rather than claimed
  away, and a job that kills its worker eventually dies and reports rather than
  looping forever.
- **Queue state is inspectable at a glance** for all queues, not just email.

## Must Not Change

- **The five-lane split and its isolation guarantees** (PR #216, PR #256). Each
  lane keeps its own timer, its own re-entrancy guard, its own concurrency
  bound. Nothing added here may reintroduce a shared guard or a shared claim
  query across lanes — that is the head-of-line-blocking pattern the lane split
  exists to prevent.
- **`fact_ai_meme_backfill` and `fact_pexels` stay at concurrency 1**, for the
  paid-API pacing reason documented in `background-work.md`.
- **`fact_ai_meme_backfill` is still never retried automatically.** Hardening
  must not quietly turn its abandonment into a retry.
- **The `HandlerResult` contract stays additive.** Existing handlers returning
  `{ ok: false, error }` keep exactly today's semantics with zero changes;
  `terminalFailure()` keeps its meaning.
- **`onAbandon`'s existing contract is unchanged** — it remains the
  retry-exhaustion hook, and it still does **not** fire on a terminal
  (`retryable: false`) failure. New alerting is added *beside* it, not by
  redefining it.
- **The dev fallback stays**: with no Resend key configured, nothing is
  delivered and nothing crashes.
- **No new source of truth for job state.** `async_jobs` remains the single
  durable record of queued work; the new alert table records *notifications
  about* jobs, never job state itself.
- **`async_jobs` retention semantics stay as they are** — it is operational
  state, not an audit log.
- No rollout-flag gating (per `agent-working-rules.md`).

## Settled Decisions

Decided by David in the pre-plan conversation on 2026-07-29, in response to four
numbered questions:

1. **Two alert channels, both (answer: C).** In-app is the durable record — an
   admin queue-health surface plus a banner. An out-of-band webhook is the push,
   so an alert reaches David when he is not looking at the admin panel. The
   webhook path must not depend on the database-backed email queue or on Resend.
2. **Scope is the whole queue, not email alone (answer: B).** All eleven queues
   get failure alerting; the delivery-correctness fixes apply to the shared
   worker rather than to the email handler. Accepted cost: a larger diff
   touching every async path.
3. **Never lose work; a rare duplicate paid call is acceptable (answer: B).**
   Where ambiguity is unavoidable — a lease whose owner may or may not still be
   alive — the queue re-runs rather than drops. This sets the fencing design to
   fail *open* toward re-execution, and makes provider-level idempotency the
   mechanism that keeps the duplicate cost near zero rather than the queue
   refusing to retry.
4. **Digest with a cooldown, not one alert per failure (answer: B).** A burst of
   related failures produces one grouped notification per cooldown window.
   Accepted cost, in David's framing: a distinct failure arriving inside a
   cooldown gets folded into the digest rather than announced on its own. See
   *Risks* for the two cheap mitigations this plan adds to narrow that gap
   without reopening the decision.

Decided by me, from the repository, and recorded here rather than asked:

5. **Instrument before changing the machine.** Phase 1 ships the read-only
   health surface before Phase 3 changes claim/finalize semantics. This is the
   repo's own stated practice for risky changes — *"land the counting/reporting
   path first and inspect it before executing"*
   (`migrations-and-backfills.md`, *Dry-run expectations*).
6. **The alert dispatcher is a sweeper, not a queued job — on its own timer.**
   Making alert delivery an `async_jobs` row would make the alarm depend on the
   queue it is alarming about, the same defect as finding 2 one level up. It
   reads `job_alerts` directly. **Amended after Codex round 1:** the first draft
   put it in the `bulk` runner's maintenance block, which reintroduced the same
   coupling by a different route — that block sits behind an awaited
   `asyncJobsTick`, so one hung handler would suppress all alerting. It gets an
   independent runner instead. The sweeper choice was right; its scheduling
   was not.
7. **The enqueue primitive moves to `onConflictDoNothing`** rather than keeping
   the catch-and-pattern-match dedupe path. It is required for transactional
   composition (Phase 4) and it retires `isDedupeConflict`'s error-chain walking
   — the same fragile shape the Stripe audit's finding 1 documents failing in
   production for real (`drizzle-orm` wraps driver errors, so `.code` checks
   miss).

## Repo Context Inspected

Code:

- `lib/db/src/schema/asyncJobs.ts` — the table, indexes, status lifecycle.
- `lib/db/src/index.ts:45-60` — the `pg.Pool`; **no `max` is set**, so it is the
  pg default of 10. This confirms the arithmetic in `deferred-work.md`.
- `artifacts/api-server/src/lib/asyncJobs.ts` (872 lines, read in full) — the
  handler registry, lane definitions, retry schedule, enqueue/dedupe,
  `asyncJobsTick`, `processClaimedJob`, `recoverStuckProcessing`,
  `purgeTerminalJobs`, `createLaneRunner`, `runAsyncJobsWorker`.
- `artifacts/api-server/src/lib/email.ts` — `sendEmail`, `deliverFromOutbox`,
  `emailJobHandler` (`run` / `onAbandon` / `retainDuringPurge` /
  `retentionDaysOverride`), the `resendAuthDisabled` latch, the deliberate
  no-static-import-of-adminNotify cycle note.
- `artifacts/api-server/src/lib/adminNotify.ts` — `notifyAdmins`,
  `notifyAdminsOfDispute`, `notifyAdminsOfAbandonedEmail`,
  `notifyAdminsOfFraudWarning`, and the admin-recipient query they share.
- `artifacts/api-server/src/lib/adminConfig.ts` — the 60s TTL cache,
  `getConfigInt` / `getConfigString`, debug-value resolution, `bustConfigCache`.
- `artifacts/api-server/src/routes/admin.ts:2189-2340` (config GET/PATCH) and
  `:2988-3120` (`/admin/email-queue` list, bulk delete, per-row retry).
- `artifacts/api-server/src/index.ts:422-432` — handler registration order and
  the single `runAsyncJobsWorker()` call.
- **The full queue registry**, enumerated rather than sampled (see finding 4's
  table): `factEnrichmentBackfillJob.ts`, `imagePromptJobs.ts` (two queues),
  `reviewRenderScenarios.ts`, `factPexelsJobs.ts`, `visualConceptJobs.ts`,
  `projectionRepairJob.ts`, `email.ts`, `aiMemeBackfillJobs.ts`,
  `enrichmentJobs.ts`, `factSendBackJob.ts` — 11 queues, 5 with an `onAbandon`.
  `factPexelsJobs.ts` and `aiMemeBackfillJobs.ts` are also the two enqueue sites
  named in the deferred-work item.
- `aiMemeBackfillJobs.ts:157-180` — the crash-recovery replay guard that makes
  finding 6's original paid-call example wrong.
- All 16 `sendEmail` call sites across 9 files (step 23's inventory), including
  `routes/users.ts:342-360`'s three-write non-atomic sequence.
- `node_modules/.../drizzle-orm/pg-core/query-builders/insert.js:100-110` — the
  `onConflictDoNothing` emission that resolves step 21's spike.
- `artifacts/overhype-me/src/components/admin/AdminLayout.tsx:45` — admin nav
  item shape; `src/App.tsx:35,391` — lazy route registration pattern.
- `artifacts/overhype-me/src/components/admin/useTaxonomyHealthActions.ts` — the
  reference two-altitude polling implementation.
- `lib/db/migrations/` — latest applied index is **0093**; next free is 0094.
- `node_modules/.pnpm/resend@6.9.4/.../dist/index.d.mts:157` — the installed
  SDK's `idempotencyKey?: string`.

Docs:

- `AGENTS.md`, `CLAUDE.md`.
- `docs/ai-context/async-ui-status.md` — the two-altitude contract the health
  surface must satisfy, including "skipped"/"still running" as first-class and
  the no-UI-timeout rule.
- `docs/manual/background-work.md` — the lane model and its stated boundaries.
- `docs/ai-context/known-failure-patterns.md` — head-of-line blocking;
  async-enqueue-treated-as-completion.
- `docs/ai-context/decisions.md` — the lane-split decision record.
- `docs/engineering/deferred-work.md` — the pool-`max` item and the
  transactional-enqueue item this plan closes.
- `docs/engineering/migrations-and-backfills.md` — the broken-generator caveat,
  `SNAPSHOT_EXEMPT_TAGS`, hand-authored idempotent SQL, the row-state matrix
  requirement.
- `docs/ai-context/stripe-payments-audit-findings.md` — finding 1's
  error-wrapping lesson, which decision 7 acts on.

## Current Behavior

A caller invokes `enqueueJob` (directly, or via `sendEmail`), which inserts a
`pending` row on the module-level `db` connection, outside any caller
transaction. Five lane runners poll on independent timers. Each tick opens a
short transaction, selects up to 10 due rows for its lane with `FOR UPDATE SKIP
LOCKED`, flips them to `processing`, and commits — releasing the row locks
before any handler work begins. Handlers then run concurrently up to the lane's
bound, each finalizing its own outcome in an independent transaction keyed on
row id alone.

On failure the row goes back to `pending` with `attempts + 1` and a backoff
delay from a five-entry ladder (5m / 30m / 2h / 8h), or to `failed` once
`attempts >= effectiveMax` (default 5). Reaching `failed` by exhaustion calls
the handler's `onAbandon` if it has one; reaching `failed` by a
`retryable: false` result deliberately does not. Every 60 seconds the `bulk`
runner sweeps rows stuck in `processing` for more than 10 minutes back to
`pending` without touching `attempts`, and purges terminal rows past their
retention window.

The only failure notification in the system is the email queue's `onAbandon`,
which is gated off by an unreachable config key, and which would deliver its
alert through the same queue and provider that just failed.

## Source-of-Truth Analysis

| Concept | Source of truth | Change |
|---|---|---|
| Queued work + its lifecycle | `async_jobs` rows | Unchanged. New columns are additive bookkeeping (lease, alert linkage); no new table duplicates job state. |
| Who currently owns a running job | *Nothing today* — `status='processing'` plus a wall-clock guess | **New:** `lease_token` + `lease_expires_at` on the same row. Still one source; the ownership fact moves from implicit to explicit. |
| Whether a failure has been notified | *Nothing today* — it is transient in-process intent | **New:** `job_alerts` rows. This is genuinely new state, not a duplicate: nothing records it today, which is finding 3. |
| Worker liveness | *Nothing today* | **New:** `worker_lane_heartbeats`, one row per lane. Operational telemetry, not job state. |
| Tunable operational settings | `admin_config` | Extended, per the repo's stated preference for DB-backed config over constants. |
| Retry/backoff policy | `admin_config` + `RETRY_DELAYS_MS` fallback | Unchanged. |
| Admin notification recipients | `users.isAdmin && adminNotifications && isActive` | Unchanged — the alert dispatcher reuses `adminNotify.ts`'s existing query rather than inventing a second recipient rule. |

No concept acquires a second authority. The one risk of that is the health page,
which must derive everything it shows from `async_jobs` and
`worker_lane_heartbeats` by query — it stores no counters of its own.

## Proposed Design

### Part A — Failure observability and alerting

**A1. A durable alert ledger.** New table `job_alerts`:

| Column | Purpose |
|---|---|
| `id` | pk |
| `kind` | `job_abandoned`, `job_terminal_failed`, `job_poison_pill`, `queue_backlog`, `queue_deferred_stale`, `worker_lane_stalled`, `email_delivery_disabled` |
| `dedupe_key` | grouping key, e.g. `job_abandoned:email:auth_error` |
| `severity` | `warning` \| `critical` |
| `queue` | nullable — set for job-scoped kinds |
| `sample_payload` | jsonb: representative job id, last error, recipient etc. |
| `first_seen_at` / `last_seen_at` | window bounds |
| `occurrence_count` | total occurrences, incremented on repeat |
| `dispatched_count` | occurrences included in a *successfully delivered* digest |
| `last_dispatched_at` | null until first successful dispatch; the cooldown watermark |
| `dispatched_channels` | jsonb: per-channel `{channel: last_success_at}` |
| `acknowledged_at` / `acknowledged_by` | admin ack from the health page |

A partial unique index on `(dedupe_key)` where `acknowledged_at IS NULL` makes
"record or coalesce" a single idempotent upsert.

**The pending-occurrence watermark** *(added, Codex round 1 — this was a real
defect in the first draft)*. My first version had the dispatcher select rows
`WHERE notified_at IS NULL` while coalescing bumped `occurrence_count` on that
same unacknowledged row. The two do not compose: once the first dispatch stamped
`notified_at`, every subsequent occurrence coalesced into a row the dispatcher
would never select again, so **failures continuing after the first digest would
go unreported until an admin acknowledged the original alert** — and the
cooldown/escalation logic had no "count since last digest" to evaluate against
in the first place.

The fix is to make pending-ness a *quantity*, not a boolean:

- **pending occurrences** = `occurrence_count - dispatched_count`;
- the dispatcher selects rows where that difference is `> 0` **and**
  (`last_dispatched_at IS NULL` **or** older than the cooldown), or where the
  difference exceeds the escalation threshold regardless of cooldown;
- on **successful** delivery it advances `dispatched_count` to the
  `occurrence_count` it actually read (captured before sending, so occurrences
  arriving mid-dispatch are not silently swallowed) and stamps
  `last_dispatched_at` plus the per-channel entry;
- on failure it advances nothing, so the next tick retries the same pending
  span.
- **Channels are tracked independently** so a webhook success plus an email
  failure does not mark the alert delivered — each channel advances its own
  entry, and `dispatched_count` advances only on the channels that succeeded,
  tracked per channel rather than as one global counter.

**A2. Recording happens inside the finalize transaction.** In
`processClaimedJob`, the same transaction that writes `status = 'failed'` also
upserts the alert row. Committed together or not at all — so an alert can never
be lost to a crash between the two, which is precisely how finding 3 loses them
today. This applies to **both** terminal paths and to every queue, replacing
today's dependency on a handler implementing `onAbandon`:

- retry exhaustion → `job_abandoned` (and `onAbandon` still fires afterward,
  unchanged, for domain side-effects like `fact_pexels`'s status write);
- `retryable: false` → `job_terminal_failed` (and `onAbandon` still does **not**
  fire — the hook contract is untouched, only alerting is added).

**A3. A sweeper dispatches, on its own timer, and retries until it succeeds.**
`dispatchPendingAlerts` selects alerts with pending occurrences outside their
cooldown (per A1's watermark), groups them into one digest per channel,
delivers, and advances the watermark **only on success**. A failed dispatch
advances nothing, so the next tick retries — no queue involvement, no job row,
no dependency on the thing being alarmed about.

**It gets its own timer and its own re-entrancy guard — not the maintenance
block** *(corrected, Codex round 1; this invalidated part of settled decision 6
as originally written)*. My first draft put dispatch in the `bulk` runner's
existing maintenance block. Re-reading `createLaneRunner` confirms Codex's
objection: `defaultBody` awaits `asyncJobsTick(...)` **before** reaching the
maintenance section (`asyncJobs.ts:740-772`), and `asyncJobsTick` itself awaits
`mapWithConcurrency` over every claimed handler (`:577-579`). So a single hung
`bulk` handler — an LLM call with no timeout, a wedged fetch — suppresses every
alert dispatch in the process, *including alerts recorded by perfectly healthy
lanes*. That reintroduces exactly the coupling this design exists to avoid, one
level up, and it is the same head-of-line-blocking shape the lane split was
built to kill.

So: `createAlertDispatchRunner()`, structurally a sixth runner built on the same
`createLaneRunner` pattern — own `setInterval`, own closure-local `ticking`
guard, own cadence (default 30s) — but claiming no jobs. The sweeper-vs-queued
choice in decision 6 stands and was never the problem; **where it was scheduled
was.** The same objection applies to `recoverStuckProcessing`, which is
currently in that same blocked-behind-handlers position: a hung bulk handler
today also suppresses stuck-row recovery process-wide. Moving reclaim onto the
independent runner alongside dispatch fixes both, and is folded into Phase 3.

**A4. Channels.**

- **Webhook (the push).** A direct `fetch` POST to `ALERT_WEBHOOK_URL`, with an
  `alert_webhook_format` config of `slack` | `discord` | `raw` shaping the body
  (`{text}` / `{content}` / the raw digest object). No database dependency, no
  Resend dependency, no queue dependency. Timeout-bounded, and its own failures
  are logged and surfaced **in-app only** — a webhook failure must never create
  an alert that tries to dispatch over the webhook.
- **In-app (the record).** The Queue Health page (Part C) plus a persistent
  banner in `AdminLayout` while any unacknowledged `critical` alert exists.
- **Email (retained, now honest).** The existing abandoned-email alert moves
  behind the same dispatcher, and the config gate is *seeded* by migration so it
  is finally togglable in the admin UI. It stays off by default — the webhook
  supersedes it — but it stops being a feature that lies about being
  configurable.

**A5. Digest + cooldown.** `alert_cooldown_minutes` (default 30) per
`dedupe_key`. The digest reads *"12 email jobs abandoned in the last 31 minutes
— first at 14:02, last error: `Resend disabled this process: invalid
RESEND_API_KEY`"* with a link to the health page. Two properties keep David's
accepted trade-off narrow:

- `dedupe_key` includes **queue + error class**, so a different queue or a
  different failure mode opens its own key and notifies immediately rather than
  folding into an unrelated digest;
- an **escalation override** — if `occurrence_count` since the last digest
  exceeds `alert_escalation_multiplier` (default 10×), it dispatches at once
  regardless of cooldown, because an order-of-magnitude change is news.

### Part B — Delivery correctness

**B1. Leases with fencing tokens.** Add `lease_token uuid` and
`lease_expires_at timestamptz` to `async_jobs`. At claim time each row gets a
fresh token and an expiry. **Every** finalize adds
`AND lease_token = <the token this run claimed> AND status = 'processing'` to
its `WHERE`, and uses `.returning()` to detect whether it applied. Zero rows
back means this run lost its lease to a reclaim; it logs loudly and does **not**
write — which is exactly the clobber that happens silently today (finding 6).

**B2. Heartbeat renewal, so slow work is never reclaimed — and it is fenced
too.** A **single timer per lane** (not per job) periodically extends
`lease_expires_at` for the rows that lane currently has in flight, in one
statement. One statement per lane per interval — this matters because the
connection pool has zero spare capacity (below).

**The renewal must be fenced by token, not by id** *(corrected, Codex round 1)*.
A renewal filtered only on `id = ANY($1)` is a hole in the fence rather than
part of it: if run A is reclaimed while its handler is still alive, A remains in
its lane's in-flight set, and A's next heartbeat **extends run B's lease**. If B
then dies, B's reclaim is postponed for as long as the zombie A keeps renewing —
which, for a wedged handler, is indefinitely. The renewal would actively defeat
the recovery mechanism it sits beside.

So renewal batches `(id, lease_token)` **pairs** and requires both the matching
token and `status = 'processing'`:

```sql
UPDATE async_jobs AS j SET lease_expires_at = now() + $lease, updated_at = now()
FROM (VALUES ($id1,$tok1), ($id2,$tok2), …) AS v(id, tok)
WHERE j.id = v.id AND j.lease_token = v.tok AND j.status = 'processing'
```

A stale owner's renewal then matches **zero** rows — which is also the signal
that the run has lost its lease, so the lane drops it from its in-flight set and
logs it, rather than continuing to renew into the void. Acceptance proves
exactly that: after token rotation, the prior owner's renewal affects zero rows.

Lease default 120s, renewed every 40s, both admin-config tunable — with the
ratio invariant enforced, see B2a. Consequences: a legitimately long job is safe
for as long as its process lives, and a dead process is detected in ~2 minutes
instead of 10.

**B2a. The lease/renewal ratio is a cross-setting invariant, and must be
enforced as one** *(added, Codex round 1)*. `async_job_lease_seconds` and
`async_job_heartbeat_seconds` are independently admin-tunable, and
`PATCH /admin/config/:key` validates only each row's own `minValue`/`maxValue`
(`admin.ts:2280-2310`) — there is no cross-key validation anywhere in that
route. An admin can therefore set renewal ≥ lease, at which point ordinary
scheduler or database jitter causes a live job to be reclaimed. The plan
enforces `heartbeat ≤ lease / 3` in **two** places, because either alone is
insufficient:

- **At write time** — the config route rejects a combination that violates the
  invariant, naming both keys in the error.
- **At read time** — the worker clamps whatever it reads, because debug values,
  a direct SQL edit, or a row seeded before the validation existed all bypass
  the route entirely. An out-of-range stored value is clamped to the safe ratio
  and logged once per process, never silently honored.

Acceptance exercises invalid combinations through both paths, plus the
renewal/reclaim boundary race at the ratio limit.

**B3. Graceful shutdown.** On `SIGTERM`/`SIGINT`: stop claiming, let in-flight
handlers finish within a bounded window, and release any still-running rows back
to `pending` **without incrementing `attempts`**. A deploy should not burn a
job's retry budget. This is what makes B4 safe.

**B4. Attempts increment on *crash* reclaim, and poison pills die.**
`recoverStuckProcessing` becomes lease-expiry-driven, increments `attempts`, and
rotates the token so the old owner's finalize can no longer apply. Rows whose
incremented count reaches their effective max are marked `failed` with a
`job_poison_pill` alert rather than being returned to `pending` — closing
finding 7's infinite loop. Because of B3, this counts only genuinely abnormal
terminations.

**B5. Provider idempotency for email.** `deliverFromOutbox` passes
`idempotencyKey: \`async-job/${row.id}\`` — stable across the retries of one
row, unique per row, and 15 characters against Resend's 256 limit. Retry after a
lost response no longer re-sends. An **admin retry** from `/admin/email-queue`
deliberately mints a *new* key, because "retry" from a human means "send it";
see *Risks* for the 24-hour window this interacts with.

**B6. Deferred-email age alarm.** The unconfigured-email defer path keeps
deferring without burning attempts (correct — a missing key is not the job's
fault), but a `queue_deferred_stale` alert fires once any email row has been
deferred beyond `email_defer_alert_hours` (default 6).

### Part C — The health surface

**C1. `worker_lane_heartbeats`** — one row per lane (`lane`,
`last_scheduled_at`, `last_tick_completed_at`, `in_flight_count`,
`last_claim_count`, `instance_id`).

**Scheduler liveness and tick completion are separate facts** *(corrected, Codex
round 1)*. My first draft stamped a single `last_tick_at` at the end of each
tick. That cannot distinguish a stopped timer from a legitimately long tick,
because `asyncJobsTick` does not return until every claimed handler finishes
(`asyncJobs.ts:577-579`) — so a 4-minute render on the `render` lane and a dead
`render` timer produce an identical signal. Any threshold tight enough to catch
the stopped 5-second lane promptly would flag the healthy long render as
stalled, and the alert would be trained into noise within a day.

Three separate stamps, written at different moments:

- **`last_scheduled_at`** — written when the timer *fires*, before any work,
  including on the re-entrancy early-return (`if (ticking) return`). This is
  pure scheduler liveness: if the interval is alive, this advances, no matter
  how long the work takes.
- **`last_tick_completed_at`** — written when a tick finishes, as before.
- **`in_flight_count`** — how many jobs that lane currently holds, so a long
  tick is legible as *working* rather than inferred from silence.

**Stall thresholds**, stated concretely rather than left to implementation:

- **Lane stalled** — `last_scheduled_at` older than `max(3 × interval, 60s)`.
  For `fast` that is 60s; for the 5s lanes, 60s; it keys off the scheduler, so
  it is unaffected by handler duration.
- **Lane wedged** — `last_scheduled_at` is current (timer alive) but
  `last_tick_completed_at` is older than the lease duration **and**
  `in_flight_count > 0` for longer than `wedged_lane_alert_minutes`
  (default 30). This is the genuinely-hung-handler case, which the first draft
  could not express at all, and it is a *different* alert kind
  (`worker_lane_wedged`) with different remediation.

Acceptance tests both directions explicitly: a long healthy handler must **not**
raise either alert, and a stopped scheduler must raise `worker_lane_stalled`
within its threshold.

**C2. `GET /admin/queue-health`** — per queue: pending / processing / failed /
done-24h, oldest-pending age, abandoned-24h; per lane: last-tick age and
configured interval; plus unacknowledged alerts. Read-only aggregation over
`async_jobs` + `worker_lane_heartbeats`; it stores nothing.

**C3. `/admin/queue-health` page**, following `async-ui-status.md`'s two
altitudes: an **aggregate** row per queue ("`enrichment` — 4 pending · 1
working · 2 failed · oldest 6m"), and **per-item** detail on expand (the
individual failing rows with their `lastError`, `attempts`, `nextAttemptAt`).
`fact_ai_meme_backfill`'s never-retried rows render as a distinct terminal
state, not as a generic failure, per the rule that "skipped" and "still running"
are first-class. Polls on a steady cadence; imposes no timeout.

**C4. `AdminLayout` banner** while any unacknowledged `critical` alert exists,
linking to the page. Acknowledging is an explicit admin action, so a real
failure cannot be cleared by a page reload.

**C5. `GET /health/queues`** — unauthenticated, no payload detail, returning
non-200 when any lane's heartbeat is stale. **This is the only design in the
plan that survives total process death**: an in-process watchdog cannot detect
its own absence. David can point any external monitor at it. Stated as a
limitation rather than papered over.

### Connection-pool interaction (not deferrable here)

`deferred-work.md` records that the five lanes' worst-case concurrent handler
count is exactly 10 and the pool `max` is unset — confirmed at
`lib/db/src/index.ts:45`, where no `max` is passed, so pg's default of 10
applies. **Zero spare connections under full load.** This plan adds steady-state
database work (heartbeat renewal, the dispatch sweeper, health queries), so it
cannot leave that arithmetic untouched:

- heartbeat renewal is **one statement per lane per interval**, deliberately
  batched, adding no per-job connection demand;
- the dispatcher and purge share the existing maintenance runner's slot;
- Phase 1 sets an explicit `max` (proposed: 20) on the pool. This is the
  deferred item's own revisit trigger arriving — the plan touches the thing the
  deferral was waiting on.

## Data Model and Migration Impact

Four hand-authored, idempotent migrations, one per phase, following the
broken-generator convention (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
EXISTS`, `CREATE INDEX IF NOT EXISTS`) plus `SNAPSHOT_EXEMPT_TAGS` and a
`_journal.json` entry each. Next free index is **0094**.

- **0094** (Phase 1) — `worker_lane_heartbeats`.
- **0095** (Phase 2) — `job_alerts` + its partial unique index; seed the
  `admin_config` rows: `email_admin_abandoned_alerts_enabled` (value `false`,
  finally present so the UI can toggle it), `alert_cooldown_minutes` (30),
  `alert_escalation_multiplier` (10), `alert_webhook_format` (`raw`),
  `email_defer_alert_hours` (6).
- **0096** (Phase 3) — `async_jobs.lease_token`, `async_jobs.lease_expires_at`,
  plus an index on `(status, lease_expires_at)` for the reclaim sweep; seed
  `async_job_lease_seconds` (120) and `async_job_heartbeat_seconds` (40).
- **0097** (Phase 4) — none expected; listed so the phase's "no schema change"
  is a stated conclusion rather than an omission.

**Row-state matrix for 0096** (the only migration touching existing rows):

| Existing row state | After migration | Correct? |
|---|---|---|
| `pending`, never run | `lease_token` NULL, `lease_expires_at` NULL | Yes — claimed normally, gets a token then. |
| `pending`, previously failed | NULL lease columns, `attempts` preserved | Yes — retry ladder unaffected. |
| `processing`, genuinely in flight during deploy | NULL lease | **See the rollout protocol below — the migration alone does not make this safe.** |
| `processing`, actually stranded pre-migration | Same legacy path | Reclaimed on the old `updatedAt` cutoff, as today. |
| `done` / `failed` (terminal) | NULL lease, untouched | Yes — never re-claimed. |
| Row inserted *during* the migration | NULL lease | Yes — same as legacy pending. |

Purely additive; no backfill rewrites existing data. **Observability:** each
migration reports affected counts per the repo's migration-observability rule.

### Mixed-version rollout protocol for 0096 (lease columns)

*(Added, Codex round 1. My first draft asserted the legacy-NULL path "handled"
this. It does not, and the objection is correct.)*

The problem is not the migration — it is **two workers running different code
against the same table at the same time**. The `7cb197f` worker finalizes by id
alone and its recovery ignores the lease columns entirely. So during any window
where old and new processes coexist:

- new code reclaims a NULL-lease row, assigns a token, and starts run B; the
  **old** process's run A finishes and finalizes by id, overwriting B — the
  exact clobber fencing exists to prevent, now caused by deploying the fix;
- symmetrically on **rollback**: leased rows are in flight under new code when
  an old worker resumes and finalizes them by id.

Fencing is only sound when every writer honors it, and a fence one participant
cannot see is not a fence. The protocol, therefore:

1. **Phase 3 splits into 3a and 3b, deployed separately.**
   - **3a — read/write the columns, honor the fence, but do not reclaim by
     lease.** New code writes `lease_token` on claim, fences its own finalizes,
     and renews heartbeats. Reclaim still uses the legacy `updatedAt` cutoff.
     An old worker coexisting here is harmless: it ignores columns it does not
     read, and it is not being raced for rows, because nothing is reclaiming on
     a short lease yet.
   - **3b — enable lease-driven reclaim**, deployed only once no `7cb197f`-era
     process remains. At this point every writer fences.
2. **Between 3a and 3b, drain rather than guess.** 3b's startup asserts that no
   row has been claimed by a pre-lease worker within the reclaim window —
   concretely, that no `status='processing'` row has a NULL `lease_token`. If
   any exist, 3b logs and defers enabling lease reclaim to the next tick rather
   than proceeding. That converts "did the old process exit?" from an assumption
   into a checked precondition, which is the part the first draft got wrong.
3. **Graceful shutdown (B3) ships in 3a, not 3b**, so the 3a→3b deploy itself
   drains cleanly and the window is short by construction.
4. **Legacy rows still get the `updatedAt` fallback** for one retention window
   after 3b, for rows stranded before any of this — that part of the original
   matrix survives.

**Rollback:** all four migrations are additive, so schema rollback is dropping
the new tables/columns. The *application* rollback that matters is 3b → 3a,
which is safe in the same direction and for the same reason: 3a honors the fence
without depending on short-lease reclaim. **Rolling back past 3a while leased
rows are processing is the unsafe direction** and is called out here as a
constraint on the deploy, not left to be discovered — drain first, exactly as in
step 2.

## Runtime Behavior

**Happy path is unchanged.** A job is enqueued, claimed (now with a lease),
runs, finalizes (now fenced), and is purged on schedule. No alert is recorded.

**Handler fails transiently.** Backoff as today. No alert until exhaustion — a
single retryable failure is not news.

**Retries exhausted.** Row → `failed`, `job_abandoned` alert recorded in the
same transaction, `onAbandon` fires as today. Within a cooldown window the
dispatcher sends one digest to the webhook and records it in-app; the banner
appears.

**Handler returns a terminal failure.** Row → `failed` immediately as today,
`job_terminal_failed` alert recorded. `onAbandon` still does not fire.

**Handler runs long (planner + image generation, 4 minutes).** The lane's
heartbeat extends the lease every 40s. The row is never reclaimed. It finalizes
normally — where today it would be re-run concurrently at the 10-minute mark and
then clobbered.

**Process is killed mid-run.** Heartbeats stop; the lease expires within ~2
minutes; the sweep reclaims with `attempts + 1` and a rotated token. If the
zombie process somehow finalizes afterward, its fenced write matches zero rows
and is logged, not applied.

**Process is deployed (SIGTERM).** In-flight jobs finish or are released to
`pending` with `attempts` untouched. No retry budget is spent on a deploy.

**A job kills the worker every time.** Each crash now costs an attempt; on
reaching the max the row is marked `failed` with a `job_poison_pill` alert
instead of looping forever.

**Resend key is revoked.** `resendAuthDisabled` latches as today; email jobs
exhaust and abandon. Alerts are recorded per job, coalesced by
`job_abandoned:email:auth_error`, and dispatched **over the webhook** — the
channel that does not depend on Resend. This is the exact scenario that is
silent today.

**A lane's timer stops.** Its heartbeat goes stale; `worker_lane_stalled` is
recorded and dispatched, the banner appears, and `/health/queues` returns
non-200 for an external monitor.

**Email delivery is unconfigured** (dev, or a missing key in production). Rows
defer as today without burning attempts; past 6 hours, one
`queue_deferred_stale` alert rather than silent accumulation.

## Admin/User UX Impact

No consumer-facing change whatsoever — background work stays invisible to
readers, per `background-work.md`.

Admin: one new nav item and page (**Queue Health**), one conditional banner, and
an acknowledge action. The page follows the two-altitude contract with aggregate
per-queue tallies and per-item expansion; empty state is an explicit "all
queues healthy, last checked <time>" rather than a blank table; loading is a
skeleton, not a spinner over the whole page; a stale-heartbeat lane is called
out in words, not only by color. `/admin/email-queue` is left exactly as it is —
it remains the email-specific working view and the abandoned-email alert keeps
linking to it.

## Security, Permissions, and Validation

- Every new admin route is behind `requireAdmin`, matching `/admin/email-queue`
  and covered by the existing `routes.admin.auth.test.ts` table.
- `GET /health/queues` is unauthenticated **by design** (an external monitor
  cannot log in) and therefore returns **only** a status code and a lane-count
  summary — no queue names, no payloads, no error strings, nothing that
  describes internal work.
- `ALERT_WEBHOOK_URL` is an environment secret, never an `admin_config` row
  (which is admin-readable and would put a credential-bearing URL in a UI), and
  never logged. Only its configured/absent state is reported.
- Alert payloads carry a recipient address and a provider error string for
  email failures. The webhook body is therefore **redacted by default** —
  recipient shown as `t***@example.com` — with the full value visible only on
  the authenticated in-app page. `lib/redact` already exists in this workspace
  and should be checked for a suitable helper before writing a new one.
- The dispatcher must bound webhook response handling (timeout, size cap) and
  must not follow redirects to an arbitrary host.
- No change to authentication, authorization, membership grants, or object
  access. Nothing in this plan touches the payment trust boundary.

## Testing Plan

Per `docs/engineering/testing-guide.md`; DB-backed tests run against the test
schema after `run-test.sh --setup`.

**Fencing and leases** (the highest-value tests — they encode the invariant, not
the example):

- A finalize whose lease token no longer matches writes **zero** rows and leaves
  the reclaimed row's state intact.
- A row reclaimed mid-flight is not double-finalized: simulate slow handler →
  expire lease → reclaim → original finalize → assert one terminal state and one
  logged lost-lease.
- Heartbeat renewal keeps a job running past the lease duration without
  reclaim (drive the timer, don't sleep).
- **A stale owner's heartbeat affects zero rows after token rotation** — and
  the lane drops that job from its in-flight set rather than renewing forever.
  This is the test that proves renewal is part of the fence, not a hole in it.
- **Config-ratio invariant:** renewal ≥ lease is rejected at the config route
  *and* clamped at read time (covering debug values and direct SQL edits), plus
  a renewal/reclaim boundary race at the ratio limit.
- **Mixed-version overlap:** a 3a-era worker (fence-honoring, legacy reclaim)
  and a 3b-era worker (lease reclaim) against the same table produce no
  double-finalize; and 3b's startup precondition defers enabling reclaim while
  any NULL-token `processing` row exists.
- **The accepted duplicate-execution window is asserted, not assumed** — a
  handler stalled past its lease is reclaimed and does run twice; only one run
  writes. This encodes settled decision 3 as a test rather than leaving it as
  prose.
- Graceful shutdown releases in-flight rows to `pending` with `attempts`
  **unchanged**; crash reclaim increments it. Both directions asserted.
- Poison pill: a row reclaimed up to its max lands `failed` with a
  `job_poison_pill` alert, and does **not** return to `pending`.
- Legacy row (`processing`, NULL lease) is reclaimed by the fallback path.

**Alerting:**

- Alert row is written **in the same transaction** as `status='failed'` — assert
  that a forced failure of the alert write rolls back the status write too, so
  the pair cannot diverge.
- Every queue produces an alert on exhaustion, including the nine with no
  `onAbandon` — parameterized over the registered queue list so a future queue
  added without an `onAbandon` is covered automatically.
- A terminal failure produces `job_terminal_failed` and does **not** invoke
  `onAbandon` (guards the *Must Not Change* contract).
- Coalescing: N failures on one dedupe key → one row, `occurrence_count = N`.
- Cooldown suppresses a second dispatch; a **different** dedupe key inside the
  same window dispatches immediately; the escalation multiplier overrides the
  cooldown.
- **The watermark sequence Codex specified:** first dispatch → further
  occurrences arrive with **no** acknowledgement → redispatch happens after the
  cooldown (this is the case the first draft silently dropped) → and an
  occurrence burst past the escalation threshold redispatches immediately.
- **Partial channel success:** webhook succeeds while email fails → the webhook
  entry advances, the email entry does not, and the alert is not marked
  delivered overall.
- Dispatch failure advances no watermark and is retried on the next tick — the
  durability property finding 3 lacks.
- **The dispatcher is not blocked by a hung handler** — block a `bulk` handler
  indefinitely, record an alert from another lane, and assert the webhook
  dispatch still happens on cadence. This is the regression test for the
  scheduling defect Codex found in round 1.
- A webhook dispatch failure does not create an alert that dispatches over the
  webhook (no feedback loop).

**Email:**

- `idempotencyKey` is passed and is stable across retries of one row, and
  **differs** after an admin retry.
- The dev fallback still delivers nothing and throws nothing.

**Health surface:**

- Route auth (added to the existing admin-auth table test).
- Aggregation correctness against a seeded mix of queue states.
- `/health/queues` returns non-200 on a stale heartbeat and leaks no queue
  detail in either state.
- **Long-healthy vs. genuinely-stopped, both directions:** a 4-minute handler on
  the `render` lane raises neither `worker_lane_stalled` nor
  `worker_lane_wedged`; a stopped scheduler raises `stalled` within its
  threshold; a live scheduler with a wedged handler raises `wedged` and not
  `stalled`. Without all three, the thresholds are unverified guesses.

**Enqueue atomicity (Phase 4):** per atomic-required call site, a forced enqueue
failure rolls back the domain mutation, and a forced mutation rollback leaves no
job row. The best-effort sites are asserted to *stay* best-effort, so the
classification is enforced rather than documented.

**Regression:** the existing `asyncJobs`, `cliJobPoller`, `factPexelsJobs`,
`aiMemeBackfillJobs`, `factSendBackJob`, `adminNotify.*` and
`adminEmailQueue.delete` suites must pass unchanged — if one needs editing, that
is a signal a *Must Not Change* invariant moved, and it goes to David.

## Implementation Steps

Four phases, each an independently shippable PR that leaves the tree green and
the product testable, with **Phase 3 split into two separately-deployed halves
(3a / 3b)** for the mixed-version reason below. Ordered so the instrument lands
before the machine changes (settled decision 5).

**Phase 1 — Instrument (no behavior change to the queue).**
1. Migration 0094: `worker_lane_heartbeats`.
2. Stamp a heartbeat at the end of each lane tick.
3. Set an explicit pool `max`; record the arithmetic in `deferred-work.md`.
4. `GET /admin/queue-health` + `GET /health/queues`.
5. The Queue Health page + nav item, per the two-altitude contract.

**Phase 2 — Alerts (closes the headline finding).**
6. Migration 0095: `job_alerts` (with the A1 watermark columns) + seeded config
   rows.
7. Record alerts inside the finalize transaction, for all queues and both
   terminal paths.
8. `createAlertDispatchRunner()` — its **own** timer and re-entrancy guard, not
   the bulk maintenance block: grouping, cooldown, escalation, watermark
   advancement per channel.
9. Webhook channel + format shaping + redaction.
10. Route the existing abandoned-email alert through the dispatcher.
11. Banner + acknowledge action.

**Phase 3a — Fence-compatible (safe alongside an old worker).**
12. Migration 0096: lease columns + index + config, with the ratio invariant
    enforced at both write time and read time.
13. Claim writes `lease_token` + `lease_expires_at`; **every** finalize is
    fenced on `(id, token, status='processing')` and checks its affected row
    count.
14. Per-lane batched heartbeat renewal, fenced on `(id, token)` pairs; a
    zero-row renewal drops the job from the lane's in-flight set and logs.
15. Graceful shutdown (moved earlier from the first draft, so the 3a→3b deploy
    drains cleanly).
16. Move `recoverStuckProcessing` off the bulk maintenance block onto the
    independent runner — still on the legacy `updatedAt` cutoff at this stage.
17. Resend idempotency key.
17a. **Audit the remaining handlers for replayed external side effects** and
    record the result in the plan's per-queue table — `image_generation` and
    `image_prompt_generation` first, since `email` and `fact_ai_meme_backfill`
    are already characterised. Any handler found to replay a paid or
    user-visible call gets provider-level or domain-level idempotency in this
    step, not later.
18. Deferred-email age alarm.

**Phase 3b — Enable lease-driven reclaim (only once no pre-lease worker
remains).**
19. Startup precondition check: no `status='processing'` row with a NULL
    `lease_token`; defer enabling to the next tick if any exist.
20. Lease-expiry reclaim with attempt increment, token rotation, and poison-pill
    termination; legacy `updatedAt` fallback retained for one retention window.

**Phase 4 — Transactional enqueue.**
21. Rewrite `enqueueJob`'s dedupe onto
    `onConflictDoNothing({ target: [queue, dedupeKey], where: <partial-index
    predicate> })`, retiring `isDedupeConflict`. **The spike is resolved — see
    below; no `SAVEPOINT` fallback is needed.** Add a generated-SQL assertion
    plus an integration test proving concurrent dedupe returns the existing
    non-terminal row.
22. Accept a caller transaction through the whole enqueue path, including the
    conflict-recovery read that hardcodes `defaultDb` today.
23. **Enumerate every enqueue caller and decide atomicity per site** — see the
    call-site inventory below. Close the `deferred-work.md` item.

### Step 21's unknown is resolved (Codex round 1)

My first draft flagged as a genuine unknown whether drizzle can target a
*partial* unique index, and proposed a `SAVEPOINT` fallback. Codex resolved it,
and I verified it independently in the installed package:

- `onConflictDoNothing(config?: { target?: IndexColumn | IndexColumn[]; where?:
  SQL })` — the property is **`where`**, not `targetWhere`;
  `targetWhere` belongs to `onConflictDoUpdate`. Probing for the wrong property
  would have made the API look unavailable and selected the fallback
  unnecessarily.
- The implementation emits
  `` sql`(${targetColumn})${whereSql} do nothing` `` — placing the predicate in
  the **index-predicate position**, i.e. `ON CONFLICT (…) WHERE … DO NOTHING`,
  which is exactly what a partial unique index requires. Verified by reading
  `pg-core/query-builders/insert.js:100-110`.

**One provenance correction to Codex's own note:** it cited "the locally
installed Drizzle 0.45.2." The version installed in this sandbox is **0.45.1**;
`pnpm-lock.yaml` resolves **0.45.2**. The same 0.45.1-vs-0.45.2 sandbox
discrepancy is already documented in the Stripe audit findings, which confirmed
the relevant behavior unchanged between them. The API conclusion holds; the
build should re-confirm against 0.45.2 as a one-line check rather than assume
it, since the reading was taken from 0.45.1.

### Step 23's call-site inventory (Codex round 1)

Codex is right that making the helper transaction-capable does not by itself
close finding 9, and that my step-21 scope — "`sendEmail` and the two
status-writing enqueue sites" — was too narrow. There are **16 `sendEmail` call
sites across 9 files**, verified by enumeration:

`jobs/factOfTheDay.ts`, `lib/moderation/ncmec.ts`, `lib/adminNotify.ts`,
`lib/userNotify.ts`, `lib/webhookHandlers.ts`, `routes/share.ts`,
`routes/users.ts`, `routes/localAuth.ts`, `routes/reviews.ts`.

The worked example Codex cites is real and I confirmed it: `routes/users.ts`
inserts an `email_verification_tokens` row (`:342-347`), fire-and-forgets
`sendEmail(...).catch(...)` (`:352-354`), and only *afterwards* writes
`pendingEmail` in a separate statement (`:359-360`). Three writes, no
transaction, in an order where a failure between any two leaves the user with a
token and no mail, or mail and no pending state.

Step 23 therefore classifies **every** site into one of three buckets, in the
plan, before any code changes:

- **Atomic-required** — the notification is part of the domain change's
  contract and a divergence is user-visible or legally material. Email
  verification, password reset, and `ncmec.ts`'s reporting path are the
  candidates; each gets its domain write and its enqueue composed in one
  transaction.
- **Best-effort by design** — an admin notification about an event that already
  happened (`adminNotify`'s fact-review alert). A missed one is a nuisance, not
  a correctness failure, and wrapping it would put a mail enqueue inside a
  moderation transaction for no benefit. Left as-is, **explicitly**, with the
  reason recorded.
- **Already-terminal** — `factOfTheDay.ts` and similar, where the enqueue *is*
  the job.

Acceptance is the two-directional test Codex asks for, per atomic-required
site: a forced enqueue failure rolls back the domain mutation, and a forced
mutation rollback leaves no job row.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Fencing is the riskiest change in the plan** — it touches every finalize path. A mistake strands jobs in `processing`. | It lands in Phase 3, *after* the health page and alerting are live, so a stranded row is visible within a poll rather than discovered weeks later. The lost-lease branch logs loudly and never writes. |
| **Attempt-on-reclaim could burn budgets during ordinary deploys.** | Graceful shutdown (step 16) lands in the same phase and releases in-flight rows without incrementing. Tested in both directions. |
| **Resend's idempotency keys expire after 24 hours** (verified below), while the retry ladder spans ~10.6h — inside the window, but a raised `maxAttempts` or a much later manual retry falls outside it, and a duplicate becomes possible again. | Documented in code at the call site. Admin retry mints a fresh key deliberately. A `maxAttempts` raise past the window is called out in `known-failure-patterns.md`. |
| **Cooldown folding hides a distinct failure** (David's accepted trade-off, decision 4). | Narrowed two ways without reopening the decision: `dedupe_key` includes queue + error class so genuinely different failures never fold together, and the escalation multiplier forces an immediate dispatch when volume jumps by an order of magnitude. |
| **Total process death cannot be self-detected.** | Stated plainly rather than designed around; `/health/queues` exists so an external monitor can close it. This is the one gap the plan does not claim to fix internally. |
| **Alert fatigue turning the banner into wallpaper.** | Only `critical` raises the banner; acknowledgement is explicit and recorded; per-queue severity is admin-config so a chatty queue is tuned rather than ignored. |
| **Pool exhaustion from the new steady-state queries.** | Heartbeat renewal is one batched statement per lane per interval; dispatcher and purge share the existing maintenance slot; Phase 1 raises `max` explicitly. |
| **Four phases is a long runway before the headline finding closes.** | Phase 2 closes it, and Phase 1 is deliberately small. If David wants alerts sooner, Phases 1 and 2 can merge into one PR — the ordering rationale is about Phase 3, not about splitting 1 from 2. |
| ~~**`onConflictDoNothing` against a partial unique index may not be expressible in drizzle 0.45.2.**~~ | **Resolved, Codex round 1** — the API is `onConflictDoNothing({ target, where })` and it emits the predicate in the index-predicate position. Verified in the installed source. No `SAVEPOINT` fallback needed; re-confirm against 0.45.2 during the build, since the reading was taken from the sandbox's 0.45.1. |
| **Mixed-version deploys defeat fencing** — an old worker finalizes by id and cannot see the fence. | Phase 3 splits into 3a (fence-honoring, legacy reclaim — safe alongside old workers) and 3b (lease reclaim, gated on a startup precondition that no NULL-token `processing` row exists). Graceful shutdown ships in 3a so the 3a→3b window is short. Rolling back past 3a with leased rows in flight is called out as the unsafe direction. |
| **A stale owner's heartbeat could extend the new owner's lease**, postponing recovery indefinitely. | Renewal is fenced on `(id, token, status)` pairs exactly like finalize; a zero-row renewal is the signal to drop the job from the lane's in-flight set. Tested directly. |
| **The alert dispatcher could be starved by a hung handler.** | It runs on an independent timer with its own re-entrancy guard, never behind an awaited `asyncJobsTick`. `recoverStuckProcessing` moves off the same blocked position in 3a. Regression-tested by blocking a bulk handler and asserting dispatch still fires. |
| **Alerting continues after the first digest but is never re-dispatched.** | `dispatched_count` / `last_dispatched_at` make pending-ness a quantity rather than a boolean; the dispatcher selects on `occurrence_count > dispatched_count`, per channel. |

## External-Claim Verification

One material external claim, verified by me against current documentation
(2026-07-29) and against the locally installed package — not from model memory.

**Claim:** Resend supports idempotency keys on send, so a retried delivery does
not duplicate the email.

- **Verified against** [Resend's idempotency-keys
  documentation](https://resend.com/docs/dashboard/emails/idempotency-keys) and
  the [changelog entry](https://resend.com/changelog/idempotency-keys).
- **Supported on** `POST /emails` and `POST /emails/batch`, via the
  `Idempotency-Key` HTTP header, `Resend-Idempotency-Key` over SMTP, or the
  Node SDK's `idempotencyKey` option passed as the second argument to
  `resend.emails.send(payload, { idempotencyKey })`.
- **Key limit:** up to 256 characters. Our `async-job/${row.id}` is ~15.
- **Retention: 24 hours.** This is the constraint that shapes the design — our
  five-attempt ladder spans ~10.6h and fits; anything beyond the window does
  not. Recorded as a risk above rather than glossed.
- **Replay semantics:** the original response is returned without re-sending; a
  replay with a *different* payload returns `409 invalid_idempotent_request`.
  Our payload is immutable per row, so 409 is not expected — but the handler
  should treat it as a terminal, non-retryable failure if it ever occurs, since
  retrying cannot fix it.
- **Version confirmed in this repo:** `artifacts/api-server/package.json`
  pins `resend@^6.9.4`; the installed
  `node_modules/.pnpm/resend@6.9.4/node_modules/resend/dist/index.d.mts:157`
  declares `idempotencyKey?: string`. **No dependency upgrade is required.**

No other external API, model, pricing, or rate-limit claim is load-bearing in
this plan.

## Questions for David

None outstanding. The four product decisions were settled in the pre-plan
conversation and are recorded under *Settled Decisions*. Two things I decided
from the repository rather than asking — the phase ordering and the pool `max`
raise — are recorded there too, with their reasoning, so they can be overridden
in one line if he disagrees.

One item that is a *notification*, not a question: Phase 1 raises the connection
pool's `max`, which `deferred-work.md` had parked as "an infra/cost decision,
not a code change to make proactively." Its stated revisit trigger has arrived —
this plan is the thing that was being waited on.

## Definition of Done

- All eleven findings above are either fixed or explicitly recorded as accepted
  with a reason (the process-death gap being the one accepted).
- Every registered queue produces a durable alert on retry exhaustion and on
  terminal failure, proven by a test parameterized over the queue registry
  rather than a list maintained by hand.
- An alert survives a crash between the job failing and the notification being
  sent — recorded transactionally, dispatched by a retrying sweeper.
- A revoked Resend key results in a delivered webhook alert, demonstrated in
  UAT.
- **Only the current lease-holder may finalize a job** — a stale owner's
  finalize and its heartbeat renewal are both proven to affect zero rows after
  token rotation.

  *(Corrected, Codex round 1. The first draft said "no job is executed twice as
  a result of a reclaim," which claimed exactly-once execution and contradicted
  settled decision 3. Fencing governs **writes**, not **execution**: an
  event-loop pause, a pool outage, or a missed renewal lasting beyond the lease
  lets the sweeper reclaim while the original handler is still performing
  external side effects. That window is real, deliberately accepted under
  decision 3's "never lose work," and the mitigation is handler-level
  idempotency — step 17a's audit — not a guarantee the queue cannot make. The
  duplicate-execution window is a tested, documented property, not an
  eliminated one.)*
- A worker-killing job reaches `failed` rather than looping.
- Queue Health shows all eleven queues at both altitudes and satisfies
  `async-ui-status.md`.
- `deferred-work.md`'s transactional-enqueue item and pool-`max` item are closed
  and struck, not silently left.
- Existing async/email/admin suites pass unchanged; CI `Build` + `Test` green.
- Each phase ships its `TEST_RUN` + `UAT` per `CLAUDE.md` (Phase 1's UAT is
  thin by nature — a read-only surface — and says so).
