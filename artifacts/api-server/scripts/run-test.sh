#!/usr/bin/env bash
# run-test.sh — run one or more api-server test files against the isolated
# heliumdb_test schema, never the live public schema.
#
# Usage (from the repo root or artifacts/api-server):
#   bash artifacts/api-server/scripts/run-test.sh src/__tests__/foo.test.ts [...]
#
#   # Or from inside artifacts/api-server:
#   bash scripts/run-test.sh src/__tests__/foo.test.ts [...]
#
# Flags:
#   --setup   Force a fresh schema clone from public into heliumdb_test before
#             running.  Implied automatically when the table counts differ.
#
# Env overrides:
#   CRON_SECRET  (default: test-cron-secret) — used by routes that guard with it
#
# Exit code mirrors the underlying `node --test` exit code.
#
# DB ISOLATION
# ─────────────
# Constructs TEST_DATABASE_URL the same way run-tests-sharded.sh does:
# appending "options=-c search_path=heliumdb_test,public" to DATABASE_URL so
# every unqualified table reference resolves to heliumdb_test first.  The
# public schema remains a fallback only for extension types like `vector`
# (pgvector), which are registered there and cannot be moved.
#
# If heliumdb_test has fewer tables than public (stale or missing schema) the
# script automatically re-clones it.  Use --setup to force a re-clone even
# when the counts match (e.g. after adding a migration).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Normalize the working directory to the api-server package root. This script is
# documented as runnable from the repo root or from artifacts/api-server, but the
# test-file arguments (src/__tests__/...) and the relative engine-seed import
# below both resolve relative to this directory. The full sharded runner gets this
# for free because pnpm sets its CWD; run-test.sh is invoked directly, so it must
# cd itself or the documented repo-root invocation breaks.
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

# ── Construct TEST_DATABASE_URL ───────────────────────────────────────────────
# Identical logic to run-tests-sharded.sh.  Python's urllib.parse is used
# because libpq requires %20 for spaces, not '+' (urlencode default).
TEST_DATABASE_URL="$(python3 << PYEOF
import os, urllib.parse
u = urllib.parse.urlparse(os.environ['DATABASE_URL'])
params = dict(urllib.parse.parse_qsl(u.query))
params['options'] = '-c search_path=${TEST_SCHEMA},public'
new_query = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
print(urllib.parse.urlunparse(u._replace(query=new_query)))
PYEOF
)"

if [ -z "${TEST_DATABASE_URL:-}" ] || [ "$TEST_DATABASE_URL" = "$DATABASE_URL" ]; then
  echo "[run-test] ERROR: failed to construct test DATABASE_URL" >&2
  exit 1
fi

# ── Schema freshness check ────────────────────────────────────────────────────
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

# ── Schema setup (clone from public) ─────────────────────────────────────────
# Drop + recreate + pg_dump clone — same pipeline as run-tests-sharded.sh.
if [ "$NEED_SETUP" = true ]; then
  echo "[run-test] setting up test schema '${TEST_SCHEMA}'…"
  if ! psql "$DATABASE_URL" -c \
       "DROP SCHEMA IF EXISTS \"${TEST_SCHEMA}\" CASCADE; CREATE SCHEMA \"${TEST_SCHEMA}\"" \
       >/dev/null 2>&1; then
    echo "[run-test] ERROR: failed to reset test schema" >&2
    exit 1
  fi

  _DUMP_TMP=$(mktemp /tmp/schema_dump_XXXXXX.sql)
  trap 'rm -f "$_DUMP_TMP"' EXIT

  pg_dump "$DATABASE_URL" \
    --schema=public \
    --schema-only \
    --no-owner \
    --no-privileges \
    --no-comments \
    -f "$_DUMP_TMP" 2>&1
  _PGDUMP_EXIT=$?
  if [ "$_PGDUMP_EXIT" -ne 0 ]; then
    echo "[run-test] ERROR: pg_dump failed (exit ${_PGDUMP_EXIT})" >&2
    exit 1
  fi

  grep -v "^CREATE SCHEMA " "$_DUMP_TMP" \
    | sed "s/public\.vector/__PGVECTOR__/g" \
    | sed "s/public\./${TEST_SCHEMA}./g" \
    | sed "s/__PGVECTOR__/public.vector/g" \
    | psql "$DATABASE_URL" 2>&1
  _PSQL_EXIT=$?
  rm -f "$_DUMP_TMP"
  trap - EXIT

  if [ "$_PSQL_EXIT" -ne 0 ]; then
    echo "[run-test] ERROR: schema clone failed (psql exit ${_PSQL_EXIT})" >&2
    exit 1
  fi
  echo "[run-test] test schema '${TEST_SCHEMA}' ready"
fi

echo "[run-test] DB isolation active — tests use schema '${TEST_SCHEMA}' (public schema untouched)"

# ── Detect --test-isolation flag ─────────────────────────────────────────────
# Same portability dance as run-tests-sharded.sh.
if node --help 2>&1 | grep -q -- '--test-isolation='; then
  isolation_flag="--test-isolation=none"
elif node --help 2>&1 | grep -q -- '--experimental-test-isolation='; then
  isolation_flag="--experimental-test-isolation=none"
else
  isolation_flag=""
fi

common_args=(--import tsx/esm)
[[ -n "$isolation_flag" ]] && common_args+=("$isolation_flag")
common_args+=(--test-concurrency=1 --test)

# ── Run ───────────────────────────────────────────────────────────────────────
export DATABASE_URL="${TEST_DATABASE_URL}"

# Seed the boot-time, code-owned catalogue rows that the API server normally
# reconciles on startup (the engine catalogue). The isolated test schema is
# structure-only — no data is cloned from public — so a targeted DB-backed test
# that expects these rows to exist would otherwise fail for an environment reason
# rather than a real product reason. This mirrors run-tests-sharded.sh so a
# single-file run and the full suite set up the same baseline; the reconcile is
# idempotent, so re-running it on an already-seeded schema is safe.
echo "[run-test] seeding boot-time engine catalogue rows in '${TEST_SCHEMA}'…"
if ! TEST_DB_ALLOW_EXIT_ON_IDLE=1 TEST_SKIP_EMBEDDINGS=1 RESEND_API_KEY_DEV="" RESEND_API_KEY_PROD="" RESEND_API_KEY="re_test_dummy" \
  CRON_SECRET="${CRON_SECRET:-test-cron-secret}" \
  node --import tsx/esm -e 'import { reconcileEngines } from "./src/lib/engines/index.ts"; import { closePool } from "@workspace/db"; try { await reconcileEngines(); } finally { await closePool(); }'; then
  echo "[run-test] ERROR: failed to seed boot-time engine catalogue rows" >&2
  exit 1
fi

TEST_DB_ALLOW_EXIT_ON_IDLE=1 \
  RESEND_API_KEY_DEV="" RESEND_API_KEY_PROD="" RESEND_API_KEY="re_test_dummy" \
  CRON_SECRET="${CRON_SECRET:-test-cron-secret}" \
  node "${common_args[@]}" "${FILES[@]}"
