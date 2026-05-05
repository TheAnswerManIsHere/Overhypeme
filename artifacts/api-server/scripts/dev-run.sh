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

ARTIFACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ARTIFACT_DIR}"

exec pnpm exec tsx watch src/index.ts
