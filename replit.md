# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Project: Chuck Norris Facts Community Database

A community-driven Chuck Norris facts/memes site — like IMDb but for Chuck Norris. Live at `/`.

### Feature Roadmap
- **Task 1 (DONE)**: Core platform — facts leaderboard, search, hashtag browsing, ratings, comments, Replit Auth, hCaptcha onboarding, seeded 15 facts, admin backend
- **Task 2**: AI features — duplicate detection, hashtag suggestions, spam moderation
- **Task 3**: Meme generator with permalink sharing
- **Task 4**: Memberships & payments (Stripe)
- **Task 5**: Store affiliate links, Google Analytics/AdSense, "Fact of the Day" email

### Admin Interface
- Frontend: `/admin` route tree — Dashboard, Facts (bulk import), Users, Billing
- Backend: `artifacts/api-server/src/routes/admin.ts` — all routes require `requireAdmin` middleware
- **Bootstrap (first run)**: The first authenticated user to visit `/admin` is automatically promoted to admin if no admins exist yet. Subsequent attempts return 403. You can also pre-set `ADMIN_USER_IDS=<comma-separated Replit user IDs>` as an environment variable.
- **Bulk import**: `POST /api/admin/facts/import` (JSON array) or `POST /api/admin/facts/import-csv` (CSV string)

### Auth Strategy
- Replit Auth (OIDC) only — use `@workspace/replit-auth-web`'s `useAuth()` on the frontend
- Auth middleware in `artifacts/api-server/src/app.ts`
- **Never** use generated API client hooks for auth — always use `useAuth()` from the lib

### API Proxy
- API server runs on its own PORT (default 8080)
- Vite proxies `/api` → API server (see `artifacts/chuck-norris-facts/vite.config.ts`)
- In app code: always use relative `/api/...` paths (Vite handles the proxy)

### Database Schema (lib/db/src/schema/)
- `users` — Replit user profiles synced on login
- `sessions` — express-session store
- `facts` — user-submitted facts with upvotes/downvotes/score
- `hashtags` — normalized tags with fact_count
- `fact_hashtags` — many-to-many join
- `ratings` — per-user +1/-1 votes on facts
- `comments` — threaded comments on facts
- `external_links` — affiliate/store link click tracking
- `search_history` — tracks popular search terms

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/           # Express API server (auth, facts, ratings, comments, hashtags)
│   └── chuck-norris-facts/   # React+Vite frontend (dark theme, orange accents)
├── lib/
│   ├── api-spec/             # OpenAPI spec + Orval codegen config
│   ├── api-client-react/     # Generated React Query hooks
│   ├── api-zod/              # Generated Zod schemas from OpenAPI
│   ├── db/                   # Drizzle ORM schema + DB connection
│   └── replit-auth-web/      # Replit OIDC auth hook (useAuth)
├── scripts/                  # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
