#!/usr/bin/env bash
# dev-run.sh — supervised dev entrypoint for @workspace/api-server.
#
# Runs TypeScript source directly via `tsx watch`, which transpiles on-the-fly
# and restarts the server whenever a source file changes. This eliminates the
# full esbuild bundle step (~1.5–4s) from the hot-reload critical path and
# keeps restarts well under 1s.
#
# Production build path (`pnpm run build`) is unchanged.

set -eu

export NODE_ENV="${NODE_ENV:-development}"

# Enable the dev-admin-login backdoor for local development + the Playwright e2e
# admin flows (which authenticate via that route). It is fail-closed by default
# (lib/devAdminLogin.ts), so it must be explicitly turned on for a dev preview.
# This is safe here: production runs `pnpm start` (not this script), and even if
# it didn't, isDevAdminLoginEnabled() hard-disables it whenever REPLIT_DEPLOYMENT
# or NODE_ENV=production is set. Override to `false` to test the disabled state.
export ENABLE_DEV_ADMIN_LOGIN="${ENABLE_DEV_ADMIN_LOGIN:-true}"

ARTIFACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ARTIFACT_DIR}"

exec pnpm exec tsx watch src/index.ts
