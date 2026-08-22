# PR #288 — Queue Health: you can finally see whether the queue is alive — UAT

Your in-app acceptance test, David. This is **Phase 1 of four** from the
async queue hardening plan, and it is deliberately the boring one: it adds
no alerting and changes no queue behaviour. It adds *eyes*.

**Why this comes first.** The plan's riskiest work is Phase 3 — replacing
the queue's wall-clock guess about who owns a running job with real lease
tokens. If that goes subtly wrong, jobs get stranded in `processing` and
nothing tells us. So the instrumentation ships first, so that when Phase 3
lands, a stranded row is visible within one page refresh instead of being
discovered weeks later.

**What was actually broken before this.** Nothing in the system recorded
whether the background worker was still ticking. `/admin/email-queue`
covers one queue of eleven. If the `render` lane's timer had stopped a
week ago, there was no screen anywhere that would have told you — you'd
have found out because memes stopped appearing.

## Setup

None.

## Steps

### 1. Worker lanes appear — the part that didn't exist before

**Do:** Open Admin → Queue Health (new item in the left sidebar, below
Email Queue).

**Expect:** A "Worker lanes" section with five cards: `fast`, `render`,
`bulk`, `pexels`, `ai_meme_backfill`.

### 2. Each lane card reports its own state

**Do:** Look at each worker lane card.

**Expect:** Each says "Scheduling" in green, plus "N live instances · last
fire Xs ago · N in flight".

### 3. A summary line sits above the cards

**Do:** Look above the worker lane cards.

**Expect:** A line reads "All five lanes are being scheduled. Last checked
HH:MM:SS."

### 4. The page polls on its own

**Do:** Watch the timestamp above the worker lane cards for several
seconds without reloading.

**Expect:** It advances roughly every 5 seconds — the polling working. You
never need to refresh the page.

### 5. The Queues section lists every registered queue

**Do:** Look at the "Queues" section.

**Expect:** Every registered queue is listed, one row per queue, with a
summary: "N queued · N working · N done · N failed", plus skipped and
no-more-retries counts, an oldest age when those apply, and a trailing
"24h: N done / N failed".

### 6. A queue that has never run still appears

**Do:** Find a queue that has never run.

**Expect:** It still appears in the list, with zeros. A queue missing
from the page would read as "fine" when the truth might be that it has
never executed once.

### 7. A queue row expands to individual jobs

**Do:** Click a queue row.

**Expect:** It expands to show individual jobs — id, state, attempt
count, and any error.

### 8. A queue row collapses again

**Do:** Click the same queue row again.

**Expect:** It collapses.

### 9. Every job state is a labelled badge

**Do:** Look at the state badges on the expanded job rows from the
previous step.

**Expect:** Each job's state is a labelled badge — Queued, Working
(spinning), Done, Failed, Skipped *(reason)*, or Failed — no more retries
— not just a colour. Skipped and Failed — no more retries in particular
used to be invisible: the database stores a skip as "done" and a
not-retried-further failure as plain "failed", so they read as very
different operator stories now.

### 10. A first-load failure says so, explicitly

**Do:** Open the page while the API is down (or ask Replit to simulate
it).

**Expect:** An explicit red panel reads "Could not load queue health",
with a Retry button and the sentence "This is not the same as the queues
being healthy — we were unable to ask." You must **not** see an empty
page, five green "Scheduling" cards, or "all queues healthy" —
"everything's fine" and "I couldn't check" must never look identical on a
page whose entire job is revealing problems.

### 11. A failure after data is on screen keeps the stale data visible

**Do:** Let the page load normally, then take the API down while you're
watching.

**Expect:** The numbers stay on screen — stale data is still useful — and
an amber banner appears: "Showing data from HH:MM:SS — the last refresh
failed and we are still retrying. These numbers are not current." It keeps
retrying and recovers on its own when the API comes back; it never gives
up and never asks you to refresh.

### 12. Loading looks like loading

**Do:** Hard-refresh the page and watch the first second.

**Expect:** Five grey skeleton bars, not a single spinner over the whole
page.

## Regression

### R1. Email Queue is untouched

**Do:** Use Admin → Email Queue.

**Expect:** Works exactly as before — untouched by this PR.

### R2. Memes still generate end to end

**Do:** Generate a meme end to end.

**Expect:** The queue's behaviour is unchanged.

### R3. Enrichment / send-back / Taxonomy Health actions still run

**Do:** Run an enrichment / send-back / Taxonomy Health action.

**Expect:** Unchanged.

### R4. The admin sidebar gains only Queue Health

**Do:** Look at the admin sidebar.

**Expect:** New "Queue Health" item present; every existing item still
present and working.

### R5. The new endpoints are admin-gated

**Do:** Visit both new admin endpoints as a non-admin user.

**Expect:** Both are admin-gated — nothing new appears for a non-admin
user.

### R6. No new database connection errors appear

**Do:** Watch for database connection errors anywhere in the app while
testing.

**Expect:** None. The per-instance connection ceiling went from an
implicit 10 to an explicit 20 — a real latent problem, since the five
lanes could want 10 connections at once with zero spare. If anything
anywhere starts reporting database connection errors, that's the one
place this PR could plausibly bite.

## Not bugs

- **No alerts anywhere yet.** No email, no webhook, no banner when
  something fails. That's Phase 2. This PR only makes state *visible* if
  you go looking.
- **The page won't tell you the app is completely down.** If the server is
  dead, the page can't load either, and `/api/health/queues` dies with it
  exactly like any other route. What actually detects total death is an
  *external* monitor polling that URL and seeing the request fail to
  connect — wiring that monitor up is a separate step.
- **"Skipped" and "no more retries" counts may both be zero.** That means
  nothing has skipped or failed-without-further-retry recently, not that
  the feature is missing.
- **`in flight` is usually 0.** Jobs are fast; you'd have to catch one
  mid-run.
- **Lane intervals are 2–5 seconds, but a lane is only called stalled
  after 60 seconds.** Deliberate: a stricter threshold would false-alarm
  on ordinary scheduler jitter, and a health page that cries wolf gets
  ignored.
- **"Live instances" will not always be 1.** The app runs on autoscale, so
  under load there may be 2, 3, or more instances, each running all five
  lanes. The page counts every instance whose worker has checked in
  recently. Seeing that number change is normal and healthy.
- **A stalled lane's red "Not scheduling" card and banner cannot be
  verified by click-through in this phase.** The only process serving the
  page's own polling endpoint is the same process running the five lane
  schedulers, so there is no way to pause one lane's scheduler while
  keeping the server up. If a lane ever genuinely stops scheduling, expect
  its card to flip to "Not scheduling" in red and a red banner above the
  cards reading "N lanes not being scheduled by any live worker: … Queued
  work in them is not moving." The backend wiring underneath (whether
  `/health/queues` actually returns 503 when a lane is stalled) is covered
  by an automated test; only the frontend card and banner aren't
  click-through verified here.
- **You may see none of the job-state badges from step 9 on a healthy
  system.** That's fine.
