---
name: close-out
description: Close out a pull request — load immediately before merging any PR, and follow it through everything the merge owes afterwards. Holds the mechanics of the contract's close-out sequence — the last reads before the merge (what counts as a Codex review having returned, the two things no gate proves), the squash-merge, checking the Repl for its own commits and syncing it, running the Post-merge verification section through the Replit connector, the harvest-notes comment, and the merge report's contents. Nicknamed Devon, after the man who debriefs every mission. NOT the review loop before the merge (that is `pr-watch`) and NOT the fleet sync (`sync-fleet`).
---

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# Close-out (Devon) — the mechanics of merging and what follows

The rules are `claude-core.md`, *Close-out is mine, end to end*: the bar, the
outage stop, the six-step sequence and what makes a merge wait on David. This
skill is the mechanics of each step. The contract governs on any conflict.

## Before the merge: reading whether the review returned

- **Every PR in the standard loop gets a Codex review and none merges before
  it returns** (Trivial waits only for the automatic pass, to read it for a P1
  — a phase registry PR not even for that; Documentation waits only for the
  automatic pass, as an input; a prototype-phase PR waits for none). A round I
  requested but haven't received is not convergence, and one still Running 15
  minutes on is a stall (*Waiting, and scheduled check-ins*, item 4). A pass on
  a commit I have since pushed past has not reviewed the diff that would
  merge. What counts as returning is the `**Reviewed commit:**` announcement —
  or, on a round nobody requested, the connector's review-summary row reading
  **Completed against this exact commit** (admitted only there, since that
  comment is rewritten in place each round). **A 👍 never counts.** A pass I
  cannot read is a parser behind the source, not proof no review ran: I read
  the PR before saying the loop never started, and a genuinely new shape is
  read on the PR, judged on my recommendation and reported as a 👀 FYI naming
  the shape, never guessed at.
- **Two things no gate proves, still mine to check by eye**: that every
  requested round came back (two requests can name one commit and a single
  pass satisfies both), and that the pass I am reading covers the head that
  would merge.

## The sequence, step by step

1. **Re-verify live PR state immediately before merging** — a fresh
   `pull_request_read`, not cached green. If anything moved, re-work the bar.
2. **Squash-merge.** Every merge in this repo, whoever clicks it.
3. **Check the Repl, then trigger its sync.** First one read-only
   `ask_question` for `git fetch` and `git status -sb`: a Repl `main`
   **ahead** of GitHub's, alone or diverged, holds commits made in the Repl,
   which are moved to a pushed branch and the Repl's `main` realigned first
   (*This environment's git constraints*), never synced over. Then trigger a
   fast-forward-only sync, wait ~15 seconds, and verify via one `ask_question`
   that the checked-out SHA matches the new `main` commit **and** the worktree
   is clean — neither check substitutes for the other. Still **behind** means
   it hasn't landed: retry at ~15-second intervals up to 4 tries, then report
   a sync problem. **Every merge, with no exception I reason my way into** —
   not "the project is paused", "no product surface", or "the Repl will pick
   it up anyway": drift is the sum of those judgements, and an unneeded sync
   costs nothing.
4. **Execute the PR's Post-merge verification section** through the connector
   (the two-call sequence below, read-only scoping stated), when it has
   content. A step that would start a paid AI run is not read-only and runs
   under David's paid-run rule: a ceiling set before it starts, and a stop
   for him at a $10 worst case in a run, $10 across a task, or past $100 in the month
   (`uat-doc-format.md`, *Lanes*).
5. **Post the harvest-notes comment** on the workstream issue (production-phase
   product PRs; a prototype-phase PR posts none).
6. **Merge report to David**, kept short (interaction rule 5): both SHAs, verification results, and
   the UAT handoff naming what to go click — the judgement steps, since `/uat`
   settles the machine lanes itself, running only what the lifecycle left
   unrun, screen facts included (the `uat` skill, section 3, and *Where the
   browser automation lives*) — plus the reminder that `/uat` walks him
   through it; for a prototype-phase PR, that the head is on `main` and
   unpublished, and which questions it asks (the `prototype` skill); the PR's
   **Decisions taken on my recommendation** entries, one line each; and,
   last, its plain-English summary (*A reversible choice proceeds*, rule 2) —
   ending on the `✅ **PLAN DONE** —` line when this merge finished the
   approved work and nothing of mine is scheduled after it; a merge that waits
   on him ends on a 🛑 banner, with a push notification beside the hook's
   alert (interaction rule 6). **Nothing of mine
   follows the merge report**; when more approved work is startable, its
   resume is armed before the report is written (*Waiting, and scheduled
   check-ins*, item 0). **No build report follows it**: that is the
   `buildreport` skill's, only when David asks.

## Working the Replit connector during close-out

(`claude-core.md`, *Connectors → Replit*, holds the authorization boundaries;
`replit-platform.md` the platform.)

- **`ask_question` reads, `update_app_using_prompt` acts.** Only
  `ask_question` returns text; the write channel returns a status, never the
  result. `phase: "busy"` means the request was dropped: wait two to three
  minutes, then re-ask (an immediate resend only bounces). `"updating"` is not
  busy: re-invoking opens a new agent turn. Ask it to **run named commands and
  report output** (quotable evidence), not how something works.
- **A post-merge verification run is a two-call sequence**: kick it off with
  `update_app_using_prompt` carrying the checks and an explicit read-only
  instruction, wait a few minutes, then `ask_question` for the results. A
  paid AI step — proceeding under the paid-run rule, or past one of its stops
  on his go-ahead — goes in a separate request that names its paid calls and
  worst-case cost, its ceiling, as the only
  thing it may do beyond reading (`uat-doc-format.md`, *Lanes*).
