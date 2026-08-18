# Reading which test actually failed in CI — the log tail won't tell you

`mcp__github__get_job_logs` returns the **tail** of a job's log, and this
repo's `Test` job ends with the Postgres service container dumping its own
output — hundreds of lines of expected `relation "stripe.…" does not exist`
noise from tests that deliberately exercise failure paths. The actual
`not ok N - <test name>` lines are in the middle and the tail never reaches
them. Pulling ever-larger tails burns a lot of context and still misses.

`get_check_run`'s `output.text` is empty for this job. `failed_only: true`
returns the same drowned tail.

**What works:** download the run's full log archive and grep it.

```
mcp__github__actions_get { method: "get_workflow_run_logs_url", resource_id: <run_id> }
curl -sS -L -o ci.zip "<logs_url>"
unzip -q ci.zip -d ci && grep -rh "not ok [0-9]* - " ci/Test/
```

The signed URL is an `results-receiver.actions.githubusercontent.com` blob, not
`api.github.com`, so it passes the agent proxy where the REST API does not (see
`github-rest-api-blocked-from-bash.md`). It 404s while the run is still
in progress — retry once the run completes.

Then `sed -n '<line-40>,<line>p'` around a hit for the assertion detail
(`error:`, `expected:`, `actual:`, stack).

**Before concluding "unrelated flake":** check reachability rather than
asserting it — `grep -c` the failing test file for the modules your diff
touched. Zero references is evidence; "it looks unrelated" is not.

**And run the test properly if you try to reproduce locally.** The suite needs
`node --import tsx/esm` (see `run_files` in `scripts/lib/test-db.sh`). Without
it you get `ERR_MODULE_NOT_FOUND`, which renders as a test failure and is not
one — a bad reproduction that looks like a confirmed one.

**Reference:** PR #498, issue #508.
