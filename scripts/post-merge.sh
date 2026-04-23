#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm tsc -p lib/api-zod/tsconfig.json
pnpm tsc -p lib/api-client-react/tsconfig.json
pnpm tsc -p lib/replit-auth-web/tsconfig.json
pnpm --filter './lib/**' --if-present run build
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/scripts run seed
