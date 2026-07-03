---
name: Running long test suites in the bash tool
description: How to reliably run the multi-minute test suites without the bash tool killing the process mid-run
---

# Running long test suites without losing output

**Symptom:** running a multi-minute suite in the foreground piped to `tail`
(e.g. `pnpm test 2>&1 | tail -20`) returns `exit code -1` with **no output**.
This is the bash tool killing the foreground subprocess before it finishes —
it is NOT a test failure and NOT a time-limit wrapper.

**Rule:**
- For node:test suites (api-server, lib/db): run detached and poll **in the same
  bash call** so the shell stays alive:
  `setsid bash -c '<cmd> > /tmp/x.log 2>&1; echo "EXIT=$?" >> /tmp/x.log' < /dev/null & disown; sleep <N>; tail /tmp/x.log`.
  node's test reporter flushes line-by-line, so the log is complete on poll.
- Backgrounding in one call and polling in a *separate* call does NOT work — each
  bash call is a fresh shell; the `&` job gets SIGHUP'd when the first call returns.
- **vitest (overhype-me frontend) buffers its summary and does not flush to a
  redirected log even when detached.** Don't fight it — run the `sentry-tests`
  workflow instead and read its status: a clean `finished` means `vitest run`
  exited 0 (pass); a failing run exits 1 and the workflow shows errored.

**Why:** the `-1`/no-output result is easy to misread as a test failure or a
"time limit"; it is neither. Reaching for the wrong pattern wastes many turns
re-running the same suite.

**How to apply:** whenever a suite takes >~60s, reach for the detached+poll or
workflow pattern up front instead of foreground-pipe-to-tail.
