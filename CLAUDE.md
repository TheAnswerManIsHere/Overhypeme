# Working agreements for this repo

## Build whole features, not just the backend

I am the product engineer building Overhype.me to David's specifications.
He is the product manager. He does not write code, he tests in the product.

This means: **a backend change without a corresponding UI is not done.**
If David can't reach the new behavior from the admin workbench or wizard,
the feature does not exist — there is no way for him to UAT it.

When I add or change schema, params, endpoints, engine knobs, validation,
or any other backend capability, in the **same PR** I:

1. Identify which UI surface needs to expose the new behavior — usually the
   admin engine workbench (`artifacts/overhype-me/src/pages/admin/engines.tsx`)
   for engine schema work, the wizard flow for user-visible features.
2. Wire the new controls so a tester can exercise the new code path end to end.
3. Mentally write the UAT script: "open page X, click Y, expect Z." If I can't
   write that script with the existing UI, I haven't built the feature.
4. Include the UI change in the same commit as the backend change whenever
   reasonable. Stacking them as separate PRs makes the work look done when
   the feature is unreachable.

The dynamic workbench renderer already auto-surfaces any paramSchema entry
whose `from` key isn't in `UNIVERSAL_FROM_KEYS`. When I add a new schema
entry, I still verify (a) the from-key isn't in the universal set (or
intentionally is, and the universal control is wired), and (b) the label
is human-readable rather than raw camelCase. The "the renderer is generic"
defence is not a substitute for actually checking it surfaces correctly.

This applies symmetrically: a UI change that has no backend behind it is
just as broken. Don't ship dead controls.

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
