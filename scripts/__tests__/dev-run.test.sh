#!/usr/bin/env bash
# Regression tests for artifacts/api-server/scripts/dev-run.sh.
#
# Verifies that dev-run.sh uses tsx watch-mode source execution rather than
# the full esbuild bundle path, ensuring dev restarts stay well under 1s.
# (Task #444)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV_RUN="${REPO_ROOT}/artifacts/api-server/scripts/dev-run.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Test 1: dev-run.sh contains an exec to tsx in watch mode, not pnpm run build
# ---------------------------------------------------------------------------
echo "test: dev-run.sh uses tsx watch, not esbuild"

if ! grep -qE "tsx\s+watch" "${DEV_RUN}"; then
  fail "dev-run.sh does not contain 'tsx watch' — watch-mode source execution is missing"
fi

if grep -v '^\s*#' "${DEV_RUN}" | grep -q "pnpm run build"; then
  fail "dev-run.sh still calls 'pnpm run build' — esbuild rebuild is still on the dev hot path"
fi

if grep -q "need_build" "${DEV_RUN}"; then
  fail "dev-run.sh still contains mtime-based build-skip logic — stale code not removed"
fi

echo "  ok"

# ---------------------------------------------------------------------------
# Test 2: dev-run.sh is executable
# ---------------------------------------------------------------------------
echo "test: dev-run.sh is executable"

if [ ! -x "${DEV_RUN}" ]; then
  fail "dev-run.sh is not executable"
fi

echo "  ok"

# ---------------------------------------------------------------------------
# Test 3: dev-run.sh sets NODE_ENV=development
# ---------------------------------------------------------------------------
echo "test: dev-run.sh exports NODE_ENV=development"

if ! grep -q 'NODE_ENV.*development' "${DEV_RUN}"; then
  fail "dev-run.sh does not set NODE_ENV=development"
fi

echo "  ok"

echo "PASS: dev-run regression tests"
