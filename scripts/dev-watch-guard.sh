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
# with no child process for several polls in a row. A poll that cannot see the
# runner's processes at all counts for nothing, so a machine that hides them
# loses crash detection rather than having a healthy server stopped. It then stops the runner
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
#   WATCH_GUARD_PROC_ROOT      (default /proc) where process information is
#                                           read; the tests point it at an
#                                           empty directory to stand for a
#                                           machine that exposes none

set -u

if [ "$#" -lt 1 ]; then
  echo "usage: dev-watch-guard.sh <runner> [args...]" >&2
  exit 2
fi

POLL_SECONDS="${WATCH_GUARD_POLL_SECONDS:-2}"
MISSING_POLLS="${WATCH_GUARD_MISSING_POLLS:-3}"
PROC_ROOT="${WATCH_GUARD_PROC_ROOT:-/proc}"

"$@" &
runner_pid=$!

stop_runner() {
  kill -TERM "${runner_pid}" 2>/dev/null || true
  wait "${runner_pid}" 2>/dev/null || true
}

# The supervisor signals this whole process group on TERM/INT, so the runner
# has normally been told already; stopping it here covers a direct signal.
trap 'stop_runner; exit 0' TERM INT

# Who the runner's children are, read from /proc/<pid>/stat (field 4 is the
# parent's pid). Every Linux kernel has it; /proc/<pid>/task/<pid>/children
# needs a kernel option some containers lack, so it is not used. Python is
# what the supervisor already relies on in the Repl's Nix environment, and
# pgrep and ps are not promised there.
#
# Prints the children's pids, space-separated, and exits:
#   0  the runner has at least one child
#   1  the runner has no child (an observation, not a guess)
#   2  the runner could not be observed (no /proc, unreadable stat): unknown
observe_children() {
  python3 - "${runner_pid}" "${PROC_ROOT}" <<'PY'
import os, sys
parent, root = sys.argv[1], sys.argv[2]
if not os.path.exists(f"{root}/{parent}/stat"):
    sys.exit(2)
found = []
try:
    names = os.listdir(root)
except OSError:
    sys.exit(2)
for name in names:
    if not name.isdigit():
        continue
    try:
        with open(f"{root}/{name}/stat") as fh:
            stat = fh.read()
    except OSError:
        continue  # a process that ended between listdir and open
    # The command name sits in parentheses and may hold spaces: split after it.
    fields = stat[stat.rfind(")") + 2:].split()
    if len(fields) > 1 and fields[1] == parent:
        found.append(name)
print(" ".join(found))
sys.exit(0 if found else 1)
PY
}

missing=0
unknown_reported=0
last_children=""
while kill -0 "${runner_pid}" 2>/dev/null; do
  sleep "${POLL_SECONDS}"
  kill -0 "${runner_pid}" 2>/dev/null || break
  children="$(observe_children)"
  status=$?
  case "${status}" in
    0)
      missing=0
      last_children="${children}"
      ;;
    1)
      missing=$((missing + 1))
      if [ "${missing}" -ge "${MISSING_POLLS}" ]; then
        if [ -n "${last_children}" ]; then
          seen="the program (last seen as pid ${last_children})"
        else
          seen="the program (gone before the first check)"
        fi
        echo "[watch-guard] ${seen} exited and the watch runner did not restart it. Its own output above says why, if it said anything; a process killed outright (an out-of-memory kill, for one) leaves no reason that anyone but its parent can read. Stopping the runner so the supervisor restarts it." >&2
        stop_runner
        exit 1
      fi
      ;;
    *)
      # Cannot tell: never counted as a crash, so a healthy server is never
      # stopped because of how the machine exposes its processes.
      missing=0
      if [ "${unknown_reported}" -eq 0 ]; then
        echo "[watch-guard] cannot read the runner's child processes here; crash detection is off for this run" >&2
        unknown_reported=1
      fi
      ;;
  esac
done

# The runner itself exited: pass its exit code on unchanged.
wait "${runner_pid}"
exit $?
