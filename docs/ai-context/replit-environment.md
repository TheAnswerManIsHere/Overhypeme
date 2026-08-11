# Replit: the live environment, not a fourth reviewer

Replit is where the app actually runs — dev and production both. It executes
the post-merge `TEST_RUN` checklists (see
[`test-run-contract.md`](../tests/test-run-contract.md)), and it also
diagnoses and repairs problems it finds there directly against the running
environment, including database migrations. This file is the shared,
cross-agent account of how that access actually works and what it means for
how the rest of us treat its output. Sibling to
[`codex-environment.md`](codex-environment.md); AGENTS.md links both under
"Agent sandboxes."

## Claude Code can run *inside* the Repl — and the repo's agent config is not written for it

Claude Code is installed in the Repl's shell (2026-08-11), which makes it a
third actor: a **live-environment operator** — diagnostics, ops, `TEST_RUN`
execution — distinct from Claude Code on the Web, which is the builder. It is
powerful like Replit Agent, not constrained like the web sandbox: it holds the
Repl's git credentials and can reach the running app.

**The trap: `.claude/settings.json` is versioned, so it follows the repo into
the Repl and is applied verbatim there.** Every setting in it was written for
a disposable container, and two of them are actively wrong in a live
environment:

- **`"defaultMode": "bypassPermissions"`** — an unsupervised agent against the
  real app, database, and `main`. Overridden Repl-side; see below.
- **The `SessionStart` hook running `scripts/setup-test-db.sh`** — it
  apt-installs packages, starts a Postgres cluster, creates a SUPERUSER role,
  force-pushes a schema, and `pnpm install`s into the working copy. That last
  one dirties the worktree that Publish snapshots. Fixed in the script itself,
  which now exits early when Replit environment variables are present.

### The Repl requires a `.claude/settings.local.json` that is NOT in git

Local settings take precedence over the versioned project settings, and
`.claude/settings.local.json` is gitignored — so the Repl's override cannot
live in the repo, and this note is the only record that it must exist.
Its contents:

```json
{
  "permissions": { "defaultMode": "default" },
  "model": "sonnet"
}
```

`defaultMode: default` restores normal permission prompting; `model: sonnet`
matches the ops tier this session works at. **If the Repl is ever rebuilt or
this file goes missing, Claude Code there silently reverts to bypassing
permissions against the live environment** — so re-create it before using an
in-Repl session, and treat its absence as a stop condition, not a nuisance.

Known limitation, deliberately left alone: the versioned settings also set
`env.DATABASE_URL` to the sandbox's local test database, which an in-Repl
session inherits. That means it cannot query the real database — safe by
default, and fine for git/log/ops work, but it must be addressed deliberately
before an in-Repl session is used for database-touching `TEST_RUN` steps.

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

## GitHub ⇄ Repl sync and Publish (shared fact, not tool-specific)

Any agent that can trigger a Replit connector's `publish_app` — Claude Code
today, potentially others later — needs this before calling it: **Publish
does not pull from GitHub.** It deploys whatever is currently checked out in
the Repl's own workspace, not whatever is newest on GitHub. Two separate
mechanisms determine what that workspace contains:

- **GitHub → Repl is always a manual step. There is no auto-sync.** An
  earlier `ask_question` pass (below) reported an opt-in "two-way sync"
  toggle in the Git pane; a follow-up diagnostic against the live Repl
  disproved that — the Git pane exposes explicit **Pull**, **Push**, and
  **Sync Changes** controls only, no persistent auto-sync setting. A push to
  `main` on GitHub never reaches the Repl on its own; someone (or some agent)
  must run `git pull origin main` or use one of those Git-pane actions every
  time.
- **Repl → Publish** takes a snapshot of the Repl's *current* workspace —
  pulled files, locally committed files, and any locally uncommitted files
  are all included — and builds/deploys that snapshot. It does not re-check
  GitHub as part of publishing.

So the only safe release sequence is: GitHub push to `main` → **manually**
trigger the Repl sync (`git pull`, or the Git pane's Pull/Sync Changes
action — never assume it already happened) → **verify two things together,
that the Repl's checked-out commit SHA matches the pushed commit *and* that
its worktree is clean** → Publish.

Both halves are load-bearing, and neither is sufficient alone:

- **SHA match without a clean worktree** still publishes the wrong thing.
  Publish snapshots uncommitted files too (above), so a leftover local edit
  — a debugging probe someone forgot to revert, most likely — ships to
  production even though HEAD is exactly right.
- **A clean worktree without a SHA match** proves nothing about freshness. A
  Repl can sit on `main`, spotlessly clean, and simply be behind because the
  manual sync never ran.

Check only one and the other becomes the hole. Check the branch name alone
and both are.

*(Source and a live lesson in the caveat below: an initial `ask_question`
pass against the Overhype.me Repl (2026-08-11) reported an opt-in "two-way
auto-sync" toggle that does not actually exist — Replit Agent's own account
of Replit's behavior was wrong. A follow-up diagnostic, explicitly
instructed not to touch any code and to `git fetch`/inspect the Git pane,
corrected it: no auto-sync toggle is visible, only explicit Pull/Push/Sync
Changes controls, so manual sync is mandatory, not merely the safe default
when auto-sync is off. This is exactly why `ask_question` output is
diagnostics, not verification evidence — the first answer was fluent,
specific, and false. Confirm against Replit's own product docs if this ever
needs to be authoritative rather than a working assumption.)*

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
