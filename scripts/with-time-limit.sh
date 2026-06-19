#!/usr/bin/env bash
# with-time-limit.sh — run a command and warn if it exceeds a wall-clock budget.
#
# Purpose: surface performance regressions in CI logs without ever masking real
# failures or inventing new ones. The exit code is always exactly the wrapped
# command's exit code.
#
#   • If the command FAILS   → exit with that non-zero status (test failure wins)
#   • If the command PASSES  → exit 0, even if it was slow
#   • If the command is SLOW → print a loud WARNING to stderr so it is visible
#                              in logs, but do NOT override the exit code
#
# Usage:
#   with-time-limit.sh <max_ms> <cmd> [args...]
#
# Example:
#   with-time-limit.sh 90000 pnpm run test
#
# Current budgets (review periodically; adjust deliberately, not just to
# silence a regression). Each budget is also the literal argument at the
# invocation site, so it is greppable from the command itself.
#
#   300000ms artifacts/api-server `test` script
#            Sharded api-server test suite (2 shards) + DB schema reset.
#            Baseline ~230s.
#
#   120000ms artifacts/api-server `typecheck` script
#            tsc --noEmit + check:cycles + check:no-console. Baseline ~90s.
#
#   120000ms artifacts/overhype-me `test` script (the `sentry-tests`
#            validation workflow). Vitest run. Baseline ~80s.
#
#   15000ms  lib/db `typecheck` script
#            tsc --noEmit on the shared db package. Baseline ~3s; generous
#            headroom because the absolute floor is small.
#
#   180000ms .replit `typecheck` workflow (whole chain)
#            api-spec codegen + lib/api-zod tsc + lib/api-client-react tsc +
#            redact build + db typecheck + api-server typecheck. Baseline
#            ~110s cold. The two named sub-checks (db + api-server) carry
#            their own tighter inner budgets above; this outer budget catches
#            drift in the un-wrapped prefix steps. If you need to bump it,
#            first identify which sub-step regressed.

set -u

if [[ $# -lt 2 ]]; then
  echo "usage: $(basename "$0") <max_ms> <cmd> [args...]" >&2
  exit 2
fi

max_ms="$1"
shift

if ! [[ "$max_ms" =~ ^[0-9]+$ ]]; then
  echo "[time-limit] max_ms must be a positive integer, got: $max_ms" >&2
  exit 2
fi

start_ns=$(date +%s%N)
"$@"
status=$?
end_ns=$(date +%s%N)

elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))

echo "[time-limit] command took ${elapsed_ms}ms (limit ${max_ms}ms)" >&2

if (( elapsed_ms > max_ms )); then
  echo "[time-limit] WARNING: exceeded ${max_ms}ms budget by $((elapsed_ms - max_ms))ms — tests are getting slow, consider investigating" >&2
fi

exit $status
