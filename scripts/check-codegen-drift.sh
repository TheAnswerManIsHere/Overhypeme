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

# `git status --porcelain`, not `git diff --exit-code`: codegen splitting out a
# brand-new generated file is untracked, not modified, so a plain diff misses
# it entirely and would let a PR merge with a generated file the checkout
# never got (Codex review, PR #236).
drift="$(git status --porcelain -- lib/)"
if [ -n "$drift" ]; then
  echo "$drift"
  echo ""
  git --no-pager diff -- lib/
  echo ""
  echo "ERROR: Generated files drifted after codegen (diff above)." >&2
  echo "If you edited a generated file (e.g. lib/api-zod/src/index.ts)," >&2
  echo "register the change in lib/api-spec/patch-generated.mjs instead." >&2
  echo "If codegen split out a new file, commit it." >&2
  exit 1
fi

echo "check-codegen-drift: clean"
