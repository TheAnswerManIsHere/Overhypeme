---
name: sync-fleet
description: Comlink — deliver KITT's merged payload to every consumer repository and tell the active sessions to pull it. Runs from KITT only, automatically when approved KITT work that changed `core/` finishes (before the plan-done line), or when David says /sync-fleet, "sync the fleet" or "push KITT out". Per consumer: checks the overlay declarations the payload now asks for, runs `scripts/sync.mjs` from a clean checkout of KITT's `main`, opens or updates the one sync pull request, merges it on David's standing Trivial declaration, syncs the Repl; then messages each active session to merge `main` at its next boundary and re-read the files that changed. NOT a Repl sync (close-out step 3), and NOT for a consumer session, which never syncs.
---

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# /sync-fleet — Comlink

**Comlink** is the communicator KITT talks to Michael through; this skill is
how KITT's payload reaches the products and how the sessions working in them
hear about it (David, 2026-11-04: *"a skill … that tells you to synchronize
Kitt to all applicable repos and to tell all active sessions to pull the
latest code"*).

**KITT only.** A consumer carries this file because every payload skill
ships, but a consumer has no `scripts/sync.mjs` at its root and nothing of
its own to deliver: invoked there, say so in one line and stop.

## When it runs

- **Automatically, once a unit of KITT work has finished and the merges in
  it changed `core/`** (David, 2026-11-04, choosing "at plan done" over
  "after every merge" and "only when asked") — an approved plan, a
  `/maintenance` pass, a one-off he asked for: after the last merge
  report's work and before the unit's final hand-back — for a plan, the
  `✅ **PLAN DONE** —` line, which is not written until this skill's sync
  PRs have merged or are each waiting on a named event. Work whose merges touched nothing under `core/` has nothing to
  deliver and does not run it. The rule is KITT's `CLAUDE.md`, *Delivering
  the payload*.
- **When David asks**, at any time.

A plan with several phases syncs once, at its end, so a consumer never
receives a phase that a later phase completes.

## Step 1 — a payload that is `main`, and nothing else

`scripts/sync.mjs` ships the **committed** `core/` of the checkout it runs
from (`git archive HEAD:core`). A session's own feature branch is not
`main`, so the sync never runs from it. Make a clean worktree of KITT at the
fetched `main` in the scratchpad and run every sync from there:

```
git fetch origin main
git worktree add --detach "$SCRATCH/kitt-main" origin/main
```

Its commit is **the delivered commit**; every PR body and message below
names it.

## Step 2 — find the consumers

Nothing lists them, and nothing should — a list is a second record to keep
true. List the repositories the account can reach (`list_repos`); a
repository whose `main` carries `.agents/core/claude-core.md` with the
`SYNCED FROM KITT` header (or the old `AI-Handbook` one) is a consumer. KITT
itself is not. Name the set found in the hand-back, so a repository missing
from it is visible.

Each consumer is attached with `add_repo` (`access: "push"`) and cloned into
the scratchpad. A refusal from GitHub or the organisation is that
repository's result, reported; the others carry on. **A refusal by the
auto-mode permission classifier is not**: it is session-wide, so the run
stops at this step and asks David once on a 🛑 — measured 2026-11-04 in a
session whose settings had no allow rule for `add_repo`, cleared when he
answered and the session left auto mode
([`add-repo-refused-in-auto-mode.md`](../../../.agents/memory/add-repo-refused-in-auto-mode.md),
which also says what KITT's allow rule may change).

## Step 3 — per consumer, what has it not got?

**The last delivered commit** is the one named on the consumer's most recent
merged sync PR (title `Re-sync KITT <sha7>`, the fleet's existing form; Step 5). With none on record, the
delta is the whole payload, and that is said. `git -C "$SCRATCH/kitt-main" log
--oneline <last>..HEAD -- core` is what the sync will carry; empty means
nothing to deliver, and the repository is reported as current.

**One sync PR per repository, ever open at once.** Before anything is
written, look for an open PR in that repository whose title starts `Re-sync
KITT`. If there is one, this run **updates it** — its branch, merged with
the consumer's `main` if that has moved, then synced again, its title and
body rewritten to the new delivered commit — rather than opening a second
that would conflict with it.

**A sync PR is one this skill opened, and the title alone never shows that.**
Every consumer is public, so anyone can open a fork PR titled `Re-sync
KITT…` and let maintainers push to its branch. Adopting that branch would
carry its commits into `main` under the Trivial declaration (Codex security
review, Overhype.me PR #859). So a PR counts as a sync PR — for the
last-delivered commit and for the one to update — only when its head branch
is `kitt-sync/<sha7>` **in the consumer repository itself** (not a fork) and
it was opened by the account this session pushes as. A PR that has the title
without both is not touched: it is named in the hand-back as an impostor, and
the run opens its own. Before merging (Step 6), the PR's diff must be only
what the sync wrote plus Step 5's index lines; anything else stops that
repository's merge and is reported.

## Step 4 — the declarations check (`docs/consuming-repos.md`, step 6)

This is the step a blind loop would skip, and the one that fails silently:
a payload rule that dereferences an answer the consumer's
`docs/ai-context/overlay-declarations.md` has never given resolves to
nothing. For the delta from Step 3:

1. **New declarations.** Compare enrollment step 1's table with the
   consumer's `overlay-declarations.md`. A question it does not answer is a
   gap.
2. **Retired rules restated locally.** Where the delta retires a rule, read
   the consumer-owned documents that rule named as its record; one still
   stating it as current is a gap.

A gap the repository can answer (a module path, a stale sentence) is fixed
in **its own PR in that repository, under the class its content earns** — it
is consumer-owned content, so the standing declaration below does not cover
it — and merges before the sync PR. A gap only David can answer (which
features are in prototype phase, which subsystems are sensitive) holds
**that repository's** sync on a 🛑 banner naming the question; the other
repositories go ahead.

## Step 5 — sync, and open the PR

In the consumer clone, on a fresh branch `kitt-sync/<sha7>` off its
`origin/main` (or the open sync PR's branch, Step 3):

```
node "$SCRATCH/kitt-main/scripts/sync.mjs" --to "$CLONE" --dry-run
node "$SCRATCH/kitt-main/scripts/sync.mjs" --to "$CLONE"
```

Read every `NOTE` the sync prints. A missing settings entry it names is
merged by hand from the template in **a separate PR under its own class**,
since a settings or permissions change is not a sync; the `NOTE` goes in the
sync PR body so it is not lost. The one hand edit the sync PR itself carries
is the index line in `.agents/memory/MEMORY.md` for each fleet memory note
the delta delivers (`docs/consuming-repos.md`, *Required consumer
documents*).

Commit, push, and open (or update) the PR:

- **Title:** `Re-sync KITT <sha7>: <what it delivers, in a few words>` — the
  form every sync PR in the fleet already carries, so Step 3 finds them.
- **Body:** the delivered commit in full and the last one; each KITT PR in
  the range by number and title; every `NOTE` line; the declarations check's
  result; `Oracle source: no plan` — the content was reviewed where it was
  written; **David's standing declaration, quoted** (*"3. 1."*, answering
  *"How each product repo's sync PR is reviewed: 1. Like a Trivial PR"*,
  2026-11-04; `working-modes.md`, *Trivial*); `## Decisions taken on my
  recommendation`; and the one latitude line: *none beyond the standing
  declaration*. No `Workstream:` line: a sync PR delivers fleet machinery,
  not a product workstream.

## Step 6 — merge it as Trivial

The bar is the Trivial class's, nothing more (`working-modes.md`,
*Trivial*): subscribe to the PR, arm the 15-minute check-in for Codex's
automatic pass (`claude-core.md`, *Waiting, and scheduled check-ins*, item
4), read that pass for a P1 — judged and reported, fixed in a named commit
or merged with the reason — resolve each thread citing the declaration,
merge on green CI by squash. No review is requested and no build report is
written.

**A sync PR whose CI fails is a finding about KITT, not about the
consumer**: the payload broke something there. It stays open, the failure
is reported, and the fix is made in KITT and delivered by the next run —
never by editing a synced file in the consumer.

Then the consumer's own close-out: check and sync its Repl
(`claude-core.md`, *Close-out*, step 3), which every merge to `main` owes.

## Step 7 — tell the sessions

A running session does **not** see a change to its `CLAUDE.md` or the core
it imports: measured 2026-11-04, a token appended to KITT's `CLAUDE.md` by a
shell command never reached the running session's context over the
following tool calls. Skills are the exception: the same session was told
of a new `SKILL.md` the moment it was written, and could invoke it. So a
session must get the files, then re-read the contract files among them.
Re-reading is the best a running session can do, and it is not proven to
win over the copy loaded at start: the same measurement showed only that the
change is not seen, and two live instructions that contradict each other can
either of them fire. **Only a new session is certain to run under the new
rules**, so the message says so, and the hand-back names any change that
needs that certainty.

List the account's sessions (`list_sessions`, `mine: true`) and send each
one that is not archived and works in a synced repository — KITT's own
included — one `send_message` at `priority: "later"`, so no turn is
interrupted:

> KITT `<sha7>` has reached `<repo>`'s `main` (PR #N — `<title>`). At your
> next boundary — before your next push, or when you start a branch — merge
> `origin/main` into your branch. Not mid-review-round: a merge is a new
> head and costs a round. Then re-read these files, since a running session
> does not reload them: `<changed paths outside .claude/skills/>`. Re-reading
> is best effort; a new session is the only sure way onto the new rules.
> Nothing else about your work changes.

A session in Replit or on a local machine is not reachable this way; the
hand-back says how many were messaged and that those were not.

## Step 8 — the hand-back

One line per consumer: current, synced (PR number and title, merged), held
(the 🛑 question), or failed (what, and where). Then the sessions messaged.
Remove the worktree. A held repository is a 🛑 banner; everything synced and
the approved work finished is the `✅ **PLAN DONE** —` line.
