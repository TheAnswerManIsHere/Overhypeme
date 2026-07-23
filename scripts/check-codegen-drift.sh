#!/usr/bin/env bash
# check-codegen-drift.sh — guard against hand-edits to codegen-owned files.
#
# The classic failure (known-failure-patterns.md → "Manual api-zod/src/index.ts
# export silently reverted by codegen"): an export added by hand to a generated
# file survives typecheck but is silently wiped by the next codegen run. This
# check reruns codegen and fails on any resulting diff, so the mistake can't
# merge — and the same command serves the CLAUDE.md local ritual after adding
# an api-zod export.
#
# Run from anywhere: pnpm run check:codegen-drift

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pnpm --filter @workspace/api-spec run codegen

if ! git diff --exit-code -- lib/; then
  echo ""
  echo "ERROR: Generated files drifted after codegen (diff above)." >&2
  echo "If you edited a generated file (e.g. lib/api-zod/src/index.ts)," >&2
  echo "register the change in lib/api-spec/patch-generated.mjs instead." >&2
  exit 1
fi

echo "check-codegen-drift: clean"
