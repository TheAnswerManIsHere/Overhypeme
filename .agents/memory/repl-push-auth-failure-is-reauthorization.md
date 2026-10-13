---
name: A push from the Repl that fails authentication needs re-approval, not a different route
description: The Repl holds GitHub credentials, but access needs David to re-approve from time to time; an auth error on push is "ask David to re-approve and retry", never proof the Repl cannot push.
---

# A Repl push that fails authentication needs re-approval

**What was observed (2026-08-27, during PR #577's close-out).** A `git push`
from the Repl failed with:

```
Invalid username or token. Password authentication is not supported for Git operations.
```

**What it means.** The Repl **does** store GitHub credentials, but access
periodically needs David to approve it again. A push rejected with this error
is a *"ask David to re-approve, then retry"* condition. Pushing from the Repl
remains a usable way to get commits off it. David corrected this on
2026-08-27, after the first harvest note recorded the opposite ("the Repl
cannot push to GitHub").

**The mistake to avoid** is inferring a permanent missing capability from a
single failed attempt. That conclusion rules out a recovery path that exists,
and that path matters most in an incident: Repl-only commits are not backed up
until something pushes them.

Related: commits the Repl makes on its own `main` reach GitHub's `main` only
through a pull request
([`replit-commits-reach-main-only-through-a-pr.md`](replit-commits-reach-main-only-through-a-pr.md)).
Push them to a branch.
