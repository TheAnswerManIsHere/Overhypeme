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
trap on_exit EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

_ms() { date +%s%3N; }

# ── launch + collect ──────────────────────────────────────────────────────────
declare -a WORKER_URLS=()
declare -a WORKER_OBJS=()
launch_and_wait() {
  local pids=() k url; local -A pid_obj=()
  for (( k=1; k<=shards; k++ )); do
    url="${WORKER_URLS[$k]}"
    run_files "$url" "$iso" -- --test-shard="${k}/${shards}" "$GLOB" &
    pids+=("$!"); pid_obj[$!]="${WORKER_OBJS[$k]}"
  done
  WORKER_PIDS=("${pids[@]}")
  local overall=0 pid
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then overall=1; FAILED_OBJ["${pid_obj[$pid]}"]=1; fi
  done
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
