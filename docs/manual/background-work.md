# Background Work (Async Jobs)

> How Overhype.me runs slow or external work — AI classification, image
> generation, email, image search, moderation refresh cycles — without making
> anyone wait on it, and how it stays visible to admins while it's happening.
>
> Deep spec: [`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues),
> [`async-ui-status.md`](../ai-context/async-ui-status.md).
> Rationale history: [`decisions.md`](../ai-context/decisions.md).

## What it does

A lot of what Overhype.me does is too slow, too unreliable, or too expensive to
do inline while someone's request is waiting: classifying a fact's joke
mechanism with an LLM, generating an AI image, sending a transactional email,
finding a stock photo, re-running enrichment on hundreds of facts at once,
repairing derived data. All of that runs as **background work** — recorded in
the database rather than held in memory, so a server restart mid-run doesn't
lose it. (One exception worth knowing: in a local setup with no email provider
configured, an outgoing email is logged instead of being queued at all — see
the email section below.) **Most** of it is also
retried automatically when it fails transiently. Not all: where a retry
couldn't actually finish the job — because a half-completed run can't be
resumed — the queue deliberately opts out rather than spending attempts on
something that cannot succeed. Which work that applies to, and why, is in
[`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues).

Background work is invisible in the sense that a reader never sees a queue —
but every **admin** surface that triggers it (Taxonomy Health, moderation
renders, bulk actions) has to make that work's progress fully visible, because
an admin is actively watching and deciding what to do next.

## How it works

### For the reader / user

Nothing is directly visible. A render or an email arrives after the action
that triggered it rather than holding that action up. There is no queue UI on
the consumer side.

### For the admin

Every admin surface that kicks off background work must show status at **two
altitudes** — per item (this specific fact's row: queued → working →
done/failed/skipped/still-running) and in aggregate (a running tally like
"7 of 25 done · 2 failed"). A single spinner with no per-item detail is
considered a bug, not a valid loading state. **Taxonomy Health
(`artifacts/overhype-me/src/components/admin/useTaxonomyHealthActions.ts`) is
the reference implementation** — copy its
pattern rather than inventing a new one. The full contract, including why
"skipped" and "still running" are first-class states and why the UI never
imposes a timeout on a legitimately long job, is
[`async-ui-status.md`](../ai-context/async-ui-status.md) — this chapter
doesn't restate it. The **Bulk Media Backfill** panel (Admin → Taxonomy
Health) is a second reference implementation of the same two-altitude
contract, for the corpus-wide stock-image and AI-meme backfill queues.

### The machinery

Everything rides **one real database table**, not an in-memory queue or a
separate pub/sub system. That single choice buys the property this whole
chapter rests on: a crash or a redeploy never loses queued work, and at any
moment an ordinary SQL query shows the queue's recorded state — what is
waiting, what has been claimed, what failed. (Recorded, not live: an
individual job carries no lease, so a job a crashed worker left behind still
reads as claimed until a recovery sweep picks it up. Whether the *workers*
themselves are alive is tracked separately — see the known limitation below.)
The table's shape and the exact status flow are in
[`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues).

Work is drained by **independent scheduling lanes**, and the important word is
*independent*: a lane that is saturated cannot hold up another. What separates
them is **who is waiting, and how much each job costs to run**:

- **`fast`** — pure-database admin actions with no AI or image call in the
  path. Someone clicked a button and is waiting to see it take effect.
- **`render`** — single-item renders a moderator is watching a spinner for.
- **`bulk`** — the catch-all for batch work nobody is watching in real time.
- **`pexels`** and **`ai_meme_backfill`** — stock-image and AI-meme work for a
  fact. Both spend money or rate-limit budget at an external provider, so what
  matters here is protecting the bill, not finishing quickly.

That is what each lane is *for*. Everything quantitative about them — how many
there are, how often each polls, how much runs at once, which queue is
assigned where, and what happens on retry — lives in
[`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues),
and this chapter deliberately doesn't carry it. (See *the one bounded
exception* in the [manual's charter](./README.md) for why a chapter about
machinery may name the parts without quantifying them.)

### Email, the most consequential rider

Transactional email — verification links, password resets, notifications —
is queued like any other background work, but it is worth calling out
because it is the one queue whose failures reach a real person's inbox, and it
carries three behaviors nothing else does:

- **A rejected API key stops further delivery attempts process-wide** — and
  that is not the same as pausing them. Once the provider rejects our
  credentials, the app stops attempting delivery for the life of that
  process. (Not instantly to the last message: sends already in flight when
  the rejection lands can still reach the provider. It is later attempts that
  are cut off, not in-progress ones.) Meanwhile each queued message that comes
  up for delivery still fails, still consumes one of its retry attempts, and
  can exhaust its budget and be marked failed.
  So rotating the key and restarting resumes sending, but it does **not**
  guarantee everything queued during the outage is still deliverable.
- **An abandoned email can alert the admins — if that alert is switched on.**
  When a message exhausts its retries it would otherwise just be marked failed
  and forgotten, which matters because a silently undelivered password reset
  looks identical to a user who never clicked. The alert is **configuration-
  dependent**: it fires only where the abandoned-email alert setting has been
  switched on, so an environment that hasn't enabled it gets no notification.
- **That alert is exempt from the usual cleanup.** Ordinary email rows are
  purged on a retention schedule; the alert about a failed email is
  deliberately kept, so the evidence outlives the thing it is evidence about.

When delivery isn't configured at all (local development), the two directions
behave differently, and the distinction matters:

- A **newly sent** email is logged and returns — it is **never queued**, so it
  will not be delivered later once a key is configured. Nothing is faked, but
  nothing is stored either.
- A row **already in the queue** is left pending and retried later rather than
  being consumed and failed, so genuinely queued work survives.

### Worker liveness and the Queue Health surface

Every lane's worker publishes a **heartbeat** — a small row saying "instance
X is still ticking lane Y, N jobs in flight" — because the queue table alone
can't tell you a worker has died: a `pending` row looks identical whether a
worker is about to claim it or every worker crashed an hour ago. Admin →
**Queue Health** is the fleet-wide view built on those heartbeats, and it's a
**third** reference implementation of the two-altitude contract above — this
time at the level of "is the whole background-work system alive," not one
queue's items:

- **Aggregate altitude** (`GET /api/admin/queue-health`) — every queue's raw
  status tallies plus two derived states, each from a different signal:
  `skipped` (a successful `done` row whose handler result says mid-run its
  work no longer applied — nothing to do with attempts or the ceiling) and
  `abandoned_no_retry` (derived from comparing a `failed` row's attempts
  against its retry ceiling: the worker deliberately won't retry this one, a
  different story from having retried repeatedly and given up). Per lane: how many
  instances have a heartbeat row recent enough to
  still count as live (not necessarily still actively ticking this exact
  second — a heartbeat can be silent past its own stale threshold but still
  inside the wider retention window), and whether the whole fleet has gone
  quiet on it.
- **Per-item altitude** (`GET /api/admin/queue-health/jobs`) — the same drill-down
  every queue gets, not just email.
- **A public liveness probe** (`GET /api/health/queues`, unauthenticated) —
  on total API-process death it's unreachable exactly like every other
  endpoint, so that's not what makes it useful. The aggregate endpoint above
  already reports the same fleet-wide stall, as data in its JSON body behind
  a 200. What's unique about the probe is turning that same verdict into
  the **HTTP status code itself** — a meaningful unhealthy response *while
  the process is still up*, so an external monitor can act on it without
  parsing a body — and it also fails closed (same unhealthy response) if
  checking lane health itself errors out, rather than risking a false "all
  clear." A single instance scaling down is normal, not an incident.

## Why it works this way

The lane split (2026-07, PR #216) replaced a single shared worker that
dispatched **all** queues through one claim query, one concurrency pool, and
one shared "is a tick already running" guard. That worked fine when every
queue was roughly equally slow, but it produced real, reported head-of-line
blocking: a cheap database-only admin click could sit in "Queued…" for 30+
seconds because it was waiting behind slow AI/image-generation work — or
because the *previous* worker tick hadn't finished processing a batch that
happened to include something slow. A moderator's test render had the same
problem in reverse: it could wait behind an unrelated bulk backfill batch.

A split that folded renders into the same lane as batch work was considered
and rejected, specifically so a render a moderator is actively watching
never has to wait on background batch work either — those are different
enough in who's watching and how urgent they are to deserve separate
isolation. The full decision, including the exact lane assignments and the
concurrency-default reasoning, is in
[`decisions.md`](../ai-context/decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes);
the general pattern (shared dispatcher + shared guard → head-of-line blocking)
is written up as a reusable lesson in
[`known-failure-patterns.md`](../ai-context/known-failure-patterns.md#head-of-line-blocking-in-a-shared-background-worker)
for the next time a similar shared-worker design shows the same symptom
elsewhere.

## Boundaries & known limitations

- **No priority *within* a lane.** The lane split only isolates *between*
  lanes, not within one — a very large batch in the `bulk` lane still drains
  progressively, not instantly. (The exact claim ordering is in
  [`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues).)
- **The lanes and ordinary site traffic share one database connection pool.**
  A job holds a connection while it is doing database work but not while it
  waits on an outside service, so the number of jobs running is not the same
  measure as the number of connections in use — and nobody has measured the
  real contention under load. The current sizing and the reasoning behind it
  are in
  [`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues).
- **A crashed job is recovered, but on a deliberate delay.** Work is never silently
  lost — a job whose process died mid-run is put back in the queue rather than
  stranded forever. But recovery runs **on a deliberate delay** rather than
  the moment a job goes quiet, and the wait is not something to plan around:
  a job must look stuck before the sweep will touch it, and a busy queue
  pushes that further out. The delay is the safe choice, not an oversight.
  The app **can** run as
  several instances at once, and a faster sweep would sometimes grab a job
  another instance is still legitimately working on — running it twice. For an
  email, that means a real person gets the message twice. Delayed recovery of
  a rare crash is the
  better trade, and the mechanism that would let it be both fast and safe is
  tracked as follow-up work in
  [`deferred-work.md`](../engineering/deferred-work.md#code-level-tech-debt).
- **Retention is not an audit log.** Old `done`/`failed` rows are purged after
  a configurable number of days per queue; `async_jobs` is operational state,
  not permanent history.
- **A `done` job can still mean "skipped."** A handler can discover mid-run
  that its work no longer applies (e.g. the target became ineligible in a
  race) and complete successfully with a skip result rather than failing. Any
  UI reading job status has to distinguish this from a plain success — see the
  "subtler version" note in
  [`known-failure-patterns.md`](../ai-context/known-failure-patterns.md#async-enqueue-treated-as-completion).
- **The video pipeline doesn't run through this queue yet.** A `fal_video`
  queue exists in code as a placeholder for future work but isn't live.

## Going deeper

- [`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues) —
  the current live queue list and lane assignments.
- [`async-ui-status.md`](../ai-context/async-ui-status.md) — the full
  status-surfacing contract every async-triggering UI must follow.
- [`decisions.md`](../ai-context/decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes) —
  why the lane split happened and what was deliberately deferred.
- Code entry points: `lib/db/src/schema/asyncJobs.ts` (the table),
  `artifacts/api-server/src/lib/asyncJobs.ts` (the worker + lanes),
  `artifacts/overhype-me/src/components/admin/useTaxonomyHealthActions.ts` (the
  reference UI polling pattern), `artifacts/api-server/src/lib/factPexelsJobs.ts`
  and `artifacts/api-server/src/lib/aiMemeBackfillJobs.ts` (the `pexels` /
  `ai_meme_backfill` queue handlers),
  `artifacts/overhype-me/src/components/admin/useBulkMediaBackfillActions.ts`
  (the Bulk Media Backfill panel's polling hook),
  `lib/db/src/schema/workerLaneHeartbeats.ts` and
  `artifacts/api-server/src/lib/workerHeartbeats.ts` (the heartbeat table +
  writer), `artifacts/api-server/src/lib/queueHealth.ts` and
  `artifacts/api-server/src/routes/health.ts` (the Queue Health queries +
  the public probe), `artifacts/overhype-me/src/pages/admin/queueHealth.tsx`
  (the Queue Health page).
- [`decisions.md`](../ai-context/decisions.md#2026-07-30--queue-health-classification-persists-the-retry-ceiling-at-finalization-instead-of-re-deriving-it-live) —
  why the **retry ceiling** (not the `abandoned_no_retry` classification
  itself, which stays derived on every read) persists on the row at finalize
  instead of being re-resolved live.

**Next:** this is the last chapter — back to the
[contents](./README.md#contents).

*Verified against `809079f` (2026-07-30) · claim inventory in PR #291.
Re-grounded after PR #288 (async-queue hardening Phase 1) landed mid-review
and falsified three claims here.*
