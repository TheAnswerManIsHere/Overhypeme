# Codex GitHub review follow-up workflow

This repo has previously used GitHub `@codex` mentions to fix comments left by
Codex reviews. When those follow-up tasks are run from a pull request that will
later be squash-merged, Codex may create a stacked PR whose base branch is the
original PR branch. If the original PR branch is deleted after the squash merge,
the stacked follow-up branch/PR can disappear before its commits ever reach
`main`.

## Current audit notes

As of 2026-05-12, the local repository was compared against the public GitHub PR
history that was visible without authentication:

- PR #43 (`MBFO-1`) had a Codex review thread on `FactDetail.tsx`. The current
  tree contains the wizard mount wiring in `FactDetail.tsx`, so the relevant
  follow-up remains present.
- PR #42 (`Phase 6`) had Codex review threads for the share-intents migration and
  share modal. The current tree contains the `0052_share_intents` migration
  journal entry/snapshot and the `meme.createdAt` render ETag fix. A stale shared
  cache-header comment was corrected in this audit.
- PR #41 (`Phase 5`) had Codex review threads for app routing, OG shell URLs, and
  the meme page. The current tree contains the absolute `og:image` handling and
  related tests.
- PR #38 (`Persist meme framing transforms`) was created from a
  `codex/follow-up-on-github-mention` branch. The current tree contains the
  `framing_transform` migration/schema/API/client rename, so that conflict
  resolution survived.
- Older codex-labeled PRs (#10-#23) are already represented in the current
  squashed history. No public, still-relevant stacked follow-up branch was visible
  for them during this audit.

## Required workflow going forward

When asking Codex to address review feedback on an in-flight PR, do **one** of
these:

1. **Preferred:** run Codex on the original PR branch and commit directly to that
   branch, then update the same PR.
2. If Codex creates a stacked PR anyway, **do not delete the original PR branch**
   until the stacked PR is merged or cherry-picked into `main`.
3. Before squash-merging the original PR, compare the stacked PR diff against the
   original PR branch and either:
   - cherry-pick the stacked commits onto the original PR branch, or
   - retarget/rebase the stacked PR onto `main` and merge it separately.

## Merge checklist

Before deleting a PR branch after squash merge:

- Search for open or recently closed PRs whose base branch is the branch being
  deleted.
- Search the original PR timeline for `@codex` follow-up comments and
  `chatgpt-codex-connector` task summaries.
- Confirm every follow-up commit is reachable from `main` with
  `git branch --contains <commit>` or by comparing the follow-up PR files against
  `main`.
- Only delete the branch after all follow-up work is present on `main` or is
  intentionally abandoned as obsolete.
