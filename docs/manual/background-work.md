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
repairing derived data. All of that runs as **background work** — durably
queued, and never lost to a server restart mid-run. **Most** of it is also
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

Nothing is directly visible. A render or an email simply arrives a little
after the action that triggered it. There is no queue UI on the consumer side.

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
waiting, what has been claimed, what failed. (Recorded, not live: there is no
lease or heartbeat, so a row a crashed worker left behind still reads as
claimed until a recovery sweep picks it up. See the known limitation below.)
The table's shape and the exact status flow are in
[`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues).

Work is drained by **independent scheduling lanes**, and the important word is
*independent*: a lane that is saturated cannot hold up another. What separates
them is **who is waiting, and how much each job costs to run**:

- **`fast`** — pure-database admin actions with no AI or image call in the
  path, like sending a fact back to review. Someone clicked a button and is
  waiting to see it take effect.
- **`render`** — single-item renders a moderator is watching a spinner for.
- **`bulk`** — batches nobody is watching in real time: re-enrichment, large
  backfills, visual-concept drafting, transactional email.
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
rides the `bulk` lane like any other batch work, but it is worth calling out
because it is the one queue whose failures reach a real person's inbox, and it
carries three behaviors nothing else does:

- **A rejected API key stops delivery attempts process-wide, immediately** —
  and that is not the same as pausing them. Once the provider rejects our
  credentials, no further calls are made for the life of that process, but
  each queued message that comes up for delivery still fails, still consumes
  one of its retry attempts, and can exhaust its budget and be marked failed.
  So rotating the key and restarting resumes sending, but it does **not**
  guarantee everything queued during the outage is still deliverable.
- **An abandoned email can alert the admins — if that alert is switched on.**
  When a message exhausts its retries it would otherwise just be marked failed
  and forgotten, which matters because a silently undelivered password reset
  looks identical to a user who never clicked. The alert is **off by default**
  and only fires when the abandoned-email alert setting is explicitly enabled,
  so a fresh or local environment gets no notification.
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

A simpler 2-lane split (fast vs. everything else) was considered and rejected
in favor of 3, specifically so a render a moderator is actively watching never
has to wait on background batch work either — those are different enough in
who's watching and how urgent they are to deserve separate isolation. The full
decision, including the exact lane assignments and the concurrency-default
reasoning, is in
[`decisions.md`](../ai-context/decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes);
the general pattern (shared dispatcher + shared guard → head-of-line blocking)
is written up as a reusable lesson in
[`known-failure-patterns.md`](../ai-context/known-failure-patterns.md#head-of-line-blocking-in-a-shared-background-worker)
for the next time a similar shared-worker design shows the same symptom
elsewhere.

## Boundaries & known limitations

- **No priority *within* a lane.** Jobs in the same lane still run FIFO
  (oldest due first); the lane split only isolates *between* lanes, not within
  one. A very large batch in the `bulk` lane still drains progressively, not
  instantly.
- **The lanes share one database connection pool, and between them they can
  use all of it.** If every lane is busy at once, there is no spare
  connection left for ordinary admin or reader traffic — so the site itself
  can feel slow while a big backfill runs, even though nothing is broken.
  That is a known rough edge rather than a designed limit: the two newest
  lanes consumed the margin that used to exist, and raising the pool's
  ceiling is deliberate follow-up work that hasn't been done yet
  ([`current-roadmap.md`](../ai-context/current-roadmap.md)). The exact
  numbers, and why they line up the way they do, are in
  [`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues).
- **A crashed job is recovered, but not quickly.** Work is never silently
  lost — a job whose process died mid-run is put back in the queue rather than
  stranded forever. But recovery is **not prompt**, and how long it takes is
  not something to plan around: a job must look stuck for a good while before
  the sweep will touch it, and if the queue is busy it waits longer still.
  The delay is the safe choice, not an oversight. The app **can** run as
  several instances at once, and a faster sweep would sometimes grab a job
  another instance is still legitimately working on — running it twice. For an
  email, that means a real person gets the message twice. Slow recovery of a
  rare crash is the
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
  (the Bulk Media Backfill panel's polling hook).

**Next:** this is the last chapter — back to the
[contents](./README.md#contents).

*Verified against `887c404` (2026-07-30) · claim inventory in PR #291.*
