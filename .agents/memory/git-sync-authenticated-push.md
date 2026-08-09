---
name: Authenticated Git sync
description: Shell HTTPS pushes can fail even when Replit's authenticated Git sync works.
---

When publishing to a GitHub remote from this workspace, prefer the authenticated Git sync integration over a direct shell `git push` if HTTPS credentials are rejected.

**Why:** The repository remote uses GitHub HTTPS, and the shell environment may not have a usable GitHub username/token even though the workspace's connected GitHub account can push successfully.

**How to apply:** Keep local branch and merge state correct with normal Git commands, then use the authenticated Git push operation for the final remote update.