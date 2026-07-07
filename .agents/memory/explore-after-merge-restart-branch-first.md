---
name: restart the branch onto origin/main BEFORE exploring/planning, not just before pushing
description: Why an Explore/Plan pass can silently read a stale local working tree after a prior PR on the same branch squash-merged, and produce a wrong plan a live-code check would have caught.
---

# Explore/plan against a stale local checkout after a squash-merge

## What happened

Mid-arc on the Stale-Fact Refresh feature, PR3 (#168) squash-merged. The next
session restarted work on PR4 (bulk send-back) on the **same branch name**,
but exploration (several `Explore`-type subagents reading local files via
`Read`/`Grep`) ran **before** the branch was restarted onto `origin/main`. The
branch's local tip was still PR3's pre-squash commits — which predated a
moderation-workflow rebuild that had *already merged into `main`* in the
meantime (three-step moderation: `concept_review` as Step 2, `production_review`
as Step 3; Visual Ideas as a *blocking* Step-2 gate).

The subagents faithfully reported what the local files said — which was
correct for the tree they were reading, wrong for the repo's actual current
state. The resulting plan called `production_review` "Step 2" and claimed
Visual Ideas "never gate the workflow." Both were fabricated-sounding but were
actually just **stale**, not hallucinated — an external review (ChatGPT,
reading `origin/main` directly) caught it before any code was written, but
only because that review happened to check live code rather than trusting the
plan's confident-sounding vocabulary.

## The generalizing rule

**Restarting the branch onto `origin/main` is a precondition for exploration
and planning, not just for pushing.** The existing squash-merge workflow
(CLAUDE.md) already mandates `git fetch origin main` + rebase-or-restart
*before pushing follow-up work* — but by the time you're at the push step,
you've already explored, planned, and possibly built on stale ground. The fix
is to move the "am I on top of origin/main?" check to the **start** of a new
work session on a branch, before spawning any subagent that reads local files:

```bash
git fetch origin main
git log origin/main..HEAD --oneline   # anything here should ONLY be your own unmerged work
```

If the branch's local tip is behind `origin/main` (or if you can't tell
whether recent commits are yours or already-merged history from a prior PR),
restart the branch (`git checkout -B <branch> origin/main`, or a fresh branch
if there's genuinely unmerged work to preserve — rebase it) **before** running
any exploration. A subagent has no way to know the tree it's reading is stale;
it will report local-file truth as if it were repo truth.

## Why this is easy to miss

- The mistake produces *confident, well-cited* output — the subagent quotes
  real file:line locations, so the report reads as verified even though the
  file itself is outdated.
- It's most likely to bite exactly when it matters most: right after a fast
  sequence of related PRs on the same feature arc, where a teammate's/agent's
  rebuild of a *related* subsystem can land on `main` between sessions without
  you noticing, because your own branch's history looks unremarkable.
- `git status`/`git log` on the stale branch show nothing alarming — the
  branch just looks like it's "a few commits behind," which is easy to
  dismiss as cosmetic when you don't yet know a semantic rebuild happened
  underneath.

## Overhype specifics

This surfaced on the Stale-Fact Refresh PR4 build (session ending in PR #205).
See the corrected vocabulary in
[`moderation-workflow.md`](../../docs/ai-context/moderation-workflow.md)
(Step 2 = `concept_review`, Step 3 = `production_review`) and the "Stale
historical docs treated as current truth" entry in
[`known-failure-patterns.md`](../../docs/ai-context/known-failure-patterns.md) —
this is the same failure family, but the stale artifact was a **local git
checkout**, not a doc file.
