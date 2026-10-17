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

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts:shows one card per worker lane, each with its own liveness verdict`

**Deferred:** #631 — 7b — the Worker lanes section on /admin/queue-health holding exactly five lane cards, no sixth — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 2. Each lane card reports its own state

**Do:** Look at each worker lane card.

**Expect:** Each says "Scheduling" in green, plus "N live instances · last
fire Xs ago · N in flight".

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts:shows one card per worker lane, each with its own liveness verdict`

**Deferred:** #631 — 7b — the Scheduling label's green colour, which no assertion reads — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 3. A summary line sits above the cards

**Do:** Look above the worker lane cards.

**Expect:** A line reads "All five lanes are being scheduled. Last checked
HH:MM:SS."

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts:summarises lane liveness in words above the cards`

**Deferred:** #631 — 7b — the summary's Last checked value on /admin/queue-health matching a clock time such as 14:03:27, not any text such as Invalid Date — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 4. The page polls on its own

**Do:** Watch the timestamp above the worker lane cards for several
seconds without reloading.

**Expect:** It advances roughly every 5 seconds — the polling working. You
never need to refresh the page.

**Lane:** ci

**Deferred:** #631 — 7b — the Last checked timestamp advancing about every 5 seconds with no reload — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 5. The Queues section lists every registered queue

**Do:** Look at the "Queues" section.

**Expect:** Every registered queue is listed, one row per queue, with a
summary: "N queued · N working · N done · N failed", plus skipped and
no-more-retries counts, an oldest age when those apply, and a trailing
"24h: N done / N failed".

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts:lists every registered queue, including ones that have never run`

**Deferred:** #631 — 7b — each queue row on /admin/queue-health reading N queued · N working · N done · N failed, then skipped, no-more-retries and oldest age when nonzero, ending 24h: N done / N failed — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 6. A queue that has never run still appears

**Do:** Find a queue that has never run.

**Expect:** It still appears in the list, with zeros. A queue missing
from the page would read as "fine" when the truth might be that it has
never executed once.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts:lists every registered queue, including ones that have never run` `artifacts/api-server/src/__tests__/queueHealth.test.ts:reports a registered queue that has never run, rather than omitting it`

**Deferred:** #631 — 7b — a registered queue with no jobs appearing on /admin/queue-health as its own row reading 0 queued · 0 working · 0 done · 0 failed — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 7. A queue row expands to individual jobs

**Do:** Click a queue row.

**Expect:** It expands to show individual jobs — id, state, attempt
count, and any error.

**Lane:** ci

**Deferred:** #631 — 7b — clicking a queue row expands it to job id, state, attempt count and error text — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 8. A queue row collapses again

**Do:** Click the same queue row again.

**Expect:** It collapses.

**Lane:** ci

**Deferred:** #631 — 7b — a second click on the same queue row collapsing it — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 9. Every job state is a labelled badge

**Do:** Look at the state badges on the expanded job rows from the
previous step.

**Expect:** Each job's state is a labelled badge — Queued, Working
(spinning), Done, Failed, Skipped *(reason)*, or Failed — no more retries
— not just a colour. Skipped and Failed — no more retries in particular
used to be invisible: the database stores a skip as "done" and a
not-retried-further failure as plain "failed", so they read as very
different operator stories now.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/queueHealth.test.ts`

**Deferred:** #631 — 7b — six job states as labelled badges: Queued, Working (spinning), Done, Failed, Skipped (reason), Failed no more retries — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 10. A first-load failure says so, explicitly

**Do:** Open the page while the API is down (or ask Replit to simulate
it).

**Expect:** An explicit red panel reads "Could not load queue health",
with a Retry button and the sentence "This is not the same as the queues
being healthy — we were unable to ask." You must **not** see an empty
page, five green "Scheduling" cards, or "all queues healthy" —
"everything's fine" and "I couldn't check" must never look identical on a
page whose entire job is revealing problems.

**Lane:** ci

**Deferred:** #631 — 7b — first-load failure showing the Could not load queue health panel with Retry and the not-healthy sentence, no green cards — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 11. A failure after data is on screen keeps the stale data visible

**Do:** Let the page load normally, then take the API down while you're
watching.

**Expect:** The numbers stay on screen — stale data is still useful — and
an amber banner appears: "Showing data from HH:MM:SS — the last refresh
failed and we are still retrying. These numbers are not current." It keeps
retrying and recovers on its own when the API comes back; it never gives
up and never asks you to refresh.

**Lane:** ci

**Deferred:** #631 — 7b — after a load, a failed poll on /admin/queue-health keeping the queue rows and showing the amber banner Showing data from <time>, the last refresh failed and we are still retrying, clearing when the API recovers — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 12. Loading looks like loading

**Do:** Hard-refresh the page and watch the first second.

**Expect:** Five grey skeleton bars, not a single spinner over the whole
page.

**Lane:** ci

**Deferred:** #631 — 7b — first load showing five grey skeleton bars, not a single spinner — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

## Regression

### R1. Email Queue is untouched

**Do:** Use Admin → Email Queue.

**Expect:** The Email Queue page loads and lists its jobs with no error.
It shows the All, Pending, Sending, Delivered and Abandoned filters; the
record count and the auto-purge setting; the Clear pending, Clear delivered,
Clear abandoned and Refresh buttons; and a table with the columns Recipient,
Subject, Kind, Status, Attempts, Last error, Next attempt and Created.
Nothing from the Queue Health page appears on it.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminScreens.spec.ts:Email Queue shows its filters, its actions and its table`

**Deferred:** #631 — 7b — /admin/email-queue loads and lists its jobs with no error — `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts`

### R2. Memes still generate end to end

**Do:** Generate a meme end to end.

**Expect:** The queue's behaviour is unchanged.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 3: the baseline fact's review renders run through the image-prompt and image-generation queues to done with decodable images

**Deferred:** #628 — Phase 4 (Cut and prune) — journey 6 recording the generate-to-image_ready duration in its evidence and failing over a stated bound, as the 10-minute poll proves only eventual completion. Killed: the route it runs through is called only by the legacy meme studio, which is deleted for launch (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*); #628 — Phase 4 (Cut and prune) — the paid user's render job reaching image_ready and the meme saving from it. Killed: journey 6 ran the user generate route, which only the legacy meme studio calls, and is removed with it (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*)

### R3. Enrichment / send-back / Taxonomy Health actions still run

**Do:** Run an enrichment / send-back / Taxonomy Health action.

**Expect:** Unchanged.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 3: provisional-approve runs enrichment then Visual Ideas to concept_review; `artifacts/api-server/src/__tests__/routes.sendBackToReview.test.ts:starts a refresh cycle: candidate + new review, createdBy = the admin, ids echoed`; `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.actions.test.ts:Repair projections resolves inline with terminal outcomes`; `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.actions.test.ts:Re-enrich with forceOverwriteAdminEdited queues a concrete job` (queued only)

**Deferred:** #631 — 7b — a Re-enrich job queued through /api/admin/taxonomy-health/actions/backfill-enrichment reaching done in /api/admin/taxonomy-health/job-status after the worker runs it — `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.actions.test.ts`

### R4. The admin sidebar gains only Queue Health

**Do:** Look at the admin sidebar.

**Expect:** New "Queue Health" item present; every existing item still
present and working.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts:renders inside the admin console for an admin`

**Deferred:** #631 — 7b — every pre-existing sidebar item still present with its route, Queue Health sitting after Email Queue — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### R5. The new endpoints are admin-gated

**Do:** Visit both new admin endpoints as a non-admin user.

**Expect:** Both are admin-gated — nothing new appears for a non-admin
user.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.admin.auth.test.ts:GET /admin/queue-health`; `artifacts/api-server/src/__tests__/routes.admin.auth.test.ts:GET /admin/queue-health/jobs`

### R6. No new database connection errors appear

**Do:** Watch for database connection errors anywhere in the app while
testing.

**Expect:** None. The per-instance connection ceiling went from an
implicit 10 to an explicit 20 — a real latent problem, since the five
lanes could want 10 connections at once with zero spare. If anything
anywhere starts reporting database connection errors, that's the one
place this PR could plausibly bite.

**Lane:** live

**Check:** `Sentry search_errors for database connection errors since the deploy`, or ask Replit to grep the app logs for `connection` errors (read-only)

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
