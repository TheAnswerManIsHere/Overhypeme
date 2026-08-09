---
name: A /document harvest branch can hit a real merge conflict against another concurrent docs PR
description: Restarting a /document ceremony's branch fresh off origin/main only fixes staleness — if another PR merged in the meantime and touched the same shared docs files, popping stashed edits produces genuine content conflicts, not just a rebase formality.
---

## Rule
The `/document` ceremony's default placement rule
([`documentation-workflow.md`](../../docs/ai-context/documentation-workflow.md#step-5--report--commit))
says to restart the harvest branch fresh off `origin/main` before committing.
That step removes *staleness* (a branch based on pre-merge history), but it
does not guarantee a clean merge: if another PR — another `/document` run, a
feature, a bugfix — merged in the interval and touched the **same** shared
docs files (`decisions.md`, `current-roadmap.md`, `known-failure-patterns.md`,
`MEMORY.md` are the highest-traffic ones, since almost every harvest touches
them), popping the stashed edits onto the fresh branch produces a real,
line-level merge conflict that must be resolved by hand.

## What happened (PR #273, verified against this repo)
While harvesting PR #270's loop-ledger learnings, PR #272 (an unrelated
Stripe-sync diagnosis harvest) squash-merged into `main` in the interval and
edited the exact same four files: `MEMORY.md`, `decisions.md`,
`current-roadmap.md`, `known-failure-patterns.md`. Restarting the branch
(`git checkout -B <branch> origin/main`) and popping the stash produced three
genuine `CONFLICT (content)` markers — not a clean auto-merge — because both
harvests appended entries at the same insertion point (the top of
`decisions.md`'s newest-first list; the end of `MEMORY.md` and
`known-failure-patterns.md`'s append-only sections).

## Why it's dangerous
It's tempting to read "restart the branch" as a mechanical, always-clean step
(like the analogous pre-push restart in
[`explore-after-merge-restart-branch-first.md`](explore-after-merge-restart-branch-first.md)),
and either skip carefully reviewing the pop, or resolve it by picking one
side and silently dropping the other PR's entry — which deletes a just-merged
colleague's documented learning without anyone noticing, since both sides of
the conflict look like innocuous doc prose rather than code that would fail a
test.

## How to avoid
- After `git stash pop` reports conflicts, resolve each file by **keeping
  both sides' content**, not by picking one — these files are additive logs
  (newest-first or append-only), so the correct resolution is almost always
  "both entries stay," ordered correctly (newest-first files: order by date;
  append-only files: either order is fine, but don't interleave mid-entry).
- Re-read each resolved file in full afterward to confirm structural
  integrity (no orphaned `---` separators, no entry split across the
  conflict boundary) — don't just stage what `git stash pop` leaves behind.
- Run `pnpm run check:docs` and `git diff --cached --check` after resolving,
  same as any other docs change — a conflict resolution is exactly the kind
  of edit that silently breaks a relative link or leaves whitespace debris.
