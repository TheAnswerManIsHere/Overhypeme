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
  enactment, not a second copy: **default to assuming the feature's PR is
  already merged** (David's stated workflow — he invokes `/document` only
  after the work has merged), so I don't spend a round-trip checking PR state
  first. I go straight to `git fetch origin main`, a fresh branch off
  `origin/main` created with **`-b` (never `-B`)**, and open a **new**, small
  docs-only PR for the harvest — never try to reuse or reopen the
  already-merged feature PR. No TEST_RUN/UAT docs on that PR (pure-docs
  exception) — a short verification note in the PR body suffices. I only
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
  here. My tooling specifics: `sub_issue_write` (method `add`) to parent the
  new issue under the feature's workstream issue, then `issue_write` to
  correct the harvest PR's `Workstream:` line once the sub-issue number
  exists — I've hit this exact gap live (PR #325 initially cited its parent
  #317 instead of its own sub-issue #326, caught by Codex round 3), so I
  don't skip step 3 of the shared contract's checklist.

## Boundary

Docs-only. If harvesting surfaces a code bug or an unresolved product
question, that goes into my report to David (for bugfix mode or new feature
work) — I never make a drive-by code change inside a `/document` run.
