# PR #288 — Queue Health: you can finally see whether the queue is alive — UAT

Your in-app acceptance test, David. This is **Phase 1 of four** from the async
queue hardening plan, and it is deliberately the boring one: it adds no alerting
and changes no queue behaviour. It adds *eyes*.

**Why this comes first.** The plan's riskiest work is Phase 3 — replacing the
queue's wall-clock guess about who owns a running job with real lease tokens. If
that goes subtly wrong, jobs get stranded in `processing` and nothing tells us.
So the instrumentation ships first, so that when Phase 3 lands, a stranded row is
visible within one page refresh instead of being discovered weeks later.

**What was actually broken before this.** Nothing in the system recorded whether
the background worker was still ticking. `/admin/email-queue` covers one queue of
eleven. If the `render` lane's timer had stopped a week ago, there was no screen
anywhere that would have told you — you'd have found out because memes stopped
appearing.

Companion engineering checklist:
[`PR288_QUEUE_HEALTH_SURFACE_TEST_RUN.md`](PR288_QUEUE_HEALTH_SURFACE_TEST_RUN.md).

## Where to go

**Admin → Queue Health** (new item in the left sidebar, below Email Queue).

The page polls every 5 seconds on its own. You never need to refresh it.

## What to expect

### 1. Worker lanes — the part that didn't exist before

- Open Admin → Queue Health.
- ✅ A **Worker lanes** section with five cards: `fast`, `render`, `bulk`,
  `pexels`, `ai_meme_backfill`.
- ✅ Each says **"Scheduling"** in green, plus *"N live instances · last fire Xs
  ago · N in flight"*.
- ✅ Above the cards, a line reading *"All five lanes are being scheduled. Last
  checked HH:MM:SS."*
- The timestamp should advance roughly every 5 seconds while you watch. That is
  the polling working.

**"Live instances" is worth understanding**, because it will not always be 1.
The app runs on autoscale, so under load there may be 2, 3 or more instances,
each running all five lanes. The page counts every instance whose worker has
checked in recently. Seeing that number change is normal and healthy.

### 2. Queues — one row each, expandable

- ✅ A **Queues** section listing every registered queue, one row per queue,
  with a summary: *"N queued · N working · N done · N failed"*, plus *skipped*
  and *never retried* counts, an *oldest* age when those apply, and a trailing
  *"24h: N done / N failed"* — the recent-throughput figures the approved plan
  requires alongside the four raw tallies.
- ✅ Queues that have **never run** still appear, with zeros. This is deliberate:
  a queue missing from the page would read as "fine" when the truth might be that
  it has never executed once.
- Click a queue row.
- ✅ It expands to show individual jobs — id, state, attempt count, and any error.
- Click it again to collapse.

### 3. Every state gets a word, not just a colour

Look at the expanded rows. Each job's state is a **labelled** badge:

| What you'll see | What it means |
|---|---|
| **Queued** | waiting for its turn |
| **Working** (spinning) | running right now |
| **Done** | finished successfully |
| **Failed** | ran out of retries |
| **Skipped** *(reason)* | the handler deliberately did nothing |
| **Failed — never retried** | failed on its first and only attempt |

Those last two are the ones I want you to notice, because they were previously
**invisible**. The database stores a skip as "done" and a never-retried failure
as plain "failed" — so a skipped job looked like a success, and an
`ai_meme_backfill` job that failed once looked identical to one that had tried
five times and given up. They are very different operator stories, and now they
read differently.

You may see none of these on a healthy system. That's fine — the TEST_RUN doc has
Replit confirm them against real rows if any exist.

### 4. A stalled lane says so, in words

This is the whole reason the page exists, so it's worth seeing once. The easiest
way is to have Replit stop the API server briefly (it's step 6 of the TEST_RUN
checklist) and then look at the page from another browser — or simply trust
Replit's report on that step.

- ✅ The lane's card flips to **"Not scheduling"** in red.
- ✅ A red banner above the cards: *"N lanes not being scheduled by any live
  worker: … Queued work in them is not moving."*
- Not just a colour change — the sentence tells you what the consequence is.

### 5. The page is honest when it can't reach the server

Two cases, and they behave **differently on purpose**. This is the part I'd most
like you to poke at, because getting it wrong is how a health page lies.

**Case A — it fails on first load.** Open the page while the API is down (or ask
Replit to simulate it).
- ✅ An explicit red panel: *"Could not load queue health"*, with a **Retry**
  button, and the sentence *"This is not the same as the queues being healthy — we
  were unable to ask."*
- ❌ What you must **not** see: an empty page, or five green "Scheduling" cards,
  or "all queues healthy". *"Everything's fine"* and *"I couldn't check"* look
  identical to a human, and on a page whose entire job is revealing problems that
  would be the worst possible bug.

**Case B — it fails after data is already on screen.** Let the page load
normally, then take the API down while you're watching.
- ✅ The numbers **stay on screen** — stale data is still useful.
- ✅ An amber banner appears: *"Showing data from HH:MM:SS — the last refresh
  failed and we are still retrying. These numbers are not current."*
- ✅ It keeps retrying, and recovers on its own when the API comes back. It never
  gives up and never asks you to refresh.

### 6. Loading looks like loading

- Hard-refresh the page and watch the first second.
- ✅ Five grey skeleton bars, not a single spinner over the whole page.

## Regression smoke — things this PR must not have broken

| Check | Expected |
|---|---|
| **Admin → Email Queue** still works exactly as before | Untouched by this PR |
| Memes still generate end to end | The queue's behaviour is unchanged |
| Enrichment / send-back / Taxonomy Health actions still run | Unchanged |
| Admin sidebar | New "Queue Health" item; every existing item still present and working |
| Nothing new appears for non-admin users | Both new admin endpoints are admin-gated |

The one behavioural change worth knowing about: **the database connection ceiling
per instance went from an implicit 10 to an explicit 20.** That was a real latent
problem — the five lanes can want 10 connections at once, so the pool had zero
spare. If anything anywhere starts reporting database connection errors, tell me;
that's the one place this PR could plausibly bite.

## Known non-bugs

- **No alerts anywhere yet.** No email, no webhook, no banner when something
  fails. That's Phase 2. This PR only makes state *visible* if you go looking.
- **The page won't tell you the app is completely down** — if the server is dead,
  the page can't load either. That's what `/health/queues` is for: an external
  monitor pointed at it. Wiring that monitor up is a separate step.
- **"Skipped" and "never retried" counts may both be zero.** That means nothing
  has skipped or failed-without-retry recently, not that the feature is missing.
- **`in flight` is usually 0.** Jobs are fast; you'd have to catch one mid-run.
- **Lane intervals are 2–5 seconds, but a lane is only called stalled after
  60 seconds.** Deliberate: a stricter threshold would false-alarm on ordinary
  scheduler jitter, and a health page that cries wolf gets ignored.

## If something's wrong

Tell me:
1. **Where** — which section, which queue or lane.
2. **What you saw** vs. what you expected.
3. **Whether the page was showing the amber "not current" banner** at the time —
   that changes the diagnosis completely (stale data vs. wrong data).
4. A screenshot if it's a rendering issue.

The most valuable bug you could find here is **the page saying something is fine
when it isn't** — that's the class of failure this whole phase exists to remove,
so it's the one I'd most want to hear about.
