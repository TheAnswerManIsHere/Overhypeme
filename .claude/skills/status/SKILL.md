---
name: status
description: Give David a cold-open summary of every open workstream — where each stands in the lifecycle, who's holding it, and which ones are stalled or need his input. Use when David says /status, "what's the state of things", "what needs me", or is picking a session back up after time away and doesn't remember where he left off. Best run from a fresh, cheap session rather than an existing long thread.
---

# /status — the workstream board, read cold

David runs ~10 concurrent sessions across Discovery → Planning →
🛑 Plan approval → Coding → Code review → 🛑 Merge → Test run →
🛑 UAT → Close-out. He can't tell which sessions need him without opening
each one. This skill answers that from **outside** any of them, using
GitHub as the shared substrate — no session memory required, which is why
it works cold in a brand-new session and shouldn't be run inside a long
existing thread (that burns the wrong session's context for no benefit).

**This is a read-only reporting skill.** It never writes labels, comments,
or issue bodies — that's `pr-watch`, `plan-review-loop`, `bugfix`, and
`pr-docs`'s job at the moments those already fire.

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
gap, not a bug in this skill. If a `/status` run feels like it's missing a
session David knows is active, that session hasn't opened its workstream
issue yet. Mention this possibility in the report if the count looks low
relative to what David expects.

**Sensitive/disclosure-carve-out workstreams.** Per the plan-review-loop's
disclosure rule, those live as draft Project items, not issues, precisely
because this repo is public. They're deliberately invisible to any
tool-based report, including this one.

## Step 1 — Fetch every open workstream issue

```
list_issues(owner, repo, state: OPEN, perPage: 50,
            fields: [number, title, labels, updated_at])
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

## Step 2 — Fetch sub-issues

For every workstream issue, call `issue_read` (`method: get`) and check
`has_children`. Where true, `get_sub_issues` to pull the children (e.g. a
`/document` harvest nested under its parent feature). A sub-issue is its
own row with its own `stage:`/`waiting:` labels — render it nested under
its parent, not flattened into the top-level list.

## Step 3 — Find each workstream's PR(s)

There is no GitHub-native issue↔PR link here, because PR bodies say
`Workstream: #N`, never `Closes #N` (deliberately — the latter would
auto-close the issue at merge and skip UAT). So:

```
list_pull_requests(owner, repo, state: all, sort: updated, direction: desc,
                    perPage: 50,
                    fields: [number, title, body, state, draft,
                             mergeable_state, html_url, updated_at])
```

One call, not one per issue — regex `Workstream:\s*#(\d+)` out of each
body to build the issue→PR map locally. Bounding to the most-recently-
updated 50 is intentional: an active workstream's PR is recent by
definition, and a workstream with no PR in that window is either
pre-code (Discovery/Planning) or genuinely stalled, both of which the
report should surface anyway.

For any workstream issue with a linked PR, pull live state in one batched
call: `pull_request_read` (`get_status` for CI, `get_review_comments` for
open threads) — same discipline as `pr-watch`, minimal calls, no
per-thread narration in the output.

## Step 4 — The judgment layer (this is the actual point)

GitHub's board can show a static Status/Waiting-on value. It cannot tell
David *why* something is stuck or *what exactly* he's being asked. That's
what turns this from "a slower way to read the board" into something
worth running.

### Stalled detection

A workstream is **stalled** when `waiting` is NOT `david` (a David-gate is
"needs you," a more urgent bucket — never double-count it as stalled) and
there has been no relevant activity — no new commit, no Codex comment, no
reply from Claude — in the linked PR for **more than 48 hours**. Use the
PR's `updated_at` plus the latest comment/review timestamp from
`get_review_comments`, whichever is more recent.

This catches both directions: `waiting:codex` with no Codex response
(review hasn't landed) *and* `waiting:claude`/`waiting:codex` with a
comment sitting unanswered (a dropped thread — this is exactly how #281
sat six days: Codex posted round 2, nobody replied, session ended). Don't
distinguish "whose fault" in the report — state the fact (last activity,
how long ago, who was last to act) and let David or the resuming session
draw the conclusion.

48 hours is a default, not a hard rule — if David asks for a tighter or
looser window in the invocation (e.g. "/status stalled=24h"), honor it.

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

## Drill-down: `/status <issue-number>`

Skip the fleet view. Fetch that one issue's full body (its State of Play
block), its linked PR's live CI + all open threads, and its sub-issues if
any. Report in full — this is the "come back to one session cold" case,
so completeness matters more than brevity here.

## Model tier

Ops-shaped, checkable output, no product surface → **Sonnet**, per
CLAUDE.md's tier table. If invoked on a higher tier, no need to flag it —
this isn't the kind of task where a mismatch matters.
