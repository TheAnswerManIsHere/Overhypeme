## `concurrency` groups: `github.ref` collides across pushes; `queue: max` can't combine with a conditional `cancel-in-progress`

Two traps hit while adding a `concurrency` block to cancel superseded
PR-review CI runs without ever dropping a push-to-main run (PR #334):

**`github.ref` is identical for every push to the same branch.** A group
key like `${{ github.workflow }}-${{ github.event.pull_request.number ||
github.ref }}` looks like it separates "PR runs" from "push-to-main runs,"
but every push-to-main run shares the exact same `github.ref`
(`refs/heads/main`) — so they all land in the *same* concurrency group as
each other. `cancel-in-progress: false` only protects the run currently
**executing**; GitHub's default `queue: single` still only holds one
**pending** run per group, so a third quick push can silently replace the
second push's still-queued run before it ever starts. A workflow comment
claiming "every push-to-main run completes" was wrong for exactly this
reason until fixed.

The fix that actually holds: fall back to **`github.run_id`** (unique per
run), not `github.ref`, for any event where every run must complete
independently. Runs that never share a group can't be queued against or
cancel each other — no `queue` setting needed at all for that side.

**`queue: max` cannot be combined with a `cancel-in-progress` that can
evaluate `true`.** GitHub documents this as a hard validation error. If a
`cancel-in-progress` expression is conditional (e.g.
`${{ github.event_name == 'pull_request' }}`) and evaluates `true` for
*any* event the workflow handles, you cannot also set `queue: max` on
that same block — even for the events where `cancel-in-progress` would
evaluate `false`. This is why `queue: max` (correct for `project-sync.yml`
and `test-run-completion.yml`, which never cancel anything) isn't a
drop-in fix for a workflow that also cancels PR runs — the `github.run_id`
fallback above sidesteps the conflict entirely by making the setting moot
for those events.

See `.github/workflows/build.yml` and `.github/workflows/codeql.yml` for
the current implementation.
