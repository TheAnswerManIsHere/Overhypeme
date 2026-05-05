#!/usr/bin/env bash
# Full typecheck pipeline. Always does a clean rebuild of declaration files
# by removing tsbuildinfo caches first — prevents stale dist/index.d.ts from
# causing spurious "not a module" errors in the api-server typecheck.
set -euo pipefail

pnpm --filter @workspace/api-spec run codegen

# Force tsc to recompile from source by removing incremental cache files.
# With composite:true, tsc trusts tsbuildinfo and skips recompilation if it
# thinks outputs are current — even when they are stale or empty.
rm -f \
  lib/api-zod/tsconfig.tsbuildinfo \
  lib/api-client-react/tsconfig.tsbuildinfo \
  lib/replit-auth-web/tsconfig.tsbuildinfo

pnpm tsc -p lib/api-zod/tsconfig.json
pnpm tsc -p lib/api-client-react/tsconfig.json
pnpm --filter @workspace/db run typecheck
pnpm --filter @workspace/api-server run typecheck
