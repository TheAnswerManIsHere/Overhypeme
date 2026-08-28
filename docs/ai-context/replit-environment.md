# Replit: the live environment, not a fourth reviewer

Replit is where the app actually runs — dev and production both. It executes
each PR's post-merge verification checks (see
[`test-run-contract.md`](../tests/test-run-contract.md)), and it also
diagnoses and repairs problems it finds there directly against the running
environment, including database migrations. This file is the shared,
cross-agent account of how that access actually works and what it means for
how the rest of us treat its output. Sibling to
[`codex-environment.md`](codex-environment.md); AGENTS.md links both under
"Agent sandboxes."

## Claude Code can run *inside* the Repl — and the repo's agent config is not written for it

Claude Code is installed in the Repl's shell (2026-08-11), which makes it a
third actor: a **live-environment operator** — diagnostics, ops,
post-merge verification runs — distinct from Claude Code on the Web, which is the builder. It is
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

### `$HOME` is wiped on every restart — which is why `claude` kept vanishing

The Repl has two filesystems, and the difference governs everything above and
below: **`/home/runner` is an ephemeral overlayfs layer, wiped on every
container restart. `/home/runner/workspace` is a persistent btrfs volume.**

Claude Code's native installer straddles that line badly. Its ~300MB payload
lands in the workspace (`.local/share/claude/versions/<version>`) and
survives fine — but it is reachable only via a symlink at
`~/.local/bin/claude`, which does not. After a restart the binary is still
perfectly intact and `claude` is nonetheless "command not found". Restarts
are frequent and unannounced: two inside 90 minutes on 2026-08-11.

Re-running the installer works but only re-creates a pointer in the same
doomed location. The durable fix is **`scripts/bin/claude`** — a git-tracked
launcher that git sync restores like any other repo file, with
`scripts/bin` placed on `PATH` by `.replit`'s `[env]` block. It resolves the
newest installed payload **at call time** rather than being a symlink,
because the payload path is version-numbered and carries no
`current`/`latest` manifest: a pinned link would keep working after a
`claude update` while silently launching the old binary.

Two things this deliberately does *not* do. It does not reinstall anything —
if the payload is genuinely absent it prints the installer command and exits
`127`. And it does not put `$HOME` back in the loop; nothing about the fix
depends on a file under `/home/runner` surviving, because none of them do.

### The Repl requires a local-settings override that is NOT in git

Local settings take precedence over the versioned project settings, and the
local-settings filename is gitignored — so the Repl's override cannot live in
the repo, and this note is the only record that it must exist. It sits in the
Repl workspace at `/home/runner/workspace/.claude/settings.local.json` (an
absolute Repl path, deliberately — the file exists only there, never in a
checkout), with these contents:

```json
{
  "model": "sonnet",
  "env": { "DATABASE_URL": "<the dev database, heliumdb — see below>" },
  "permissions": {
    "defaultMode": "default",
    "deny": ["Bash(git commit:*)", "Bash(git push:*)", "Bash(gh auth:*)",
             "Bash(python3 -c:*)", "Bash(node -e:*)", "Read(**/.env*)", "…"],
    "allow": ["Bash(git status:*)", "Bash(git log:*)", "Bash(ls:*)",
              "Bash(wc:*)", "Bash(ps:*)", "Bash(which:*)", "…"]
  }
}
```

**Deliberately excluded from `allow`, even though they look like ordinary
read-only ops: `cat`, `head`, `tail`, `grep`, `rg`, `find`.** The first
version of this file included them, and a Codex review on PR #417 caught
why that defeated the design: `Bash(cat:*)` reads `.env` fine even though
`Read(**/.env*)` denies it — the deny is scoped to Claude Code's own `Read`
tool, and a shell command is a different door into the same file that rule
doesn't cover. The same gap applies to any utility that can print file
*content* (`head`, `tail`, `grep`, `rg`), not just `cat`. `find` is worse in
a different way: `-exec` lets it run an arbitrary command, including
anything else on the deny list, through a prefix (`find`) the rule never
inspects past. There's no narrower glob that fixes this — the permission
syntax matches a command prefix, not its flags or arguments — so the
correct fix is exclusion, not a tighter pattern. Routine file-content
reads go through Claude Code's own `Read` tool instead, which already
enforces the same deny rule correctly.

`defaultMode: default` restores normal permission prompting; `model: sonnet`
matches the ops tier this session works at. **If the Repl is ever rebuilt or
this file goes missing, Claude Code there silently reverts to bypassing
permissions against the live environment** — so re-create it before using an
in-Repl session, and treat its absence as a stop condition, not a nuisance.

**Why a curated `deny`/`allow` split, not just `defaultMode: default` alone
(David, 2026-08-11):** the first version of this file shipped with
`defaultMode: default` and nothing else, and it failed in practice within the
same session — one-off approvals to repeated prompts silently accumulate as
standing grants, and a human clicking through a wall of prompts will not
review each one closely. That produced live grants for `git commit`,
`git push`, `gh auth`, and arbitrary `python3 -c` execution — the exact
review-bypass and code-execution risk the whole in-Repl operator role exists
to avoid. **`deny` takes precedence over `allow`, which is what makes it
fatigue-proof:** even a mis-click on a future prompt can't grant a denied
command. The paired `allow` list exists so ordinary read-only ops (`git
status`, `ls`, `grep`, log reads) don't keep re-prompting — the goal is
prompts becoming rare enough to actually be read, not merely fewer.

The `env.DATABASE_URL` now points at the real **dev** database (`heliumdb`),
not the sandbox test database it originally inherited from the versioned
settings — wired in deliberately so in-Repl sessions can do real diagnostics
and, eventually, database-touching post-merge verification steps. **Production (`neondb`
on Neon) is not present anywhere in this file, or anywhere else in the Repl's
environment, and that is deliberate** — see the dev/prod split noted below,
which the production guard now protects explicitly.

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

## The fast lane: David's own UI tweaks during UAT (David, 2026-08-28)

The push path above is a general capability. This is the specific, common use
David actually makes of it, named so that no agent treats it as an incident:
**while testing, he asks Replit Agent for a small UI change, and it appears on
his UAT screen in seconds.** That is sanctioned and expected. It is the same
David-originated live repair CLAUDE.md already permits — not an unreviewed
patch sneaking past the pipeline, which remains barred for Claude Code's own
changes.

**The lane boundary is display vs. behavior — not small vs. big.** Diff size
does not predict risk, and the repo has one worked example on each side of the
line, a day apart:

- **Display (in the lane).** `c678a53` added `Review #{r.id}` to each row of
  the admin Moderation list — one line, rendering an id already present in the
  row's data. No API, no data model, no logic. Reviewed after the fact in well
  under a minute.
- **Behavior (not in the lane).** The Visual Overrides change was also
  "one line", and it crashed every refresh-seeded enrichment job on a partial
  visual override (fixed in #582, with a follow-on badge fix in #585). It cost
  an hour and six review rounds — and those rounds are what *caught* it.

So the routing question is never "is this small?" but **"does this change what
the app does, or only what it shows?"** Anything touching data, logic,
migrations, auth, payments, or the visual/enrichment pipelines goes through the
normal pipeline instead. When David is unsure, he asks — and a misjudgment is
recoverable, because the sweep below is the backstop.

**The ceremony is two clicks, and both matter:**

1. **Pull before the tweak**, so Replit Agent edits current code.
2. **Sync after it**, so the change reaches GitHub promptly.

Sync is what makes the change *visible* — GitHub is not where the app runs, but
it is the only surface Codex and Claude Code can read, so an unsynced Repl
change is invisible to every agent that could catch a problem in it, and the
next post-merge sync will collide with it. Ordering is what keeps merge
conflicts off David's screen: pull-first means the tweak is authored on top of
`main` rather than diverging from it.

**Never Publish while the Repl and GitHub disagree** — Publish snapshots the
Repl's working tree (see the sync/Publish section below), so a
still-unsynced tweak ships to production without ever having been seen.

**The lane is an explicit exception to workstream tracking.**
[`AGENTS.md`](../../AGENTS.md)'s *Workstream tracking* gives every unit of work
a GitHub issue as its spine; a fast-lane tweak deliberately has none. Requiring
an issue for a one-line display change would reinstate exactly the overhead the
lane exists to remove, and the tweak is already recorded where it matters — as
a commit on `main`. **The sweep is the lane's accountability, not the Project
board**, so no agent should "correct" a fast-lane commit by demanding an issue
for it retroactively. What the sweep *finds* is different: a real defect
becomes a `/bugfix`, and that carries its own workstream issue like any other.
The lane is therefore invisible to `/status-all` by design — which is
acceptable only because these changes are display-only and land in seconds; the
moment one needs tracking to be understood, it was behavior, and it did not
belong in the lane.

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

*(Source, and a live lesson in how to ask: an initial `ask_question` pass
against the Overhype.me Repl (2026-08-11) reported an opt-in "two-way
auto-sync" toggle that does not actually exist — Replit Agent's own account
of Replit's behavior was wrong. A follow-up diagnostic, explicitly
instructed not to touch any code and to `git fetch`/inspect the Git pane,
corrected it: no auto-sync toggle is visible, only explicit Pull/Push/Sync
Changes controls, so manual sync is mandatory, not merely the safe default
when auto-sync is off.*

***The two passes differ in the shape of the question, and that — not the
tool — is what decides how far an answer can be trusted** (clarified
2026-08-14). The failing pass asked how a feature works and got an answer
composed from the agent's understanding: fluent, specific, and false. The
correcting pass named the commands to run and asked for their output, and
came back grounded in what actually executed. A `ask_question` answer that
quotes the command it ran and that command's raw output (`git rev-parse
HEAD` → the SHA, `git status` → the literal text) is deterministic
evidence and can be recorded as fact; an answer describing how something
behaves is a working assumption until corroborated — against Replit's own
product docs, if it needs to be authoritative. This distinction is why
`ask_question` is the connector's read channel for live state rather than
something to route around: the mutating call
(`update_app_using_prompt`) never returns answer text at all.)*

## Dev and production are two separate databases

**`heliumdb`** (on the `helium` host) is the **development** database — the
one wired into the Repl's local Claude Code settings (above). **Production
is a separate database, `neondb`, hosted on Neon** — a different provider
entirely, not just a different name on the same Postgres server.

`assert_not_production` (`artifacts/api-server/scripts/lib/test-db.sh`) refuses
by exact name (`heliumdb`, `neondb`, `production`), by substring (anything
containing `prod`), by a generic `neon.tech` host marker, and by two env-var
extension lists (`TEST_DB_PROTECTED_NAMES`/`TEST_DB_PROTECTED_HOSTS`, both
unset in this Repl). `neondb` and the host marker were added as guard
defaults once the dev/prod split meant `heliumdb` no longer implied
production — see [`TESTING.md`](../tests/TESTING.md#production-guard-safety-critical)
for the full matrix.

## The one thing that IS ours: a periodic retrospective read

Nothing gates Replit's push, so the only enforcement point is after the
fact — a code review David asks for, not a check anything blocks on. The sweep
reads commits authored `Replit Agent` (by name, across every identity it
commits under) on `main`:

- **Skim** a change that is genuinely display-only — copy, layout, or a value
  that was already in the data. Seconds each, no deep read needed.
- **Actually read** anything that changes behavior, **whatever file it lives
  in**: data, logic, migrations, schema, auth, payments, or the
  visual/enrichment pipelines. A UI file is not evidence of a display-only
  change — the Visual Overrides regression (#582) was behavior inside the UI
  layer, so a rule that skims "anything UI" would skim precisely the tweak this
  sweep exists to catch. Match the fast lane's own boundary: display vs.
  behavior, never file location.
- Anything real found goes through the normal channel — a `/bugfix` PR, or a
  flagged item for David — never a unilateral revert of Replit's work.

**It runs at two cadences** (David, 2026-08-28), and neither asks anything of
David at the moment he makes a tweak. *Opportunistically*: any session that
touches `main` — which every session does on its first fetch — runs one bounded
`git log --author="Replit Agent"` there and reads what it names. **The command
is the mechanism, not the noticing**: `fetch` and `checkout` print nothing about
authorship, so without an explicit author log, "a session that touches `main`
finds one" names no real moment. Exact command and its bound: CLAUDE.md's *This
environment's git constraints*. *Weekly*: the `/maintenance` pass (see
[`.claude/skills/maintenance/SKILL.md`](../../.claude/skills/maintenance/SKILL.md))
runs the same sweep as the **backstop**.

**What the two cadences do and don't guarantee.** The opportunistic sweep needs
nothing from David and covers any week we are working at all. The weekly
backstop is **David-invoked** — `/maintenance` is a ritual he runs, and the
check-in contract rules out scheduling it, since a weekly heartbeat is exactly
what that contract forbids. So the honest guarantee is: a Replit commit is read
the next time any session starts work, and a week with **no** session and **no**
`/maintenance` leaves it unread until one of the two happens. That is acceptable
because the lane is display-only by construction; it would not be acceptable as
the safety net for behavior changes, which is one more reason those never enter
the lane.

**There is deliberately no sweep ledger, and re-sweeping is the accepted
cost.** A record of "which commits were already swept" is a cache of state the
git log already holds, and this repo has been burned by exactly that shape
before — the review-loop round tally was stored, drifted, and was replaced by
counting fresh from GitHub every time (see CLAUDE.md's *Review loops*). Reading
a one-line display diff twice costs seconds; a ledger that goes stale costs a
missed commit. Where a sweep finds something real, the resulting `/bugfix` PR
is itself the durable record.

This is a retrospective safety net, not a gate: it never blocks or delays
Replit's own work, and it does not replace Replit's own internal CI or its
ability to repair what it finds live.
