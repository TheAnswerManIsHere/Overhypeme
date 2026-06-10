---
name: Test idle-drain timeout
description: Why DB-touching test files appear to "time out" ~60s after finishing, and the durable rule that prevents it.
---

# A test process that hangs after the summary prints is a leaked handle, not a slow test

Symptom that wasted the most time here: a test file's assertions all pass and the
summary prints, then the process sits for ~60s before exiting — looking exactly like
a "test timeout" and blowing past CI/tool budgets. It was blamed on test sharding;
sharding was never the cause.

**Durable lesson:** when a Node process won't exit after work is done, suspect a
ref'd timer or open handle keeping the event loop alive — here, the shared pg `Pool`'s
`idleTimeoutMillis` timer. The fix is to let idle handles unref in test contexts
(`allowExitOnIdle` for pg), NOT to reach for `--test-force-exit` (which masks
leaked-promise and open-resource bugs).

**Why it was intermittent:** the official sharded runner exported an env var that
enabled the unref; ad-hoc single-file runs didn't, so only those hung. So "works in
CI, hangs locally" pointed at the invocation, not the tests.

**How to apply / the trap to avoid:** detecting "are we under the test runner" needs
*two* signals, because the answer differs by isolation mode — one signal is set under
default (process) isolation and absent under `--test-isolation=none`, and vice-versa.
Whatever auto-detect you write, exercise it under both isolation modes plus a normal
dev/prod process; an over-narrow check silently brings the 60s hang back for the
missed path. Keep an explicit env-var override too.
