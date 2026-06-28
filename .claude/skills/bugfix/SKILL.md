---
name: bugfix
description: Enter bug-fixing mode — the lightweight workflow for small, well-understood fixes. Use when David says /bugfix, or asks to "just fix" a bug without the feature ceremony. Sets up a fresh bug branch off origin/main and switches to a fix-and-commit loop (one focused commit per bug, no plan file, no ChatGPT review, no TEST_RUN/UAT docs). Opposite of the default feature-building flow in CLAUDE.md.
---

# Bug-fixing mode

This skill puts me in **bug-fixing mode**: the deliberately lightweight
counterpart to the heavy feature-building flow that CLAUDE.md describes by
default. David invokes it explicitly (`/bugfix`) so there is **zero
inference** about which mode we're in — when this skill is active, the fast
path below is in force until David ends the session, opens plan mode, or
explicitly switches back to feature work.

## What this mode turns OFF

While in bug-fixing mode, the following CLAUDE.md feature-ceremony steps are
**suspended** — I do not do them, and I don't ask whether to:

- **No plan mode / no plan markdown file.** I don't draft a plan, don't write
  a plan `.md`, don't `SendUserFile` a plan, don't `ExitPlanMode`. I just fix.
- **No ChatGPT/external plan review.**
- **No `docs/PR<N>_*_TEST_RUN.md` and no `docs/PR<N>_*_UAT.md`.** Bug-fix PRs
  ship **neither doc** (David's standing call). The PR body itself carries a
  short per-bug "what changed / how to verify" line instead.
- **No "ship the UI surface" gate as a blocker.** A bug fix that's purely a
  fix doesn't need a new /debug page. (If the fix genuinely needs a UI change
  to be testable, include it — but don't manufacture surface ceremony.)

## What this mode KEEPS (non-negotiable)

- **Pause-and-ask on real ambiguity (CLAUDE.md rule 4).** If a "bug" turns out
  to be a behavior change in disguise, or the intended correct behavior is
  genuinely unclear, I stop and ask via `AskUserQuestion`. The bar is high —
  most small bugs are unambiguous and I just fix them — but a fix that silently
  changes what the product *does* is not a bug fix.
- **Verify before committing.** For each fix I run the touched tests +
  typecheck (the SessionStart hook already stands up the test DB). A fix that
  breaks the build doesn't get committed.
- **The squash-merge / never-force-push discipline** from CLAUDE.md still
  applies when I open the PR.
- **Bot-review engagement** (CLAUDE.md rule 6 + the auto-watch rules) still
  applies once a bug-fix PR is open.

## The loop

### 1. On `/bugfix` — set up the branch

David always squash-merges, so each batch gets a **fresh branch off current
`origin/main`** (avoids phantom conflicts from prior squash-merges):

Pick a short date slug, then **check for an existing branch of that name
before creating** — and create with a **non-resetting** `-b`, never `-B`.
`-B` *resets* the ref to `origin/main`, which would silently wipe an existing
same-day batch's unpushed commits:

```
git fetch origin main
# Choose the slug, e.g. claude/bugfix-jun28. If a branch with that name
# already exists for an unrelated open batch, pick a disambiguated slug FIRST
# (claude/bugfix-jun28-2, or a topic word) — do this before any checkout.
git checkout -b <chosen-slug> origin/main   # -b (not -B): fails if it exists, so it can't wipe unpushed work
```

If the `-b` create fails because the branch already exists, that's the signal
to pick a new slug and retry — **never** fall back to `-B`, `--force`, or any
reset onto `origin/main` to "fix" it, since that's exactly what could destroy
unpushed fixes. Then confirm to David: branch name + "bug-fixing mode is on,
send me bugs."

> Note: if I was already invoked on a designated working branch for this task,
> stay on it rather than creating a new one — the fresh-branch step is for the
> normal case where David starts a bug batch from scratch.

### 2. Per bug — fix, verify, commit

David feeds bugs one at a time or as a list. For **each** bug:

1. Reproduce / locate the cause.
2. Make the **smallest correct fix**.
3. Run the touched tests + typecheck.
4. **One focused commit per bug** — message names the bug and the fix, so the
   PR is a clean, revertable, one-commit-per-bug history. Don't batch multiple
   unrelated bugs into one commit.

Keep going as David sends more. Don't open a PR yet — bug-fixing mode
accumulates commits on the branch and **waits for David's explicit "create the
PR."**

### 3. On "create the PR" — ship the batch

1. `git fetch origin main` and rebase the branch onto `origin/main` so it sits
   exactly on top of current `main` (per CLAUDE.md's squash-merge workflow).
2. Re-run the touched tests + typecheck on the rebased state.
3. `git push -u origin <branch>` (retry with backoff on network errors; never
   force-push — `.claude/guard.sh` blocks it).
4. Open the PR (`mcp__github__create_pull_request`, base `main`). **Body
   format:** a short bullet list — one line per bug — each with *what was
   wrong → what changed → how to verify*. **No TEST_RUN doc, no UAT doc.**
5. Auto-subscribe to the PR's activity (CLAUDE.md auto-watch rules) and return
   the PR URL.

## When NOT to use this mode

If the request is actually a feature, a behavior change, a schema change with
product consequences, or anything where David needs to verify intent — that's
**feature mode** (the CLAUDE.md default). Don't use `/bugfix` to sneak a
feature through the lightweight path. When unsure which it is, ask.
