#!/usr/bin/env bash
# dev-run.sh — supervised dev entrypoint for @workspace/api-server.
#
# Skips the esbuild bundle step when dist/index.mjs is already newer than
# every source file under src/, then exec()s the start command. Saves ~1.5s
# per restart in the supervisor crash-loop scenario, which gives the
# wait-for-port-free poll more headroom inside the rolling-window crash
# budget.

set -eu

export NODE_ENV="${NODE_ENV:-development}"

ARTIFACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ARTIFACT_DIR}"

DIST="dist/index.mjs"
need_build=0
if [ ! -f "${DIST}" ]; then
  need_build=1
elif [ -n "$(find src -type f -newer "${DIST}" -print -quit 2>/dev/null)" ]; then
  need_build=1
elif [ -f build.mjs ] && [ "build.mjs" -nt "${DIST}" ]; then
  need_build=1
elif [ -f package.json ] && [ "package.json" -nt "${DIST}" ]; then
  need_build=1
fi

if [ "${need_build}" = "1" ]; then
  echo "[api-server:dev-run] sources changed since last build — running pnpm run build"
  pnpm run build
else
  echo "[api-server:dev-run] dist/index.mjs is up to date — skipping build"
fi

exec pnpm run start
