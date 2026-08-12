#!/usr/bin/env bash
# test-db.sh — shared helpers for the api-server test runners.
#
# This file is SOURCED by run-test.sh (targeted, single-file) and
# run-tests-sharded.sh (full suite, per-worker isolated databases). It centralizes
# the database-isolation primitives so the two runners cannot drift into two
# slightly different schema-clone implementations.
#
# DESIGN RULES (enforced because this layer creates and drops databases):
#   * No side effects on source: functions never mutate the global DATABASE_URL;
#     URL-returning functions print to stdout and log only to stderr.
#   * No traps: sourced functions must NOT install EXIT/INT/TERM traps — the
#     calling runner owns exactly one cleanup trap. Temp files are removed inline.
#   * Two URLs: cluster-level ops (CREATE/DROP/TEMPLATE, pg_stat_activity) use a
#     CONTROL url on the `postgres` maintenance DB; the source url is used only to
#     pg_dump the source `public` schema; workers connect to their own DB url.
#   * Strict identifiers: every db/schema name passes sanitize_id (lowercase,
#     [a-z0-9_], <=63 bytes, fail-closed). No unsanitized interpolation into SQL.
#   * ON_ERROR_STOP=1 on every psql call whose failure must fail the step.
#   * Credential-safe: never log a full DATABASE_URL (it carries the password).
#
# Run `bash scripts/lib/test-db.sh --self-check` to validate the brittle pure
# helpers (identifier sanitization, URL redaction/stripping, isolation detection)
# without touching any database.

# Guard against double-sourcing.
if [ -n "${_TEST_DB_LIB_LOADED:-}" ]; then return 0 2>/dev/null || true; fi
_TEST_DB_LIB_LOADED=1
_TEST_DB_LIB_VERSION=1

if [ -n "${TEST_DATABASE_URL:-}" ]; then export DATABASE_URL="$TEST_DATABASE_URL"; fi

# ── logging ───────────────────────────────────────────────────────────────────
# All logs go to stderr so stdout stays clean for URL-returning helpers.
_td_log()  { echo "[test-db] $*" >&2; }
_td_err()  { echo "[test-db] ERROR: $*" >&2; }

# ── identifier sanitization ───────────────────────────────────────────────────
# sanitize_id <raw> [maxlen]
#   Lowercase, keep only [a-z0-9_], collapse the rest to '_', enforce the Postgres
#   63-byte identifier cap (default), fail closed (return 1) on an empty result.
sanitize_id() {
  local raw="${1:-}" maxlen="${2:-63}" out
  out="$(printf '%s' "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9_]/_/g' \
    | sed 's/__*/_/g; s/^_//; s/_$//')"
  out="${out:0:$maxlen}"
  out="${out%_}"
  if [ -z "$out" ]; then
    _td_err "sanitize_id produced an empty identifier from '${raw}'"
    return 1
  fi
  printf '%s' "$out"
}

# ── URL helpers (pure; via python3 urllib for libpq-correct encoding) ──────────
# All read DATABASE_URL from the environment and print a derived URL to stdout.
# Stripping `options` prevents a connection being silently redirected to a test
# schema via a leftover search_path.

# build_control_db_url_for — maintenance DB (`postgres`), options stripped.
build_control_db_url_for() { TD_NEWPATH="/postgres" TD_STRIP_OPTIONS=1 _td_url_rewrite; }
# build_source_db_url_for — keep the source dbname, strip options. For pg_dump.
build_source_db_url_for() { TD_NEWPATH="" TD_STRIP_OPTIONS=1 _td_url_rewrite; }
# build_db_url_for <dbname> — point at <dbname>, strip options (per-DB workers need
# no search_path; pgvector lives in their own public).
build_db_url_for() {
  local db; db="$(sanitize_id "$1")" || return 1
  TD_NEWPATH="/${db}" TD_STRIP_OPTIONS=1 _td_url_rewrite
}
# build_schema_url_for <schema> — keep source dbname, set search_path=<schema>,public.
build_schema_url_for() {
  local schema; schema="$(sanitize_id "$1")" || return 1
  TD_NEWPATH="" TD_SEARCH_PATH="${schema},public" _td_url_rewrite
}

_td_url_rewrite() {
  python3 - <<'PYEOF'
import os, urllib.parse, sys
u = urllib.parse.urlparse(os.environ['DATABASE_URL'])
params = dict(urllib.parse.parse_qsl(u.query))
if os.environ.get('TD_STRIP_OPTIONS'):
    params.pop('options', None)
sp = os.environ.get('TD_SEARCH_PATH')
if sp:
    params['options'] = f'-c search_path={sp}'
newpath = os.environ.get('TD_NEWPATH') or u.path
q = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
sys.stdout.write(urllib.parse.urlunparse(u._replace(path=newpath, query=q)))
PYEOF
}

# redact_url <url> — for logging; replaces the password with ***.
redact_url() { printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'; }

# source_db_name — the dbname of the source DATABASE_URL (for logging/guards).
source_db_name() {
  python3 - <<'PYEOF'
import os, urllib.parse, sys
u = urllib.parse.urlparse(os.environ['DATABASE_URL'])
sys.stdout.write((u.path or '/').lstrip('/'))
PYEOF
}

# source_db_host — the hostname of the source DATABASE_URL (for the prod guard).
source_db_host() {
  python3 - <<'PYEOF'
import os, urllib.parse, sys
u = urllib.parse.urlparse(os.environ['DATABASE_URL'])
sys.stdout.write(u.hostname or "")
PYEOF
}

# _td_split — split a comma/space-separated list into words on stdout.
_td_split() { printf '%s' "${1:-}" | tr ',' ' '; }

# ── production safety guard ────────────────────────────────────────────────────
# assert_not_production — refuse destructive DB setup against production/dev.
# Deny-by-detection (no opt-in flag for normal dev/test/CI runs). Refuses when:
#   * NODE_ENV is "production" (case-insensitive);
#   * the source dbname is a protected name — by default `heliumdb` (DEV),
#     `neondb` (PRODUCTION) and `production`, plus any in
#     TEST_DB_PROTECTED_NAMES (comma/space-separated) — or contains 'prod';
#   * the source host matches `neon.tech` (where production lives) or any
#     substring in TEST_DB_PROTECTED_HOSTS;
#   * the URL won't parse.
#
# DEV AND PRODUCTION ARE DIFFERENT DATABASES ON DIFFERENT PROVIDERS. `heliumdb`
# (host `helium`) is dev; production is `neondb`, hosted on Neon. They used to
# share the single name `heliumdb`, and for a while after the split this guard
# still only knew that one name — so it protected dev and would have waved a
# destructive run straight through to production, which matches none of
# `heliumdb`/`production`/`*prod*`. Both the name and a generic `neon.tech`
# host marker are now baked in as defaults rather than left to the
# TEST_DB_PROTECTED_* env vars, which are unset in every environment this
# guard actually runs in.
#
# The host marker is deliberately generic (any `*.neon.tech`), not the specific
# production endpoint: an endpoint hostname is environment-specific config that
# does not belong in a public repo, and matching the provider fails closed for
# any future Neon database too. Consequence to know about: a Neon-hosted TEST
# database would also be refused, with no opt-out. That is the correct default
# while no such database exists — if one is ever needed, add an explicit
# allowlist mechanism then rather than loosening this marker.
# The dedicated test database is named `heliumdb_test` (Replit's TEST_DATABASE_URL
# points here; the sandbox/CI uses `overhype_test`). Those are allowed because the
# match is EXACT, not a substring — which is also why the per-worker
# `heliumdb_t_*`/`heliumdb_w_*` clones are fine.
assert_not_production() {
  local db host p node_env
  node_env="$(printf '%s' "${NODE_ENV:-}" | tr '[:upper:]' '[:lower:]')"
  if [ "$node_env" = "production" ]; then
    _td_err "refusing to run test-DB setup with NODE_ENV=production."
    _td_err "Point DATABASE_URL at the test database 'heliumdb_test' (not the 'heliumdb' prod/dev DB)."
    return 1
  fi
  if ! db="$(source_db_name)" || [ -z "$db" ]; then
    _td_err "could not parse a database name from DATABASE_URL; refusing to proceed."
    return 1
  fi
  for p in heliumdb neondb production $(_td_split "${TEST_DB_PROTECTED_NAMES:-}"); do
    if [ "$db" = "$p" ]; then
      _td_err "database '${db}' is a protected live database (heliumdb=dev, neondb=production); refusing destructive test-DB setup."
      _td_err "Point DATABASE_URL at the test database 'heliumdb_test' instead."
      return 1
    fi
  done
  case "$db" in
    *prod*)
      _td_err "database name '${db}' looks like production (contains 'prod'); refusing."
      return 1 ;;
  esac
  host="$(source_db_host)"
  if [ -n "$host" ]; then
    for p in neon.tech $(_td_split "${TEST_DB_PROTECTED_HOSTS:-}"); do
      case "$host" in
        *"$p"*)
          _td_err "host '${host}' matches a protected host marker ('${p}'); refusing destructive test-DB setup."
          return 1 ;;
      esac
    done
  fi
  return 0
}

# ── node --test isolation flag detection ──────────────────────────────────────
detect_isolation_flag() {
  if node --help 2>&1 | grep -q -- '--test-isolation='; then
    printf '%s' '--test-isolation=none'
  elif node --help 2>&1 | grep -q -- '--experimental-test-isolation='; then
    printf '%s' '--experimental-test-isolation=none'
  else
    _td_log "WARNING: node $(node --version 2>/dev/null) advertises no test-isolation flag; running without it"
    printf '%s' ''
  fi
}

# ── connection management ─────────────────────────────────────────────────────
# terminate_backends <dbname> — drop other sessions on <dbname> (via control URL).
terminate_backends() {
  local db ctl; db="$(sanitize_id "$1")" || return 1
  ctl="$(build_control_db_url_for)"
  psql "$ctl" -tAc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = '${db}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
}

# has_active_connections <dbname> — 0 (true) if other sessions are connected.
has_active_connections() {
  local db ctl n; db="$(sanitize_id "$1")" || return 1
  ctl="$(build_control_db_url_for)"
  n="$(psql "$ctl" -tAc \
    "SELECT count(*) FROM pg_stat_activity
     WHERE datname = '${db}' AND pid <> pg_backend_pid();" 2>/dev/null | tr -d ' \n')"
  [ "${n:-0}" -gt 0 ]
}

# lock_template <tmpl> — make a freshly-built template safe to clone from:
# disallow NEW connections, terminate any lingering ones, and verify the template
# is idle. Closes the race where a leaked session reconnects between terminate and
# clone. Returns non-zero (and logs) if the template still has sessions after that.
lock_template() {
  local tmpl ctl; tmpl="$(sanitize_id "$1")" || return 1
  ctl="$(build_control_db_url_for)"
  psql "$ctl" -q -c "ALTER DATABASE \"${tmpl}\" WITH ALLOW_CONNECTIONS false;" >/dev/null 2>&1 || true
  terminate_backends "$tmpl"
  if has_active_connections "$tmpl"; then
    _td_err "template ${tmpl} still has active connections after lock+terminate; refusing to clone"
    return 1
  fi
  return 0
}

# ── capability probe ──────────────────────────────────────────────────────────
# can_create_database — REAL end-to-end probe: create a disposable DB from
# template0 via the control URL and drop it. Returns 0 if per-DB mode is viable.
can_create_database() {
  local ctl probe
  ctl="$(build_control_db_url_for)"
  probe="$(sanitize_id "heliumdb_probe_$$_${RANDOM}")" || return 1
  if psql "$ctl" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"${probe}\" TEMPLATE template0;" >/dev/null 2>&1; then
    psql "$ctl" -q -c "DROP DATABASE IF EXISTS \"${probe}\";" >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}

# ── schema clone primitives ───────────────────────────────────────────────────
# _td_dump_public <outfile> — dump the source public schema (structure only).
_td_dump_public() {
  local out="$1" src; src="$(build_source_db_url_for)"
  pg_dump "$src" --schema=public --schema-only --no-owner --no-privileges --no-comments -f "$out"
}

# reset_and_clone_schema_into <target_db> — build a per-DB template (route B):
# fresh DB from template0 + pgvector + the source public DDL (structure only).
# Return codes: 0 ok; 1 create failed; 2 extension denied; 3 real dump/replay error.
reset_and_clone_schema_into() {
  local target ctl target_url
  target="$(sanitize_id "$1")" || return 1
  ctl="$(build_control_db_url_for)"
  target_url="$(build_db_url_for "$target")"

  terminate_backends "$target"
  psql "$ctl" -q -c "DROP DATABASE IF EXISTS \"${target}\";" >/dev/null 2>&1 || true
  if ! psql "$ctl" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"${target}\" TEMPLATE template0;"; then
    _td_err "CREATE DATABASE ${target} failed"; return 1
  fi
  if ! psql "$target_url" -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS vector;"; then
    _td_err "CREATE EXTENSION vector in ${target} failed"; return 2
  fi

  local dump; dump="$(mktemp /tmp/td_dump_XXXXXX.sql)"
  if ! _td_dump_public "$dump"; then
    rm -f "$dump"; _td_err "pg_dump of source public failed"; return 3
  fi
  if ! grep -v "^CREATE SCHEMA " "$dump" | psql "$target_url" -v ON_ERROR_STOP=1 -q; then
    rm -f "$dump"; _td_err "schema replay into ${target} failed"; return 3
  fi
  rm -f "$dump"
  return 0
}

# clone_database_from_template <tmpl> <new> — fast (~ms) file-copy clone.
# Drains the template once and retries if a lingering session blocks the copy.
clone_database_from_template() {
  local tmpl new ctl
  tmpl="$(sanitize_id "$1")" || return 1
  new="$(sanitize_id "$2")" || return 1
  ctl="$(build_control_db_url_for)"
  psql "$ctl" -q -c "DROP DATABASE IF EXISTS \"${new}\";" >/dev/null 2>&1 || true
  if ! psql "$ctl" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"${new}\" TEMPLATE \"${tmpl}\";"; then
    terminate_backends "$tmpl"
    if ! psql "$ctl" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"${new}\" TEMPLATE \"${tmpl}\";"; then
      _td_err "clone ${tmpl} -> ${new} failed"; return 1
    fi
  fi
  return 0
}

# reset_and_clone_schema <schema> — fallback mode: clone source public into a
# named schema in the SAME database (DROP/CREATE SCHEMA + pg_dump + rename sed).
reset_and_clone_schema() {
  local schema src dump; schema="$(sanitize_id "$1")" || return 1
  src="$(build_source_db_url_for)"
  if ! psql "$src" -v ON_ERROR_STOP=1 -q -c \
       "DROP SCHEMA IF EXISTS \"${schema}\" CASCADE; CREATE SCHEMA \"${schema}\";"; then
    _td_err "reset schema ${schema} failed"; return 1
  fi
  dump="$(mktemp /tmp/td_dump_XXXXXX.sql)"
  if ! _td_dump_public "$dump"; then rm -f "$dump"; _td_err "pg_dump failed"; return 1; fi
  if ! grep -v "^CREATE SCHEMA " "$dump" \
       | sed "s/public\.vector/__PGVECTOR__/g" \
       | sed "s/public\./${schema}./g" \
       | sed "s/__PGVECTOR__/public.vector/g" \
       | psql "$src" -v ON_ERROR_STOP=1 -q; then
    rm -f "$dump"; _td_err "schema clone into ${schema} failed"; return 1
  fi
  rm -f "$dump"
  return 0
}

# ── boot-time catalogue seed ──────────────────────────────────────────────────
# seed_catalogue <db_or_schema_url> — reconcile the engine catalogue (idempotent).
seed_catalogue() {
  local url="$1"
  DATABASE_URL="$url" TEST_DB_ALLOW_EXIT_ON_IDLE=1 TEST_SKIP_EMBEDDINGS=1 \
    RESEND_API_KEY_DEV="" RESEND_API_KEY_PROD="" RESEND_API_KEY="re_test_dummy" \
    CRON_SECRET="${CRON_SECRET:-test-cron-secret}" \
    node --import tsx/esm -e 'import { reconcileEngines } from "./src/lib/engines/index.ts"; import { closePool } from "@workspace/db"; try { await reconcileEngines(); } finally { await closePool(); }'
}

# ── worker execution ──────────────────────────────────────────────────────────
# run_files <url> <isolation_flag> -- <node-test-args...>
# EXECs node so that, when this is backgrounded (`run_files ... &`), the captured
# $! is node's own PID — not a wrapping subshell's. That lets the sharded runner's
# signal cleanup kill the actual test process (otherwise an orphaned node would
# reconnect and block its database DROP). Callers run this as their final action.
run_files() {
  local url="$1" iso="$2"; shift 2
  [ "${1:-}" = "--" ] && shift
  local common=(--import tsx/esm)
  [ -n "$iso" ] && common+=("$iso")
  common+=(--test-concurrency=1 --test)
  exec env DATABASE_URL="$url" TEST_DB_ALLOW_EXIT_ON_IDLE=1 TEST_SKIP_EMBEDDINGS=1 \
    RESEND_API_KEY_DEV="" RESEND_API_KEY_PROD="" RESEND_API_KEY="re_test_dummy" \
    CRON_SECRET="${CRON_SECRET:-test-cron-secret}" \
    node "${common[@]}" "$@"
}

# ── cleanup ───────────────────────────────────────────────────────────────────
drop_database_if_exists() {
  local db ctl; db="$(sanitize_id "$1")" || return 0
  ctl="$(build_control_db_url_for)"
  terminate_backends "$db"
  psql "$ctl" -q -c "DROP DATABASE IF EXISTS \"${db}\";" >/dev/null 2>&1 || true
}

drop_schema_if_exists() {
  local schema src; schema="$(sanitize_id "$1")" || return 0
  src="$(build_source_db_url_for)"
  psql "$src" -q -c "DROP SCHEMA IF EXISTS \"${schema}\" CASCADE;" >/dev/null 2>&1 || true
}

# now_stamp — epoch seconds, embedded into object names so a later run can age
# them out (pg_database exposes no creation-time column).
now_stamp() { date +%s; }

# cleanup_stale_test_objects <ttl_seconds> — drop runner-owned objects whose
# embedded <stamp> is older than the TTL AND which have no active connections.
# Matches only the narrow runner prefixes; NEVER the cached `heliumdb_test`.
# Anchored name patterns. The numeric group is the epoch stamp. A name that does
# not match its exact pattern is skipped (never dropped) — `heliumdb_test` can
# never match any of these.
_TD_RE_TMPL='^heliumdb_t_([0-9]+)_[a-z0-9_]+$'
_TD_RE_WORKER='^heliumdb_w_([0-9]+)_[a-z0-9_]+_[0-9]+$'
_TD_RE_SCHEMA='^heliumdb_s_([0-9]+)_[a-z0-9_]+_[0-9]+$'

# _td_stamp_if_stale <name> <regex> <cutoff> — echo the stamp if <name> matches
# the anchored <regex> and its stamp is older than <cutoff>; else nothing.
_td_stamp_if_stale() {
  local name="$1" re="$2" cutoff="$3" stamp
  [[ "$name" =~ $re ]] || { return 1; }
  stamp="${BASH_REMATCH[1]}"
  [ "$stamp" -lt "$cutoff" ] || return 1
  printf '%s' "$stamp"
}

cleanup_stale_test_objects() {
  local ttl="${1:-86400}" ctl src now cutoff name
  ctl="$(build_control_db_url_for)"; src="$(build_source_db_url_for)"
  now="$(now_stamp)"; cutoff=$(( now - ttl ))
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    if _td_stamp_if_stale "$name" "$_TD_RE_TMPL" "$cutoff" >/dev/null \
       || _td_stamp_if_stale "$name" "$_TD_RE_WORKER" "$cutoff" >/dev/null; then
      if has_active_connections "$name"; then
        _td_log "stale sweep: skipping active database ${name}"; continue
      fi
      _td_log "stale sweep: dropping database ${name}"
      drop_database_if_exists "$name"
    fi
  done < <(psql "$ctl" -tAc \
    "SELECT datname FROM pg_database
     WHERE datname LIKE 'heliumdb_t_%' OR datname LIKE 'heliumdb_w_%';" 2>/dev/null)
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    if _td_stamp_if_stale "$name" "$_TD_RE_SCHEMA" "$cutoff" >/dev/null; then
      _td_log "stale sweep: dropping schema ${name}"
      drop_schema_if_exists "$name"
    fi
  done < <(psql "$src" -tAc \
    "SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'heliumdb_s_%';" 2>/dev/null)
}

# ── self-check (no database access) ───────────────────────────────────────────
_td_self_check() {
  local fail=0
  export DATABASE_URL="postgres://user:secretpw@db.example.com:5432/overhype_test?sslmode=require"

  [ "$(sanitize_id 'Foo-Bar/Baz')" = "foo_bar_baz" ] || { echo "FAIL sanitize basic"; fail=1; }
  local long; long="$(sanitize_id "$(printf 'a%.0s' {1..200})")"
  [ "${#long}" -le 63 ] || { echo "FAIL sanitize 63-byte cap (${#long})"; fail=1; }
  if sanitize_id '///' >/dev/null 2>&1; then echo "FAIL sanitize should reject empty"; fail=1; fi

  local ctl src dbu schu
  ctl="$(build_control_db_url_for)"; src="$(build_source_db_url_for)"
  dbu="$(build_db_url_for 'heliumdb_w_1')"; schu="$(build_schema_url_for 'heliumdb_test')"
  case "$ctl" in */postgres*) ;; *) echo "FAIL control url not on postgres db"; fail=1 ;; esac
  case "$src" in */overhype_test*) ;; *) echo "FAIL source url dbname"; fail=1 ;; esac
  case "$dbu" in *heliumdb_w_1*) ;; *) echo "FAIL build_db_url_for path"; fail=1 ;; esac
  case "$schu" in *search_path*heliumdb_test*) ;; *) echo "FAIL schema url search_path"; fail=1 ;; esac
  case "$ctl" in *sslmode=require*) ;; *) echo "FAIL control url dropped sslmode"; fail=1 ;; esac

  case "$(redact_url "$DATABASE_URL")" in *secretpw*) echo "FAIL redact leaked password"; fail=1 ;; esac

  ( NODE_ENV=production assert_not_production ) 2>/dev/null && { echo "FAIL guard NODE_ENV=production"; fail=1; }
  ( NODE_ENV=Production assert_not_production ) 2>/dev/null && { echo "FAIL guard NODE_ENV=Production (case)"; fail=1; }
  ( export DATABASE_URL="postgres://u:p@h/heliumdb"; assert_not_production ) 2>/dev/null && { echo "FAIL guard heliumdb (prod/dev)"; fail=1; }
  ( export DATABASE_URL="postgres://u:p@h/overhype_prod"; assert_not_production ) 2>/dev/null && { echo "FAIL guard prod dbname"; fail=1; }
  ( export DATABASE_URL="postgres://u:p@h/heliumdb_test"; assert_not_production ) 2>/dev/null || { echo "FAIL guard blocked heliumdb_test"; fail=1; }
  assert_not_production 2>/dev/null || { echo "FAIL guard blocked a legit test db"; fail=1; }

  # Production is `neondb` on Neon — a different database on a different
  # provider from dev's `heliumdb`. Both the name and the host must refuse
  # INDEPENDENTLY: the name check alone would miss a renamed prod database,
  # and the host check alone would miss a Neon database reached through a
  # proxy/alias hostname. Asserting them separately (not just the realistic
  # URL that trips both) is what keeps one silently regressing behind the
  # other.
  ( export DATABASE_URL="postgres://u:p@some-host/neondb"; assert_not_production ) 2>/dev/null && { echo "FAIL guard neondb by name"; fail=1; }
  ( export DATABASE_URL="postgres://u:p@ep-x-y.us-east-1.aws.neon.tech/anything"; assert_not_production ) 2>/dev/null && { echo "FAIL guard neon.tech by host"; fail=1; }
  ( export DATABASE_URL="postgresql://neondb_owner:p@ep-x-y.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require"; assert_not_production ) 2>/dev/null && { echo "FAIL guard real prod URL shape"; fail=1; }
  # The name match stays EXACT, so a test database that merely starts with the
  # protected name is still allowed — same property that keeps heliumdb_test
  # and the heliumdb_t_*/heliumdb_w_* clones working.
  ( export DATABASE_URL="postgres://u:p@h/neondb_test"; assert_not_production ) 2>/dev/null || { echo "FAIL guard blocked neondb_test"; fail=1; }

  if [ "$fail" -eq 0 ]; then echo "[test-db] self-check: PASS"; else echo "[test-db] self-check: FAIL"; fi
  return "$fail"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--self-check" ]; then
  _td_self_check
  exit $?
fi
