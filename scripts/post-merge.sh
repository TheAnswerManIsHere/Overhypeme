#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen

# Guard: task agents sometimes add `export * from "./generated/types"` to
# api-zod/src/index.ts, which creates duplicate-export errors because
# generated/api.ts already re-exports everything from generated/types/.
# Restore the canonical form if the problematic line is present.
INDEX="lib/api-zod/src/index.ts"
if grep -q 'export \* from "./generated/types"' "$INDEX"; then
  echo "Fixing duplicate export in $INDEX..."
  cat > "$INDEX" << 'EOF'
export * from "./generated/api";
export type { AuthUser } from "./generated/types/authUser";
export {
  type MemeAspectRatio,
  MEME_ASPECT_RATIOS,
  TEMPLATE_RENDER_SCALE,
  DEFAULT_MEME_ASPECT_RATIO,
} from "./memeAspectRatios";
EOF
fi

# Guard: orval v8.5.3 sometimes emits an empty api.ts for api-client-react
# (TS2306 "not a module" when anything re-exports it).  If the file is empty
# after codegen, restore it from the most-recent git commit that had content.
API_TS="lib/api-client-react/src/generated/api.ts"
if [ ! -s "$API_TS" ]; then
  echo "WARNING: $API_TS is empty after codegen — restoring from git history..."
  RESTORE_HASH=""
  while IFS= read -r hash; do
    byte_count=$(git show "$hash":"$API_TS" 2>/dev/null | wc -c)
    if [ "$byte_count" -gt 100 ]; then
      RESTORE_HASH="$hash"
      break
    fi
  done < <(git log --format="%H" -- "$API_TS")

  if [ -n "$RESTORE_HASH" ]; then
    git show "$RESTORE_HASH":"$API_TS" > "$API_TS"
    echo "Restored $API_TS from $RESTORE_HASH ($(wc -l < "$API_TS") lines)"
  else
    echo "ERROR: Could not find a non-empty version of $API_TS in git history"
    exit 1
  fi
fi

pnpm tsc -p lib/api-zod/tsconfig.json
pnpm tsc -p lib/api-client-react/tsconfig.json
pnpm tsc -p lib/replit-auth-web/tsconfig.json
pnpm --filter './lib/**' --if-present run build

# Explicitly rebuild the @workspace/db package so that TypeScript consumers
# (e.g. api-server) always pick up the latest schema types after a merge.
pnpm --filter @workspace/db exec tsc -p tsconfig.json

pnpm --filter @workspace/db run migrate

# Safety: drizzle-kit sometimes records a migration as applied in _journal.json
# (from a task agent environment) but never executes the SQL against the local DB.
# Apply idempotent migrations directly to guard against this.
psql "$DATABASE_URL" -f lib/db/migrations/0022_email_outbox.sql 2>&1 | grep -v "already exists" || true

pnpm --filter @workspace/scripts run seed
