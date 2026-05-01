#!/usr/bin/env bash
# retry-on-eagain.sh — run a command and retry up to N times if it fails with
# the specific "Resource temporarily unavailable" / EAGAIN error that node
# (and its child processes via pnpm) throws when the cgroup pid limit is
# saturated under heavy parallel validation load (typecheck +
# sentry-tests + api-server-tests + db-tests all racing to spawn tsx ESM
# loader workers and tsc / vitest helper processes at the same time).
#
# We only retry when the captured combined output contains the EAGAIN
# signature so we never paper over a real test failure.
#
# Usage: bash scripts/retry-on-eagain.sh <max-attempts> <cmd> [args...]

set -u

MAX_ATTEMPTS="${1:-3}"
shift

EAGAIN_RE='pthread_create: Resource temporarily unavailable|ERR_WORKER_INIT_FAILED|spawn[^A-Za-z]+EAGAIN|EAGAIN|Aborted[[:space:]]+\(core dumped\)|terminating forks worker|Exit status 13[4579]'

# Exit codes that almost always indicate the OS killed the process due to
# resource exhaustion (cgroup pid limit, OOM, etc) rather than a real bug:
# 134=SIGABRT (often raised by libc/node when worker creation fails late),
# 137=SIGKILL, 139=SIGSEGV. We retry these unconditionally.
SIGNAL_EXIT_CODES=" 134 135 137 139 "

attempt=1
while :; do
  OUT_FILE=$(mktemp)
  set +e
  # Run with combined stdout+stderr captured to a tempfile while still
  # streaming live to the user. We avoid bash process substitution so we
  # get a reliable child exit code.
  ( "$@" 2>&1 ) | tee "$OUT_FILE"
  # PIPESTATUS[0] is the real child exit code; tee almost always succeeds.
  rc=${PIPESTATUS[0]}
  set -e

  if [ "$rc" -eq 0 ]; then
    rm -f "$OUT_FILE"
    exit 0
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    rm -f "$OUT_FILE"
    exit "$rc"
  fi

  retry_reason=""
  if grep -Eq "$EAGAIN_RE" "$OUT_FILE"; then
    retry_reason="EAGAIN signature in output"
  elif [[ "$SIGNAL_EXIT_CODES" == *" $rc "* ]]; then
    retry_reason="signal-like exit code $rc (likely cgroup/OOM kill)"
  fi
  if [ -n "$retry_reason" ]; then
    backoff=$(( attempt * 2 ))
    echo "[retry-on-eagain] attempt $attempt failed: $retry_reason; sleeping ${backoff}s and retrying" >&2
    rm -f "$OUT_FILE"
    sleep "$backoff"
    attempt=$(( attempt + 1 ))
    continue
  fi

  rm -f "$OUT_FILE"
  exit "$rc"
done
