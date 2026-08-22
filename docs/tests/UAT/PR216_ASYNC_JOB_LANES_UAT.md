# PR #216 — Async-Jobs Worker Lanes — UAT

Admin actions that used to sit in a "Queued…" spinner for 30+ seconds now
clear in a couple of seconds, because the background job worker no longer
makes fast jobs wait in line behind slow ones.

Every kind of background job — cheap database updates and slow AI/image
renders — used to share one worker that processed them in one queue. A
5-millisecond "Send back to review" could get stuck behind a minute-long
image render that happened to be ahead of it. Now there are three separate
lanes that run independently, so a cheap job never waits on a slow one.

This is the exact behavior you reported on **Taxonomy Health "Send back to
review"** and on the **moderation "test render."**

## Setup

- [david] Sign in as an admin.

## Steps

### 1. "Send back to review" clears fast even under load

**Do:** Go to Admin → Taxonomy Health. Kick off slow background work
first (click **Send next 50 stale**, or open a fact and fire a couple of
moderation **test renders**), then click **Send back to review** on any
single stale fact row while that background work is still running.

**Expect:** the row's status goes to **Queued…** and clears to **Done /
Refresh in review** within a few seconds (roughly one or two blinks),
even while the bulk work is still going. It must not sit on "Queued…" for
20–30+ seconds — that was the bug.

### 2. A test render starts promptly under load

**Do:** Go to Admin → Moderation, open a fact in review, open the AI
render / "test render" panel — ideally with a big **Send next 50 stale**
batch running in the background — and fire a **test render**.

**Expect:** it begins working (spinner → image or status update) on its
own timeline, without waiting for the unrelated bulk backfill batch to
finish first.

### 3. A bulk run still finishes correctly

**Do:** Let a **Send next 50 stale** run go to completion.

**Expect:** each fact still shows its own per-row status (Queued → Done /
Skipped / Refresh in review), the aggregate progress line still counts
up, and the corpus-remaining count still updates — exactly as before.
Only the speed of the fast actions changed, not what any of them do.

### 4. Sending back a fact already in review is skipped, not an error

**Do:** Click **Send back** on a fact that's already in review.

**Expect:** it still shows "Refresh already in review" (skipped), not an
error.

### 5. Rapid clicks on different rows don't block each other

**Do:** Rapidly click **Send back** on several different rows.

**Expect:** each row lights up and clears on its own; they don't block
each other.

### 6. Email still sends, on the bulk lane

**Do:** Exercise anything that sends email.

**Expect:** it still sends; email now rides the "bulk" lane (~5s poll),
unchanged in behavior.

## Regression

### R1. Bulk send-back resolves

**Do:** Run **Send next 50 stale**.

**Expect:** per-row and aggregate status behave as before; all rows
resolve.

### R2. Single re-enrich / projection repair resolves

**Do:** Trigger a single re-enrich or projection repair from a row.

**Expect:** the row shows status and resolves.

### R3. Moderation renders run in parallel

**Do:** Fire 3–4 scenario renders.

**Expect:** all run (still in parallel), each showing live status.

### R4. Idle Taxonomy Health has no stuck state

**Do:** Sit idle on Taxonomy Health with nothing running.

**Expect:** no spinners stuck, no console errors.

## Not bugs

- **A completed job doesn't always resolve the health issue.** As before,
  the refreshed list is the source of truth — a fact can still appear
  after its action finishes.
- **Slow jobs are still slow.** This change removes *waiting in line*; it
  does not make an AI render or enrichment itself faster. A test render
  still takes as long as the model takes.
- **Very large bulk batches still drain over time.** The fast lane is
  instant, but a 50-fact bulk enrichment is still background work that
  finishes progressively — you'll see it count up, not complete
  instantly.
- **Under heavy simultaneous load,** all lanes share one database
  connection pool; if you ever see everything slow at once (not just one
  lane), note it — that's a pool-capacity signal being watched
  separately, apart from this fix.
