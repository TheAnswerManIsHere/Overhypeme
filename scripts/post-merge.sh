#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/scripts run seed
