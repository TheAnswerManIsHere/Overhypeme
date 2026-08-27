# PR582 — Refresh-seeded enrichment no longer crashes · UAT

**PR:** #582 · **Workstream:** #579 · **Mode:** bugfix, Tier B

## What broke, in one line

A fact sent back for a refresh went into "AI prep" and never came out — every
enrichment job it queued died instantly, and the stuck set only grew.

## What you are checking

That a fact sent back for a refresh **completes** its enrichment and reaches
"Renders ready — needs review", including facts carrying a moderator
visual-strategy override. And that nothing about how overrides behave changed
along the way — this was a read-side tolerance fix, not a change to what an
override means.

## Before you start

Run `/uat` and I will drive this step by step, do the setup, and file anything
that breaks. You should not need to run a command yourself at any point.

**Setup I own:** confirming `main` is synced to the Repl and reading the
enrichment queue's pre-state so the "after" reading means something. Nothing is
written to the database by setup.

**One thing to know before step 1:** the jobs stuck from #579 retry on their own
5-attempt budget. After the sync they should drain without anyone re-enqueueing
them. If some had already burned all 5 attempts before the merge they will sit
in `failed` — that is expected, not a regression, and re-running them is your
call, not something the fix does automatically.

---

## Step 1 · The stuck backlog drains on its own

1. Go to **Admin → Queue Health**.
2. Find the `enrichment` lane.

**Pass:** the queued count is falling, or has reached 0, and `failed` is still
`0`. No job carries `Cannot read properties of undefined (reading 'forEach')`.

**Fail:** any job still carries that message, or `failed` is climbing.

> The pre-merge reading was `9 queued · 1 working · 1 done · 0 failed`, with ten
> of eleven jobs carrying the error. I will capture the current numbers as we go
> so there is a before and after on the record.

---

## Step 2 · The stuck facts clear on the Moderation screen

1. Go to **Admin → Moderation**.
2. Look at the banner and the rows that were showing `AI prep running`.

**Pass:** the "N facts are in AI prep" count is **falling**, and rows that were
stuck on `Preparing… / Enrichment ⟳ working…` now read
`Renders ready — needs review` with `Enrichment ✓ ready`.

**Fail:** the count is flat or climbing, or a row sits on `working…` with no
movement across several minutes.

> The count climbed 4 → 7 during the original failure. Falling is the signal.

---

## Step 3 · A fresh send-back completes end to end

This is the real test — the backlog draining could in principle be old jobs
finishing for some other reason. This one starts clean.

1. Go to **Admin → Taxonomy Health**.
2. Send back a stale fact for refresh. If nothing is eligible, decline a refresh
   review in Moderation first to free one up (that is the documented reset
   lever — it marks the candidate `rejected` and leaves the live fact alone).
3. Watch that fact on **Admin → Moderation**.

**Pass:** it moves through `AI prep running` and lands on
`Renders ready — needs review` with `Enrichment ✓ ready`. It does not sit
spinning.

**Fail:** it sticks in `Preparing…`, or Queue Health shows a new errored job.

---

## Step 4 · A fact with a moderator visual override still refreshes

The crash was specifically in the visual-override read path, so a fact that
actually has one is the case that mattered.

1. Find or set up a fact carrying a **visual-strategy override** — a core scene,
   a required visual detail, a speech bubble, any of it.
2. Send that fact back for a refresh.

**Pass:** it completes exactly like step 3, **and** its override is still intact
afterwards — open the enrichment editor and confirm the override content you
saw before the refresh is still there, unchanged.

**Fail:** it crashes, or any part of the override content is missing, emptied,
or reworded.

> This is the "must not change" check. The fix reads these blobs more
> tolerantly; it must not have rewritten one.

---

## Step 5 · Overrides still behave the way they did

A spot check that the tolerance fix did not quietly change what an override
*means*.

1. Open a fact with a visual override in the enrichment editor.
2. Confirm the "this fact has a manual override" signal is still shown for it.
3. Open a fact with **no** override, or an empty one.

**Pass:** the override signal shows for the fact that has content and does
**not** show for the empty one. Editing and saving an override still works
normally.

**Fail:** the signal appears on facts with nothing in them, disappears from
facts that have content, or saving an override errors.

---

## Step 6 · Return to what this was blocking

#579 blocked the UAT backlog burn-down (#562) at **PR216 step 3** — "bulk run
finishes correctly". With enrichment working, that step can be attempted again.

**Pass:** PR216 step 3 can now run — sent-back facts resolve, so the step is
reachable whether or not it then passes on its own merits.

**Fail:** it is still blocked on enrichment.

> Whether PR216 step 3's per-row and aggregate *display* is separately correct
> was never established — it may simply have been hidden behind this crash. If
> it now fails on display grounds, that is a **new** finding and gets its own
> issue, not a reopening of #579.

---

## If something fails

Stop and tell me at the step. I will capture the evidence, file the bug, and
say what the way back is. A failed UAT is a follow-up PR on a fresh branch, not
a revert — `main` is not broken here.

## Known gaps, already recorded — not failures of this UAT

Both are on #579, filed rather than fixed under this bugfix:

- **A terminally-broken enrichment job renders as `working…` indefinitely** on
  Moderation and never surfaces its error. If you see a job that is genuinely
  stuck but the screen still says "working", that is this gap, not a new bug.
- **The worker reports only the error message and discards the stack trace**,
  which is why Queue Health could show the text but not the frame that made it
  diagnosable.

Two further **unvalidated copy points** (`enrichmentVersioning.ts`,
`enrichmentJobs.ts`) read a stored override the same raw way. Neither is on this
crash's path. Deferred and undecided — flagged so a later crash in that shape is
recognised immediately rather than re-diagnosed from scratch.
