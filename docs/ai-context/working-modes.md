# Working Modes: feature (default) vs. bugfix

> The canonical, cross-agent statement of the two workflows David uses. **David
> picks the mode explicitly so there is zero guessing.** This applies to Codex,
> Claude, and any agent. (Claude Code layers extra ceremony on top per
> [`CLAUDE.md`](../../CLAUDE.md) and its `/bugfix` skill; the *distinction* below
> is the shared truth.)

There are two modes. The default is **feature mode**. **Bugfix mode** is a
deliberately lightweight path David turns on explicitly for small, well-understood
fixes.

## Feature mode (default)

The full workflow for building or changing product functionality. In this mode:

1. **Inspect the repo first** (read the relevant `docs/ai-context/*`).
2. **Plan before implementing, and get David's explicit approval** before you
   build — see the plan-before-implementation rule in
   [`agent-working-rules.md`](./agent-working-rules.md) and the template in
   [`../../.agents/PLANS.md`](../../.agents/PLANS.md). Do not start the build on an
   unapproved non-trivial plan.
3. **Build it fully, end to end** (backend + the UI surface to exercise it + tests
   + any doc updates).
4. **Tests prove the general invariant**, not just the reported example.
5. **Open a PR** for review.

Any "let's build / add / change X", a behavior change, or a schema change with
product consequences is feature mode.

## Bugfix mode (explicit, lightweight)

A fast fix-and-commit loop for small, well-understood bugs. **David turns it on
explicitly** (see *How each agent enters/exits a mode* below) — once per bug
batch, not per bug. While it's on:

**Setup — a fresh branch off `origin/main`.** Because David squash-merges, each
batch starts from current `origin/main` to avoid phantom conflicts from prior
merges. Use a non-resetting create (fail rather than wipe an existing same-day
batch), pick a disambiguated name if it already exists, and **never** force/reset
onto `origin/main` to "fix" a name clash.

**Per bug — fix, verify, commit:**
1. Reproduce / locate the cause.
2. Make the **smallest correct fix**.
3. **Verify before committing** — run the touched tests + typecheck (see
   [`../engineering/testing-guide.md`](../engineering/testing-guide.md)). A fix
   that breaks the build doesn't get committed.
4. **One focused commit per bug** — the message names the bug and the fix, so the
   history is clean and revertable. Don't batch unrelated bugs into one commit.

Accumulate commits as David sends more bugs. **Don't open the PR until David
explicitly says so** ("create the PR"). Then rebase onto `origin/main`, re-run the
touched tests, push, and open the PR with a short **one-line-per-bug** body (*what
was wrong → what changed → how to verify*).

**What bugfix mode turns OFF:**
- No plan / no plan-approval ceremony (you just fix).
- No forced "ship a new UI surface" gate for a pure fix (include UI only if the fix
  genuinely needs it to be testable).
- No heavyweight per-PR test/UAT docs.

**What it KEEPS (non-negotiable):**
- **Pause-and-ask on real ambiguity.** If a "bug" is actually a behavior change in
  disguise, or the correct behavior is genuinely unclear, **stop and ask** — that's
  feature work, not a fix.
- **Verify before committing.**
- **Source-of-truth discipline** (don't silently overwrite human decisions, don't
  create a duplicate source of truth) — see
  [`known-failure-patterns.md`](./known-failure-patterns.md).
- **Squash-merge / never-force-push discipline** and **bot-review engagement** once
  a PR is open.

## How each agent enters / exits a mode

**The mode is always David's explicit choice — never inferred.**

- **Claude Code** has an auto-loading `/bugfix` skill; David types `/bugfix` to
  enter and any clear exit phrase ("back to features", "exit bugfix mode") to leave.
- **Codex** has no auto-triggering skill system, so the signal is **in David's
  prompt**. David starts a request with, e.g., **"Bugfix mode:"** (lightweight fix)
  or **"Regular mode:"** / **"Feature mode:"** (full workflow, plan first). Codex
  reads *this doc* via `AGENTS.md` and applies the matching workflow. Absent an
  explicit signal, Codex is in **feature mode** (the default) and follows the
  plan-before-implementation rule.
  - *Optional:* if a given Codex setup supports custom prompt files (e.g. a
    `/bugfix` prompt), point that prompt at this doc — it doesn't change the
    contract, just the trigger.

**Mode persistence & switching:** a mode stays in force across messages until David
ends it. If a request that arrives during bugfix mode looks like **building or
changing product functionality** (a feature, a behavior change, a schema change
with product consequences), **do not silently treat it as a fix and do not silently
switch** — **ask** whether to exit bugfix mode and switch to the feature workflow.
Guessing wrong is expensive in both directions (skipping a plan a feature needed, or
piling ceremony onto a one-line fix), and the confirm costs one question.

## When NOT to use bugfix mode

Features, behavior changes, schema changes with product consequences, or anything
where David needs to verify intent — that's **feature mode**. Don't use bugfix mode
to sneak a feature through the lightweight path. When unsure which it is, **ask.**
