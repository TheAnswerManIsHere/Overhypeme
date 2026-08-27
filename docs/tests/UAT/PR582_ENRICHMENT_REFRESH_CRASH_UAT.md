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

Step 4 is the one that matters most — a fact that actually carries a visual
override, which is the case that was breaking. Step 5 is there because the fix
made the override reader more forgiving, and "more forgiving" must not have
turned into "reports overrides that aren't there."

## Setup

- [claude] Confirm `main` is synced to the Repl and the checked-out SHA matches the merge commit, before anything else is read.
- [claude] Capture the `enrichment` lane's job counts on Admin → Queue Health, so the "after" reading has a "before" to be measured against.
- [claude] Capture the count of facts whose stored visual override is missing a list field — the true size of the affected corpus.
- [david] Sign in to the admin console as yourself; step 3 and step 4 need admin actions under your own account.
- [restore] None of the above writes. Step 3 and step 4 send facts back for a refresh, which is ordinary admin work and is deliberately not reverted — the resulting candidates go through normal moderation.

## Steps

### 1. The stuck backlog drains on its own

**Do:** Go to **Admin → Queue Health** and find the `enrichment` lane.

**Expect:** The queued count is lower than the number I captured in setup, or is
0; `failed` reads `0`; and no listed job shows the text
`Cannot read properties of undefined (reading 'forEach')`.

### 2. The stuck facts clear on the Moderation screen

**Do:** Go to **Admin → Moderation** and read the banner at the top plus the
rows that were showing `AI prep running`.

**Expect:** The "N facts are in AI prep" count is lower than it was in setup,
and at least one row that was stuck on `Preparing…` now reads
`Renders ready — needs review` with an `Enrichment ✓ ready` pill.

### 3. A fresh send-back completes end to end

**Do:** Go to **Admin → Taxonomy Health** and send one stale fact back for
refresh. If the "Send back to review" button is not offered on any row, first go
to **Admin → Moderation** and decline one refresh review — that returns its fact
to eligible. Then watch that fact's row on **Admin → Moderation**.

**Expect:** The row moves from `AI prep running` / `Preparing…` to
`Renders ready — needs review` with `Enrichment ✓ ready`, without sitting on the
spinner indefinitely.

### 4. A fact carrying a moderator visual override refreshes

**Do:** Open a fact that has a visual-strategy override with content in it — a
core scene, a required visual detail, or a speech bubble — and note what that
override says. Send that fact back for a refresh from **Admin → Taxonomy
Health**, then watch it on **Admin → Moderation**.

**Expect:** It reaches `Renders ready — needs review` with `Enrichment ✓ ready`,
and reopening its enrichment editor shows the same override content you noted
before the refresh, word for word.

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
- **Jobs that had already burned all 5 retry attempts before the merge** will
  sit in `failed` rather than draining. That is expected — re-running them is a
  deliberate call, not something the fix does automatically.
