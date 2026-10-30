---
name: archive
description: Answer one question cheaply — "are we done with everything this session needs to do, and should we archive it?" — and archive the session when the answer is yes. Use when David says /archive, "can we archive this", "are we done here", or "should I close this session". Checks only what dies with the session (unpushed work, a PR this session watches, armed check-ins, running tasks, unpaid close-out, unpersisted learnings, an open ask), returns one of three verdicts — continue, hand off, archive — and on archive schedules the session's own archiving a minute after the verdict is shown. NOT /handoff (which moves context and costs far more) and NOT /next or /status (which rank or report work); this skill reads no workstream but its own.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# /archive — is this session finished?

One question, answered with a handful of reads: **is anything of value held
only by this session, and is anything startable here next?** If neither, the
session is finished and I archive it (David, 2026-10-22: *"I'd like to be able
to just answer the one question of 'should we archive?'"*).

**It is cheap on purpose.** No ranking (`/next`), no repo-wide fetch
(`/status-all`), no prompt-writing (`/handoff`). It reads this session's own
branch, its own PRs and its own scheduled wakes, and nothing else. A check that
needs more than that is not this skill's.

**It runs in the main loop, never a subagent** — the same bar the `handoff`
skill pre-registers, for the same reason: most of the checklist is
enumeration from this session's own context, which a cold worker does not
have. Any model tier.

## The asymmetry that sets the bar

An idle session costs nothing. A wrongly archived one loses whatever is bound
to the session rather than to the repository — and the container is reclaimed
after inactivity anyway, so unpushed work is at risk whether or not I archive.
So the checklist is exactly **what dies with the session**, and any hit on it
means *not yet*.

## Step 1 — The checklist

Each item is a read or an enumeration, each produces one line. Run all seven;
do not stop at the first hit, since David wants the whole list once.

1. **Unpushed work.** `git status --porcelain` and, for every local branch with
   an upstream, `git log @{u}..` — a dirty tree, an untracked file worth
   keeping, or a commit ahead of origin. A plan draft under `docs/plans/` is
   gitignored by design, so look there explicitly.
2. **A PR this session opened or watches that is still open.** One
   `list_pull_requests` for this session's branches (head
   `<owner>:<branch>`, state open) plus the PRs I subscribed to in this
   session. A subscription binds to this session; archiving it leaves the PR
   unwatched — the PR #458 shape the `handoff` skill names.
3. **Armed scheduled wakes bound to this session.** `list_triggers`, kept to
   enabled entries whose `persistent_session_id` is this session's id
   (`get_session` with no id returns it). A `send_later` into an archived
   session is a wake into nothing.
4. **Running work.** A background task, a dispatched agent not yet returned,
   or a review round requested and not yet landed.
5. **Close-out this session owes and has not paid** (`claude-core.md`,
   *Close-out is mine, end to end*): a merge without its Repl sync, an unrun
   Post-merge verification, the harvest-notes comment, the merge report or
   build report not delivered, or a workstream issue whose State of Play,
   labels or *Spend so far* line no longer match what happened. Enumerated
   from this session's own record; the issue is read only if the session
   touched one.
6. **Learnings held only in chat.** A Type 1 rule or a "remember this" not yet
   written to its file, or a `/document` owed and not noted on the issue.
7. **An open 🛑 ask** David has not answered. Archiving discards the context
   his answer would land in.

## Step 2 — The verdict

Exactly one, first match wins:

| Verdict | When |
| --- | --- |
| **continue** | Any checklist hit, or approved work in this session's plan is still startable here. Name each hit and the action that clears it. |
| **hand off** | No hit, the next work is in a different workstream, and this session holds context worth carrying (the `handoff` skill's Step 1 test). Under `/archive`, recommend `/handoff` and do not run it; on a build report's **Session** line, the hand-off prompt follows the report instead (`claude-core.md`, *Watching the PRs I open*). |
| **archive** | No hit, and nothing worth carrying: the work is done, or the next work starts cold just as well. |

A *continue* whose every hit I can clear myself is not a verdict to stop on:
clear them (push, post the comment, persist the note), say so, and re-run
Step 1. A hit only David can clear — an open ask, a step that is his — stays
*continue* and names it.

## Step 3 — Archiving, on an *archive* verdict

**The verdict is shown before the session goes.** Archiving releases the
container, and a turn whose container is gone may never deliver its last
message — so the archive is never called in the turn that states the verdict.
Instead:

1. Arm one `send_later`, `delay_minutes: 1`, `initiation: human_request`,
   message: *"/archive verdict was archive. If David has written since, do
   nothing. Otherwise call archive_session on this session's id and write
   nothing."*
2. End the turn with the report below as its last text. The minute is
   David's veto: any message from him cancels it, since the wake checks.
3. On the wake, if he has not written, call `archive_session` with this
   session's id. **If it is refused**, the session stays as it is and the one
   line he needs is that it could not archive itself and he can archive it
   from the app. Whether a session may archive itself is
   `unable to verify: no session has called archive_session on its own id
   yet; the first archive verdict is the measurement`.

Nothing else is archived — never another session, and never a session whose
verdict was not *archive* in this invocation. Unarchiving is one call
(`unarchive_session`), so this is a reversible choice and proceeds without
asking (`claude-core.md`, *A reversible choice proceeds*).

## Shape

```
ARCHIVE — nothing left here.
  Pushed and merged: #231. No open PR, no armed wake, no running task.
  Close-out paid; nothing held only in chat.
  Archiving in one minute — any message from you stops it.
```

```
CONTINUE — two things die with this session.
  1. Uncommitted edit to scripts/sync.mjs — pushing it now.
  2. PR #233 is watched here and waiting on Codex — archiving would leave it unwatched.
  Next: after Codex's review on #233.
```

The hand-back footer applies (*Done / Next / Needs you / Spend*); on an
*archive* verdict, **Next:** takes the core's `nothing —` form:
`nothing — the work here is done; archiving at <time> unless you write
first`. That form is the alert hook's idle tier (`claude-core.md`,
interaction rule 6), so the verdict rings David's phone and repeats until
he acknowledges it: a finished session with nothing startable is one he
directs next, and he asked to know the moment any session is done.

## What this skill does not do

- **Move context.** That is `/handoff`, and its prompt-writing is the cost
  this skill exists to avoid.
- **Recommend the next task.** That is `/next`; *archive* means only that
  nothing here needs this session.
- **Run unasked.** The build report's **Session** line states the same
  verdict at every unit's close (`claude-core.md`, *Watching the PRs I
  open*), but only an explicit `/archive` archives.
