---
name: Auto-checkpoints can lose merge ancestry
description: Verify intended merge-parent ancestry after conflict resolution, even when the worktree is clean.
---

After resolving a Git merge conflict, verify that the intended remote tip is
actually an ancestor of the resulting branch. A clean worktree and an automatic
checkpoint commit are not sufficient evidence that the merge completed.

**Why:** During a conflict resolution, an automatic checkpoint preserved the
resolved file tree but replaced the in-progress merge with commits that did not
include the remote tip as a parent. Git therefore remained behind the remote
despite reporting a clean worktree.

**How to apply:** After any checkpoint-assisted conflict resolution, run
`git merge-base --is-ancestor <intended-remote-tip> HEAD` and inspect `HEAD`'s
parents. If the resolved tree is already correct but the parent is missing,
record the remote ancestry explicitly without reapplying stale tree content.