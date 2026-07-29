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
4. **Nine of eleven queues never alert at all.** `onAbandon` is implemented only
   by `email` (`email.ts:239`) and `fact_pexels` (`factPexelsJobs.ts:215`).
   `enrichment`, `image_prompt`, `image_generation`, `fact_visual_concepts`,
   `review_render_prep`, `projection_repair`, `fact_send_back`,
   `fact_enrichment_backfill` and `fact_ai_meme_backfill` exhaust their retries
   in silence.
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
   result. For `email` that is a duplicate send to a real person. For
   `fact_ai_meme_backfill` it is a duplicate paid OpenAI call on a queue
   deliberately built never to retry for exactly that reason. Boot recovery uses
   a 5-minute cutoff (`asyncJobs.ts:843`, default arg `cutoffMinutes = 5`), so a
   restart during any slow job does the same thing with half the margin.
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
- **A job is not run twice by accident**, and a job that kills its worker
  eventually dies and reports rather than looping forever.
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
6. **The alert dispatcher is a sweeper, not a queued job.** Making alert
   delivery an `async_jobs` row would make the alarm depend on the queue it is
   alarming about — the exact defect as finding 2, one level up. It runs in the
   existing maintenance runner and reads `job_alerts` directly.
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
- `artifacts/api-server/src/lib/factPexelsJobs.ts`,
  `aiMemeBackfillJobs.ts` — the only two queues with an `onAbandon`, and the two
  enqueue sites named in the deferred-work item.
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
| `occurrence_count` | incremented on repeat |
| `notified_at` / `notified_channels` | null until dispatched — **this is the durability fix for finding 3** |
| `acknowledged_at` / `acknowledged_by` | admin ack from the health page |

A partial unique index on `(dedupe_key)` where `acknowledged_at IS NULL` makes
"record or coalesce" a single idempotent upsert.

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

**A3. A sweeper dispatches, and retries until it succeeds.** A
`dispatchPendingAlerts` step in the `bulk` runner's existing maintenance block
selects alerts with `notified_at IS NULL` whose `dedupe_key` is outside its
cooldown, groups them into one digest per channel, delivers, and stamps
`notified_at` / `notified_channels` **only on success**. A failed dispatch
leaves the row untouched, so the next tick retries — no queue involvement, no
job row, no dependency on the thing being alarmed about.

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

**B2. Heartbeat renewal, so slow work is never reclaimed.** A **single timer per
lane** (not per job) periodically extends `lease_expires_at` for all rows that
lane currently has in flight, in one `UPDATE ... WHERE id = ANY($1)`. One
statement per lane per interval — this matters because the connection pool has
zero spare capacity (below). Lease default 120s, renewed every 40s, both
admin-config tunable. Consequences: a legitimately long job is safe for as long
as its process lives, and a dead process is detected in ~2 minutes instead of
10.

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

**C1. `worker_lane_heartbeats`** — one row per lane (`lane`, `last_tick_at`,
`last_claim_count`, `instance_id`), upserted at the end of every tick.

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
| `processing`, genuinely in flight during deploy | NULL lease | **Handled:** the reclaim sweep treats `status='processing' AND lease_expires_at IS NULL` as legacy and falls back to the old `updatedAt` cutoff for one retention window, so a pre-migration row is neither stranded forever nor yanked instantly. |
| `processing`, actually stranded pre-migration | Same legacy path | Yes — reclaimed on the old cutoff, as today. |
| `done` / `failed` (terminal) | NULL lease, untouched | Yes — never re-claimed. |
| Row inserted *during* the migration | NULL lease | Yes — same as legacy pending. |

Purely additive; no backfill rewrites existing data. **Rollback:** all four are
additive, so rollback is dropping the new tables/columns; no data written by the
old code is destroyed or rewritten, and the queue continues to function with the
new columns present but unused if the application is rolled back first.
**Observability:** each migration reports affected counts per the repo's
migration-observability rule.

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
- Dispatch failure leaves `notified_at` NULL and is retried on the next tick —
  the durability property finding 3 lacks.
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

**Regression:** the existing `asyncJobs`, `cliJobPoller`, `factPexelsJobs`,
`aiMemeBackfillJobs`, `factSendBackJob`, `adminNotify.*` and
`adminEmailQueue.delete` suites must pass unchanged — if one needs editing, that
is a signal a *Must Not Change* invariant moved, and it goes to David.

## Implementation Steps

Four phases, each an independently shippable PR that leaves the tree green and
the product testable. Ordered so the instrument lands before the machine
changes (settled decision 5).

**Phase 1 — Instrument (no behavior change to the queue).**
1. Migration 0094: `worker_lane_heartbeats`.
2. Stamp a heartbeat at the end of each lane tick.
3. Set an explicit pool `max`; record the arithmetic in `deferred-work.md`.
4. `GET /admin/queue-health` + `GET /health/queues`.
5. The Queue Health page + nav item, per the two-altitude contract.

**Phase 2 — Alerts (closes the headline finding).**
6. Migration 0095: `job_alerts` + seeded config rows.
7. Record alerts inside the finalize transaction, for all queues and both
   terminal paths.
8. The dispatcher sweeper in the maintenance runner: grouping, cooldown,
   escalation.
9. Webhook channel + format shaping + redaction.
10. Route the existing abandoned-email alert through the dispatcher.
11. Banner + acknowledge action.

**Phase 3 — Delivery correctness.**
12. Migration 0096: lease columns + index + config.
13. Claim writes a lease; every finalize is fenced and checks its row count.
14. Per-lane batched heartbeat renewal.
15. Lease-driven reclaim with attempt increment, token rotation, poison-pill
    termination, and the legacy fallback.
16. Graceful shutdown.
17. Resend idempotency key.
18. Deferred-email age alarm.

**Phase 4 — Transactional enqueue.**
19. Rewrite `enqueueJob`'s dedupe onto `onConflictDoNothing`, retiring
    `isDedupeConflict`. **Spike first:** confirm drizzle 0.45.2 can target a
    *partial* unique index (`target` + `targetWhere`); if it cannot, use a
    `SAVEPOINT` around the insert instead. This is a genuine unknown and the
    plan should not pretend otherwise.
20. Accept a caller transaction through the whole enqueue path, including the
    conflict-recovery read that hardcodes `defaultDb` today.
21. Compose `sendEmail` and the two status-writing enqueue sites inside their
    callers' transactions; close the `deferred-work.md` item.

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
| **`onConflictDoNothing` against a partial unique index may not be expressible in drizzle 0.45.2.** | Explicit spike as step 19, with a `SAVEPOINT` fallback already identified. Phase 4 is last precisely because it is the least certain. |

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
- No job is executed twice as a result of a reclaim; fenced writes are proven to
  match zero rows.
- A worker-killing job reaches `failed` rather than looping.
- Queue Health shows all eleven queues at both altitudes and satisfies
  `async-ui-status.md`.
- `deferred-work.md`'s transactional-enqueue item and pool-`max` item are closed
  and struck, not silently left.
- Existing async/email/admin suites pass unchanged; CI `Build` + `Test` green.
- Each phase ships its `TEST_RUN` + `UAT` per `CLAUDE.md` (Phase 1's UAT is
  thin by nature — a read-only surface — and says so).
