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
queued, retried automatically if it fails transiently, and never lost to a
server restart mid-run.

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

Everything rides one durable table, **`async_jobs`**: a `queue` discriminator
(which kind of work), a JSON payload, an optional dedupe key, and retry
bookkeeping. A row's status moves `pending → processing → done | failed`.
Using one real database table — not an in-memory queue or a separate
pub/sub system — means a crash or redeploy never loses queued work, and the
state is always inspectable with a normal SQL query.

**Five independent scheduling lanes** claim and run those rows. Each lane —
`fast`, `render`, `bulk`, `pexels`, `ai_meme_backfill` — has its own poll
timer, its own concurrency limit, and (crucially) its own re-entrancy guard,
so none of them can ever be delayed by another:

- **`fast`** — pure-database admin actions with no AI/image call in the path
  (e.g. "Send back to review," a projection repair). Polls every 2 seconds;
  these finish in a couple of ticks almost regardless of what else is running.
- **`render`** — single-item renders a moderator is actively watching a
  spinner for (the image-prompt-planning step and the actual image
  generation). Polls every 5 seconds with room for a few in parallel, so
  firing 3–4 test renders at once doesn't serialize them.
- **`bulk`** (the default for any queue that doesn't ask for a different lane)
  — background batches nobody's watching in real time: re-enrichment,
  large backfills, stock-photo search, visual-concept drafting, transactional
  email. Polls every 5 seconds.
- **`pexels`** — stock-image search/prep for a fact (root or variant),
  concurrency capped at 1 so requests to the photo API stay paced the same
  way the old direct-call code did.
- **`ai_meme_backfill`** — AI-generated meme backgrounds for a fact (root or
  variant), also capped at concurrency 1 for the same paid-API pacing reason —
  and, unlike most queues, never retried automatically: a partial failure part
  way through generating a fact's image set would otherwise re-pay for the
  slots that already succeeded.

A queue's lane is a one-line registration choice
(`registerJobHandler(queue, handler, { lane: "fast" })`); nothing about
retries, dedupe, or claim ordering changes based on lane. A job that fails
retries with increasing backoff and is marked `failed` only after exhausting
its attempt budget; a crash mid-run leaves a row safely reclaimable rather
than stuck forever.

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
- **All five lanes share one database connection pool.** Their combined
  worst-case concurrent handler count (fast 2 + render 3 + bulk 3 + pexels 1 +
  ai_meme_backfill 1 = 10) now exactly matches the pool's default limit (10) —
  the `pexels`/`ai_meme_backfill` lanes added for variant independence (PR
  #256) used up what used to be a small margin. That leaves **no** default
  spare connection for admin + reader traffic outside these lanes when all
  five are simultaneously busy, not just thin headroom. Raising the pool's
  connection limit was deliberately left as follow-up work, not done
  proactively — see
  [`current-roadmap.md`](../ai-context/current-roadmap.md).
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
