# A brand-new workflow can't be `workflow_dispatch`-triggered until it exists on the default branch

**What happened:** while building the workstream-board sync (PR #318), I
tried to manually trigger the new `.github/workflows/project-sync.yml` via
`workflow_dispatch` against the *feature branch*
(`ref: claude/status-skill-lifecycle-ovg8yw`) before the PR merged, on the
theory that GitHub only needs the workflow file to exist on the ref being
dispatched against. It doesn't: the API call returned a 404, and
`list_workflows` confirmed the workflow wasn't registered in the repo at
all pre-merge.

**The generalizable rule:** a workflow's *first* `workflow_dispatch`
requires the workflow file to already be on the repository's **default
branch** — GitHub registers dispatchable workflows from the default
branch, not from arbitrary refs, even though `workflow_dispatch`'s own
`ref` parameter looks like it should let you target any branch that has
the file. After that first registration (post-merge), it dispatches
against other refs normally. Don't try to test-drive a brand-new
`workflow_dispatch` workflow pre-merge from its own PR branch — the only
way to verify it end-to-end is to merge it first, then trigger it.

**Reference:** PR #318 (introduced the workflow) → PR #322 (the fix its
first live run needed). `mcp__github__actions_run_trigger` /
`mcp__github__actions_list` (`list_workflows`) are the tools that surfaced
this.
