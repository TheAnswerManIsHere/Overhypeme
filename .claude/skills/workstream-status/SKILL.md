---
name: workstream-status
description: Give David a cold-open summary of every open workstream — where each stands in the lifecycle, who's holding it, and which ones are stalled or need his input. Use when David says /workstream-status, "what's the state of things", "what needs me", or is picking a session back up after time away and doesn't remember where he left off. Best run from a fresh, cheap session rather than an existing long thread.
---

# /workstream-status — the workstream board, read cold

David runs ~10 concurrent sessions across Discovery → Planning →
🛑 Plan approval → Coding → Code review → 🛑 Merge → Test run →
🛑 UAT → Close-out. He can't tell which sessions need him without opening
each one. This skill answers that from **outside** any of them, using
GitHub as the shared substrate — no session memory required, which is why
it works cold in a brand-new session and shouldn't be run inside a long
existing thread (that burns the wrong session's context for no benefit).

**Named `/workstream-status`, not `/status`**, because `/status` is
Claude Code's own built-in command (opens the Settings Status tab) — using
that name would make this skill unreachable through its intended trigger.

**This is a read-only reporting skill.** It never writes labels, comments,
or issue bodies — that's `pr-watch`, `plan-review-loop`, `bugfix`, and
`pr-docs`'s job at the moments those already fire, plus one automated
exception outside any agent session: `test-run-completion.yml` writes the
`stage:test-run` → `stage:uat`/`stage:close-out` transition itself.

## Why this reads issues + labels, not the Project board

No tool available to me can read *or* write GitHub Projects v2 item field
values — confirmed by direct search when building the sync mechanism
(`scripts/sync-project-fields.mjs`, PR #318/#322). Labels are the actual
source of truth; the Project board is a projection of them for David's
visual scanning. So this skill recomputes the same view the board shows,
directly from labels — it doesn't (can't) query the board itself. If the
board and this report ever disagree, the board is stale and labels are
right (or the sync Action needs a look).

## What this cannot see

**Work with no issue yet.** A pure Discovery conversation that hasn't
produced an issue is invisible to GitHub entirely — this is a structural
gap, not a bug in this skill. If a `/workstream-status` run feels like
it's missing a session David knows is active, that session hasn't opened
its workstream issue yet. Mention this possibility in the report if the
count looks low relative to what David expects.

**Sensitive/disclosure-carve-out workstreams.** Per the plan-review-loop's
disclosure rule, those live as draft Project items, not issues, precisely
because this repo is public. They're deliberately invisible to any
tool-based report, including this one.

## Step 1 — Fetch every open workstream issue

Page through **all** open issues, not just the first page — a single
capped call silently drops any workstream past the page boundary, and a
missing row reads as "nothing needs attention," the opposite of what this
report promises:

```
list_issues(owner, repo, state: OPEN, perPage: 100,
            fields: [number, title, labels, updated_at])
# repeat with pagination until the response is exhausted
```

Filter out anything without a `stage:` label — that's not a workstream
issue (shouldn't happen if `/document`, `bugfix`, and plan-review-loop are
tagging correctly, but don't assume).

For each issue, parse its labels the same way `sync-project-fields.mjs`
does:
- `stage:*` → lifecycle stage (exactly one; more than one is a real data
  error — flag it in the report rather than silently picking one)
- `waiting:*` → who's holding it (david / claude / codex / replit / ci)
- `mode:*` → feature / bugfix / docs / devops

## Step 2 — Fetch sub-issues, then deduplicate the top-level set

For every workstream issue, call `issue_read` (`method: get`) — this same
call already returns `has_children` **and** `has_parent`/`parent`, so check
both, not just the downward direction. Where `has_children` is true,
`get_sub_issues` to pull the children (e.g. a `/document` harvest nested
under its parent feature). **Filter the returned children to `state: OPEN`
before rendering** — `get_sub_issues` returns closed children too (e.g. a
harvest sub-issue that finished and closed while its parent stayed open
through UAT), and this is a report of *open* work, so a closed child
should render as neither a nested row nor inflate any count. An open
sub-issue is its own row with its own `stage:`/`waiting:` labels — render
it nested under its parent, not flattened into the top-level list.

**An open issue can have a parent that's already closed** — a
documentation-harvest sub-issue can outlive its feature (the parent closes
first, the harvest lags a little). Downward traversal alone misses this:
Step 1 only fetched *open* issues, so a closed parent was never in that
set for `get_sub_issues` to be called on. Use `has_parent`/`parent` from
this same call instead — if an open issue has a parent not present in the
Step 1 set, render it nested under a note naming that closed parent rather
than as an unrelated top-level workstream.

**Remove every issue returned by `get_sub_issues` (open or closed), and
every issue nested under a closed parent via `has_parent`/`parent`, from
the Step 1 set** before rendering the top-level fleet view. Step 1 fetches
*every* open issue with a `stage:` label, which already includes labeled
sub-issues — without this removal, a nested-either-way open child appears
twice (once nested, once again as its own top-level row) and the section
counts are wrong. The closed-parent path needs this exact same removal:
it's still an open issue nested by the paragraph above, just discovered
upward instead of downward, and the dedup rule applies to it identically.
(A closed child of an open parent was never in the Step 1 set to begin
with, since Step 1 only fetches open issues — that specific case needs no
removal, but every other nested case does.)

## Step 3 — Find each workstream's PR(s) and its full activity

There is no GitHub-native issue↔PR link here, because PR bodies say
`Workstream: #N`, never `Closes #N` (deliberately — the latter would
auto-close the issue at merge and skip UAT). So:

```
list_pull_requests(owner, repo, state: all, sort: updated, direction: desc,
                    perPage: 50,
                    fields: [number, title, body, state, draft,
                             mergeable_state, html_url, updated_at, merged_at])
```

One call, not one per issue — regex `^Workstream:[ \t]*#(\d+)` (multiline,
anchored to the start of a line, matching `sync-test-run-completion.mjs`'s
`extractWorkstreamIssueNumber`) out of each body to build the issue→PR map
locally. The anchor matters: an unanchored `Workstream:\s*#(\d+)` can cross
a line break (`\s` matches newlines) and grab an unrelated `#N` several
lines later, or match an example embedded in prose (an approved-plan
oracle illustrating the convention, say) as if it were the real marker —
either misfire links the wrong PR to the wrong issue. Bounding to the
most-recently-updated 50 is intentional for the common case: an *active*
workstream's PR is recent by definition, so one batched call covers nearly
everyone.

**More than one PR can carry the same marker for one issue over its
lifetime** — most commonly a closed `[PLAN REVIEW]` draft PR from Planning
alongside the later, real implementation PR once Coding opens. When the
map-building finds multiple matches for one issue number, don't take
whichever came first or last in the list: prefer an **open** PR over a
closed one (a closed plan-review PR is superseded evidence, not the
current state — its CI/comments/activity belong to a phase that's over),
and if more than one is open, the most recently updated. Only fall back to
a closed PR if it's the *sole* match **and the issue is at `stage:planning`
or `stage:plan-approval`** — that's the honest signal for an issue still
in Planning with no implementation PR yet, not a stale one. At
`stage:coding` or later, a sole match that's closed and unmerged is the
*obsolete* plan-review PR outliving its usefulness, not the current
state — treat the issue as having no linked PR instead (Step 4's no-PR
path, using its own comment history) rather than computing status from a
thread that belongs to a phase that's already over.

**Once the implementation PR itself merges, both matches are closed** — the
plan-review PR (never merged, per `plan-review-loop`'s own contract) and
the now-merged implementation PR. Both show `state: closed` alone, so tell
them apart by `merged_at` (non-null only for the real implementation PR) —
this is exactly why the batched call above requests it. A closed
`[PLAN REVIEW]` PR is definitionally unmerged, so among multiple closed
matches prefer the one with a non-null `merged_at`; it's the real
implementation history (UAT status, CI, comments) an issue at Merge/Test
run/UAT/Close-out needs, not the plan-review artifact. Most recently
merged/updated among ties, same as the
open case.

**But recency isn't proof of "no PR" for a workstream at a long-lived
gate.** An issue sitting at `stage:merge`/`stage:uat`/`stage:close-out`
for a while is exactly the kind of thing that stops generating new PR
activity — its own PR isn't updating, so 50 *other*, busier PRs (routine
bugfixes, devops, docs) can push it off the page even though it's still
genuinely linked. Don't treat every issue the top-50 scan didn't match as
stalled: for any workstream at a stage that structurally implies a PR
should already exist — **`planning` onward**, not just `coding` onward: a
`[PLAN REVIEW]` draft PR opens while the issue is still at
`stage:planning` per `plan-review-loop`'s own contract, so Planning is
not PR-less by default either — with no match in the map, do one targeted
lookup instead of assuming — search for `"Workstream: #<N>"` in PR bodies
(`search_pull_requests`, query `"Workstream: #<N>" in:body
repo:<owner>/<repo>`) before concluding it's actually unlinked. This only
fires for the rare case the batched scan missed, so it stays cheap in the
common case while closing the gap for long-lived gates.

For any workstream issue with a linked PR, pull live state in one batched
call: `pull_request_read` (`get_status` for CI, `get_review_comments` for
open threads, `get_comments` for top-level issue comments, **and
`get_commits` for attributable push history**) — same discipline as
`pr-watch`, minimal calls, no per-thread narration in the output.
**Page `get_commits`, `get_review_comments`, and `get_comments` to
exhaustion**, the same way Step 1 pages through issues — a review loop
that's gone several rounds can exceed one page of any of these (see
`scripts/loop-metrics.mjs`'s own pagination for real examples), and a
single capped call can silently return an incomplete prefix that's
missing the most recent commit or reply. Since Step 4 picks the *latest*
item across these three collections, an incomplete page doesn't just
under-report — it can make an active workstream look stalled. `get_comments`
matters here, not just for completeness: this repo's Codex loop delivers
some events — a clean re-review pass, an `@codex review` trigger — as
plain issue comments rather than inline review threads
(`scripts/loop-metrics.mjs`'s own derivation has to handle this same
shape). Skipping `get_comments` makes those events invisible, which can
misreport who's actually holding a workstream. `get_commits` matters for
Step 4's stall detection: a PR's raw `updated_at` advances on *any*
update — including a relabel or a David edit with no comment — but
carries no actor, so it can't tell you who moved it last. Commit
authorship can.

## Step 4 — The judgment layer (this is the actual point)

GitHub's board can show a static Status/Waiting-on value. It cannot tell
David *why* something is stuck or *what exactly* he's being asked. That's
what turns this from "a slower way to read the board" into something
worth running.

### Stalled detection

A workstream is **stalled** when `waiting` is NOT `david` (a David-gate is
"needs you," a more urgent bucket — never double-count it as stalled) and
there has been no relevant activity — no new commit, no Codex comment, no
reply from Claude — for **more than 48 hours**.

**A GitHub login match is not proof David personally acted — I post
through David's own GitHub account in this environment, not a separate
bot identity.** Every reply, review comment, and commit I make in this
repo appears under `TheAnswerManIsHere`'s login (confirmed by this very
PR's own reply-thread history, and by the MCP fixture in
`scripts/__tests__/loop-metrics.test.mjs`). Filtering "authored by David"
by login alone therefore misclassifies every one of my own responses as
David's — discarding real activity and reporting an active, answered
thread as stalled, the opposite of what this filter exists to catch. Tell
them apart by **content, not login**: a comment or review I post carries
the Claude Code attribution footer (`_Generated by [Claude Code]`), and a
commit I make carries a `Co-Authored-By: Claude` trailer (this repo's own
convention for both) — either signature means it's my action, genuine
non-David activity, even though the author field reads David. Only an
item with David's login **and no such signature** is David's own act.
This applies everywhere "exclude David" appears below.

**Compute the activity timestamp from the latest *attributable, non-David*
action** (per the distinction above) — the newest of: the latest commit's
author + date (`get_commits`), the latest review comment's author +
timestamp (`get_review_comments`), and the latest issue comment's author +
timestamp (`get_comments`), all from step 3. **Never use the PR's raw
`updated_at` as an activity signal on its own** — it advances on any
update (a relabel, a David edit with no comment) but carries no author, so
it can't be attributed to "David" or "not David" at all; treat it only as
a fallback when none of the three attributable sources above yield
anything (e.g. a brand-new PR with no commits fetched yet). A
`waiting:claude`/`waiting:codex` thread that David pinged after it had
already gone quiet is exactly the stale handoff this report exists to
catch; using David's ping — or the `updated_at` bump it causes — as the
activity timestamp resets the 48-hour clock and hides it. If David *was*
the last person to act (e.g. he already answered and nobody has picked it
up since), still report that fact plainly — just don't let his own
activity mask a stale non-David handoff underneath it.

**A workstream with no linked PR can stall too** — this isn't limited to
Discovery/Planning: any workstream Step 3 confirms has no linked PR
(including a genuinely PR-less Coding-stage issue, e.g. before its
implementation PR has opened) sitting at `waiting:claude`/`waiting:codex`
with no repo activity for days is stalled the same way a quiet PR thread
is. For these, apply the **same attributable, non-David filtering as the
PR path above** (the login-vs-signature distinction included) to the
issue's own comment history (`issue_read`, **paged to exhaustion, same as
the PR path's `get_commits`/`get_review_comments`/`get_comments`**), not
its raw `updated_at` alone. A single capped page can omit the latest
non-David reply the same way an unpaged PR call can, and mis-mark an
active issue stalled or attribute the last move to the wrong actor. A
David comment, label edit, or body edit advances `updated_at` the same
actorless way a PR's does, and would reset this clock and hide the same
stale handoff the PR path is designed to expose — don't let "no PR yet"
mean "can't be stalled," since a workstream that never gets a PR shape
stalls in exactly the same way, just on a different object. **If the
paged comment history is empty** (an issue freshly opened with nothing
posted since), fall back to the issue's own `created_at` as the baseline
activity event — otherwise there's no timestamp to measure the 48-hour
threshold against at all, and a workstream that's sat untouched since
creation could never be flagged.

This catches both directions: `waiting:codex` with no Codex response
(review hasn't landed) *and* `waiting:claude`/`waiting:codex` with a
comment sitting unanswered (a dropped thread — this is exactly how #281
sat six days: Codex posted round 2, nobody replied, session ended). Don't
distinguish "whose fault" in the report — state the fact (last activity,
how long ago, who was last to act) and let David or the resuming session
draw the conclusion.

48 hours is a default, not a hard rule — if David asks for a tighter or
looser window in the invocation (e.g. "/workstream-status stalled=24h"),
honor it.

### Plain-language blockers for anything `waiting:david`

Don't just say "needs you" — say **what**, restated in one sentence from
the actual source, not guessed from the stage name alone:

- If there's an open, unresolved review thread addressed to David → read
  it and restate the actual question in plain language.
- If the gate is structural (🛑 Plan approval, 🛑 Merge, 🛑 UAT) with no
  open question — say so plainly ("ready to merge, CI green, Codex
  converged" / "merged — UAT doc at `docs/PR<N>_..._UAT.md`, not yet run").
  Search for the UAT doc filename before claiming one doesn't exist.
- Accuracy over cheapness here: a wrong restatement makes the whole report
  untrustworthy, which defeats the purpose. Read the actual comment/thread
  rather than inferring from labels alone.

## Step 5 — Render the report

Sparse, scannable, grouped by urgency — David is triaging across ten
things, not reading a document. Rough shape (adapt to what's actually
found; don't pad empty sections):

```
🛑 NEEDS YOU (n)
#311 — CodeQL rate-limiter: merged, UAT doc ready at docs/PR308_..._UAT.md, not yet run
#281 — Evidence retention plan: [specific restated question from the thread]

⚠️ STALLED (n) — no activity >48h, nobody currently blocked on David
#309 — Evidence retention: Codex posted round 2 findings 6d ago, unanswered
#313 — CodeQL false-positive record: same pattern, 2 unanswered findings

IN PROGRESS (n)
#310 — NCMEC reporting: code review, waiting on Codex (last activity 3h ago)
#312 — Ledger [LEDGER] PRs: code review, waiting on Codex

CAN'T SEE
Reminder that Discovery-stage conversations with no issue yet won't appear here.
```

A section header is a plain label, not the chat-interruption
`🛑 **NEED YOU**` banner ritual (rule/bold/rule) — this is a status
report, not a mid-task blocking question, so don't dress it up as one.
The 🛑 glyph itself is fine to reuse since it's already how the lifecycle
stages and the board's own columns are named; just don't imitate the
banner's structure here.

No item anywhere gets silently dropped to keep the report short — if
something doesn't fit a bucket cleanly, say so rather than omitting it.

## Drill-down: `/workstream-status <issue-number>`

Skip the fleet view. Fetch that one issue's full body (its State of Play
block), its linked PR's live CI + all open threads, and its sub-issues if
any. Report in full — this is the "come back to one session cold" case,
so completeness matters more than brevity here.

## Model tier

Ops-shaped, checkable output, no product surface → **Sonnet**, per
CLAUDE.md's tier table. If invoked on a higher tier, no need to flag it —
this isn't the kind of task where a mismatch matters.
