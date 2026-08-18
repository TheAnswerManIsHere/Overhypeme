# Finding which test actually failed in CI — and why the obvious route is blocked

**The problem.** `mcp__github__get_job_logs` returns the **tail** of a job's
log, and this repo's `Test` job ends with the Postgres service container
dumping its own output — hundreds of lines of expected
`relation "stripe.…" does not exist` noise from tests that deliberately
exercise failure paths. The `not ok N - <test name>` lines are in the middle,
and the tail never reaches them however large you make it. `get_check_run`'s
`output.text` is empty for this job, and `failed_only: true` returns the same
drowned tail. **There is currently no MCP method that surfaces the failing
assertion for this job.**

**The archive route works but is NOT available to you.** The run's full log
archive (`actions_get` → `get_workflow_run_logs_url`, then download + `grep -rh
"not ok [0-9]* - "`) does contain it, and the signed
`results-receiver.actions.githubusercontent.com` URL is a blob host rather than
`api.github.com`. But downloading it needs `curl`/`wget`, and
`scripts/guard-decision.mjs` **refuses those categorically** — no exception for
argument shape or host (see `github-rest-api-blocked-from-bash.md`). Do not
plan around this by reaching for the fetch anyway.

**What to do instead, in order:**

1. **A repo script is unaffected** — the guard refuses a directly-typed `curl`,
   not a script that runs one internally. If this recurs, the right fix is a
   small committed script that fetches and greps a run's archive. That does not
   exist yet.
2. **Otherwise ask David**, which is what the guard's own refusal text says to
   do when an ad-hoc fetch is genuinely needed.

**Before concluding "unrelated flake":** check reachability rather than
asserting it — `grep -c` the failing test file for the modules your diff
touched. Zero references is evidence; "it looks unrelated" is not. And a test
failing twice on different commits is not automatically your regression, but it
does end the flake explanation until you can point at a mechanism (a thin
timing margin, a shared fixture) rather than a shrug.

**Reproduce with the runner's real invocation** — `node --import tsx/esm`, per
`run_files` in `scripts/lib/test-db.sh`. Without it you get
`ERR_MODULE_NOT_FOUND`, which renders as a test failure and is not one. That
produced a "5/5 failed under load" result that meant nothing.

**Reference:** PR #498, issue #508, PR #509 round 1 (which caught that the
download step this note originally prescribed is blocked).
