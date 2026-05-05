#!/usr/bin/env bash
# Regression tests for scripts/dev-supervisor.sh.
#
# Covers the EADDRINUSE crash-loop fix from task #441:
#   1. When the port is held by a previous process, the supervisor sends
#      SIGTERM, waits for the port to free, and then starts the wrapped
#      child cleanly — without producing EADDRINUSE crashes.
#   2. The singleton flock prevents a second supervisor for the same label
#      from running concurrently with the first.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPERVISOR="${REPO_ROOT}/scripts/dev-supervisor.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Pick a random free port for each test by binding to port 0 and reading
# the assigned port back.
pick_free_port() {
  python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()"
}

# Holds the port until SIGTERM, then exits cleanly. Used as the placeholder
# "previous process".
hold_port_script() {
  cat <<'PY'
import signal, socket, sys, time
port = int(sys.argv[1])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", port))
s.listen(16)
running = {"v": True}
def _stop(*_):
    running["v"] = False
signal.signal(signal.SIGTERM, _stop)
print(f"[holder] listening on {port} pid={__import__('os').getpid()}", flush=True)
while running["v"]:
    time.sleep(0.05)
print("[holder] exiting", flush=True)
s.close()
PY
}

# Binds the port and writes a sentinel file once it's listening, then
# stays up until SIGTERM. This is the supervisor's child in test 1.
child_script() {
  cat <<'PY'
import os, signal, socket, sys, time
port = int(sys.argv[1])
sentinel = sys.argv[2]
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", port))
s.listen(16)
with open(sentinel, "w") as fh:
    fh.write(str(os.getpid()))
running = {"v": True}
def _stop(*_):
    running["v"] = False
signal.signal(signal.SIGTERM, _stop)
print(f"[child] listening on {port} pid={os.getpid()}", flush=True)
while running["v"]:
    time.sleep(0.05)
print("[child] exiting", flush=True)
s.close()
PY
}

cleanup_pids=()
cleanup() {
  local pid
  for pid in "${cleanup_pids[@]:-}"; do
    [ -z "${pid}" ] && continue
    kill -TERM "${pid}" 2>/dev/null || true
  done
  sleep 0.2
  for pid in "${cleanup_pids[@]:-}"; do
    [ -z "${pid}" ] && continue
    kill -KILL "${pid}" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Test 1: supervisor waits for held port to free, then starts the child.
# ---------------------------------------------------------------------------
echo "test: supervisor frees a held port and starts child cleanly"
PORT1="$(pick_free_port)"
LABEL1="t441-port-$$"
TMP1="$(mktemp -d)"
HOLDER_SCRIPT="${TMP1}/hold.py"
CHILD_SCRIPT="${TMP1}/child.py"
SENTINEL="${TMP1}/started"
LOG1="${TMP1}/supervisor.log"
hold_port_script > "${HOLDER_SCRIPT}"
child_script > "${CHILD_SCRIPT}"

# Start the placeholder.
python3 "${HOLDER_SCRIPT}" "${PORT1}" >"${TMP1}/holder.log" 2>&1 &
HOLDER_PID=$!
cleanup_pids+=("${HOLDER_PID}")

# Wait until the holder is actually listening.
for _ in $(seq 1 50); do
  if python3 -c "import socket,sys; s=socket.socket(); 
import errno
try:
  s.bind(('127.0.0.1', $PORT1)); sys.exit(0)
except OSError as e:
  sys.exit(1)" 2>/dev/null; then
    sleep 0.1
  else
    break
  fi
done

# Sanity: holder is up.
if ! kill -0 "${HOLDER_PID}" 2>/dev/null; then
  fail "holder did not stay alive (log: $(cat "${TMP1}/holder.log"))"
fi

# Now run the supervisor with the child that wants the same port.
PORT="${PORT1}" SUPERVISOR_PORT_FREE_TIMEOUT=15 SUPERVISOR_LOCK_TIMEOUT=5 \
  bash "${SUPERVISOR}" "${LABEL1}" \
    python3 "${CHILD_SCRIPT}" "${PORT1}" "${SENTINEL}" \
  >"${LOG1}" 2>&1 &
SUP_PID=$!
cleanup_pids+=("${SUP_PID}")

# Poll for the sentinel — child has bound the port == port was successfully freed.
ok=0
for _ in $(seq 1 100); do  # 20s
  if [ -f "${SENTINEL}" ]; then
    ok=1
    break
  fi
  sleep 0.2
done

if [ "${ok}" != "1" ]; then
  echo "--- supervisor log ---"
  cat "${LOG1}" || true
  echo "--- holder log ---"
  cat "${TMP1}/holder.log" || true
  fail "supervisor did not start the child within 20s"
fi

# Verify the supervisor actually mentioned freeing the port — i.e. it took
# the wait-for-port-free path rather than racing the bind by luck.
if ! grep -q "is held by" "${LOG1}"; then
  echo "--- supervisor log ---"
  cat "${LOG1}"
  fail "supervisor log did not mention detecting a port holder"
fi
if grep -qiE "EADDRINUSE|address already in use" "${LOG1}"; then
  echo "--- supervisor log ---"
  cat "${LOG1}"
  fail "supervisor produced an EADDRINUSE error — wait-for-port-free did not work"
fi

# Tear down: kill the supervisor (it will TERM the child).
kill -TERM "${SUP_PID}" 2>/dev/null || true
wait "${SUP_PID}" 2>/dev/null || true
wait "${HOLDER_PID}" 2>/dev/null || true
echo "  ok"

# ---------------------------------------------------------------------------
# Test 2: singleton lock prevents a second supervisor with the same label.
# ---------------------------------------------------------------------------
echo "test: singleton lock blocks a second supervisor for the same label"
LABEL2="t441-lock-$$"
TMP2="$(mktemp -d)"
LOG_A="${TMP2}/a.log"
LOG_B="${TMP2}/b.log"

# First supervisor: long-running sleep, no PORT (so port logic is skipped).
bash "${SUPERVISOR}" "${LABEL2}" sleep 30 >"${LOG_A}" 2>&1 &
SUP_A=$!
cleanup_pids+=("${SUP_A}")

# Wait until first supervisor reports it's started its child.
ok=0
for _ in $(seq 1 50); do
  if grep -q "starting" "${LOG_A}" 2>/dev/null; then
    ok=1
    break
  fi
  sleep 0.1
done
[ "${ok}" = "1" ] || fail "first supervisor never logged 'starting' (log: $(cat "${LOG_A}"))"

# Second supervisor with a 2s lock timeout — should refuse and exit non-zero.
start_ts=$(date +%s)
set +e
SUPERVISOR_LOCK_TIMEOUT=2 \
  bash "${SUPERVISOR}" "${LABEL2}" sleep 30 >"${LOG_B}" 2>&1
rc=$?
set -e
elapsed=$(( $(date +%s) - start_ts ))

if [ "${rc}" = "0" ]; then
  echo "--- second supervisor log ---"
  cat "${LOG_B}"
  fail "second supervisor exited 0 — singleton lock did not block it"
fi
if [ "${elapsed}" -gt 6 ]; then
  fail "second supervisor took ${elapsed}s to give up — expected ~2s lock timeout"
fi
if ! grep -q "already holding" "${LOG_B}"; then
  echo "--- second supervisor log ---"
  cat "${LOG_B}"
  fail "second supervisor did not log the lock-held diagnostic"
fi

# Cleanup
kill -TERM "${SUP_A}" 2>/dev/null || true
wait "${SUP_A}" 2>/dev/null || true
echo "  ok"

echo "PASS: dev-supervisor regression tests"
