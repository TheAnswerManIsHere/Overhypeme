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
- **Commit / PR discipline** — the CLAUDE.md squash-merge workflow:
  - Feature PR still open → commit the docs onto that same branch.
  - Feature already merged → `git fetch origin main`, fresh branch off
    `origin/main` created with **`-b` (never `-B`)**, **never force-push**
    (`.claude/guard.sh` blocks it), then a small docs-only PR. No TEST_RUN/UAT
    docs (pure-docs exception) — a short verification note in the PR body.
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

## Boundary

Docs-only. If harvesting surfaces a code bug or an unresolved product
question, that goes into my report to David (for bugfix mode or new feature
work) — I never make a drive-by code change inside a `/document` run.
