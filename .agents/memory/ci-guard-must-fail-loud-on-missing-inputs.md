---
name: A CI guard that skips on missing inputs is indistinguishable from one that verified everything
description: check-ledger-coverage.mjs's coverage half returned exit 0 both when it ran the real check and when GITHUB_TOKEN/PR_NUMBER were absent and it silently skipped. First CI run went green either way, with no way to tell which happened from the job log alone.
---

# A CI guard that skips on missing inputs is indistinguishable from one that verified everything

## What happened

`scripts/check-ledger-coverage.mjs` (PR #286) has two checks: an offline
arithmetic check, and a coverage check that needs `GITHUB_TOKEN` + `PR_NUMBER`
to call the GitHub API. The coverage check's original behavior was to print a
"skipped, needs credentials" line and `return` cleanly when those env vars
were absent — reasonable for local runs, where there's genuinely no
credential.

The first CI run of the guard went green. That proved nothing: a guard that
silently skipped would have produced the *exact same* exit code and the
*exact same* "Build passed" outcome as one that actually queried the API and
found full coverage. Reading the job log's stdout to tell the two apart is
possible but expensive and easy to skip under time pressure — and a future
misconfiguration of the workflow's `PR_NUMBER`/`GITHUB_TOKEN` wiring would
silently disable the entire coverage guard behind a permanently green check,
with nothing surfacing the regression.

## What worked instead

Made the missing-inputs case branch on environment: skipping is still correct
when running locally (no credential exists to skip past), but throws when
`GITHUB_ACTIONS === "true"` and `GITHUB_EVENT_NAME === "pull_request"` — a
context where both inputs are always supposed to be present, so their absence
means the workflow's env wiring broke, not that the check has nothing to do.
This turned the next CI run into a real, self-verifying test of the guard's
live behavior instead of a plausible-looking green check.

## Takeaway

Before trusting a new CI guard's first green run as proof it verified
anything, ask whether its "nothing to check" path and its "checked and
passed" path produce **the same exit code** — that's the only thing CI's
pass/fail status actually surfaces to a reader glancing at the check list;
their stdout can differ (this guard's two paths print visibly different
lines) and still be equally invisible to anyone who doesn't open the job log.
If the exit codes match, that ambiguity is a defect in the guard itself, not
something to resolve by reading job logs after the fact — make the guard
throw when it's in an environment where its required inputs should always be
present. This applies to any guard added to `.github/workflows/build.yml`
(the docs-accuracy check, the codegen-drift check, the migration-snapshot
validator, this one), not just the ledger coverage check specifically.
