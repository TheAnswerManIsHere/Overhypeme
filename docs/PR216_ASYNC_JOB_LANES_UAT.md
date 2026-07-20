# PR216 — Async-Jobs Worker Lanes · UAT

**What changed, in one line:** admin actions that used to sit in a "Queued…"
spinner for 30+ seconds now clear in a couple of seconds, because the background
job worker no longer makes fast jobs wait in line behind slow ones.

**Why it was slow:** every kind of background job — cheap database updates AND
slow AI/image renders — shared one worker that processed them in one queue. A
5-millisecond "Send back to review" could get stuck behind a minute-long image
render that happened to be ahead of it. Now there are three separate lanes that
run independently, so a cheap job never waits on a slow one.

This is the exact behavior you reported on **Taxonomy Health "Send back to
review"** and on the **moderation "test render"**.

Reference: `docs/PR216_ASYNC_JOB_LANES_TEST_RUN.md` (engineering checklist).

---

## Part A — "Send back to review" is fast again (~2 minutes)

1. Go to **Admin → Taxonomy Health**.
2. (Optional, to make the old bug reproducible) first kick off some slow
   background work: click **Send next 50 stale**, or open a fact and fire a
   couple of moderation **test renders**, so the queue has slow jobs running.
3. Now click **Send back to review** on any single stale fact row.
4. **Expect:** the row's status goes to **Queued…** and clears to **Done / Refresh
   in review** within **a few seconds** (roughly one or two blinks), *even while*
   the bulk work from step 2 is still going.
5. **Do NOT expect:** a spinner that sits on "Queued…" for 20–30+ seconds. That
   was the bug.

## Part B — Moderation test renders start promptly (~2 minutes)

1. Go to **Admin → Moderation**, open a fact in review, and open the AI render /
   "test render" panel.
2. If you have a big **Send next 50 stale** batch running in the background, good —
   that's the stress case.
3. Fire a **test render**.
4. **Expect:** it begins working (spinner → image or status update) on its own
   timeline, **without waiting** for the bulk backfill batch to finish first.
5. **Do NOT expect:** the render to sit idle until the unrelated bulk batch drains.

## Part C — Everything still finishes correctly (~2 minutes)

1. Let a **Send next 50 stale** run go to completion.
2. **Expect:** each fact still shows its own per-row status (Queued → Done /
   Skipped / Refresh in review), the aggregate progress line still counts up, and
   the corpus-remaining count still updates — exactly as before. Only the *speed*
   of the fast actions changed, not what any of them do.

## Part D — Edge cases worth clicking

- **Send back a fact that's already in review** → still shows "Refresh already in
  review" (skipped), not an error.
- **Rapidly click Send back on several different rows** → each row lights up and
  clears on its own; they don't block each other.
- **Email / notifications** (if you exercise anything that sends email) → still
  sends; email now rides the "bulk" lane (~5s poll), unchanged in behavior.

## Part E — Regression smoke (existing behavior unchanged)

| Area | Do | Expect |
|---|---|---|
| Bulk send-back | Send next 50 stale | Per-row + aggregate status as before; all resolve |
| Single re-enrich / projection repair | Trigger from a row | Row shows status, resolves |
| Moderation renders | Fire 3–4 scenario renders | All run (still in parallel), each shows live status |
| Nothing running | Idle on Taxonomy Health | No spinners stuck; no console errors |

---

## Bug report template

If something's off, capture:

- **Which action** (row send-back / bulk send-back / test render / other) and
  **where** (Taxonomy Health / Moderation).
- **What the spinner did** — how long "Queued…" stayed, and what it settled to
  (Done / Failed / still spinning).
- **Was slow background work running at the same time?** (e.g. a Send-next-50 batch
  or renders.)
- **Screenshot** of the row/panel, and the approximate time, so the server log can
  be matched.
- Anything in the browser console (red errors).

## Known limitations (NOT bugs)

- **A completed job doesn't always resolve the health issue.** As before, the
  refreshed list is the source of truth — a fact can still appear after its action
  finishes.
- **Slow jobs are still slow.** This change removes *waiting in line*; it does not
  make an AI render or enrichment itself faster. A test render still takes as long
  as the model takes.
- **Very large bulk batches still drain over time.** The fast lane is instant, but
  a 50-fact bulk enrichment is still background work that finishes progressively —
  you'll see it count up, not complete instantly.
- **Under heavy simultaneous load**, all lanes share one database connection pool;
  if you ever see everything slow at once (not just one lane), note it — that's a
  pool-capacity signal we're deliberately watching, separate from this fix.
