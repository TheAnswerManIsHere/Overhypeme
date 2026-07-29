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

## The deployment is autoscaled — this reframes the whole plan

*(Added, Codex round 2. This is the round's real finding, and it invalidated a
single-instance assumption that ran silently through every part of the first
two drafts.)*

Verified, not inferred:

- **`.replit` sets `deploymentTarget = "autoscale"`** — the production
  deployment runs **N concurrent instances**, scaled by load.
- **`index.ts:432` calls `runAsyncJobsWorker()` unconditionally**, after the
  handler registrations. There is no leader election, no instance guard, no
  `REPLIT_DEPLOYMENT`-conditional skip. A repo-wide search for one found only
  unrelated uses of the Replit env vars (security headers, dev-admin gating,
  site URL).

So **every instance runs all five lanes**, and every mechanism this plan adds
runs N times concurrently. Three consequences, in ascending order of how much
they change:

**1. What already works, and why.** Claiming is safe — `FOR UPDATE SKIP LOCKED`
is exactly the right primitive for N claimers, and that is presumably why it was
chosen. Nothing in this plan may weaken it.

**2. What this means for finding 6, today, on `main`.** The unfenced finalize is
not a theoretical race waiting for a slow handler; **autoscale makes it a live
production defect.** `runAsyncJobsWorker()` calls `recoverStuckProcessing(defaultDb)`
at startup with the default 5-minute cutoff (`asyncJobs.ts:843`). When autoscale
adds an instance — routine under load — that new instance immediately reclaims
any row another instance has held in `processing` for over five minutes. The
`render` lane's own comment concedes the planner alone can take 180s before
image generation begins. So: instance A is legitimately mid-render, instance B
boots and reclaims the row, both run the handler, and A's unfenced finalize
overwrites B's result. This requires no crash and no bug — only a scale-up
during a slow job. See the *NEED YOU* item raised with David separately: the
severity of finding 6 is higher than the first draft assessed.

**3. What it means for everything this plan adds.** A process-local
re-entrancy guard bounds one instance, not the fleet. Any design of mine that
reasoned "the runner's guard prevents concurrent X" was reasoning about one
process while N were running. Concretely, this is what round 2's findings are
all instances of, and each is fixed below:

| Mechanism | Single-instance assumption | Multi-instance fix |
|---|---|---|
| Alert dispatch | closure-local `ticking` guard prevents double-send | advisory lock per `(dedupe_key, channel)`, held across the send (A3a) |
| Lane heartbeats | one row per lane | keyed `(instance_id, lane)`, aggregated for health, pruned on departure (C1) |
| Lease reclaim | read expired rows, then update | single fenced atomic statement with `SKIP LOCKED` (B4) |
| 3b rollout gate | poll for NULL-token `processing` rows | version-stamped instance heartbeats as a real drain barrier (rollout §2) |
| Alert watermark | one global `dispatched_count` | per-channel dispatch rows (A1) |

**The governing rule this plan now states explicitly, so no later step
reintroduces the assumption:** *every mechanism must be correct when N instances
run it simultaneously, and "correct" means proven by the database, not by a
process-local guard.*

## Source-of-Truth Analysis

| Concept | Source of truth | Change |
|---|---|---|
| Queued work + its lifecycle | `async_jobs` rows | Unchanged. New columns are additive bookkeeping (lease, alert linkage); no new table duplicates job state. |
| Who currently owns a running job | *Nothing today* — `status='processing'` plus a wall-clock guess | **New:** `lease_token` + `lease_expires_at` on the same row. Still one source; the ownership fact moves from implicit to explicit. |
| Whether a failure has been notified | *Nothing today* — it is transient in-process intent | **New:** `job_alerts` rows. This is genuinely new state, not a duplicate: nothing records it today, which is finding 3. |
| Worker liveness | *Nothing today* | **New:** `worker_lane_heartbeats`, one row per **`(instance_id, lane)`** — the fleet's composition is itself the state, which is what makes the 3b drain barrier provable. Operational telemetry, not job state. |
| Whether an alert has been delivered, per channel | *Nothing today* | **New:** `job_alert_dispatches`, one row per `(alert_id, channel)`. Kept out of `job_alerts` deliberately: a single global counter cannot represent partial channel success. |
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
| `kind` | one of the shared `ALERT_KINDS` registry below |
| `dedupe_key` | grouping key, e.g. `job_abandoned:email:auth` |
| `severity` | `warning` \| `critical` |
| `queue` | nullable — set for job-scoped kinds |
| `sample_payload` | jsonb: representative job id, last error, recipient etc. |
| `first_seen_at` / `last_seen_at` | window bounds |
| `occurrence_count` | total occurrences, incremented on repeat |
| `state` | `active` \| `resolved` — see the incident lifecycle below |
| `resolved_at` | when the underlying condition cleared |
| `acknowledged_at` / `acknowledged_by` | admin ack from the health page |

**Dispatch state is a child table, not columns** *(corrected, Codex round 2)*.
My round-1 fix put a single global `dispatched_count` on the alert plus a
per-channel *timestamp* map — which cannot express partial success at all. If
webhook succeeds through occurrence N and email fails, advancing the global
count loses email's retry, leaving it unchanged makes webhook resend the same N,
and a timestamp cannot identify which later occurrences are new. The round-1
reply claimed per-channel independence that the round-1 *schema* could not
implement. So `job_alert_dispatches`:

| Column | Purpose |
|---|---|
| `alert_id` | fk → `job_alerts` |
| `channel` | `webhook` \| `email` \| `in_app` |
| `dispatched_count` | occurrences this channel has successfully delivered |
| `last_dispatched_at` | this channel's cooldown watermark |
| `last_error` / `failure_count` | per-channel delivery diagnostics |

Primary key `(alert_id, channel)`. Each channel advances independently; pending
for a channel is `alert.occurrence_count - dispatch.dispatched_count`.

A partial unique index on `(dedupe_key)` where `state = 'active'` makes
"record or coalesce" a single idempotent upsert.

**One shared `ALERT_KINDS` registry** *(added, Codex round 3)*. My kind list and
my producer list had drifted apart while I was editing them in separate rounds:
`email_delivery_disabled` was declared with **no producer**, and
`worker_lane_wedged` was produced by two sections while **absent from the
declared list**. The promised "every declared kind has a producer" test would
therefore have either failed on the first or silently skipped the second —
a test that cannot pass is not coverage.

So one exported registry is the single source, and the schema check, the
lifecycle shape, the producer sweep, and the parameterized tests all derive
from it rather than repeating it:

| Kind | Shape | Producer | Severity |
|---|---|---|---|
| `job_abandoned` | event | A2 finalize | critical |
| `job_terminal_failed` | event | A2 finalize | critical |
| `job_poison_pill` | event | B4 reclaim | critical |
| `queue_backlog` | condition | A2a sweep | warning |
| `queue_deferred_stale` | condition | A2a sweep | warning |
| `worker_lane_stalled` | condition | A2a sweep | critical |
| `worker_lane_wedged` | condition | A2a sweep | critical |

`email_delivery_disabled` is **removed**, not given a producer: it described the
same situation `queue_deferred_stale` already covers (email configured away
while rows pile up), and two kinds for one condition would have produced two
alerts for one incident. Adding a kind to this table without a producer entry
fails the build.

**Incident lifecycle: acknowledgement must not re-arm a still-true condition**
*(added, Codex round 2)*. The round-1 design keyed the partial index on
`acknowledged_at IS NULL`, which is right for event-shaped alerts (a job
abandoned — a thing that happened once) and **wrong for condition-shaped ones**
(a lane is stalled — a thing that is *still true*). Acknowledging the sole row
for a stale lane removes it from the index while the lane is still stale, so the
next evaluator tick inserts a fresh unacknowledged row and the banner returns
immediately. Acknowledgement would be a button that does nothing, and one
uninterrupted incident would emit digests forever.

Two alert shapes, handled differently:

- **Event alerts** (`job_abandoned`, `job_terminal_failed`, `job_poison_pill`) —
  each occurrence is a fact about the past. `state` goes `active` and is set
  `resolved` on acknowledgement. Coalescing behaves as designed.
- **Condition alerts** (`queue_backlog`, `queue_deferred_stale`,
  `worker_lane_stalled`, `worker_lane_wedged`) — **edge-triggered**. The
  producer sweep (A2a) sets `state = 'resolved'`, `resolved_at = now()` when the
  condition clears, and only a fresh `active` row can be created *after* that.
  Acknowledging a condition alert suppresses its **notifications** and its
  banner without resolving it, and it does **not** re-fire until either the
  condition clears and recurs, or a **duration** escalation boundary is crossed.
  The health page still shows it as an unresolved-but-acknowledged condition, so
  acknowledgement hides the alarm, never the fact.

  **Conditions escalate on duration, and the boundary needs a durable
  watermark.** A5's escalation is an **occurrence-count** multiplier, which an
  edge-triggered condition can never reach: it produces no further occurrences
  after its initial false→true edge, so an acknowledged lane wedge would stay
  silent forever while getting worse. Nor is a bare duration rule enough — an
  acknowledged condition alert has its occurrence count fully dispatched and its
  acknowledgement set, so without a state transition at the boundary an
  implementer lands either on "stays silent forever" or "re-alerts on every tick
  past 4 hours," and both read as following the spec.

  So the boundary is expressed as **three durable counters that the existing
  watermark machinery already knows how to compare** — a tier bump alone would
  not do it, because the dispatcher selects on `occurrence_count >
  dispatched_count` and a tier bump changes neither count, and the banner reads
  `acknowledged_at`, which a tier bump does not clear:

  - **`job_alerts.escalation_tier`** (int, default 0). The sweep computes
    `tier = floor(hours_since_first_seen / condition_escalation_hours)`
    (default 4) inside its locked transaction and bumps the column when
    `tier > escalation_tier`. Between boundaries the comparison is false and
    nothing is written, so two evaluators cannot both cross the same boundary.
  - **`job_alert_dispatches.dispatched_tier`** (int, default 0) — the
    **per-channel** half. The dispatcher's selection predicate gains
    `OR alert.escalation_tier > dispatch.dispatched_tier`, and a successful
    delivery advances `dispatched_tier` to the alert's `escalation_tier` in the
    same write that advances `dispatched_count`. Partial-channel behavior is
    therefore identical to the occurrence watermark's: a failed channel advances
    neither counter and retries the same boundary next tick, while a healthy
    channel is unaffected.
  - **`job_alerts.acknowledged_tier`** (int, default 0), set to the alert's
    current `escalation_tier` when an admin acknowledges. The banner shows an
    alert while `state = 'active' AND (acknowledged_at IS NULL OR
    escalation_tier > acknowledged_tier)`, so a boundary reactivates the banner
    exactly once with **no clearing write** — acknowledgement is never undone
    behind the admin's back, it is simply out of date.

  Volume escalation stays what it is — the right metric for event alerts.
  Acceptance: exactly one notification per channel and one banner reactivation
  at each boundary, **zero** between them (the half that catches the every-tick
  failure), and a boundary crossed while one channel is failing redispatches
  only that channel once it recovers.

The distinction is a column on the alert kind, not a judgement call at each
call site, so a future alert kind must declare which shape it is.

**The pending-occurrence watermark, per channel.** Pending-ness is a
**quantity**, not a boolean, and it is tracked **independently per channel**:

- **pending for a channel** = `alert.occurrence_count -
  dispatch.dispatched_count` for that `(alert_id, channel)` row;
- the dispatcher selects channels where that difference is `> 0` **and**
  (never dispatched **or** that channel's `last_dispatched_at` is older than the
  cooldown), or where the difference exceeds the escalation threshold regardless
  of cooldown, **or where `alert.escalation_tier > dispatch.dispatched_tier`**
  (the duration-escalation boundary above, which produces no new occurrences and
  so must have its own term in this predicate);
- on **successful** delivery it advances that channel's `dispatched_count` to
  the `occurrence_count` **captured before sending** (and its `dispatched_tier`
  to the `escalation_tier` captured with it), so occurrences arriving
  mid-dispatch are not swallowed into a span that was never reported;
- on failure it advances nothing for that channel, so the next tick retries the
  same span — while a healthy channel is unaffected, and a failing channel does
  not inherit a healthy one's cooldown.

*(Two rounds of correction produced this shape. Round 1: the original design
selected on `notified_at IS NULL` while coalescing bumped `occurrence_count` on
the same row, so alerting went permanently quiet after the first digest until an
admin acknowledged — the counter-based watermark replaced it. Round 2: the
round-1 schema still had **one global** `dispatched_count` plus per-channel
*timestamps*, which cannot represent partial channel success at all — advancing
the global count loses the failing channel's retry, not advancing it makes the
healthy channel resend, and a timestamp cannot identify which occurrences are
new. Hence the normalized child table above.)*

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

**A2a. Condition alerts need a producer, which the first two drafts never
specified** *(added, Codex round 2)*. A2 covers alerts produced by a **job
finalizing**. But four declared kinds — `queue_backlog`, `queue_deferred_stale`,
`worker_lane_stalled`, `worker_lane_wedged` — describe states that no job
transition ever announces: nothing finalizes when a lane's timer stops. I listed
those kinds in the ledger and asserted in *Runtime Behavior* that "a lane's timer
stops → `worker_lane_stalled` is recorded," and **no implementation step
produced them.** The runtime claim was unimplementable as written; the plan
described an alarm with no sensor.

**Thresholds are read once, uncached, inside the locked evaluation.**
`adminConfig.ts` caches the whole table per process for 60s and
`bustConfigCache()` clears only the serving process's copy (`adminConfig.ts:24-44`).
On an autoscaled fleet that means alternating evaluators can hold **different
threshold values** for up to a minute after a PATCH — one opens an incident
under the new value, the next resolves it under the stale one, the next reopens
it. Edge-triggered alerting turns that into a stream of false transitions and
notifications, and the sweep lock does not help because both instances are
individually "correct" against what they read. So the sweep reads one uncached
snapshot of its threshold keys inside the locked transaction, making every
evaluation of a given tick consistent by construction.

**What acceptance can and cannot prove here.** The obvious criterion — "two
instances, one stale cache and one fresh" — **cannot run in this repository**:
two `createLaneRunner` instances in one test process share the module-level
`_cache` singleton in `adminConfig.ts`, so they can contend over separate pooled
connections but can never represent one stale and one fresh *process* cache.

So the criterion targets the remedy directly instead: prime the singleton cache,
update the threshold in the database **without** calling `bustConfigCache()`,
and assert `evaluateAlertConditions()` reads the **new** value. That proves the
property that matters — the sweep bypasses the cache — rather than staging a
cross-process condition this harness cannot create. Genuine multi-process cache
behaviour remains a **stated, untested assumption**, which is better than a
green test that proves nothing.

So: `evaluateAlertConditions()`, running on the same independent runner as
dispatch (A3), before it. Each tick it evaluates every condition against
`async_jobs` and `worker_lane_heartbeats`, opens an `active` alert for any newly
true, and **resolves** any that has cleared — which is what makes the
edge-triggered lifecycle above real rather than aspirational. Thresholds, all
admin-config:

| Condition | Predicate | Default |
|---|---|---|
| `queue_backlog` | oldest `pending` row for a queue older than | 30 min |
| `queue_deferred_stale` | an `email` row deferred beyond | 6 h |
| `worker_lane_stalled` | no instance's `last_scheduled_at` for a lane within | `max(3 × interval, 60s)` |
| `worker_lane_wedged` | some instance's timer alive but tick incomplete + in-flight beyond | 30 min |

Acceptance proves **each declared kind is actually produced** by driving its
condition true, and then resolved by clearing it — a test I would not have
written from the first draft, because the first draft implied they came for
free.

**A3. A sweeper dispatches, on its own timer, and retries until it succeeds.**
`dispatchPendingAlerts` selects alerts with pending occurrences outside their
cooldown (per A1's watermark), groups them into one digest per channel,
delivers, and advances the watermark **only on success**. A failed dispatch
advances nothing, so the next tick retries — no queue involvement, no job row,
no dependency on the thing being alarmed about.

**Where it is scheduled: its own timer, never the maintenance block.**
`createLaneRunner`'s `defaultBody` awaits `asyncJobsTick(...)` **before** it
reaches the maintenance section (`asyncJobs.ts:740-772`), and `asyncJobsTick`
itself awaits `mapWithConcurrency` over every claimed handler (`:577-579`). So a
single hung `bulk` handler — an LLM call with no timeout, a wedged fetch —
suppresses every alert dispatch in that process, *including alerts recorded by
perfectly healthy lanes*: the same head-of-line blocking the lane split was
built to kill, reintroduced one level up.

So `createAlertDispatchRunner()` is structurally a sixth runner on the
`createLaneRunner` pattern — own `setInterval`, own cadence (default 30s) — but
claims no jobs. The sweeper-vs-queued choice in settled decision 6 stands; only
its scheduling position changed. `recoverStuckProcessing` sits in that same
blocked-behind-handlers position today, so a hung bulk handler currently
suppresses stuck-row recovery process-wide too; moving it onto the independent
runner alongside dispatch fixes both, folded into Phase 3a.

**A3a. The re-entrancy guard is a database lock, per channel.** A closure-local
`ticking` boolean bounds one process while the fleet is unbounded: two instances
select the same pending span and both POST the digest before either advances a
watermark. A conditional `WHERE dispatched_count = <captured>` *after* the send
does not save it either — that prevents a duplicate state update, after a
duplicate notification has already reached David's phone. The lock must be held
**across** the send.

Its granularity must match the *delivery* granularity, which is the channel, not
the alert: the dispatcher groups **multiple alerts into one digest per channel**,
so with pending alerts A and B, per-alert locks let two instances each take a
different alert's lock, skip the other's, and each send a *partial* digest — two
notifications, neither complete.

`pg_try_advisory_xact_lock(hashtext('alert_dispatch:' || channel))`, acquired
**before selection** and held across the whole build-and-send for that channel:

- `try_` rather than blocking: a second instance that cannot take the lock skips
  that alert this tick and moves on — the next tick retries, and dispatch has no
  latency requirement that would justify queueing behind a peer.
- `_xact_` so the lock is released on commit **or** on crash, with no unlock
  path to forget. A process killed mid-dispatch cannot wedge the alert forever.
- Keyed per **channel**, so a slow webhook POST does not block the email
  channel — while guaranteeing exactly one digest per channel per tick
  fleet-wide, which is what the acceptance criterion actually asserts.
- `hashtext()` collisions are bounded and safe here: two colliding channel keys
  would make one instance *skip* a dispatch it would have retried on the next
  tick — a delay, never a missed alert, since the watermark advances only on
  actual delivery. With three channel values a collision is theoretical; the
  property is stated because it must survive future channels being added.

The residual window is honest and small: an instance that takes the lock, POSTs
successfully, and dies before commit will re-send that digest on a later tick.
That is at-least-once notification, consistent with settled decision 3's
posture, and vastly better than the unbounded duplication without the lock.
**The same cross-instance argument applies to `evaluateAlertConditions()`** (one
advisory lock for the whole sweep — it is cheap and idempotent) and to reclaim
(B4, which uses a different and stronger mechanism).

Acceptance is a two-runner test: two dispatchers against one database, one
delivered digest.

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

**The error class is a bounded classifier, and specifying it is load-bearing.**
The whole cooldown guarantee rests on `dedupe_key` carrying an "error class."
`HandlerResult.code` is **optional** on retryable failures, and handlers
interpolate raw provider text (fal, OpenAI, Resend) into `error`. Using that
string would give effectively unique keys per failure — **coalescing would never
fire, so every failure would notify individually**, precisely the behavior David
rejected — and it would persist request-specific, possibly sensitive provider
text into an *indexed* column.

`classifyFailure(row, outcome): AlertErrorClass` returns a value from a closed
enum: `auth`, `rate_limit`, `timeout`, `network`, `provider_5xx`,
`provider_4xx`, `validation`, `unknown`. Resolution order: the handler's typed
`code` when present (already required on terminal failures), else a small set
of matchers over the provider error, else `unknown`. **Nothing else ever reaches
`dedupe_key`** — the raw message lives in `sample_payload`, which is redacted on
schedule (A6). Tests exercise real handler failure shapes from the repo's
existing fixtures, not two synthetic strings, and assert the enum is total.

**Every `dedupe_key` example and test fixture in this plan uses the exact enum
value** — `job_abandoned:email:auth`, never a near-miss like `auth_error`. A
near-miss in prose is not cosmetic: if one producer is written from the example
and another from the enum, the same Resend outage splits into two `active`
incidents and bypasses the coalescing the whole cooldown design rests on.

**A6. Retention for the ledger itself** *(added, Codex round 2)*. Migration 0095
creates a durable table and no phase bounded its growth — every resolved alert
and its `sample_payload` (which carries a recipient and a provider error string)
would be stored forever. Over months, and especially for condition alerts that
resolve and recur, that grows without limit, and it quietly turns an operational
table into a long-lived store of recipient addresses, which is a retention
posture nobody chose.

- `job_alerts` rows in `state = 'resolved'` are purged after
  `job_alert_retention_days` (default 90), cascading to
  `job_alert_dispatches`. Active and unresolved-but-acknowledged rows are never
  purged — an unresolved condition must not vanish because it is old.
- `sample_payload` is redacted in place at `job_alert_sample_redact_days`
  (default 7) — the counts, kind, and timing stay for trend reading; the
  recipient address and raw provider error do not need to outlive triage.
- Purge runs on the same independent runner, under the same advisory-lock
  discipline, with counts logged per the repo's migration/observability rule.
- Indexed on `(state, resolved_at)` so the purge does not degrade as the table
  grows — the mistake would be adding retention without the index and
  rediscovering it as a slow query at month three.

**And the legacy forever-retention is reconciled, not left beside it.**
`emailJobHandler.retainDuringPurge` currently keeps every `async_jobs` row whose
`kind` starts with `admin_abandoned_email_alert`, forever, specifically so the
alert thread survives (`email.ts:257-260`). Once `job_alerts` is the durable
record of *that a failure was alerted on*, that exemption is redundant — it
retains a **delivery** row to preserve **notification history** the ledger now
holds properly. Phase 2 removes `retainDuringPurge` and lets those rows age out
on the normal email retention, with the reasoning recorded in `decisions.md`.
Two mechanisms preserving the same fact is exactly the duplicate-source-of-truth
problem this plan's own *Source-of-Truth Analysis* promises not to create.

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

**B4. Attempts increment on *crash* reclaim, and poison pills die — as one
fenced atomic transition.** `recoverStuckProcessing` becomes lease-expiry-driven,
increments `attempts`, and rotates the token so the old owner's finalize can no
longer apply. Rows whose incremented count reaches their effective max are marked
`failed` with a `job_poison_pill` alert rather than returned to `pending` —
closing finding 7's infinite loop. Because of B3, this counts only genuinely
abnormal terminations.

**Reclaim must not be read-then-write** *(corrected, Codex round 2)*. Every
autoscaled instance runs this sweep. If it reads expired rows and their
effective attempt limits and *then* updates, two instances can both increment
the same crash attempt (burning two of five attempts for one crash) or both
independently conclude the row is a poison pill. Round 1's fix made the
*finalize* path atomic and left the *reclaim* path in exactly the shape the
finalize path was criticised for.

The claim path already solves this and the reclaim path should use the same
primitive rather than inventing a second one. Select the expired rows
`FOR UPDATE SKIP LOCKED` inside the sweep's transaction, and make each row's
transition a **conditional update fenced on the state that was observed**:

```sql
UPDATE async_jobs SET …
WHERE id = $id AND status = 'processing'
  AND lease_token = $observed_token AND lease_expires_at = $observed_expiry
```

A peer that got there first has already rotated the token, so the loser's update
matches zero rows and it skips the row — the identical "zero rows means I lost"
discipline as B1 and B2, which is the point: **one fencing idiom, applied
everywhere a row transitions**, not three mechanisms to keep in sync.

The per-queue effective-max lookup stays outside the row transaction (it is
`admin_config`, cached), but the *decision* it feeds — pending vs. poison-pill —
is evaluated inside the fenced update via the row's own post-increment
`attempts`, so it cannot be made twice from one stale read.

Acceptance: two simultaneous reclaimers against one expired row produce exactly
one attempt increment and one outcome.

**B5. Provider idempotency for email.** `deliverFromOutbox` passes
`idempotencyKey: \`async-job/${row.id}/${row.deliveryGeneration}\`` — stable
across the automatic retries of one row, unique per row, and comfortably inside
Resend's 256-character limit. Retry after a lost response no longer re-sends.

**The generation counter is what makes an admin retry actually send.** An admin
retry means "send it," so it must mint a *different* key — but the existing
`POST /admin/email-queue/:id/retry` route (`routes/admin.ts:3087-3125`) resets
**that same row** to `pending` with `attempts = 0` rather than inserting a new
one, so a key derived from `row.id` alone would be byte-identical to the one
Resend already saw. Inside the 24-hour retention window Resend would replay the
original response and the admin's retry would silently do nothing, with a
`success: true` on screen — the looks-fine-while-broken shape this plan exists
to remove, in the one control an operator reaches for when delivery is already
suspect.

So migration 0096 adds `async_jobs.delivery_generation` (int, default 0) and
that route's existing atomic conditional update increments it in the same
statement that resets the row. Automatic retries leave it untouched, so the
key stays stable exactly where it must; a human retry changes it, so the send
is real. Acceptance asserts both halves against one row: stable across the
retry ladder, different after the admin route runs. See *Risks* for the 24-hour
window this interacts with.

**B6. Deferred-email age alarm.** The unconfigured-email defer path keeps
deferring without burning attempts (correct — a missing key is not the job's
fault), but a `queue_deferred_stale` alert fires once any email row has been
deferred beyond `email_defer_alert_hours` (default 6).

### Part C — The health surface

**C1. `worker_lane_heartbeats`** — one row per **`(instance_id, lane)`**, with
`worker_version`, `last_scheduled_at`, `last_tick_completed_at`,
`in_flight_count`, `last_claim_count`.

**Three stamps, written at three different moments**, because scheduler liveness
and tick completion are different facts:

- **`last_scheduled_at`** — written when the timer *fires*, before any work,
  **including on the `if (ticking) return` early-return**. Pure scheduler
  liveness, unaffected by how long a handler takes.
- **`last_tick_completed_at`** — written when a tick finishes.
- **`in_flight_count`** — how many jobs that instance's lane currently holds, so
  a long tick reads as *working* rather than being inferred from silence.
  **Written when the claim commits, before any handler is awaited**, decremented
  as each job leaves the in-flight set, and cleared on completion or shutdown.
  The write moment is load-bearing, not an implementation detail: a wedged tick
  never completes, so a completion-only write leaves the durable row at its
  previous value — normally zero — and `worker_lane_wedged` requires
  `in_flight_count > 0`. Publishing at claim time is what makes the wedge
  predicate observable in the one case it exists for.

**Keyed by instance, and evaluated with the right quantifier per condition:**

- **`worker_lane_stalled`** — **∀ live instances**, none has scheduled that lane
  within `max(3 × interval, 60s)`. The lane is dead fleet-wide. Keyed off the
  scheduler, so handler duration cannot trigger it.
- **`worker_lane_wedged`** — **∃ a live instance** whose timer is current but
  whose `last_tick_completed_at` is older than the lease **and**
  `in_flight_count > 0` beyond `wedged_lane_alert_minutes` (default 30). A
  genuinely hung handler, needing different remediation than a dead timer.

**`worker_version`** is stamped on every tick, which is what makes the 3b
rollout barrier provable rather than inferred — see the rollout protocol.

**Departed instances are pruned:** a row whose `last_scheduled_at` is older than
`instance_heartbeat_ttl_minutes` (default 15) is excluded from evaluation and
then deleted, so a scaled-down instance does not read as a permanently stalled
lane. Admin-config because the trade-off cuts both ways — prune eagerly and a
briefly-paused instance is forgotten; lazily and a scale-down raises a false
stall.

*(Two rounds of correction produced this shape. Round 1: a single
`last_tick_at` stamped at completion could not distinguish a stopped 5-second
timer from a legitimate 4-minute render, because `asyncJobsTick` does not return
until every claimed handler finishes (`asyncJobs.ts:577-579`) — any threshold
tight enough for the former would have flagged the latter, training the alert
into noise. Round 2: one row **per lane** is worse than imprecise on an
autoscaled fleet — every instance overwrites the same row, so a healthy idle
instance continuously masks a wedged handler on another, and `worker_lane_wedged`
could never fire. Collapsing to one row also destroyed both quantifiers above;
applying either one alone would half-fix it, since `∀` lets a wedged instance
hide behind healthy peers and `∃` raises a false stall whenever one instance is
slow to schedule.)*

Acceptance covers all three states explicitly: a long healthy handler raises
neither alert; a stopped scheduler raises `stalled`; a live scheduler with a
wedged handler raises `wedged` and not `stalled` — plus a wedge on instance A
while B is healthy and idle, and a scale-down that must not raise a false stall.

**C2a. `GET /admin/queue-health/jobs`** — the **per-item** half. Without it the
aggregate endpoint would have to return every row to satisfy the two-altitude
contract, which is unsafe at a 50,000-row backlog — and the aggregate is the
endpoint the page polls continuously. It follows the existing
`/admin/email-queue` shape (`admin.ts:2993`) rather than inventing a second
convention: `?queue=&status=&page=&limit=` with `limit` capped at 100, a `total`
count, and `validStatuses` echoed back — **plus a derived status the raw four
cannot express.**

Copying `/admin/email-queue`'s projection verbatim would quietly break the
contract this page exists to satisfy. That projection exposes only
`pending | processing | done | failed` and **omits `async_jobs.result`** — but in
this repo an inactive `fact_ai_meme_backfill` finishes as `status = 'done'` with
`result = { skipped: true, reason: 'not_active' }`, and its never-retried failure
is just `failed` after `maxAttempts: 1`. Both would render as a generic success
and a generic failure, so "skipped" and "never retried" — the two states
`async-ui-status.md` names as first-class and explicitly forbids collapsing —
would be unreachable from the response no matter what the frontend did.

So C2a returns a **derived** `displayStatus` alongside the raw one:
`skipped` (terminal-ok with a skip result) and `abandoned_no_retry` (failed with
an effective max of 1) are distinct values, with a **sanitized** `skipReason`
drawn from a known set rather than passed through raw. Acceptance covers both a
handler-level skip and a first-attempt abandonment, **at both altitudes** — the
aggregate tally and the per-row detail — since a derived status that is right in
one and wrong in the other is the failure mode.

It exposes **all four statuses**, not just failures: a per-item view limited to
failing rows would leave `pending` and `processing` items with no per-item
status at all, in direct violation of the contract it claims to satisfy.
Acceptance seeds a large backlog and asserts bounded response size and query
time.

**C2. `GET /admin/queue-health`** — per queue: pending / processing / failed /
done-24h, oldest-pending age, abandoned-24h, **plus the derived tallies C2a
defines** (`skipped`, `abandoned_no_retry`), so the two altitudes agree; per
lane: last-tick age and configured interval. Read-only aggregation over
`async_jobs` + `worker_lane_heartbeats`; it stores nothing.

**Its shape is staged across two phases, because the alert ledger does not exist
in Phase 1.** `job_alerts` arrives with migration 0095 in Phase 2, while this
endpoint and its page ship in Phase 1 — so a Phase 1 response that included
alert fields could not be built, and the phase would not be independently
runnable:

- **Phase 1 response:** queue tallies (raw and derived), lane liveness, and
  nothing else. No alert fields at all — not an empty array, which would read as
  "no alerts" rather than "alerts do not exist yet."
- **Phase 2 extends it** with `unacknowledgedAlerts`, in the same PR that
  creates the table.

Acceptance covers **each phase's response separately**: Phase 1 asserts the
endpoint is complete and correct without any alert key present; Phase 2 asserts
the added key against a seeded mix of acknowledged and unacknowledged alerts.

**C3. `/admin/queue-health` page**, following `async-ui-status.md`'s two
altitudes: an **aggregate** row per queue ("`enrichment` — 4 pending · 1
working · 2 failed · 1 skipped · oldest 6m"), and **per-item** detail on expand
— **every paginated row C2a returns, in all four raw statuses and both derived
ones**, with `lastError`, `attempts`, `nextAttemptAt`. Expansion limited to
failing rows would drop `pending`, `processing`, and skipped items from the
per-item altitude entirely. `fact_ai_meme_backfill`'s never-retried rows render
as `abandoned_no_retry` and a handler-level skip as `skipped` — distinct
terminal states, never a generic failure or a checkmark, per the rule that
"skipped" and "still running" are first-class. Frontend tests assert a skip and
a no-retry abandonment **at both altitudes**: counted in the queue's aggregate
row and rendered with their own state on expansion. Polls on a steady cadence;
imposes no timeout.

**C4. `AdminLayout` banner** while any unacknowledged `critical` alert exists,
linking to the page. Acknowledging is an explicit admin action, so a real
failure cannot be cleared by a page reload.

**C5. `GET /health/queues`** — unauthenticated, no payload detail, returning
non-200 when a lane is stalled **fleet-wide**. It applies C1's live-instance
filter and quantifier verbatim: departed and TTL-expired instances are excluded
first, then a lane counts as unhealthy only when **no live instance** has
scheduled it inside the threshold. "Any stale heartbeat" would be wrong on the
deployment this plan is written for — one instance pausing or scaling down while
another keeps scheduling the lane is normal autoscale behavior, and reporting it
as an outage to an external monitor manufactures pages for a healthy fleet.
Acceptance runs one stale instance alongside one healthy instance and asserts
200. **This is the only design in the
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
- dispatch, condition evaluation, and the ledger purge run on the **independent
  alert runner** (A3), so their demand is counted as that runner's own — they
  cannot be folded into the bulk maintenance slot, which is exactly what A3
  exists to escape;
- **Phase 1 sets an explicit `max`, derived from the fleet's budget — and
  cannot ship without it.** Each autoscaled instance constructs its **own**
  `pg.Pool` (`lib/db/src/index.ts:45`), so the fleet ceiling is `max × N`, not
  `max`; reasoning about "the pool" as a single pool is what made an earlier
  draft's hard-coded 20 look safe when it quietly doubled the fleet ceiling
  from `10N` to `20N` with nothing checking what the database allows.
  `deferred-work.md` classifies this as an infra/cost decision precisely
  because no repository value establishes what is safe. Phase 1 therefore
  **records the production Postgres connection limit and the autoscale
  maximum-instance setting, then derives**
  `per_instance_max = floor(db_budget / max_instances)`. There is **no floor at
  today's value**: if the derivation lands under 10, then 10 was already
  over-subscribed and preserving it preserves the over-subscription. If the
  arithmetic does not close, the answer is a shared pooler or lower per-lane
  concurrency, not a larger number. **Those two production numbers are the one
  thing in this plan I cannot obtain from the repository; they gate Phase 1 and
  are listed under *Questions for David*.**

## Data Model and Migration Impact

Four hand-authored, idempotent migrations, one per phase, following the
broken-generator convention (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
EXISTS`, `CREATE INDEX IF NOT EXISTS`) plus `SNAPSHOT_EXEMPT_TAGS` and a
`_journal.json` entry each. Next free index is **0094**.

- **0094** (Phase 1) — `worker_lane_heartbeats`, primary key
  `(instance_id, lane)`, with `worker_version`; index on `last_scheduled_at` for
  the prune sweep. Seed `instance_heartbeat_ttl_minutes` (15).
- **0095** (Phase 2) — `job_alerts` (with `state` / `resolved_at` /
  `escalation_tier` / `acknowledged_tier`) + its partial
  unique index on `(dedupe_key) WHERE state = 'active'`, plus the
  `job_alert_dispatches` child table keyed `(alert_id, channel)` — carrying
  `dispatched_count`, `dispatched_tier`, `last_dispatched_at` — and an index on
  `(state, resolved_at)` for the retention purge. Seed the `admin_config` rows:
  `email_admin_abandoned_alerts_enabled` (value `false`, finally present so the
  UI can toggle it), `alert_cooldown_minutes` (30),
  `alert_escalation_multiplier` (10), `alert_webhook_format` (`raw`),
  `email_defer_alert_hours` (6), `queue_backlog_alert_minutes` (30),
  `condition_escalation_hours` (4), `alert_webhook_timeout_ms` (5000),
  `wedged_lane_alert_minutes` (30), `job_alert_retention_days` (90),
  `job_alert_sample_redact_days` (7).
- **0096** (Phase 3) — `async_jobs.delivery_generation` (int, not null,
  default 0 — the value that lets an admin retry mint a *different* provider
  idempotency key on the same row; see B5), plus
  `async_jobs.lease_token`, `async_jobs.lease_expires_at`,
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
| `processing`, actually stranded pre-migration | NULL lease | **Not reclaimed during 3a** — the rollout protocol below disables *all* reclaim for the overlap, so a genuinely stranded row waits, visibly, until 3b is enabled. |
| `done` / `failed` (terminal) | NULL lease, untouched | Yes — never re-claimed. |
| Row inserted *during* the migration | NULL lease | Yes — same as legacy pending. |

Purely additive; no backfill rewrites existing data. **Observability:** each
migration reports affected counts per the repo's migration-observability rule.

### Mixed-version rollout protocol for 0096 (lease columns)

**The hazard.** Any pre-lease (Phase-2-era) worker finalizes by id and cannot
see the fence. If such a worker owns a row and anything else reclaims that row,
the old worker's later finalize silently overwrites the new run — the exact
clobber this whole design exists to prevent, caused by deploying the fix.

**Two properties constrain every possible protocol, and both are easy to get
wrong:**

1. **Any reclaim during the overlap is a clobber source — the lease length is
   irrelevant.** It is tempting to say an old worker coexisting with 3a is
   harmless "because nothing is reclaiming on a short lease yet." It is not:
   legacy `updatedAt` recovery requeues a slow row owned by a Phase-2 worker
   after its cutoff, 3a claims it with a token, and the old worker then
   finalizes by id over the new run. The reclaim did not need to be
   *short*-lease to cause the damage; it only needed to happen.
2. **TTL absence is not termination.** "No pre-lease `worker_version` seen
   within the 15-minute TTL" is not proof every old writer has exited: a wedged
   instance — event loop blocked, handler hung — stops heartbeating while
   remaining perfectly capable of finalizing when it recovers. **That is the
   precise failure class this plan exists to survive**, so using its own symptom
   as the all-clear is circular. The same objection sinks every other in-app
   proxy (a row snapshot, a quiet period): there is no signal from inside the
   application that a silent process is gone.

**The protocol, accepting that limit rather than working around it:**

1. **3a disables reclaim entirely** — not legacy, not lease. It writes lease
   tokens on claim, fences every finalize, and renews heartbeats, but **nothing
   reclaims a row while unfenced workers may exist.** A genuinely stuck row
   simply waits for the duration of the overlap, which is a bounded and visible
   cost (the Phase 1 health surface shows it) and strictly better than a
   silent double-execution.
2. **Graceful shutdown ships in 3a**, so the overlap ends promptly under normal
   deploys.
3. **Enabling 3b is an explicit operator action, not an inference.** A deploy
   flag or admin toggle, taken after confirming in the Replit deployment console
   that the previous revision has **zero** running instances. The plan states
   plainly that this is human-verified, because the application cannot prove it
   and every automated proxy tried so far has been wrong in the same direction.
4. **The version check survives as an interlock that can only *block*, never
   *enable*.** If the operator enables 3b while a pre-lease `worker_version` is
   still visible, the worker refuses and logs. It cannot say "safe"; it can say
   "definitely not safe," and that asymmetry is the only sound use of it.

**Cost, stated for David rather than buried:** this adds one manual step to one
deploy. That is the price of not pretending a distributed drain is observable
from inside the process that needs it.

**Rollback:** 3b → 3a is safe (3a honors the fence and reclaims nothing).
**Rolling back past 3a while leased rows are processing is the unsafe
direction** — drain first.

**Acceptance** now tests the version *interlock* (a pre-lease `worker_version`
heartbeating with zero jobs in flight blocks enabling) and the 3a **no-reclaim**
property (a row stuck during the overlap is not requeued by any path), replacing
the superseded NULL-row predicate test.

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
`job_abandoned:email:auth`, and dispatched **over the webhook** — the
channel that does not depend on Resend. This is the exact scenario that is
silent today.

**A lane's timer stops on every live instance.** Its heartbeats go stale
fleet-wide; `worker_lane_stalled` is recorded and dispatched, the banner
appears, and `/health/queues` returns non-200 for an external monitor. (One
instance going quiet while another still schedules the lane is *not* this case
and raises nothing — see C5.)

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
out in words, not only by color.

**Failure states are specified, not left to the implementer** *(added, Codex
round 4)*. The round-3 UX defined loading and healthy-empty and said nothing
about a failed request — leaving two silent-wrong renderings available: showing
"all queues healthy" when the request **errored** (indistinguishable from
genuine health, on the page whose entire job is to reveal problems), and leaving
stale counts on screen after a poll fails. Both are the looks-fine-while-broken
shape this plan exists to eliminate, reintroduced in the UI. So:
- **Initial load failure** renders an explicit error state with a retry action —
  never the empty/healthy view.
- **Poll failure after data is shown** keeps the last-known data, visibly marked
  stale with the time of the last successful fetch, and keeps retrying. Stale
  data is useful; stale data presented as current is not.
- Neither path imposes a timeout on a legitimately long job — the no-timeout
  rule governs *job* duration, not request failure, and conflating them would
  reintroduce the very thing that rule forbids.

Frontend tests cover initial failure and mid-session poll failure. `/admin/email-queue` is left exactly as it is —
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
- **Webhook egress is specified concretely and tested, not asserted** *(Codex
  round 3)*. Round 2 listed redirect refusal, timeouts, and size caps as
  security requirements and then neither implemented nor tested them — and
  **`fetch` follows redirects by default**, so a 3xx from the configured
  endpoint would forward the digest to a host nobody configured. Concretely:
  `redirect: "manual"` (a 3xx is a delivery *failure*, not a hop),
  `AbortSignal.timeout(alert_webhook_timeout_ms)` (default 5s), a response-body
  read capped at 8 KB and otherwise discarded, and no retry inside the tick —
  the watermark not advancing *is* the retry. Tests use a redirecting server, a
  stalled response, and an oversized response, and assert the credential-bearing
  URL never appears in `job_alert_dispatches.last_error` or in any log line.
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
- **Mixed-version overlap:** a 3a-era worker (fence-honoring, **reclaim
  disabled**) and a 3b-era worker (lease reclaim) against the same table produce
  no double-finalize.
- **Enablement is operator-driven and the interlock only blocks:** reclaim stays
  off with no operator action even when *no* pre-lease `worker_version` is
  visible (absence is not an enable signal), and an operator enable **is
  refused** while a pre-lease version is visible. Both directions, because a
  test of the refusal alone would still pass against the superseded design that
  enabled on TTL absence.
- **The accepted duplicate-execution window is asserted, not assumed** — a
  handler stalled past its lease is reclaimed and does run twice; only one run
  writes. This encodes settled decision 3 as a test rather than leaving it as
  prose.

**Multi-instance** — the round-2 class. Every one of these runs **two runners
against one database**, because a single-runner test cannot fail in the way that
matters:

- **Two dispatchers, one delivered digest** — the advisory lock is held across
  the send, so the peer skips rather than double-notifying.
- **Two reclaimers, one expired row** → exactly one attempt increment and one
  outcome; the loser's fenced update matches zero rows.
- **Two condition evaluators** → one `active` alert, not two.
- **Heartbeats do not mask each other:** a wedged handler on instance A raises
  `worker_lane_wedged` while instance B is healthy and idle — the exact case a
  lane-keyed table silently swallowed.
- **Scale-down does not raise a false `worker_lane_stalled`:** an instance stops
  heartbeating, its row is pruned at TTL, the lane stays healthy because a live
  instance still schedules it.
- **The 3b barrier holds against an idle old instance** — a pre-lease
  `worker_version` heartbeating with zero jobs still blocks enabling reclaim,
  which is the case the round-1 row-predicate gate passed by mistake.

**Alert lifecycle:**

- Acknowledging a **condition** alert whose condition is still true does **not**
  re-fire it on the next evaluator tick, and does not restore the banner.
- The same condition, once resolved and later recurring, **does** open a fresh
  alert — acknowledgement must not permanently deafen the alarm.
- **Each declared alert kind is actually produced** — but split by shape and by
  phase, because one parameterized test over the whole registry **cannot pass in
  Phase 2** *(corrected, Codex round 4)*. `job_poison_pill`'s producer is B4,
  which does not land until Phase 3b; and the three event kinds cannot be
  "driven true and then cleared" at all, since an event is not a condition. So:
  - a **registry exhaustiveness check** in every phase — every kind has a
    declared producer and a declared shape (the part that must never drift
    again);
  - **event-producer tests** per phase, for the kinds whose producer has landed:
    `job_abandoned` and `job_terminal_failed` in Phase 2, `job_poison_pill`
    added in 3b;
  - **condition open/clear tests** for the four condition kinds in Phase 2,
    where driving the condition true and then false is meaningful.
- Retention purges resolved alerts and redacts `sample_payload` on schedule,
  and leaves active/unresolved-acknowledged rows alone regardless of age.
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
- **Condition escalation, all three counters:** an acknowledged, still-true
  condition crosses `condition_escalation_hours` → exactly **one** notification
  per channel and one banner reactivation (`escalation_tier > acknowledged_tier`
  becomes true once); **zero** dispatches on every tick between boundaries; and
  a boundary crossed while the email channel is failing advances neither of that
  channel's counters and redispatches it once it recovers, without re-notifying
  the webhook.
- **The dispatcher is not blocked by a hung handler** — block a `bulk` handler
  indefinitely, record an alert from another lane, and assert the webhook
  dispatch still happens on cadence. This is the regression test for the
  scheduling defect Codex found in round 1.
- A webhook dispatch failure does not create an alert that dispatches over the
  webhook (no feedback loop).

**Email:**

- `idempotencyKey` is passed and is stable across the **automatic** retries of
  one row, and **differs** after an admin retry — asserted against the real
  `POST /admin/email-queue/:id/retry` route, which must increment
  `delivery_generation` on the same row. A test that only checks two different
  row ids would pass against the broken design.
- The dev fallback still delivers nothing and throws nothing.

**Health surface:**

- Route auth (added to the existing admin-auth table test).
- Aggregation correctness against a seeded mix of queue states.
- `/health/queues` applies the **fleet-wide** quantifier, not "any stale
  heartbeat": one stale instance alongside one healthy instance still scheduling
  the lane returns **200**; only a lane no live instance is scheduling returns
  non-200. It leaks no queue detail in either state.
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
1. Migration 0094: `worker_lane_heartbeats`, keyed `(instance_id, lane)`, with
   `worker_version`.
1a. **Record the production Postgres connection limit and the autoscale
   max-instance setting** (the two numbers under *Questions for David*), then
   derive the per-instance pool `max` from them. Do **not** hard-code a value.
2. Stamp `last_scheduled_at` when the timer fires (including on the re-entrancy
   early-return); **publish `in_flight_count` as soon as the claim commits,
   before any handler is awaited**, decrement it as each job leaves the
   in-flight set, and clear it on completion or shutdown; stamp
   `last_tick_completed_at` at completion; prune rows past the instance TTL.
   *(The claim-time publication is not a detail: a wedged tick never reaches
   completion, so a completion-only write leaves the durable count at zero and
   `worker_lane_wedged`'s `in_flight_count > 0` predicate can never be satisfied
   by the case it exists for.)*
3. Apply the derived pool `max`; record the fleet arithmetic (`max × N`) in
   `deferred-work.md` and close that item.
4. `GET /admin/queue-health` (aggregating **across live instances**, with the
   ∀/∃ quantifiers per condition) + `GET /health/queues` (same live-instance
   filter and fleet-wide quantifier — not "any stale heartbeat"). The Phase 1
   response carries **no alert fields at all**: `job_alerts` does not exist
   until migration 0095 in Phase 2, so including them here — even as an empty
   array — would be unbuildable or a lie. Phase 2 step 11a adds them.
4a. **`GET /admin/queue-health/jobs` (C2a) — in Phase 1, before the page.** The
   aggregate deliberately cannot carry a large backlog, so without the paginated
   per-item endpoint the page cannot deliver its per-item altitude and Phase 1
   is not independently shippable against its own definition of done. Includes
   the bounded pagination contract, all four statuses, the derived
   skipped/never-retried status, and its API tests.
5. The Queue Health page + nav item, per the two-altitude contract.

**Phase 2 — Alerts (closes the headline finding).**
6. Migration 0095: `job_alerts` + `job_alert_dispatches` + seeded config rows.
7. Record alerts inside the finalize transaction, for all queues and both
   terminal paths.
7a. **`evaluateAlertConditions()`** — the producer sweep for the four
   condition-shaped kinds, opening `active` alerts and **resolving** them when
   the condition clears. Without this step the condition alerts have no sensor.
   **This includes B6, the deferred-email age alarm** (`queue_deferred_stale`).
   It is one of the four condition kinds, so Phase 2's own acceptance requires
   its open/clear test; an earlier draft listed it as a separate Phase 3a step,
   which would have left the Phase 2 criterion unimplementable *and* made the
   3a step duplicate shipped work. It needs nothing from Phase 3 — the defer
   path it observes already exists on `main`.
8. `createAlertDispatchRunner()` — its **own** timer and re-entrancy guard, not
   the bulk maintenance block: grouping, cooldown, escalation, per-channel
   watermark advancement.
8a. **`pg_try_advisory_xact_lock` per *channel*, acquired before selection and
   held across the whole build-and-send**, plus one sweep-wide lock for the
   condition evaluator, which also reads its thresholds uncached inside that
   lock. This is what
   makes 7a and 8 safe on an autoscaled fleet; a post-hoc conditional update is
   not a substitute.
9. Webhook channel + format shaping + redaction.
10. Route the existing abandoned-email alert through the dispatcher, and
   **remove `emailJobHandler.retainDuringPurge`** — the ledger now holds that
   history properly (A6).
10a. Retention purge for `job_alerts` + `sample_payload` redaction.
11. Banner + acknowledge action, with acknowledgement suppressing notification
   without resolving a still-true condition. Acknowledging stamps
   `acknowledged_tier` alongside `acknowledged_at`, so a later escalation
   boundary reactivates the banner without any write that undoes the
   acknowledgement itself.
11a. **Extend `GET /admin/queue-health` with `unacknowledgedAlerts`** — the
   field Phase 1 deliberately omitted, added in the same phase that creates the
   table it reads. Phase 1's response test is updated here rather than being
   left asserting an absence that is no longer true.

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
    independent runner **and disable it for the duration of 3a** — no legacy
    `updatedAt` reclaim, no lease reclaim, on either the startup or the periodic
    path. *(Corrected, Codex round 4: an earlier revision of this step kept
    legacy recovery running, which contradicts the rollout protocol above and
    recreates the clobber — a Phase-2 worker's slow row exceeds the cutoff, 3a
    requeues and re-claims it, the old worker finalizes by id over the new run.
    The reclaim never needed to be short-lease to cause that.)*
17. Resend idempotency key — `async-job/${row.id}/${row.deliveryGeneration}`,
    **plus the one-line change to `POST /admin/email-queue/:id/retry`** that
    increments `delivery_generation` in its existing atomic conditional update.
    Without that half the key never changes and an admin retry is a no-op
    inside Resend's 24-hour window.
17a. **Audit the remaining handlers for replayed external side effects** and
    record the result in the plan's per-queue table — `image_generation` and
    `image_prompt_generation` first, since `email` and `fact_ai_meme_backfill`
    are already characterised. Any handler found to replay a paid or
    user-visible call gets provider-level or domain-level idempotency in this
    step, not later.

*(The deferred-email age alarm (B6) is **not** here — it is one of Phase 2's
four condition producers, step 7a.)*

**Phase 3b — Enable lease-driven reclaim (only once no pre-lease worker
remains).**
19. **Operator-enabled reclaim, with a block-only interlock.** Lease reclaim is
    switched on by an **explicit operator action** — a deploy flag or admin
    toggle — taken after confirming in the Replit deployment console that the
    previous revision has zero running instances. The `worker_version` check
    runs at enable time and can only **refuse**: if a pre-lease version is still
    visible the worker declines and logs. It never enables anything on its own.
    Absence of a recent pre-lease heartbeat is **not** the enable condition —
    that is the TTL inference the rollout protocol proves unsafe, since a wedged
    instance stops heartbeating while remaining able to finalize. Depends on
    Phase 1's per-instance heartbeats for the interlock — a cross-phase
    dependency, stated so 3b cannot ship without it.
20. Lease-expiry reclaim as a **fenced atomic transition** (`SKIP LOCKED` +
    conditional update on the observed `(status, lease_token, lease_expires_at)`),
    with attempt increment, token rotation, and poison-pill termination; legacy
    `updatedAt` fallback retained for one retention window.

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

### Step 23's call-site inventory (Codex rounds 1 and 2)

Codex is right that making the helper transaction-capable does not by itself
close finding 9, and that my step-21 scope — "`sendEmail` and the two
status-writing enqueue sites" — was too narrow.

**Round 2 correction: my round-1 fix enumerated only the *email* callers**, and
then claimed to be "every enqueue caller." Email is one queue of eleven; the
`enqueueJob` surface is the actual scope, and I substituted the part I had
already been looking at for the whole. That is the same error shape as the
`onAbandon` inventory in round 1 — a partial enumeration presented as complete —
which is now twice in this plan, so the enumeration below is exhaustive and
mechanically derived rather than sampled.

**Layer 1 — direct `enqueueJob` callers: 17 sites across 14 files.**

*The way I kept getting this count wrong is the useful part.* Round 1:
enumerated only the two deferred-work helpers. Round 2: enumerated only
`sendEmail` callers and labelled it complete. Round 3: Codex found
`routes/memes.ts:1889`, which my `grep "enqueueJob("` could not see because that
module imports it **aliased** — `import { enqueueJob as enqueueJob_v2 }`
(`memes.ts:1672`) — so the call site reads `enqueueJob_v2({`. Three incomplete
enumerations, three different causes: truncated output, wrong scope, aliased
import. The list below is derived from **imports** rather than call-text, which
is the only method an alias cannot defeat, and the same method now governs the
parameterized tests.

Every site is classified **now**, in the plan — "classify as you go" is how the
sites nobody thought about stay unclassified:

| File | Sites | Preceding domain write | Bucket |
|---|---|---|---|
| `lib/imagePromptAttempts.ts` | `:134` | inserts attempt row, `.returning()` | **atomic-required** |
| `routes/memes.ts` | `:1889` | inserts `image_prompt_attempts_v2` row, `.returning()` | **atomic-required** |
| `lib/imagePromptJobs.ts` | `:290` | updates the attempt row, then chains `image_generation` | **atomic-required** |
| `routes/admin.ts` | `:1409` | sets `facts.enrichmentStatus = 'pending'` | **atomic-required** |
| `lib/firstTimeStagingPrep.ts` | `:91` | sets `enrichmentStatus = 'pending'` | **atomic-required** — and its own comment describes hand-rolled compensation for exactly this ("surface `failed` … instead of a permanent fake-pending"), which the transaction lets us delete |
| `lib/visualConceptJobs.ts` | `:92` | sets `visualConceptStatus = 'pending'` | **atomic-required** |
| `lib/factPexelsJobs.ts` | `:110` | status marker | **atomic-required** (named in the deferred-work item) |
| `lib/aiMemeBackfillJobs.ts` | `:98` | status marker | **atomic-required** (the other deferred-work item) |
| `lib/sendBackToReview.ts` | `:183` | candidate-version write | **atomic-required** |
| `lib/moderationStaging.ts` | `:359` | staging transition | **atomic-required** |
| `lib/reviewRenderScenarios.ts` | `:647` | called from the enrichment transition | **atomic-required** |
| `routes/adminTaxonomyHealth.ts` | `:404`, `:500`, `:566` | none — per-fact loop over `targets.toEnqueue`, each failure counted into `outcomes`/`failed` and reported per item | **best-effort by design** — already surfaces per-item enqueue failure to the admin, which is the two-altitude contract working; wrapping the loop in one transaction would make one bad fact roll back the whole bulk action |
| `lib/reviewRenderScenarios.ts` | `:665` | the force path, deliberately keyless; guarded by an atomic compare-and-set at the call site | **best-effort by design** — the docstring's concurrency argument is the guard, and adding a transaction here would not improve it |
| `lib/factSendBackJob.ts` | `:101` | inside a handler; chains the next queue | **already-terminal** — an enqueue failure returns `ok:false` and the outer job retries, which is the correct compensation and needs no transaction |
| `lib/email.ts` | `:156` | the `sendEmail` funnel | see layer 2 |

**Layer 2 — `sendEmail` callers: 16 sites across 9 files**, all funnelling
through `email.ts:156`. Final buckets, not candidates:

| Site | Bucket | Why |
|---|---|---|
| `routes/users.ts` (email-change verification) | **atomic-required** | token row + `pendingEmail` + mail are three writes with no transaction (`:342-360`); any gap leaves a token with no mail or a pending state with no token |
| `routes/localAuth.ts` (signup verification, password reset) | **atomic-required** | the same shape — a reset token with no mail is an account the user cannot recover |
| `lib/moderation/ncmec.ts` | **atomic-required** | a reporting obligation; a report recorded but not sent is the worst possible divergence on this path |
| `lib/adminNotify.ts` (fact review, dispute, fraud warning, abandoned-email) | **best-effort by design** | each describes an event that already happened. A missed one is a nuisance, and wrapping it would put a mail enqueue inside a moderation or webhook transaction for no correctness gain. **Recorded explicitly so a later reader does not "fix" it.** |
| `lib/webhookHandlers.ts` (membership/billing notifications) | **best-effort by design** | the grant is the contract; the email is a courtesy, and the Stripe handler transaction must not be lengthened by a mail enqueue |
| `lib/userNotify.ts`, `routes/reviews.ts` (approve/reject) | **best-effort by design** | the moderation decision is authoritative and already durable; the notification follows it |
| `routes/share.ts` | **best-effort by design** | user-initiated share invite; failure is visible to the sender in-request |
| `jobs/factOfTheDay.ts` | **already-terminal** | the enqueue *is* the job's output |

**The classification happens in the plan, before implementation — not during
it.** Codex's round-2 point stands: deferring it to build time is what leaves
finding 1.6 open, because "classify as you go" is how the two sites nobody
thought about stay unclassified. **Both layers** get classified into one of three
buckets:

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
| **Resend's idempotency keys expire after 24 hours** (verified below), while the retry ladder spans ~10.6h — inside the window, but a raised `maxAttempts` or a much later manual retry falls outside it, and a duplicate becomes possible again. | Documented in code at the call site. An admin retry mints a genuinely different key by incrementing `delivery_generation` (B5) — not by relying on the row id, which the retry route does not change. A `maxAttempts` raise past the window is called out in `known-failure-patterns.md`. |
| **Cooldown folding hides a distinct failure** (David's accepted trade-off, decision 4). | Narrowed two ways without reopening the decision: `dedupe_key` includes queue + error class so genuinely different failures never fold together, and the escalation multiplier forces an immediate dispatch when volume jumps by an order of magnitude. |
| **Total process death cannot be self-detected.** | Stated plainly rather than designed around; `/health/queues` exists so an external monitor can close it. This is the one gap the plan does not claim to fix internally. |
| **Alert fatigue turning the banner into wallpaper.** | Only `critical` raises the banner, and severity is a **static property of the alert kind** in `ALERT_KINDS` — there is no per-queue severity override, and an earlier draft's claim that one existed pointed at a mechanism no step builds. The real noise controls are the ones the plan does specify: error-class-scoped `dedupe_key`s so unrelated failures never share a digest, `alert_cooldown_minutes`, and explicit recorded acknowledgement. If a specific queue proves chatty in practice, the fix is its dedupe key or its threshold, both already admin-config. |
| **Pool exhaustion from the new steady-state queries.** | Heartbeat renewal is one batched statement per lane per interval. Dispatch, condition evaluation, and the alert-ledger purge all run on the **independent alert runner** (A3) — *not* the bulk maintenance slot, which sits behind an awaited lane tick and would reintroduce the headline failure — so the pool arithmetic counts that runner's own concurrent demand. Phase 1 sets `max` to the derived fleet-safe value. |
| **Four phases is a long runway before the headline finding closes.** | Phase 2 closes it, and Phase 1 is deliberately small. If David wants alerts sooner, Phases 1 and 2 can merge into one PR — the ordering rationale is about Phase 3, not about splitting 1 from 2. |
| ~~**`onConflictDoNothing` against a partial unique index may not be expressible in drizzle 0.45.2.**~~ | **Resolved, Codex round 1** — the API is `onConflictDoNothing({ target, where })` and it emits the predicate in the index-predicate position. Verified in the installed source. No `SAVEPOINT` fallback needed; re-confirm against 0.45.2 during the build, since the reading was taken from the sandbox's 0.45.1. |
| **Mixed-version deploys defeat fencing** — an old worker finalizes by id and cannot see the fence. | Phase 3 splits into 3a (fence-honoring, **all reclaim disabled** — safe alongside old workers because nothing requeues their rows) and 3b (lease reclaim, enabled by an explicit operator action after confirming zero old instances, with the `worker_version` check as a block-never-enable interlock). Graceful shutdown ships in 3a so the window is short. Rolling back past 3a with leased rows in flight is the unsafe direction. |
| **A stale owner's heartbeat could extend the new owner's lease**, postponing recovery indefinitely. | Renewal is fenced on `(id, token, status)` pairs exactly like finalize; a zero-row renewal is the signal to drop the job from the lane's in-flight set. Tested directly. |
| **The alert dispatcher could be starved by a hung handler.** | It runs on an independent timer with its own re-entrancy guard, never behind an awaited `asyncJobsTick`. `recoverStuckProcessing` moves off the same blocked position in 3a. Regression-tested by blocking a bulk handler and asserting dispatch still fires. |
| **Alerting continues after the first digest but is never re-dispatched.** | Per-channel `job_alert_dispatches` rows make pending-ness a quantity rather than a boolean; the dispatcher selects on `occurrence_count > dispatched_count`, independently per channel. |
| **The deployment is autoscaled, so every mechanism here runs N times concurrently** — the assumption that broke most of round 2. | A stated governing rule (correctness proven by the database, never by a process-local guard) plus five specific fixes: advisory-locked dispatch, `(instance_id, lane)` heartbeats, fenced atomic reclaim, version-based 3b barrier, per-channel watermarks. Every one is tested with two runners. |
| **Autoscale makes finding 6 a live defect, not a latent one** — boot recovery reclaims another instance's in-flight row on every scale-up. | Raised with David separately as a possible hoisted fix ahead of the phased plan; within the plan it is closed by 3a's fencing, which is why 3a is deliberately deployable alongside old workers. |
| **Condition alerts could re-fire immediately after acknowledgement**, making the banner permanent and the button useless. | Edge-triggered lifecycle with explicit `resolved` state; acknowledgement suppresses notification without resolving, and re-alerts only after recovery or the escalation boundary. |
| **The ledger grows without bound and quietly retains recipient addresses.** | Resolved-alert purge at 90 days (indexed on `(state, resolved_at)`), `sample_payload` redaction at 7 days, and the redundant legacy `retainDuringPurge` exemption removed rather than left running beside it. |

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
- **Key limit:** up to 256 characters. Our
  `async-job/${row.id}/${row.deliveryGeneration}` is ~17.
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

**Two production numbers I cannot obtain from the repository, and they gate
Phase 1.** Phase 1 sets the connection-pool `max`, and because each autoscaled
instance builds its own pool, the real ceiling is `max × N`. Hard-coding a value
would be guessing with the database's connection budget:

1. **The production Postgres `max_connections`** (or the Neon plan's connection
   limit), and how much of it is already spoken for.
2. **The autoscale maximum-instance setting** for the deployment.

With those, `per_instance_max = floor(budget / max_instances)`.

**Why this blocks rather than defers.** Phase 1 **adds** steady-state database
work (heartbeats, the dispatch runner, health queries) to a pool this plan
describes as having *zero* spare capacity. Shipping that at an unchanged ceiling
does not preserve the status quo — it consumes headroom that is already gone.
Nor does flooring the derivation at today's effective 10 rescue it: if
`floor(budget / max_instances) < 10`, then 10 was already over-subscribed and
the floor merely preserves the over-subscription.

So Phase 1 does not ship until either (a) the two numbers are known and the
arithmetic closes — **total configured connections plus reserved headroom for
admin and reader traffic fit inside the production limit** — or (b) we adopt the
documented alternative: a shared pooler, or lowering the per-lane concurrency
bounds so the fleet's worst case fits. Acceptance is the arithmetic itself,
written down, not a value chosen because it looked reasonable.

**Nothing else is outstanding.** The four product decisions were settled in the
pre-plan conversation and are recorded under *Settled Decisions*. Two things I
decided from the repository rather than asking — the phase ordering, and setting
the pool `max` explicitly at all — are recorded there too, with their reasoning,
so they can be overridden in one line if David disagrees.

One item that is a *notification*, not a question: Phase 1 **sets** the
connection pool's `max` to the derived fleet-safe value, which `deferred-work.md`
had parked as "an infra/cost decision, not a code change to make proactively."
Its stated revisit trigger has arrived — this plan is the thing that was being
waited on. Note the direction is *derived, not assumed*: `floor(budget /
max_instances)` may land **below** today's effective 10, and in that case the
plan applies the lower value rather than protecting the current ceiling — an
over-subscribed fleet is the problem, not the baseline. Acceptance includes that
case explicitly: given a budget and instance count that derive a max under 10,
the configured value is the derived one and the fleet arithmetic still closes.

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
