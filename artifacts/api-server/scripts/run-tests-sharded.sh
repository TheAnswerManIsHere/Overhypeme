#!/usr/bin/env bash
# run-tests-sharded.sh — run the api-server test suite as N parallel shards.
#
# Each shard is its own `node --test` process. Node's --test-shard=K/N flag
# splits the matched test files across N shards by file index, so each shard
# gets an independent process — that means in-memory module state (the
# stripeSyncRunner lock, in-memory rate limiters, the session cache, env-var
# snapshots) is naturally isolated between shards.
#
# Usage:
#   run-tests-sharded.sh [shard_count]
#
# If shard_count is omitted, defaults to 2. Must be a positive integer >=1.
#
# Exit status is the bitwise-OR of the individual shard exit codes, so any
# shard failure surfaces as a non-zero overall exit. Output from the shards
# is interleaved on stdout/stderr — that is acceptable here because the test
# runner already prints per-test diagnostics with file paths.
#
# DB ISOLATION
# ─────────────
# Tests run against an isolated schema (heliumdb_test) inside the same
# PostgreSQL server. The development schema (public) is never written to.
#
# Before each test run the test schema is dropped and recreated (clean slate),
# then the current schema structure is cloned from the public schema using
# pg_dump --schema-only. This is required because the earliest migration files
# contain only ALTER TABLE statements that assume the base tables already exist
# — there is no "migration 0" that creates the initial schema. pg_dump gives
# us the authoritative current schema without needing the migration history.
#
# DATABASE_URL is then overridden to point every pool connection (via the
# search_path startup parameter) at the test schema. The dev schema and its
# data are never touched.

set -u

shards="${1:-2}"

if ! [[ "$shards" =~ ^[0-9]+$ ]] || (( shards < 1 )); then
  echo "[run-tests-sharded] shard_count must be a positive integer, got: $shards" >&2
  exit 2
fi

# Resolve the workspace root from this script's location so the script is
# runnable from any working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Args common to every shard. --test-isolation=none + --test-concurrency=1
# keep each shard single-process (file ordering inside a shard stays
# sequential), and we let Node expand the glob.
#
# TEST_DB_ALLOW_EXIT_ON_IDLE=1 tells the @workspace/db Pool to set
# allowExitOnIdle: true at construction time.  This unrefs idle-timeout
# timers and client sockets so Node exits cleanly once all tests have
# finished, without waiting up to idleTimeoutMillis (60 s) for idle
# connections to drain.  That lets us drop --test-force-exit and regain
# the ability to detect leaked promises.
# The test-isolation flag was introduced as --experimental-test-isolation and
# later stabilized to --test-isolation. Different node builds (CI, Replit, the
# cloud dev environment) ship different versions and advertise different names —
# passing the wrong one makes node abort at startup ("bad option"). Detect which
# name THIS node knows from --help and use it; both select the same
# single-process behavior. Don't silently omit it: within a shard we rely on
# isolation=none so in-memory module state (the stripeSyncRunner lock, rate
# limiters, caches) is shared and file ordering stays sequential.
if node --help 2>&1 | grep -q -- '--test-isolation='; then
  isolation_flag="--test-isolation=none"
elif node --help 2>&1 | grep -q -- '--experimental-test-isolation='; then
  isolation_flag="--experimental-test-isolation=none"
else
  echo "[run-tests-sharded] WARNING: node $(node --version) advertises no test-isolation flag;" >&2
  echo "[run-tests-sharded] running without it (each test file gets its own process)." >&2
  isolation_flag=""
fi

common_args=(--import tsx/esm)
[[ -n "$isolation_flag" ]] && common_args+=("$isolation_flag")
common_args+=(--test-concurrency=1 --test)

# ─── Test Schema Setup ────────────────────────────────────────────────────────
TEST_SCHEMA="heliumdb_test"

# Construct a DATABASE_URL that sets search_path to the test schema first,
# then public. The two-schema path is required because extension types like
# `vector` (pgvector) are installed in the `public` schema and must be
# reachable at type-lookup time even when tables live in heliumdb_test.
# Drizzle's unqualified table queries ("facts", "users") still resolve to
# heliumdb_test because it is listed first; dev data in public is never touched.
# Python's urllib.parse handles URL encoding correctly — spaces must be %20
# (which libpq requires); urlencode's default '+' is not supported by libpq.
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
  echo "[run-tests-sharded] ERROR: failed to construct test DATABASE_URL" >&2
  exit 1
fi

# Step 1: Drop and recreate the test schema for a clean slate on every run.
# DROP CASCADE removes all tables, types, indexes, and sequences from a previous
# run. The schema is then repopulated from the dev schema below.
echo "[run-tests-sharded] resetting test schema '${TEST_SCHEMA}'…"
if ! psql "$DATABASE_URL" -c \
     "DROP SCHEMA IF EXISTS \"${TEST_SCHEMA}\" CASCADE; CREATE SCHEMA \"${TEST_SCHEMA}\"" \
     >/dev/null 2>&1; then
  echo "[run-tests-sharded] ERROR: failed to reset test schema '${TEST_SCHEMA}'" >&2
  exit 1
fi

# Step 2: Clone the schema structure from public to the test schema.
# pg_dump --schema-only captures all tables, custom types (enums), indexes,
# sequences, constraints, and FK relationships.
#
# pg_dump can output schema objects in two formats depending on the server
# version: (a) fully qualified as "CREATE TABLE public.facts (...)" or (b) with
# "SET search_path = public, pg_catalog" followed by unqualified "CREATE TABLE
# facts (...)". The sed pipeline handles both by rewriting every schema name
# occurrence — both explicit "public." qualifications AND the search_path
# settings that govern unqualified names.
#
# We use a temp file so we can check pg_dump's exit code separately from psql's
# (in a pipeline, only the last command's exit code is visible without pipefail).
echo "[run-tests-sharded] cloning schema structure from public to '${TEST_SCHEMA}'…"
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
  echo "[run-tests-sharded] ERROR: pg_dump failed (exit ${_PGDUMP_EXIT})" >&2
  exit 1
fi

# Transform the dump:
#   1. Remove any "CREATE SCHEMA public" line (the schema already exists).
#   2. Protect the pgvector extension type "public.vector" with a placeholder
#      before the general schema-rename sed runs.  The vector type is registered
#      in the public schema by the pgvector extension and must stay as
#      "public.vector" — renaming it to "heliumdb_test.vector" would produce
#      "type does not exist" because the type was never created in heliumdb_test.
#   3. Rewrite every remaining "public." prefix to "heliumdb_test." so that
#      tables, user-defined enums, sequences, FKs, and indexes are all created
#      in the test schema.  The dump uses explicit schema qualifications (the
#      modern pg_dump format sets search_path to empty and qualifies every name),
#      so replacing the prefix is sufficient — no search_path fixup is needed.
#   4. Restore the placeholder back to "public.vector".
grep -v "^CREATE SCHEMA " "$_DUMP_TMP" \
  | sed "s/public\.vector/__PGVECTOR__/g" \
  | sed "s/public\./${TEST_SCHEMA}./g" \
  | sed "s/__PGVECTOR__/public.vector/g" \
  | psql "$DATABASE_URL" 2>&1
_PSQL_EXIT=$?
rm -f "$_DUMP_TMP"
trap - EXIT

if [ "$_PSQL_EXIT" -ne 0 ]; then
  echo "[run-tests-sharded] ERROR: schema clone to '${TEST_SCHEMA}' failed (psql exit ${_PSQL_EXIT})" >&2
  exit 1
fi

# Verify the clone produced a non-empty schema — a sanity check that catches
# silent empty-pipe scenarios (e.g. pg_dump produced no output).
_TABLE_COUNT=$(psql "$DATABASE_URL" -t -c \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${TEST_SCHEMA}' AND table_type = 'BASE TABLE'" \
  2>/dev/null | tr -d ' \n')
echo "[run-tests-sharded] test schema '${TEST_SCHEMA}' has ${_TABLE_COUNT} tables"
if [ "${_TABLE_COUNT:-0}" -lt 5 ]; then
  echo "[run-tests-sharded] ERROR: schema clone looks incomplete (expected ≥5 tables, got ${_TABLE_COUNT})" >&2
  exit 1
fi

echo "[run-tests-sharded] DB isolation active — tests use schema '${TEST_SCHEMA}' (public schema untouched)"

# Step 3: Override DATABASE_URL for all child processes so every pool
# connection targets the test schema via the search_path startup parameter.
export DATABASE_URL="${TEST_DATABASE_URL}"

# Seed boot-time catalogue rows that are normally reconciled when the API server
# starts. The isolated test schema is structure-only (no data copied from
# public), so tests that assert reconciliation preserves admin-edited engine
# fields need the baseline engine rows to exist before shard processes launch.
echo "[run-tests-sharded] seeding boot-time engine catalogue rows in '${TEST_SCHEMA}'…"
if ! TEST_DB_ALLOW_EXIT_ON_IDLE=1 RESEND_API_KEY_DEV="" RESEND_API_KEY_PROD="" RESEND_API_KEY="re_test_dummy" \
  CRON_SECRET="${CRON_SECRET:-test-cron-secret}" \
  node --import tsx/esm -e 'import { reconcileEngines } from "./src/lib/engines/index.ts"; import { closePool } from "@workspace/db"; try { await reconcileEngines(); } finally { await closePool(); }'; then
  echo "[run-tests-sharded] ERROR: failed to seed boot-time engine catalogue rows" >&2
  exit 1
fi

pids=()
for ((k = 1; k <= shards; k++)); do
  # CRON_SECRET has no fallback in routes/jobs.ts — app.js throws at module load
  # if it is unset, which fails every test that imports the full app (e.g.
  # csrf.integration). Stub it the same way RESEND_API_KEY is stubbed so the
  # suite is self-contained and does not depend on a real secret being present.
  TEST_DB_ALLOW_EXIT_ON_IDLE=1 RESEND_API_KEY_DEV="" RESEND_API_KEY_PROD="" RESEND_API_KEY="re_test_dummy" \
    CRON_SECRET="${CRON_SECRET:-test-cron-secret}" \
    node "${common_args[@]}" --test-shard="${k}/${shards}" \
    'src/__tests__/**/*.test.ts' &
  pids+=("$!")
done

overall=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    overall=1
  fi
done

exit "$overall"
