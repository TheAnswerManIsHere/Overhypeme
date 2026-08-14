#!/usr/bin/env bash
# run-tests-sharded.sh — run the api-server test suite as N parallel shards, each
# fully ISOLATED from the others.
#
# Each shard is its own `node --test` process. Node's --test-shard=K/N flag splits
# the matched test files across N shards by file index, so each shard gets an
# independent, disjoint subset.
#
# ISOLATION (this is the important part)
# ──────────────────────────────────────
# Workers do NOT share a database. Two modes, chosen by capability detection:
#
#   per-DB (default, when CREATE DATABASE is permitted):
#     Build ONE template database for the run (fresh from template0 + pgvector +
#     the source `public` DDL, structure-only, + the boot-time engine catalogue
#     seed). Lock it (ALLOW_CONNECTIONS false), then give each shard a fast
#     ~60ms `CREATE DATABASE ... TEMPLATE` clone of it. Each worker runs against
#     its OWN database — no shared rows, so global-state tests cannot race.
#
#   per-schema (fallback, when CREATE DATABASE is denied):
#     Each shard gets its own isolated schema in the source database, cloned and
#     seeded independently. Slower setup, same isolation guarantee.
#
# All cluster-level operations (CREATE/DROP/TEMPLATE) use a CONTROL connection on
# the `postgres` maintenance database; the dev/public schema is never written to.
#
# CANONICAL COMMAND: `pnpm --filter @workspace/api-server test` (its `pretest`
# applies push-force + migrations + codegen first). Invoking this script DIRECTLY
# is an advanced path that assumes the source `public` schema is already current;
# after a migration run `pnpm --filter @workspace/db push-force && pnpm --filter
# @workspace/db run migrate` first.
#
# Usage:
#   run-tests-sharded.sh [shard_count]
#
# Shard count precedence (logged as source=...): positional arg > $TEST_SHARDS >
# auto min(nproc,4) (falls back to 2 if nproc is unavailable).
#
# Env:
#   TEST_SHARDS          override shard count (positional arg still wins)
#   FORCE_TEST_DB_MODE   "schema" to force the per-schema fallback
#   KEEP_TEST_DBS=1      retain the template + any FAILED worker objects for debug
#   TEST_DB_STALE_TTL    seconds; startup stale sweep drops older runner-owned
#                        objects with no active sessions (default 86400 = 24h)
#
# Exit status is the OR of the shard exit codes (any shard failure ⇒ non-zero).

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/test-db.sh
source "${SCRIPT_DIR}/lib/test-db.sh"

# The pg_dump/template-build and engine-seed paths are relative to the package root.
API_SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${API_SERVER_DIR}"

# ── shard count selection ─────────────────────────────────────────────────────
shard_source="auto"
shards=""
if [ "${1:-}" != "" ]; then
  shards="$1"; shard_source="positional"
elif [ "${TEST_SHARDS:-}" != "" ]; then
  shards="$TEST_SHARDS"; shard_source="env"
else
  _nproc="$(nproc 2>/dev/null || echo "")"
  if [[ "$_nproc" =~ ^[0-9]+$ ]] && [ "$_nproc" -ge 1 ]; then
    shards=$(( _nproc < 4 ? _nproc : 4 ))
  else
    shards=2
  fi
fi
if ! [[ "$shards" =~ ^[0-9]+$ ]] || (( shards < 1 )); then
  echo "[run-tests] ERROR: shard count must be a positive integer, got: '${shards}'" >&2
  exit 2
fi

# ── safety guard + stale sweep ────────────────────────────────────────────────
assert_not_production || exit 1
cleanup_stale_test_objects "${TEST_DB_STALE_TTL:-86400}" || true

# ── mode selection ────────────────────────────────────────────────────────────
MODE="perdb"
mode_reason="createdb-template-supported"
if [ "${FORCE_TEST_DB_MODE:-}" = "schema" ]; then
  MODE="schema"; mode_reason="forced"
elif ! can_create_database; then
  MODE="schema"; mode_reason="create-database-denied"
fi

run_id="$(sanitize_id "${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-0}_$$")"
stamp="$(now_stamp)"
iso="$(detect_isolation_flag)"
GLOB='src/__tests__/**/*.test.ts'

# ── shared run state + cleanup ────────────────────────────────────────────────
TEMPLATE_DB=""
declare -a CREATED_DBS=()       # worker databases (per-DB mode)
declare -a CREATED_SCHEMAS=()   # worker schemas (schema mode)
declare -A FAILED_OBJ=()        # name -> 1 for objects whose worker failed
declare -a WORKER_PIDS=()       # live worker node PIDs (for signal cleanup)
declare -a PREFIX_PIDS=()       # live shard-prefixer (sed) PIDs (for signal cleanup)
FIFO_DIR=""                     # holds the per-shard log-prefixing FIFOs
cleanup_dropped=0
cleanup_retained=0

_cleaned=0
do_cleanup() {
  [ "$_cleaned" = "1" ] && return 0
  _cleaned=1
  # Kill any still-running worker processes FIRST. On normal exit they have
  # already finished (no-op); on a signal they may still be alive and would
  # otherwise reconnect to their database and block the DROP below.
  local p
  for p in "${WORKER_PIDS[@]:-}"; do
    [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true
  done
  # Also kill any live prefixer (sed). Killing a worker whose write end is open
  # sends its reader EOF, so this is normally a no-op — but a prefixer whose
  # reader is still blocked in open(), waiting for a writer that was signalled
  # away before it ever started (or never even spawned, mid-loop), would
  # otherwise hang forever: removing the FIFO_DIR below only unlinks the
  # directory entry, it does not wake a process blocked opening it.
  for p in "${PREFIX_PIDS[@]:-}"; do
    [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true
  done
  local keep="${KEEP_TEST_DBS:-}"
  local name
  for name in "${CREATED_DBS[@]:-}"; do
    [ -z "$name" ] && continue
    if [ "$keep" = "1" ] && [ -n "${FAILED_OBJ[$name]:-}" ]; then
      _td_log "keeping failed worker database ${name} (KEEP_TEST_DBS=1)"
      cleanup_retained=$(( cleanup_retained + 1 )); continue
    fi
    drop_database_if_exists "$name"; cleanup_dropped=$(( cleanup_dropped + 1 ))
  done
  for name in "${CREATED_SCHEMAS[@]:-}"; do
    [ -z "$name" ] && continue
    if [ "$keep" = "1" ] && [ -n "${FAILED_OBJ[$name]:-}" ]; then
      _td_log "keeping failed worker schema ${name} (KEEP_TEST_DBS=1)"
      cleanup_retained=$(( cleanup_retained + 1 )); continue
    fi
    drop_schema_if_exists "$name"; cleanup_dropped=$(( cleanup_dropped + 1 ))
  done
  [ -n "$FIFO_DIR" ] && rm -rf "$FIFO_DIR"
  if [ -n "$TEMPLATE_DB" ]; then
    if [ "$keep" = "1" ]; then
      _td_log "keeping template ${TEMPLATE_DB} (KEEP_TEST_DBS=1)"; cleanup_retained=$(( cleanup_retained + 1 ))
    else
      drop_database_if_exists "$TEMPLATE_DB"; cleanup_dropped=$(( cleanup_dropped + 1 ))
    fi
  fi
  _td_log "cleanup dropped=${cleanup_dropped} retained=${cleanup_retained}"
}

# Normal exit: preserve the real test exit code. Signals: report the canonical
# 130 (SIGINT) / 143 (SIGTERM) so an interrupted/cancelled run can never be
# reported as a pass. `trap -` before exiting prevents the EXIT trap from running
# cleanup a second time (do_cleanup is also idempotent as a backstop).
on_exit() { local rc=$?; do_cleanup; exit "$rc"; }
on_signal() { trap - EXIT INT TERM; do_cleanup; exit "$1"; }

# `_in_critical`/`_deferred_sig`: a caught signal between spawning a child and
# recording its PID would otherwise see an empty WORKER_PIDS/PREFIX_PIDS and
# leak that child — narrower than the whole-loop version of this bug (fixed
# earlier by moving the append next to the spawn), but a real bash safe-point
# gap between two simple commands, reproduced directly: self-delivering TERM
# between a `&` and the following array append lands in the trap with the
# array still empty. Bash only checks for a pending trapped signal at command
# boundaries — never mid-instruction — so setting a flag with one simple
# command is itself atomic with respect to signal delivery: a signal arriving
# while `_in_critical=1` is being set cannot land "in between" that assignment
# and the next command seeing the flag as 1. `on_signal` checks the flag and,
# if set, defers rather than cleaning up immediately — signals are recorded,
# never dropped, so a real Ctrl-C during a critical section still fires
# cleanup, just at the end of that section instead of losing the child.
_in_critical=0
_deferred_sig=""
on_signal() {
  if [ "$_in_critical" = "1" ]; then _deferred_sig="$1"; return; fi
  trap - EXIT INT TERM
  do_cleanup
  exit "$1"
}
# check_deferred_signal — call immediately after each critical section ends.
check_deferred_signal() { [ -n "$_deferred_sig" ] && on_signal "$_deferred_sig"; return 0; }
trap on_exit EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

_ms() { date +%s%3N; }

# ── launch + collect ──────────────────────────────────────────────────────────
declare -a WORKER_URLS=()
declare -a WORKER_OBJS=()
# Each worker's combined stdout/stderr is prefixed with its shard id so a failure
# spread across shards is attributable instead of one interleaved, unlabeled TAP
# stream. `sed -u` keeps it line-buffered, so shards interleave in close to real
# time rather than arriving in stalled chunks.
#
# The prefixer is fed through an explicit FIFO rather than a pipe or a process
# substitution, because BOTH of those lose a PID this function needs:
#
#   * A pipe (`run_files ... | sed ... &`) makes `$!` the PID of `sed`, the
#     pipeline's last command — not `run_files`'s exec'd node. do_cleanup's
#     signal kill would then miss the real test process, and an orphaned node
#     would reconnect and block its database DROP. (test-db.sh's run_files EXECs
#     specifically so a background caller's `$!` IS node's own PID.)
#   * A process substitution (`> >(sed ...)`) keeps `$!` correct, but gives no
#     handle on the sed reader at all. `wait` would then return as soon as node
#     exits, while the prefixer may still be draining buffered output — so the
#     run's own result line and cleanup summary could print before (or instead
#     of) a shard's final TAP lines, truncating diagnostics on exactly the noisy
#     failures this prefixing exists to make readable.
#
# A FIFO gives both PIDs separately: node's for the exit status and the signal
# kill, the prefixer's to wait on for a complete drain.
launch_and_wait() {
  local pids=() k url fifo; local -A pid_obj=()
  FIFO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shard_prefix_XXXXXX")"
  for (( k=1; k<=shards; k++ )); do
    url="${WORKER_URLS[$k]}"
    fifo="${FIFO_DIR}/shard${k}"
    mkfifo "$fifo"
    # Start the reader first: opening a FIFO for reading blocks until a writer
    # appears, so this parks harmlessly until run_files opens the write end.
    #
    # Each spawn+publish pair is a critical section (see _in_critical above):
    # published to the GLOBAL array immediately, not batched after the loop,
    # AND signal-deferred across the two commands themselves — a signal
    # arriving between `&` and the following array append is a real bash
    # safe-point gap, not just a whole-loop-iteration one.
    _in_critical=1
    sed -u "s|^|[shard ${k}/${shards}] |" < "$fifo" &
    PREFIX_PIDS+=("$!")
    _in_critical=0
    check_deferred_signal
    _in_critical=1
    run_files "$url" "$iso" -- --test-shard="${k}/${shards}" "$GLOB" > "$fifo" 2>&1 &
    pids+=("$!"); pid_obj[$!]="${WORKER_OBJS[$k]}"
    WORKER_PIDS+=("$!")
    _in_critical=0
    check_deferred_signal
  done
  local overall=0 pid
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then overall=1; FAILED_OBJ["${pid_obj[$pid]}"]=1; fi
  done
  # Every writer has exited, so each prefixer now sees EOF. Waiting here means
  # all shard output has been flushed before the caller logs the run result.
  for pid in "${PREFIX_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  return "$overall"
}

template_ms=0; clone_ms_total=0

if [ "$MODE" = "perdb" ]; then
  # Build template (structure-only). Downgrade to schema mode on capability
  # failures; FAIL LOUDLY on a real dump/replay error (return 3).
  TEMPLATE_DB="$(sanitize_id "heliumdb_t_${stamp}_${run_id}")"
  _tb0="$(_ms)"
  set +e; reset_and_clone_schema_into "$TEMPLATE_DB"; build_rc=$?; set -e
  template_ms=$(( $(_ms) - _tb0 ))
  case "$build_rc" in
    0) : ;;
    3) echo "[run-tests] ERROR: template schema build failed (real DDL/dump error) — not falling back" >&2
       exit 1 ;;
    *) _td_log "per-DB template build failed (rc=${build_rc}); falling back to per-schema mode"
       drop_database_if_exists "$TEMPLATE_DB"; TEMPLATE_DB=""
       MODE="schema"; mode_reason="perdb-build-failed" ;;
  esac
fi

if [ "$MODE" = "perdb" ]; then
  if ! seed_catalogue "$(build_db_url_for "$TEMPLATE_DB")"; then
    echo "[run-tests] ERROR: seeding the template catalogue failed" >&2; exit 1
  fi
  if ! lock_template "$TEMPLATE_DB"; then
    echo "[run-tests] ERROR: could not quiesce the template for cloning" >&2; exit 1
  fi
  _cl0="$(_ms)"
  for (( k=1; k<=shards; k++ )); do
    wdb="$(sanitize_id "heliumdb_w_${stamp}_${run_id}_${k}")"
    if ! clone_database_from_template "$TEMPLATE_DB" "$wdb"; then
      echo "[run-tests] ERROR: cloning worker database ${wdb} failed" >&2; exit 1
    fi
    CREATED_DBS+=("$wdb"); WORKER_OBJS[$k]="$wdb"; WORKER_URLS[$k]="$(build_db_url_for "$wdb")"
  done
  clone_ms_total=$(( $(_ms) - _cl0 ))
else
  # per-schema fallback: clone + seed one schema per worker in the source DB.
  for (( k=1; k<=shards; k++ )); do
    sch="$(sanitize_id "heliumdb_s_${stamp}_${run_id}_${k}")"
    if ! reset_and_clone_schema "$sch"; then
      echo "[run-tests] ERROR: cloning worker schema ${sch} failed" >&2; exit 1
    fi
    CREATED_SCHEMAS+=("$sch"); WORKER_OBJS[$k]="$sch"; WORKER_URLS[$k]="$(build_schema_url_for "$sch")"
    if ! seed_catalogue "${WORKER_URLS[$k]}"; then
      echo "[run-tests] ERROR: seeding worker schema ${sch} failed" >&2; exit 1
    fi
  done
fi

_td_log "MODE=${MODE} reason=${mode_reason} shards=${shards} source=${shard_source} run_id=${run_id}"

_tt0="$(_ms)"
set +e; launch_and_wait; overall=$?; set -e
test_ms=$(( $(_ms) - _tt0 ))

_td_log "MODE=${MODE} shards=${shards} source=${shard_source} template_ms=${template_ms} clone_ms_total=${clone_ms_total} test_ms=${test_ms} result=$([ "$overall" -eq 0 ] && echo pass || echo fail)"

exit "$overall"
