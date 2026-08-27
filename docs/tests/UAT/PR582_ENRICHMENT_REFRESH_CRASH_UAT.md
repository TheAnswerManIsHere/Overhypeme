# PR #582 — Facts sent back for a refresh finish their AI prep — UAT

**Workstream:** #579

Every fact sent back for a refresh went into "AI prep" and never came out — the
enrichment job behind it died instantly, and the stuck set only grew (4 facts at
9:24 PM, 7 by 9:42 PM). Live facts were never affected, because a refresh only
writes to a candidate until it is promoted; the damage was that the refresh
pipeline was stalled and the stale-fact backlog could not be worked down at all.

The crash was in the code that reads a fact's moderator visual override. Older
stored overrides are missing fields that were added to the format later, and
reading one of those killed the job. Two places now handle that: the reader
normalizes before checking, and the shared function tolerates a partial value.

**Step 3 is the load-bearing one**, not step 1. A fresh send-back enqueues a job
that runs immediately, so it gives a clean answer within a minute. The
already-stuck backlog is on an exponential retry schedule (5 min, 30 min, 2 h,
8 h) that syncing new code does **not** reset — so a job on attempt 2 may sit
untouched for half an hour while the fix is working perfectly. Step 1 is written
to account for that rather than read it as a failure.

**Where a successful refresh actually lands:** enrichment finishing advances the
review to concept review and enqueues visual-idea generation. Renders do not
start until a moderator approves the concept. So the success signal here is
`Enrichment ✓ ready` plus a concept-stage label — **not** "Renders ready — needs
review", which is two moderator actions further down the pipeline.

## Setup

- [claude] Confirm `main` is synced to the Repl and the checked-out SHA matches the merge commit, before anything else is read.
- [claude] Capture the `enrichment` lane's job counts from Admin → Queue Health — queued, working, done and **failed** — so every "after" reading has a "before" to be measured against.
- [claude] Capture each stuck job's attempt number and its `next_attempt_at`, so step 1 can tell "still inside its backoff window" apart from "not retrying".
- [claude] Capture the count of facts whose stored visual override is missing a list field — the true size of the affected corpus.
- [david] Sign in to the admin console as yourself; steps 3, 4 and 6 need admin actions under your own account.
- [restore] None of the captures above writes anything. Steps 3 and 4 send facts back for a refresh and step 6 edits one override — all ordinary admin work, deliberately not reverted; the resulting candidates go through normal moderation.

## Steps

### 1. No job is still dying on the old error

**Do:** Go to **Admin → Queue Health**, find the `enrichment` lane, and read it
against the counts I captured in setup.

**Expect:** No job whose retry has already come due still carries
`Cannot read properties of undefined (reading 'forEach')`, and the `failed`
count is no higher than the number captured in setup. A queued count that has
not moved is **not** a failure on its own — check it against the captured
`next_attempt_at` times first; jobs still inside their backoff window have not
been retried yet.

### 2. The stuck facts start clearing on the Moderation screen

**Do:** Go to **Admin → Moderation** and read the banner plus the rows that were
showing `AI prep running`.

**Expect:** At least one row whose retry has come due has left `Preparing…` and
now shows `Enrichment ✓ ready` with a concept-stage label —
`Generating visual ideas…` or `Ready for concept review`. Rows still inside
their backoff window may legitimately still read `Preparing…`.

### 3. A fresh send-back completes end to end

**Do:** Go to **Admin → Taxonomy Health** and send one stale fact back for
refresh. If the "Send back to review" button is not offered on any row, first go
to **Admin → Moderation** and decline one refresh review — that returns its fact
to eligible. Then watch that fact's row on **Admin → Moderation**.

**Expect:** Within about a minute the row leaves `Preparing…` and shows
`Enrichment ✓ ready` alongside `Generating visual ideas…` or
`Ready for concept review`. It does not sit on the `Preparing…` spinner, and
Queue Health shows no new job carrying the `forEach` error.

### 4. A fact carrying a moderator visual override refreshes

**Do:** Open a fact that has a visual-strategy override with content in it — a
core scene, a required visual detail, or a speech bubble — and note what that
override says. Send that fact back for a refresh from **Admin → Taxonomy
Health**, then watch it on **Admin → Moderation**.

**Expect:** It reaches `Enrichment ✓ ready` with a concept-stage label, exactly
as in step 3, and reopening its enrichment editor shows the same override
content you noted before the refresh, word for word.

### 5. An empty override is still reported as empty

**Do:** Open the enrichment editor for a fact that has **no** visual override,
or one whose override is an empty scaffold.

**Expect:** No "manual override" / visual-override signal is shown for it. (Step
4 already confirmed the opposite case — a fact with content still shows one.)

### 6. Saving a visual override still works

**Do:** In the enrichment editor for any fact, add or edit a required visual
detail on its visual override and save.

**Expect:** The save succeeds with no error, and reopening the editor shows the
edited value.

## Regression

### R1. A brand-new submission still enriches

**Do:** Submit a new fact through the normal submission flow and watch it on
**Admin → Moderation**.

**Expect:** It reaches a classified state with `Enrichment ✓ ready`, exactly as
before this PR.

### R2. The enrichment editor still opens on a normal fact

**Do:** Open **Admin → Moderation**, pick any fact with completed enrichment and
open its enrichment editor.

**Expect:** The editor loads with its classification fields populated — archetype,
subtype, fit — and no error banner.

### R3. PR216 step 3 is reachable again

**Do:** Return to the UAT run in #562 and attempt **PR216 step 3, "bulk run
finishes correctly"**.

**Expect:** The step can actually run — sent-back facts resolve rather than
hanging, so the step reaches a real pass or fail on its own merits instead of
being blocked.

## Not bugs

- **A crashed enrichment job shows an indefinite `working…` spinner** on
  Admin → Moderation and never surfaces its error; the error text only ever
  appeared on Queue Health. Recorded on #579 as a separate defect, not fixed
  here. If you see a job that is genuinely stuck while the screen still says
  "working", that is this gap.
- **The worker reports only an error message and discards the stack trace**,
  which is why this crash was diagnosable only by cross-referencing a Sentry
  event from the admin route. Also recorded on #579, also not in scope.
- **Two places still copy a stored override without validating it**
  (`enrichmentVersioning.ts`, `enrichmentJobs.ts`). Neither is on this crash's
  path now that both fixes are in. Whether to validate on write rather than
  tolerate on read is an open question on #579, deliberately not decided here.
- **Jobs that had already burned all 5 retry attempts before the merge** sit in
  `failed` and never drain. That is expected, which is why step 1 compares the
  failed count against the captured pre-state rather than requiring zero.
  Re-running those is a deliberate call, not something the fix does.
- **A refresh that succeeds does not produce renders.** It stops at concept
  review by design — renders wait for a moderator to approve the concept. A row
  sitting at `Ready for concept review` is a **passed** refresh, not a stalled
  one.
