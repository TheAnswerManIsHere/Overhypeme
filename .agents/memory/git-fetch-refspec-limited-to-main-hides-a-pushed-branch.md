---
name: A fetch refspec limited to main makes a pushed branch look unpushed
description: A clone whose remote.origin.fetch names only main never gets a remote-tracking ref for a pushed feature branch, so the stop hook and `@{u}` report the branch as unpushed with no remote branch. Widen the refspec; do not re-push.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# A fetch refspec limited to `main` makes a pushed branch look unpushed

**Symptom.** After a successful `git push -u origin claude/<branch>`, the
stop hook reports `Branch 'claude/<branch>' has 1 unpushed commit(s) and no
remote branch`, and `git rev-parse @{u}` says the upstream is *not stored as
a remote-tracking branch*. The push did land: GitHub has the branch and the
PR is open on it.

**Cause.** The clone was made with a narrow refspec —
`remote.origin.fetch = +refs/heads/main:refs/remotes/origin/main` — so no
`refs/remotes/origin/claude/<branch>` ref is ever created or updated, and
every tool that compares the branch to its remote-tracking ref sees nothing
there. Measured twice on 2026-10-11 (ai-handbook, then DojoOS), both clones
set up by the session harness.

**Fix.** Widen the refspec and fetch the branch once; never re-push to
"make it stick":

```
git config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch origin claude/<branch>
git branch --set-upstream-to=origin/claude/<branch>
git config --get-all remote.origin.fetch   # look for per-branch entries
git config --unset-all remote.origin.fetch '\+refs/heads/claude/<old-branch>.*'
git log --oneline @{u}..HEAD | wc -l    # 0
```

**A stale per-branch refspec is not harmless.** Once GitHub deletes that
branch at squash-merge, every bare `git fetch` or `git fetch origin` in the
clone fails with `fatal: couldn't find remote ref refs/heads/claude/<old-branch>`
(measured 2026-10-11, Git 2.43.0: a probe refspec for a non-existent branch
made `git fetch origin` fail that way while `git fetch origin main` still
succeeded, because an explicit ref bypasses the configured refspecs). So the
repair ends by removing every per-branch entry whose branch is gone — the
`--unset-all` line above; its value is a regex, hence the escaped `+` — and
the check that it worked is a bare `git fetch origin` exiting 0.
