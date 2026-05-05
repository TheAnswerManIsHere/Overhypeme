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
# Environment-driven knobs:
#   PORT
#     If set in the environment, the supervisor treats this run as a
#     port-bound service. Before each restart it (a) finds any process
#     currently listening on that port, (b) sends SIGTERM, (c) polls until
#     the kernel actually frees the socket (NOT the same as "the previous
#     process exited" — there can be a TIME_WAIT or graceful-shutdown
#     window), then (d) escalates to SIGKILL if the port stays held past
#     SUPERVISOR_PORT_FREE_TIMEOUT seconds. This eliminates the EADDRINUSE
#     crash-loop that happens when a force-restart races the previous
#     instance's 10s graceful-shutdown window.
#
#   SUPERVISOR_LOCK_TIMEOUT  (default 30)
#     Seconds to wait on /tmp/dev-supervisor-<label>.lock before giving up.
#     Long enough to cover the previous supervisor's full graceful-shutdown
#     window with margin.
#
#   SUPERVISOR_PORT_FREE_TIMEOUT  (default 15)
#     Seconds to poll for the port becoming free after sending SIGTERM,
#     before escalating to SIGKILL. The default 15s comfortably covers the
#     api-server's 10s graceful-shutdown window (src/shutdown.ts) plus
#     margin for the kernel to actually release the listening socket.
#
#   SUPERVISOR_PORT_FREE_ESCALATION_TIMEOUT  (default 5)
#     After SIGKILL, additional seconds to poll before declaring the port
#     unrecoverable and exiting non-zero with a clear diagnostic. Total
#     worst-case wait before give-up is therefore 15 + 5 = 20 seconds, in
#     line with the per-step budget defined in task #441.
#
# Implementation notes:
#   - `set -m` enables job control so the child runs in its own process group
#     (PGID == child PID). On TERM/INT we signal the whole group, which
#     reliably kills grandchildren too (pnpm → node, vite → esbuild workers,
#     etc) instead of orphaning them.
#   - Restart cap is a true rolling window: we keep an array of restart
#     timestamps and prune entries older than WINDOW_SEC every iteration.
#   - Singleton enforcement uses flock(1) on /tmp/dev-supervisor-<label>.lock.
#     A second invocation for the same label will block until the first
#     releases the lock or the wait times out, which prevents the
#     two-supervisors-fighting-for-the-same-port race during workflow
#     reconciliation.
#   - `fuser` is intentionally NOT used: it isn't installed in this Nix env
#     (the previous preamble silently no-op'd, which is why this fix is
#     needed). We parse /proc/net/tcp{,6} via a small Python helper instead.

set -u
set -m

label="${1:-process}"
shift

MAX_RESTARTS=20
WINDOW_SEC=300
LOCK_TIMEOUT="${SUPERVISOR_LOCK_TIMEOUT:-30}"
PORT_FREE_TIMEOUT="${SUPERVISOR_PORT_FREE_TIMEOUT:-15}"
PORT_FREE_ESCALATION_TIMEOUT="${SUPERVISOR_PORT_FREE_ESCALATION_TIMEOUT:-5}"

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

# ---------------------------------------------------------------------------
# Singleton lock
# ---------------------------------------------------------------------------
# Using a sanitized label so a label like "foo/bar" can't escape /tmp.
sanitized_label="$(printf '%s' "${label}" | tr -c 'A-Za-z0-9._-' '_')"
LOCK_FILE="/tmp/dev-supervisor-${sanitized_label}.lock"
exec 9>"${LOCK_FILE}"
if ! flock -w "${LOCK_TIMEOUT}" 9; then
  echo "[supervisor:${label}] another supervisor for this label is already holding ${LOCK_FILE} after ${LOCK_TIMEOUT}s — refusing to start a second one"
  exit 1
fi
# Stamp our PID into the lock file so other tools can see who holds it.
echo "$$" >&9 || true

# ---------------------------------------------------------------------------
# Port helpers (only used if PORT is set)
# ---------------------------------------------------------------------------
# Echoes a space-separated list of PIDs currently listening on $1, by
# parsing /proc/net/tcp{,6} for LISTEN sockets and matching their inodes
# against /proc/*/fd/*. We use Python for the directory walk because doing
# it portably in pure bash is ~50 lines of fragile globbing.
pids_on_port() {
  local port="$1"
  python3 - "${port}" <<'PY' 2>/dev/null || true
import os, sys, glob

try:
    port = int(sys.argv[1])
except (IndexError, ValueError):
    sys.exit(0)

hexp = f"{port:04X}"
inodes = set()
for path in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        with open(path) as f:
            next(f, None)
            for line in f:
                parts = line.split()
                if len(parts) < 10:
                    continue
                local, state, inode = parts[1], parts[3], parts[9]
                if state != "0A":  # TCP_LISTEN
                    continue
                if local.rsplit(":", 1)[-1] != hexp:
                    continue
                if inode == "0":
                    continue
                inodes.add(inode)
    except OSError:
        pass

if not inodes:
    sys.exit(0)

pids = set()
for pid_dir in glob.glob("/proc/[0-9]*"):
    pid = pid_dir.rsplit("/", 1)[-1]
    fd_dir = pid_dir + "/fd"
    try:
        for fd in os.listdir(fd_dir):
            try:
                target = os.readlink(fd_dir + "/" + fd)
            except OSError:
                continue
            if target.startswith("socket:[") and target.endswith("]"):
                if target[8:-1] in inodes:
                    pids.add(pid)
                    break
    except OSError:
        continue

print(" ".join(sorted(pids, key=int)))
PY
}

# Echoes the comm (process name) for $1, or "?" if unknown.
comm_for_pid() {
  local pid="$1"
  if [ -r "/proc/${pid}/comm" ]; then
    cat "/proc/${pid}/comm" 2>/dev/null || echo "?"
  else
    echo "?"
  fi
}

describe_holders() {
  local port="$1"
  local pids
  pids=$(pids_on_port "${port}")
  if [ -z "${pids}" ]; then
    echo "<none>"
    return
  fi
  local out=""
  local pid
  for pid in ${pids}; do
    local comm
    comm=$(comm_for_pid "${pid}")
    if [ -z "${out}" ]; then
      out="PID ${pid} (${comm})"
    else
      out="${out}, PID ${pid} (${comm})"
    fi
  done
  echo "${out}"
}

# Polls until pids_on_port returns empty or `timeout` seconds elapse.
# Returns 0 if the port is free, 1 otherwise. Polls every 200ms.
wait_for_port_free() {
  local port="$1"
  local timeout="$2"
  local deadline=$(( $(date +%s) + timeout ))
  while :; do
    if [ -z "$(pids_on_port "${port}")" ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      return 1
    fi
    sleep 0.2
  done
}

# Ensures $PORT is free before starting the child. SIGTERM → wait → SIGKILL →
# wait → give up. Returns 0 if the port is free at exit, 1 otherwise.
ensure_port_free() {
  local port="${PORT:-}"
  if [ -z "${port}" ]; then
    return 0
  fi
  local pids
  pids=$(pids_on_port "${port}")
  if [ -z "${pids}" ]; then
    return 0
  fi
  echo "[supervisor:${label}] port ${port} is held by $(describe_holders "${port}") — sending SIGTERM"
  local pid
  for pid in ${pids}; do
    kill -TERM "${pid}" 2>/dev/null || true
  done
  if wait_for_port_free "${port}" "${PORT_FREE_TIMEOUT}"; then
    return 0
  fi
  echo "[supervisor:${label}] port ${port} still occupied after ${PORT_FREE_TIMEOUT}s by $(describe_holders "${port}") — escalating with SIGKILL"
  pids=$(pids_on_port "${port}")
  for pid in ${pids}; do
    kill -KILL "${pid}" 2>/dev/null || true
  done
  if wait_for_port_free "${port}" "${PORT_FREE_ESCALATION_TIMEOUT}"; then
    return 0
  fi
  echo "[supervisor:${label}] port ${port} still occupied after escalation by $(describe_holders "${port}") — giving up so the underlying error stays visible"
  return 1
}

# ---------------------------------------------------------------------------
# Restart-window bookkeeping
# ---------------------------------------------------------------------------
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
  if [ "${active_restarts}" -ge ${MAX_RESTARTS} ]; then
    echo "[supervisor:${label}] ${MAX_RESTARTS} crashes within the last ${WINDOW_SEC}s — giving up so the underlying error stays visible. Fix the error and restart the workflow."
    exit 1
  fi

  if ! ensure_port_free; then
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

  # Backoff: 2s, 5s, then 10s for the rest of the window. The early values
  # are tuned so back-to-back restarts don't burn through the 20-crash
  # budget faster than the previous instance's 10s graceful-shutdown
  # window can complete.
  case "${attempt}" in
    1) sleep_s=2 ;;
    2) sleep_s=5 ;;
    *) sleep_s=10 ;;
  esac
  echo "[supervisor:${label}] restart in ${sleep_s}s"
  sleep "${sleep_s}"
done
