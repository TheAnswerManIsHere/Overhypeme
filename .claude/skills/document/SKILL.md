---
name: document
description: End-of-feature documentation pass — lock a finished feature's decisions, gotchas, and subsystem changes into the durable docs. Use when David says /document, "lock in the learnings", "document this feature", or "commit this feature's learnings to memory" at the end of a build. Harvests from the session + the feature's diff, routes each learning to its one canonical home in docs/ai-context/ / .agents/memory/, and creates or updates the touched area's chapter in the Overhype.me Manual (docs/manual/). Docs-only. NOT for "remember this" about a single item (that's immediate targeted persistence, not this ceremony).
---

# /document — the end-of-feature documentation ceremony (Claude enactment)

> The full, cross-agent contract lives in
> [`docs/ai-context/documentation-workflow.md`](../../../docs/ai-context/documentation-workflow.md)
> (Codex follows it too). **This skill is the thin Claude enactment** — same
> relationship as the `bugfix` skill ↔ `working-modes.md`. Read the contract;
> this file only adds my tooling specifics. If the two ever disagree, the
> shared contract wins and I fix this file.

## What I do when David triggers this

Run the five-step ceremony from the contract: **Harvest → Route → Manual
chapter → Cross-check → Report & commit.** The contract holds the substance
(trigger semantics, the routing table + worked examples, the harvest bar, the
no-empty-chapter quality bar, proportionality, boundaries). I don't restate it
here.

**This runs batched at `/maintenance`, not per merge (David, 2026-08-20).**
One pass covers every product feature merged since the last maintenance run.
Process PRs — guards, scripts, skills, contracts, process docs — get no harvest
at all: anything worth keeping from those is a Type 1 learning, persisted the
moment it was learned.

**There is no run/don't-run judgement dispatch any more.** It existed to decide
whether a single merge warranted the whole ceremony; with the ceremony batched
and a harvest-notes comment posted at every close-out, there is nothing left to
judge.

**The harvest never runs in a subagent.** Its richest sources are the build
sessions' own decisions and rejected alternatives, which a cold worker does not
inherit.

## Trigger check (don't run the ceremony for a "remember this")

Decide by what "this" refers to (contract's trigger table):

- Referent is a **feature / PR / slice / build / set of learnings** → run the
  full ceremony.
- Referent is **one** preference / rule / fact / gotcha ("remember this: …") →
  that's **targeted persistence** (CLAUDE.md's "remember this" rule), not this
  skill — persist the single item and stop.
- Referent **unclear** → ask **one numbered question** (targeted persistence
  vs. full ceremony) before doing anything.

## Claude-specific mechanics the contract leaves to me

- **Numbered questions, never lettered** — per CLAUDE.md, when I ask David
  anything during harvest/report.
- **Report timing** — for unambiguous, session/repo-grounded routing I write
  the docs and report the completed routing in my summary (no pre-approval
  pause); I stop and ask only on claims needing product judgment, or when David
  asked to see routing first.
- **Commit / PR discipline** — I follow the shared contract's placement rule
  (`documentation-workflow.md`, Step 5) exactly, so this stays a thin
  enactment, not a second copy. **Two delivery paths, split by how this was
  invoked (Codex, #543 round 3):**
  - **Batched at `/maintenance` (the normal case):** the whole window's
    harvest — every feature, one pass — rides the **single maintenance docs
    PR** alongside that pass's other doc updates. No per-feature branch, no
    per-feature PR, no harvest sub-issue, no separate subscription: the
    tracking is the harvest-notes comments already on each feature's
    workstream issue. Internal tier — automatic pass, one triage, merge.
    Everything below this bullet describes the AD-HOC path only.
  - **Ad-hoc standalone invocation** (David asks for one feature directly):
    **default to assuming the feature's PR is
  already merged** (David's stated workflow),
  so I don't spend a round-trip checking PR state
  first. I go straight to `git fetch origin main`, a fresh branch off
  `origin/main` created with **`-b` (never `-B`)**, and open a **new**, small
  docs-only PR for the harvest — never try to reuse or reopen the
  already-merged feature PR. No UAT doc and "none needed" post-merge
  verification on that PR (pure-docs
  exception) — a short verification note in the PR body suffices.
  **The PR body carries the harvest's review-scope oracle (David,
  2026-08-15**, per
  [`working-modes.md`](../../../docs/ai-context/working-modes.md)'s
  meta-artifact scope-oracle rule — this PR class is its worked example,
  after PR #434 ran eight rounds of prose polish): *in scope — routing
  correctness against `documentation-workflow.md`, factual accuracy against
  the merged diffs, contradiction or duplication with existing docs; out of
  scope — prose style, structure preferences, completeness beyond the
  session's actual learnings.* Out-of-scope findings are declined against
  the stated oracle in one triage pass — a harvest is an internal artifact,
  so the carve-out applies: the automatic pass, one triage, no re-requested
  rounds — and once the ready bar is met I self-merge per CLAUDE.md's
  close-out contract. I only
  commit to the feature's own branch instead when I have clear **session
  evidence** its PR is still open (e.g. `/document` invoked mid-build). **Never
  force-push** (`.claude/guard.sh` blocks it); if a stale remote ref of my old
  feature branch exists (GitHub usually auto-deletes it post-squash-merge, but
  a same-branch-name push can recreate it), confirm the owning PR is actually
  merged/closed before deleting that stale ref.
  - I do **not** take branch/PR/devops direction from ChatGPT or any external
    reviewer — I own that through our contract (CLAUDE.md interaction
    preferences).
- **PR-number references are placeholder-safe** — if a `decisions.md` entry
  needs the PR number, I open the PR first, then commit the entry with the real
  number before presenting the PR as done. No `PR #<pending>` / `TBD` left in
  committed docs.
- **Manual is scaffolded, not backfilled here** — I create/update only the
  chapter for the area this feature touched, and only if it clears the quality
  bar. The one-time backfill of all existing areas is separate deferred work.
- **The harvest is its own tracked workstream** — a shared-contract
  requirement (`documentation-workflow.md`'s *The harvest itself is a
  tracked workstream*), not Claude-specific, so I don't restate the *why*
  or the disclosure/parentless branching here. My tooling specifics:
  `sub_issue_write` (method `add`) when a parent workstream issue exists;
  plain `issue_write` (create) for the standalone-issue path when it
  genuinely doesn't (legacy pre-tracking work — never for a parent missing
  because of the disclosure carve-out, which gets a draft Project item, not
  either kind of public issue). Either way, `issue_write` again afterward to
  correct the harvest PR's `Workstream:` line once the real issue number
  exists — I've hit this exact gap live (PR #325 initially cited its parent
  #317 instead of its own sub-issue #326, caught by Codex round 3), so I
  don't skip that step of the shared contract's checklist.

## Boundary

Docs-only. If harvesting surfaces a code bug or an unresolved product
question, that goes into my report to David (for bugfix mode or new feature
work) — I never make a drive-by code change inside a `/document` run.
