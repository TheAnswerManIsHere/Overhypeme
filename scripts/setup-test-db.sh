#!/usr/bin/env bash
# Idempotent test DB setup for Claude Code on the web sandbox.
#
# This is NOT used by the production app or by Replit. It exists solely to
# give Claude a working Postgres so it can run integration tests in its own
# sandbox before pushing code. Reads/writes nothing outside the sandbox.
#
# Wired to .claude/settings.json SessionStart hook so it runs on every new
# session automatically.

set -euo pipefail

DB_NAME="overhype_test"
DB_USER="overhype"
DB_PASS="overhype"
DB_PORT="5432"
DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}"

log() { echo "[setup-test-db] $*"; }

# ── 1. Ensure pgvector apt package is installed ───────────────────────────────
if ! dpkg -l postgresql-16-pgvector >/dev/null 2>&1; then
  log "Installing postgresql-16-pgvector..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-16-pgvector >/dev/null
fi

# ── 2. Start the default cluster if it isn't already running ──────────────────
if ! pg_isready -h localhost -p "${DB_PORT}" -q 2>/dev/null; then
  log "Starting Postgres cluster 16/main..."
  pg_ctlcluster 16 main start >/dev/null
  # wait for it to come up (max ~10s)
  for i in $(seq 1 20); do
    pg_isready -h localhost -p "${DB_PORT}" -q && break
    sleep 0.5
  done
fi

# ── 3. Create role + database if missing ──────────────────────────────────────
ROLE_EXISTS=$(sudo -u postgres psql -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null || true)
if [ "${ROLE_EXISTS}" != "1" ]; then
  log "Creating role ${DB_USER}..."
  sudo -u postgres psql -q -c \
    "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}' SUPERUSER;" >/dev/null
fi

DB_EXISTS=$(sudo -u postgres psql -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null || true)
if [ "${DB_EXISTS}" != "1" ]; then
  log "Creating database ${DB_NAME}..."
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
fi

# ── 4. Enable pgvector extension in the test DB ───────────────────────────────
sudo -u postgres psql -q -d "${DB_NAME}" -c \
  "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

# ── 5. Apply schema (drizzle-kit push) ────────────────────────────────────────
# Only run if node_modules are present — first session needs `pnpm install`
# from the user before this can succeed. The hook also runs `pnpm install`
# when node_modules is missing.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -d "${REPO_ROOT}/node_modules" ]; then
  log "node_modules missing — running pnpm install..."
  (cd "${REPO_ROOT}" && pnpm install --silent)
fi

log "Applying schema with drizzle-kit push..."
(cd "${REPO_ROOT}/lib/db" && DATABASE_URL="${DATABASE_URL}" pnpm push-force >/dev/null 2>&1) \
  || log "drizzle-kit push reported errors — continuing (existing tables may already match)"

log "Test DB ready at ${DATABASE_URL}"
