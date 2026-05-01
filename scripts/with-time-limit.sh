#!/usr/bin/env bash
# with-time-limit.sh — run a command and fail if it exceeds a wall-clock budget.
#
# Acts as a CI guard against silent performance regressions in long-running
# checks (test suites, codegen, etc). The wrapped command always runs to
# completion; if the command exits non-zero we propagate that status as-is, so
# real failures aren't masked by the time check. Only when the command
# *succeeds but is too slow* do we override with a non-zero exit.
#
# Usage:
#   with-time-limit.sh <max_ms> <cmd> [args...]
#
# Example:
#   with-time-limit.sh 90000 pnpm run test

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

# Preserve the underlying failure if the command itself failed.
if [[ $status -ne 0 ]]; then
  exit $status
fi

if (( elapsed_ms > max_ms )); then
  echo "[time-limit] FAIL: exceeded ${max_ms}ms budget by $((elapsed_ms - max_ms))ms" >&2
  exit 1
fi

exit 0
