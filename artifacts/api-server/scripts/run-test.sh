#!/usr/bin/env bash
# run-test.sh — run one or more api-server test files against the isolated
# heliumdb_test schema, never the live public schema.
#
# This is the fast INNER-LOOP runner. It keeps a CACHED `heliumdb_test` schema and
# only re-clones it when stale (or when --setup is passed). It deliberately does
# NOT create per-run worker databases or run stale cleanup — that is the full
# runner's job (run-tests-sharded.sh). Low-level DB primitives are shared with the
# full runner via scripts/lib/test-db.sh so the two cannot drift.
#
# Usage (from the repo root or artifacts/api-server):
#   bash artifacts/api-server/scripts/run-test.sh src/__tests__/foo.test.ts [...]
#   bash scripts/run-test.sh src/__tests__/foo.test.ts [...]
#
# Flags:
#   --setup   Force a fresh schema clone from public into heliumdb_test before
#             running. Implied automatically when the table counts differ.
#             (--setup re-clones from the ALREADY-updated public schema; it does
#             not run migrations. After a migration: `pnpm --filter @workspace/db
#             push-force && pnpm --filter @workspace/db run migrate`, then --setup.)
#
# Env overrides:
#   CRON_SECRET  (default: test-cron-secret) — used by routes that guard with it
#
# Exit code mirrors the underlying `node --test` exit code.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/test-db.sh
source "${SCRIPT_DIR}/lib/test-db.sh"

# Normalize the working directory to the api-server package root: the test-file
# arguments (src/__tests__/...) and the engine-seed import resolve relative to it.
# run-test.sh is invoked directly (not via pnpm), so it must cd itself.
API_SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${API_SERVER_DIR}"

if [ "$#" -eq 0 ]; then
  echo "Usage: bash scripts/run-test.sh [--setup] <test-file> [<test-file> ...]" >&2
  exit 2
fi

FORCE_SETUP=false
FILES=()
for arg in "$@"; do
  if [ "$arg" = "--setup" ]; then
    FORCE_SETUP=true
  else
    FILES+=("$arg")
  fi
done

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "[run-test] ERROR: no test files specified" >&2
  exit 2
fi

TEST_SCHEMA="heliumdb_test"

# Safety: never run destructive schema setup against a production database.
assert_not_production || exit 1

# ── Schema freshness check (cache behavior; run-test.sh specific) ─────────────
# Re-clone only when forced or when heliumdb_test has fewer tables than public.
_PUBLIC_COUNT=$(psql "$DATABASE_URL" -t -c \
  "SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'" \
  2>/dev/null | tr -d ' \n')
_TEST_COUNT=$(psql "$DATABASE_URL" -t -c \
  "SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema = '${TEST_SCHEMA}' AND table_type = 'BASE TABLE'" \
  2>/dev/null | tr -d ' \n')

NEED_SETUP=false
if [ "$FORCE_SETUP" = true ]; then
  NEED_SETUP=true
elif [ "${_TEST_COUNT:-0}" -lt "${_PUBLIC_COUNT:-1}" ]; then
  echo "[run-test] heliumdb_test has ${_TEST_COUNT:-0} tables vs public ${_PUBLIC_COUNT} — auto-running setup"
  NEED_SETUP=true
fi

if [ "$NEED_SETUP" = true ]; then
  echo "[run-test] setting up test schema '${TEST_SCHEMA}'…"
  if ! reset_and_clone_schema "$TEST_SCHEMA"; then
    echo "[run-test] ERROR: failed to set up test schema" >&2
    exit 1
  fi
  echo "[run-test] test schema '${TEST_SCHEMA}' ready"
fi

echo "[run-test] DB isolation active — tests use schema '${TEST_SCHEMA}' (public schema untouched)"

TEST_URL="$(build_schema_url_for "$TEST_SCHEMA")"
ISO="$(detect_isolation_flag)"

# Seed the boot-time, code-owned engine catalogue rows (idempotent) so a targeted
# DB-backed test sets up the same baseline as the full suite.
echo "[run-test] seeding boot-time engine catalogue rows in '${TEST_SCHEMA}'…"
if ! seed_catalogue "$TEST_URL"; then
  echo "[run-test] ERROR: failed to seed boot-time engine catalogue rows" >&2
  exit 1
fi

run_files "$TEST_URL" "$ISO" -- "${FILES[@]}"
