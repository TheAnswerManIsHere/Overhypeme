# Working agreements for this repo

## Always open a PR when work is done

The user works exclusively from the Claude Code on the Web UI. Pushing to a
feature branch is necessary but not sufficient — they only see merge-able
work via GitHub pull requests.

**Whenever I finish a unit of work, before ending my turn:**

1. Verify the branch has commits ahead of `origin/main`.
2. Check `mcp__github__list_pull_requests` (head: `theanswermanishere:<branch>`,
   state: `open`) — is there already an open PR?
3. If yes, the existing PR will pick up the new push. Mention the PR URL in
   the closing message and stop.
4. If no, open a new PR with `mcp__github__create_pull_request` (base: `main`,
   head: the branch). Title + body should describe the change. Return the
   PR URL.

This applies even when the user didn't explicitly ask for a PR. The default
is "ship for review." The only exceptions: pure exploration with no commits,
or the user has explicitly said "don't open a PR for this."

If the branch is ahead of `main` by commits already merged into `main` via a
squash (i.e., the original feature commit + a follow-up), rebase onto
`origin/main` before opening so the PR diff is the follow-up alone.
