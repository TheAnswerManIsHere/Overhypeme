#!/usr/bin/env bash
# Codex cloud-environment startup script.
#
# This is the versioned copy of what Codex runs when it boots a container for
# this repo. The Codex environment's setup field should call this file
# (`bash scripts/codex-setup.sh`) rather than carrying its own inline copy, so
# the startup path is reviewable in PRs like any other code.
#
# It is NOT used by Replit, by CI, or by Claude's sandbox (that one is
# scripts/setup-test-db.sh, wired to a SessionStart hook).
#
# Design notes — see docs/ai-context/codex-environment.md for the evidence:
#   * pnpm 9 is deliberate: .github/workflows/build.yml pins
#     pnpm/action-setup@v4 to version 9, so Codex resolves the same tree CI
#     does. Do not bump this without bumping CI in the same change.
#   * --ignore-scripts is safe here. pnpm-workspace.yaml's onlyBuiltDependencies
#     (@swc/core, esbuild, msw, unrs-resolver) all resolve their native binaries
#     from platform packages at runtime, so codegen, typecheck, the production
#     build, and the frontend vitest suite all pass without postinstall.
#   * The root `prepare` lifecycle script is skipped by --ignore-scripts, which
#     is why the lib build is invoked explicitly on the last line.
#
# The DB is opt-in. Provisioning Postgres is the slow part of a cold boot, and
# most Codex work (plan review, code review, frontend and pure-logic changes)
# never touches it. Set CODEX_SETUP_DB=1 in the environment when a task needs
# the api-server integration suite, which cannot run at all without Postgres +
# pgvector.

set -euo pipefail

corepack enable
corepack prepare pnpm@9 --activate

pnpm install --frozen-lockfile --ignore-scripts

pnpm --filter @workspace/api-spec run codegen
pnpm tsc -p lib/api-zod/tsconfig.json
pnpm --filter './lib/**' --if-present run build

if [ "${CODEX_SETUP_DB:-0}" = "1" ]; then
  # Must happen here, in the setup phase: Codex disables network for the task
  # itself, so an on-demand DB bootstrap later cannot apt-get anything.
  echo "[codex-setup] CODEX_SETUP_DB=1 — provisioning test Postgres..."
  bash scripts/setup-test-db.sh
fi
