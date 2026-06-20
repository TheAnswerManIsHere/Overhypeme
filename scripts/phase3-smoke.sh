#!/usr/bin/env bash
# phase3-smoke.sh — single-shot verification that Phase 3 is healthy.
#
# Runs in three layers, escalating from cheap to slow:
#   1. Drizzle migration journal + snapshot consistency  (~1s)
#   2. Full repo type checking                           (~30s)
#   3. lib/db migrate suite                              (~1s)
#   4. api-server integration tests                      (~30s, hits Postgres)
#   5. overhype-me unit tests (vitest, 195+ cases)       (~6s)
#
# Each step prints its own header. The script exits non-zero on the first
# failure so a fast feedback loop is preserved.
#
# Run from the repo root:  bash scripts/phase3-smoke.sh
#
# Prereqs (Replit / dev-env):
#   - pnpm install has been run at least once
#   - DATABASE_URL points at a Postgres with the migrations applied (or a
#     fresh DB; the migrate test will apply them).
#
# Add  --skip-server  to skip the api-server integration tests (useful when
# you don't have a Postgres handy).

set -uo pipefail

SKIP_SERVER=0
for arg in "$@"; do
  case "$arg" in
    --skip-server) SKIP_SERVER=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0

step() {
  local label="$1"; shift
  echo
  echo "──────────────────────────────────────────────────────────────────"
  echo "▶ $label"
  echo "──────────────────────────────────────────────────────────────────"
  if "$@"; then
    echo "✓ $label"
    PASS=$((PASS+1))
  else
    echo "✗ $label" >&2
    FAIL=$((FAIL+1))
    return 1
  fi
}

# Build lib types so cross-package imports resolve in subsequent steps.
step "lib type build (pnpm typecheck:libs)" \
  pnpm typecheck:libs

# Phase 3 → 5 transition: confirm the studio mounts the NEW builder, not the
# legacy file. A simple static grep — if someone reverts the wiring this
# fails fast, before any expensive layer runs.
step "studio mounts new MemeBuilder (static wiring check)" \
  bash -c '
    set -e
    studio="artifacts/overhype-me/src/components/MemeStudio.tsx"
    if ! grep -q "@/components/meme-builder/MemeBuilder" "$studio"; then
      echo "FAIL: $studio is not importing the new builder (@/components/meme-builder/MemeBuilder)" >&2
      exit 1
    fi
    if grep -qE "from \"@/components/MemeBuilder\"|import\(\"@/components/MemeBuilder\"\)" "$studio"; then
      echo "FAIL: $studio still imports the legacy builder (@/components/MemeBuilder)" >&2
      exit 1
    fi
  '

step "drizzle journal + snapshot consistency" \
  pnpm --filter @workspace/db check-snapshots

step "full repo typecheck" \
  pnpm typecheck

step "lib/db migrate test" \
  pnpm --filter @workspace/db test

if [[ "$SKIP_SERVER" -eq 0 ]]; then
  # Run only the Phase-3 integration test via the run-test.sh wrapper so it
  # targets heliumdb_test (same isolation as the full pnpm test sharded runner)
  # rather than the live public schema.
  step "phase3.lineage integration test (run-test.sh)" \
    bash -c 'cd artifacts/api-server && \
      pnpm --filter @workspace/api-spec run codegen >/dev/null 2>&1 && \
      pnpm tsc -p ../../lib/api-zod/tsconfig.json >/dev/null 2>&1 && \
      BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh \
        src/__tests__/phase3.lineage.integration.test.ts'
else
  echo
  echo "  (skipped api-server integration tests — --skip-server set)"
fi

step "overhype-me unit tests (vitest)" \
  bash -c 'cd artifacts/overhype-me && pnpm test'

echo
echo "=================================================================="
echo "Summary: $PASS passed, $FAIL failed."
echo "=================================================================="
exit $FAIL
