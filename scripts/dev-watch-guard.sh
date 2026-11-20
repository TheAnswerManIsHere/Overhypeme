#!/usr/bin/env bash
# dev-watch-guard.sh — make a crash under a watch-mode runner visible to the
# supervisor.
#
# A watch-mode runner (`tsx watch`) starts the real program as its one child
# and restarts it when a source file changes. When that child exits on its own
# — a fatal error, an OOM kill, anything — the runner stays alive and waits for
# the next file change, so dev-supervisor.sh, which watches the runner, never
# sees an exit and never restarts anything: the dev API stays down until
# someone edits a file (Issue #1083; measured with tsx 4.21.0).
#
# This wrapper runs the runner and watches for that state: the runner alive
# with no child process for several polls in a row. It then stops the runner
# and exits 1, which the supervisor treats as a crash: logged, backed off,
# restarted, and counted against its crash cap.
#
# A restart on a file change does not trip it: the runner replaces the child
# at once, so the gap with no child is far shorter than the polls it takes.
#
# Usage:
#   dev-watch-guard.sh <runner> [args...]
#
# Knobs (environment):
#   WATCH_GUARD_POLL_SECONDS   (default 2)  seconds between polls
#   WATCH_GUARD_MISSING_POLLS  (default 3)  consecutive polls with no child
#                                           before the runner is stopped

set -u

if [ "$#" -lt 1 ]; then
  echo "usage: dev-watch-guard.sh <runner> [args...]" >&2
  exit 2
fi

POLL_SECONDS="${WATCH_GUARD_POLL_SECONDS:-2}"
MISSING_POLLS="${WATCH_GUARD_MISSING_POLLS:-3}"

"$@" &
runner_pid=$!

stop_runner() {
  kill -TERM "${runner_pid}" 2>/dev/null || true
  wait "${runner_pid}" 2>/dev/null || true
}

# The supervisor signals this whole process group on TERM/INT, so the runner
# has normally been told already; stopping it here covers a direct signal.
trap 'stop_runner; exit 0' TERM INT

# The kernel's own list of a process's children. Read from /proc rather than
# pgrep or ps, which the Repl's Nix environment does not promise (the
# supervisor avoids fuser for the same reason).
has_child() {
  local children
  children="$(cat "/proc/${runner_pid}/task/${runner_pid}/children" 2>/dev/null)" || return 1
  [ -n "${children// /}" ]
}

missing=0
while kill -0 "${runner_pid}" 2>/dev/null; do
  sleep "${POLL_SECONDS}"
  kill -0 "${runner_pid}" 2>/dev/null || break
  if has_child; then
    missing=0
    continue
  fi
  missing=$((missing + 1))
  if [ "${missing}" -ge "${MISSING_POLLS}" ]; then
    echo "[watch-guard] the program exited on its own and the watch runner did not restart it — stopping the runner so the supervisor restarts it" >&2
    stop_runner
    exit 1
  fi
done

# The runner itself exited: pass its exit code on unchanged.
wait "${runner_pid}"
exit $?
