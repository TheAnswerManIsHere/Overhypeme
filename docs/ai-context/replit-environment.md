# Replit: the live environment, not a fourth reviewer

Replit is where the app actually runs — dev and production both. It executes
the post-merge `TEST_RUN` checklists (see
[`test-run-contract.md`](../engineering/test-run-contract.md)), and it also
diagnoses and repairs problems it finds there directly against the running
environment, including database migrations. This file is the shared,
cross-agent account of how that access actually works and what it means for
how the rest of us treat its output. Sibling to
[`codex-environment.md`](codex-environment.md); AGENTS.md links both under
"Agent sandboxes."

## Authoritative on what IS; the repo docs are authoritative on what SHOULD BE

Replit has one advantage none of the rest of us have: it can read live server
logs, live database state, and the actual running app, in real time. On
questions of fact — is this constraint present, did this backfill run
correctly, is this endpoint actually returning what the code says it should —
**Replit's live read is the ground truth, and second-guessing it from a diff
or a schema file is the wrong instinct.**

What Replit's environment access does *not* give it is product-decision
context — the settled calls recorded in `decisions.md`, a retired ceremony
noted only in a code comment, an invariant that changed shape three commits
after the checklist that tests it was written. PR293 is the worked example:
Replit's live read was flawless (found the dangling row, verified it against
`quarantined_memes`, deleted nothing) — the checklist it was executing was
stale, written before the 2026-08-07 decision that retired the backlog-audit
disposition it was still asking for. **The checklist is the bridge between
Replit's live-environment authority and the repo's decision authority; a
stale checklist is a defect in the bridge, not evidence Replit got something
wrong.** Keeping checklists current with actual product decisions is our job,
not Replit's.

## Auto-commits are checkpoints, not intent signals

Replit's Agent creates a git commit automatically at each checkpoint — every
point it judges a task internally "done" — into the workspace's own
repository. That commit boundary reflects Replit's own save cadence, not a
deliberate publish decision. Two consequences:

- **Don't read a Replit commit message, or a handoff doc's description of
  workspace state, as a claim about what's finished or reviewed.** The
  2026-08-09 handoff described three changes as "uncommitted" when git showed
  they'd already been committed (and pushed) — the handoff was simply behind
  the checkpoints. When the two disagree, trust `git log` / `git status` over
  the doc. This is also why a handoff should describe *how to check* current
  state rather than assert a snapshot of it — see
  [`docs/handoff/README.md`](../handoff/README.md), where these documents now
  live.
- Replit's commits are mechanically identifiable by author **name** —
  `git log --author="Replit Agent"` — which is what makes a periodic
  retrospective review tractable without any push-side gate (see below). Use
  the name, not one specific email: the repo's history carries commits from
  at least two Replit bot identities (`agent@replit.com` and
  `replit-agent@bots.noreply.replit.com`) that share the display name, and an
  exact-email filter would silently drop whichever one isn't currently
  active.

## The push path has no external gate, and that's accepted

Replit pushes directly to `main` through its own Git pane, on request. There
is no PR, no Codex review, and none of GitHub Actions' checks run *before*
the push lands — only after, against a `main` that already has the change.
This is structural, not a misconfiguration, and **not something to build
around**: David uses Replit specifically for its ability to touch the running
environment and verify a fix against it immediately, and inserting a PR gate
into that path would remove the thing that makes it useful.

**Migration and schema repairs are explicitly included, not an exception.**
Replit can apply a migration and watch it take effect against the real
database in the same breath — verify the constraint now exists, attempt a
row that should violate it, confirm the rollback — in a way neither Codex nor
Claude Code can from a diff. Migration 0098 (2026-08-09, restoring
`facts_active_requires_concept` after a `drizzle-kit push` had silently
dropped it — see the `known-failure-patterns.md` entry) is the example this
was decided against: correct, verified live, and faster than routing it
through a PR loop would have been. Do not propose gating this path; David
settled it on 2026-08-09.

## Replit has its own CI — not none, and not ours

Replit runs its own internal review/testing loop as part of its development
process before it considers a change checkpoint-worthy. It is real, but it is
**not** GitHub Actions' `build.yml`, and it is not Codex's review — neither of
those runs against a Replit-authored change before it reaches `main`. Don't
describe Replit as having "no CI"; describe it accurately as running its own
CI, separate from the repo's.

## The one thing that IS ours: a periodic retrospective read

Nothing gates Replit's push, so the only enforcement point is after the
fact — a code review David asks for, not a check anything blocks on. The
weekly `/maintenance` pass (see
[`.claude/skills/maintenance/SKILL.md`](../../.claude/skills/maintenance/SKILL.md))
sweeps commits authored `Replit Agent` (by name, across every identity it
commits under) on `main` since the last run:

- **Skim** UI/copy/test-only changes — seconds each, no deep read needed.
- **Actually read** anything touching a migration, schema, auth, or payment
  path.
- Anything real found goes through the normal channel — a `/bugfix` PR, or a
  flagged item for David — never a unilateral revert of Replit's work.

This is a retrospective safety net, not a gate: it never blocks or delays
Replit's own work, and it does not replace Replit's own internal CI or its
ability to repair what it finds live.
