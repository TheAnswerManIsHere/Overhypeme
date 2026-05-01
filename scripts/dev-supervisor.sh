#!/usr/bin/env bash
# dev-supervisor.sh — keep a long-running dev process alive.
#
# Wraps a command in a restart loop with backoff so a crashed process
# auto-recovers without anyone having to click "Restart" in the Workflows
# pane. Caps at 20 crashes within a rolling 5-minute window so a hard-failing
# build doesn't spin forever and bury the real error in scrolling logs.
#
# Usage:
#   dev-supervisor.sh <label> <cmd> [args...]
#
# Implementation notes:
#   - `set -m` enables job control so the child runs in its own process group
#     (PGID == child PID). On TERM/INT we signal the whole group, which
#     reliably kills grandchildren too (pnpm → node, vite → esbuild workers,
#     etc) instead of orphaning them.
#   - Restart cap is a true rolling window: we keep an array of restart
#     timestamps and prune entries older than WINDOW_SEC every iteration.

set -u
set -m

label="${1:-process}"
shift

MAX_RESTARTS=20
WINDOW_SEC=300

restart_times=()  # epoch seconds, append-on-restart, prune-on-loop
child_pid=""

# Opportunistic stale-git-lock cleanup at startup. A crash often leaves both
# a stale `.git/*.lock` AND restarts a workflow at roughly the same moment,
# so this gives every workflow restart a free pass at clearing locks before
# the watcher's next tick. The sweeper has its own guardrails (allowlist,
# stale-age threshold, active-`git`-process check) so this is safe to call
# blindly. We never let sweeper errors block the wrapped command.
SUPERVISOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEPER="${SUPERVISOR_DIR}/clean-stale-git-locks.sh"
if [ -x "${SWEEPER}" ]; then
  bash "${SWEEPER}" || true
fi

prune_window() {
  local now=$1
  local cutoff=$((now - WINDOW_SEC))
  local kept=()
  local t
  for t in "${restart_times[@]:-}"; do
    [ -z "${t}" ] && continue
    if [ "${t}" -ge "${cutoff}" ]; then
      kept+=("${t}")
    fi
  done
  restart_times=("${kept[@]:-}")
}

cleanup() {
  echo "[supervisor:${label}] received TERM/INT — stopping child process group"
  if [ -n "${child_pid}" ]; then
    # Negative pid → kill the whole process group whose PGID == child_pid.
    # Catches grandchildren (pnpm → node, vite → workers) the inner shell spawned.
    kill -TERM -- "-${child_pid}" 2>/dev/null || kill -TERM "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup TERM INT

while true; do
  now=$(date +%s)
  prune_window "${now}"
  active_restarts=${#restart_times[@]}
  # Filter out empty array element edge case in old bash versions
  if [ "${active_restarts}" -ge ${MAX_RESTARTS} ]; then
    echo "[supervisor:${label}] ${MAX_RESTARTS} crashes within the last ${WINDOW_SEC}s — giving up so the underlying error stays visible. Fix the error and restart the workflow."
    exit 1
  fi

  echo "[supervisor:${label}] starting (recent crashes: ${active_restarts}/${MAX_RESTARTS})"
  "$@" &
  child_pid=$!
  wait "${child_pid}"
  code=$?
  child_pid=""

  if [ "${code}" -eq 0 ]; then
    echo "[supervisor:${label}] exited cleanly (code 0) — not restarting"
    exit 0
  fi

  echo "[supervisor:${label}] exited with code ${code}"
  crash_at=$(date +%s)
  restart_times+=("${crash_at}")
  attempt=${#restart_times[@]}

  # Backoff: 1s, 2s, 3s, then 10s for the rest of the window.
  if [ "${attempt}" -lt 4 ]; then
    sleep_s=${attempt}
  else
    sleep_s=10
  fi
  echo "[supervisor:${label}] restart in ${sleep_s}s"
  sleep "${sleep_s}"
done
