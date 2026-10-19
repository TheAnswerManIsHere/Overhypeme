# PR #729 — Queue Health stops showing a recovered job's old error — UAT

**Workstream:** #692

A background job that crashed once and then succeeded on its retry used to sit
on Admin → Queue Health marked done, with the old crash message still shown in
red beside it. A success now clears that message, so a red error means the
job's latest attempt failed. The same stale message also showed on Taxonomy
Health's job status and the Email Queue, and this fix clears it there too.

Jobs that recovered before this fix keep their old message until finished jobs
are purged (30 days by default); see *Not bugs*.

## Setup

None. Every step is checked in CI against the real job runner; nothing needs
the Repl or your account.

## Steps

### 1. A job that recovers on retry shows no error

**Do:** Run a job whose first attempt crashes with `Cannot read properties of
undefined (reading 'forEach')` and whose retry succeeds, then read it from Queue
Health.

**Expect:** The job is `done` and its error is empty.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/queueHealth.test.ts:shows no error for a job that failed and then succeeded on retry, and keeps it while the retry is pending (#692)`

### 2. A job still waiting on its retry keeps its error

**Do:** Read the same job from Queue Health after the first, crashing attempt
and before its retry runs.

**Expect:** The job is `pending` and its error reads `Cannot read properties of
undefined (reading 'forEach')`.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/queueHealth.test.ts:shows no error for a job that failed and then succeeded on retry, and keeps it while the retry is pending (#692)`

## Regression

### R1. A failed job still shows its error

**Do:** Read a `failed` job with a long error from Queue Health.

**Expect:** The error is shown, cut to 500 characters.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/queueHealth.test.ts:truncates lastError rather than returning a full provider stack trace`

### R2. A job whose handler is unavailable keeps its reason

**Do:** Run a job while its handler reports itself unavailable.

**Expect:** The job stays `pending`, no attempt is used, and its error carries
the unavailable reason.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/asyncJobs.test.ts:leaves a queued row pending, without burning an attempt, while its handler is unavailable`

## Not bugs

- **A job that recovered before this fix may still show its old error.** The
  fix stops new stale errors; it does not rewrite rows already stored. Those
  rows age out when finished jobs are purged, after 30 days by default
  (`async_job_<queue>_retention_days`).
- **A job waiting on a retry still shows red.** That is intended: its latest
  attempt failed.
