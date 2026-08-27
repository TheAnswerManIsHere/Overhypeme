---
name: a squash-merge deletes the remote branch, but a stale local remote-tracking ref survives and can trigger a false "unpushed commits" warning
description: git fetch --prune fixes a stop-hook or git-status report that claims unpushed local commits exist when the branch is actually fully merged and identical to origin/main.
---

# A deleted remote branch leaves a stale tracking ref behind

## What happened

After PR #416 squash-merged, GitHub deleted the remote branch
`claude/replit-connector-capabilities-u84hqm` as usual. A git stop-hook then
reported "1 unpushed commit(s) on branch
'claude/replit-connector-capabilities-u84hqm'. Please push these changes."

The local branch was, in fact, byte-for-byte identical to `origin/main` (same
SHA, empty `git status`, zero commits in `git log HEAD ^origin/main`). The
warning was checking against `origin/claude/replit-connector-capabilities-u84hqm`
— a local remote-tracking ref left over from *before* the merge, still
pointing at the branch's pre-merge head. Git had no way to know the remote
branch was gone until something re-fetched with pruning; until then, the
stale ref looked like a real, unmerged divergence.

## The generalizing rule

**A squash-merge deletes the remote branch but does not clean up the local
remote-tracking ref that pointed at it.** Any check that compares local `HEAD`
against `origin/<same-branch-name>` — a stop hook, a manual `git status
--branch`, a habit of eyeballing "am I pushed?" — can read that stale ref and
report a false divergence for a branch that is, in reality, fully merged.

Diagnose before acting on the warning:

```bash
git rev-parse HEAD
git rev-parse origin/main
git rev-parse origin/<branch-name>          # does this even exist on the real remote?
git ls-remote --heads origin <branch-name>  # empty output = branch is gone, ref is stale
```

If the remote branch is genuinely gone and local `HEAD` already matches
`origin/main`, the fix is `git fetch origin --prune` (or `git fetch --prune
--all`) — never a push. Pushing to a name GitHub just deleted would
silently recreate the branch and does nothing to actually reconcile anything.

## Why this is easy to get wrong under pressure

The warning's wording ("push these changes") reads as an instruction to run
`git push`, which is exactly the wrong reflex here — there is nothing to
push, and attempting it either fails oddly or resurrects a branch that was
correctly deleted. The fix is the opposite direction: prune the stale local
state, don't publish more of it.

## Overhype specifics

Surfaced 2026-08-11 on the Replit-connector session, immediately after PR
#416 (the `scripts/bin/claude` launcher) squash-merged. Same branch name was
about to be reused for further work in the same session, which is exactly
the situation this bites in — see also
[`explore-after-merge-restart-branch-first.md`](./explore-after-merge-restart-branch-first.md)
for the related-but-distinct failure of exploring against stale *content* on
a reused branch name, rather than a stale *ref* triggering a false alarm.
