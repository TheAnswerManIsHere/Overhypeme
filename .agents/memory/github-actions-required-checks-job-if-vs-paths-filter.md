## Skipping CI on some PRs: job-level `if:`, never workflow-level `paths:`

To skip a required check on PRs that provably can't affect it (e.g. a
docs-only PR skipping the integration test suite), gate the **job** with
`if:`, never the **workflow** with `paths:`/`paths-ignore:`.

A workflow-level `paths` filter means the workflow simply never triggers for
a non-matching push. A required status check with no run to report against
it sits at "Expected — waiting for status to be reported" **forever** — it
is not "passed," it blocks the merge indefinitely, and nothing about it
looks broken until someone notices the PR won't go green.

A job skipped via `if:` instead reports its own status as **"Success"** —
GitHub's documented behavior: *"A job that is skipped will report its
status as 'Success'. It will not prevent a pull request from merging, even
if it is a required check."* Same skip outcome, opposite effect on a
required check.

Corollary bugs to watch for once you're gating with job-level `if:`:

- **A `needs:`-gated job SKIPS (doesn't run) if the job it depends on
  fails** — and a skipped job reports success. So a transient failure in
  the gating job (e.g. the classifier that decides `run-heavy`) would
  silently green-light every downstream required check with zero tests
  run, unless the gated jobs' condition explicitly runs on failure too
  (`!cancelled() && (needs.<job>.result != 'success' || ...)`, not a bare
  `needs.<job>.outputs.foo == 'true'`).
- **Use `!cancelled()`, not `always()`**, in that condition if the workflow
  also uses a `concurrency` block with `cancel-in-progress` — `always()`
  would run the job even after its own concurrency group cancelled it.

See `scripts/classify-ci-paths.mjs` and `.github/workflows/build.yml`
(PR #334) for the current implementation.
