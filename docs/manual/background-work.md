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

Everything rides **one real database table**, not an in-memory queue or a
separate pub/sub system. That single choice buys the property this whole
chapter rests on: a crash or a redeploy never loses queued work, and at any
moment you can see exactly what is waiting, running, or failed with an
ordinary SQL query. The table's shape and the exact status flow are in
[`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues).

Work is drained by **five independent scheduling lanes**, and the important
word is *independent*: each keeps its own timer, its own concurrency budget,
and its own guard against overlapping runs, so a lane that is saturated can
never hold up another. What separates them is **who is waiting and how much
each job costs**:

- **`fast`** — pure-database admin actions with no AI or image call in the
  path, like sending a fact back to review. Someone clicked a button and is
  watching for it to take effect, so this lane polls the most aggressively and
  finishes in a couple of ticks almost regardless of what else is running.
- **`render`** — single-item renders a moderator is actively watching a
  spinner for. Sized to run a few at once, so firing several test renders
  doesn't serialize them behind each other.
- **`bulk`** — the default lane, for batches nobody is watching in real time:
  re-enrichment, large backfills, visual-concept drafting, transactional email.
- **`pexels`** and **`ai_meme_backfill`** — stock-image and AI-meme work for a
  fact (root or variant). Both are deliberately serialized to one job at a
  time, because both spend money or rate-limit budget at an external provider.
  `ai_meme_backfill` goes further and is **never retried automatically**: it
  saves each image as it goes, so re-running a half-finished set would pay for
  the slots that already succeeded.

Choosing a lane is a one-line decision when a queue is registered, and it
changes **only scheduling** — retries, dedupe, and ordering behave the same in
every lane. A job that fails is retried with increasing backoff and marked
failed only once its attempt budget is spent. The per-lane poll intervals,
concurrency bounds, and queue assignments live in
[`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues);
this chapter doesn't restate them.

### Email, the most consequential rider

Transactional email — verification links, password resets, notifications —
rides the `bulk` lane like any other batch work, but it is worth calling out
because it is the one queue whose failures reach a real person's inbox, and it
carries three behaviors nothing else does:

- **A bad API key disables sending process-wide, immediately.** If the email
  provider rejects our credentials, the app stops attempting delivery rather
  than burning every queued message's retry budget against a key that cannot
  work. Delivery resumes after the key is rotated and the process restarts.
- **An abandoned email tells the admins.** When a message exhausts its retries,
  it doesn't just get marked failed and forgotten — the admin team is notified,
  because a silently undelivered password reset looks identical to a user who
  simply never clicked.
- **That alert is exempt from the usual cleanup.** Ordinary email rows are
  purged on a retention schedule; the alert thread about a failed email is
  deliberately kept, so the evidence outlives the thing it is evidence about.

When delivery isn't configured at all (local development), emails are logged
rather than sent, and queued rows are left pending instead of being consumed —
so nothing is lost and nothing is faked.

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
- **A crashed job is recovered, but not quickly.** Work is never silently
  lost — a job whose process died mid-run is put back in the queue rather than
  stranded forever. But recovery is deliberately unhurried: the sweep only
  reclaims a job that has looked stuck for **about half an hour**. That delay
  is the safe choice, not an oversight. The app runs as several instances at
  once, and a faster sweep would sometimes grab a job another instance is
  still legitimately working on — running it twice. For an email, that means a
  real person gets the message twice. Slow recovery of a rare crash is the
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
