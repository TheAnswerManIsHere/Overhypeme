#!/usr/bin/env bash
# Regression tests for scripts/dev-watch-guard.sh (Issue #1083).
#
# The bug: under `tsx watch`, a dev API server that exits on its own is never
# restarted, because the watch runner outlives it and the supervisor only
# watches the runner. The guard turns "runner alive, no child" into an exit
# the supervisor can see.
#
#   1. A runner whose child dies and is not replaced: the guard stops the
#      runner and exits 1.
#   2. A runner that replaces its child (a restart on a file change): the
#      guard keeps running.
#   3. A runner that exits on its own: the guard passes its exit code on.
#   4. A runner whose child was started from a second thread: still seen.
#   5. A machine that exposes no process information: the guard never stops
#      a runner on a guess.
#   6. dev-run.sh runs tsx watch through the guard, with tsx as the guard's
#      direct child (a `pnpm exec` in between would always have a child).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="${REPO_ROOT}/scripts/dev-watch-guard.sh"
DEV_RUN="${REPO_ROOT}/artifacts/api-server/scripts/dev-run.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# A stand-in for `tsx watch`: starts one child, then idles without spawning
# anything else (a shell loop built on `sleep` would always have a child).
#   argv[1]  seconds the child lives
#   argv[2]  "replace" to start a new child each time one exits, else "leave"
#   argv[3]  seconds until the runner itself exits with argv[4] (0 = never)
cat > "${WORK}/runner.py" <<'PY'
import subprocess, sys, time
child_life, mode, runner_life, runner_code = float(sys.argv[1]), sys.argv[2], float(sys.argv[3]), int(sys.argv[4])
spawn = lambda: subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({child_life})"])
child = spawn()
started = time.time()
while True:
    time.sleep(0.05)
    if child is not None and child.poll() is not None:
        child = spawn() if mode == "replace" else None
    if runner_life and time.time() - started > runner_life:
        if child is not None:
            child.kill()
        sys.exit(runner_code)
PY

export WATCH_GUARD_POLL_SECONDS=0.2
export WATCH_GUARD_MISSING_POLLS=3

# ---------------------------------------------------------------------------
echo "test: a child that dies and is not replaced makes the guard exit 1"
set +e
timeout 15 bash "${GUARD}" python3 "${WORK}/runner.py" 0.3 leave 0 0 2> "${WORK}/t1.err"
code=$?
set -e
[ "${code}" -eq 1 ] || fail "expected exit 1, got ${code} (124 means the guard never noticed)"
grep -q "did not restart it" "${WORK}/t1.err" || fail "the guard did not say why it stopped the runner"
grep -qE "last seen as pid [0-9]+" "${WORK}/t1.err" || fail "the guard did not name the program's last pid"
if pgrep -f "${WORK}/runner.py" >/dev/null 2>&1; then
  fail "the runner is still alive after the guard exited"
fi
echo "  ok"

# ---------------------------------------------------------------------------
echo "test: a child that is replaced (a watch restart) does not trip the guard"
set +e
timeout 4 bash "${GUARD}" python3 "${WORK}/runner.py" 0.3 replace 0 0 2> "${WORK}/t2.err"
code=$?
set -e
[ "${code}" -eq 124 ] || fail "expected the guard to still be running at the 4s timeout (124), got ${code}"
echo "  ok"

# ---------------------------------------------------------------------------
echo "test: a runner that exits on its own has its exit code passed on"
set +e
timeout 15 bash "${GUARD}" python3 "${WORK}/runner.py" 30 leave 0.5 7 2> "${WORK}/t3.err"
code=$?
set -e
[ "${code}" -eq 7 ] || fail "expected the runner's exit code 7, got ${code}"
echo "  ok"

# ---------------------------------------------------------------------------
echo "test: a child started from a second thread is still seen"
# Fable, PR #1089 round 1: the kernel's per-thread children list misses a
# child started from any thread but the main one, so a lookup through it would
# stop this healthy runner. The parent-id scan the guard uses sees it.
cat > "${WORK}/thread_runner.py" <<'PY'
import subprocess, sys, threading, time
holder = {}
def start():
    holder["child"] = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
t = threading.Thread(target=start)
t.start()
t.join()
while True:
    time.sleep(0.05)
PY
set +e
timeout 4 bash "${GUARD}" python3 "${WORK}/thread_runner.py" 2> "${WORK}/t5.err"
code=$?
set -e
[ "${code}" -eq 124 ] || fail "expected the guard to leave a runner whose child came from a second thread running (124), got ${code}"
pkill -f "${WORK}/thread_runner.py" 2>/dev/null || true
echo "  ok"

# ---------------------------------------------------------------------------
echo "test: a machine that hides its processes never has a healthy server stopped"
# Codex, PR #1089: the first version read a kernel file some containers lack,
# and counted the failed read as "the server died". An empty directory stands
# for a machine that exposes no process information at all; the child here
# dies and is not replaced, which would trip the guard if unknown counted.
mkdir -p "${WORK}/no-proc"
set +e
WATCH_GUARD_PROC_ROOT="${WORK}/no-proc" timeout 4 bash "${GUARD}" python3 "${WORK}/runner.py" 0.3 leave 0 0 2> "${WORK}/t4.err"
code=$?
set -e
[ "${code}" -eq 124 ] || fail "expected the guard to keep running when it cannot observe (124), got ${code}"
grep -q "crash detection is off" "${WORK}/t4.err" || fail "the guard did not say crash detection is off"
[ "$(grep -c "crash detection is off" "${WORK}/t4.err")" -eq 1 ] || fail "the guard repeated its can't-observe message"
pkill -f "${WORK}/runner.py" 2>/dev/null || true
echo "  ok"

# ---------------------------------------------------------------------------
echo "test: dev-run.sh runs tsx watch through the guard, as its direct child"
grep -v '^\s*#' "${DEV_RUN}" | grep -qE "dev-watch-guard\.sh.*tsx\"? watch" \
  || fail "dev-run.sh does not run tsx watch through dev-watch-guard.sh"
if grep -v '^\s*#' "${DEV_RUN}" | grep -qE "pnpm exec tsx"; then
  fail "dev-run.sh runs tsx through 'pnpm exec', so the guard would watch pnpm, which always has a child"
fi
echo "  ok"

echo "PASS: dev-watch-guard regression tests"
