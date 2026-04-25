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

pnpm tsc -p lib/api-zod/tsconfig.json
pnpm tsc -p lib/api-client-react/tsconfig.json
pnpm tsc -p lib/replit-auth-web/tsconfig.json
pnpm --filter './lib/**' --if-present run build
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/scripts run seed
