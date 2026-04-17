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

## Project: Overhype.me

A community-driven, fully personalized facts database. Facts are stored with `{First_Name}` and `{Last_Name}` tokens and render dynamically with whatever name the user sets. Live at `/`.

**Auth**: Email is the primary user identifier — no username field. Login and registration both use email + password. Replit OAuth also supported.

### Feature Roadmap
- **Task 1 (DONE)**: Core platform — facts leaderboard, search, hashtag browsing, ratings, comments, Replit Auth, hCaptcha onboarding, seeded 15 facts, admin backend
- **Task 2 (DONE)**: AI features — duplicate detection, hashtag suggestions, spam moderation
- **Task 3 (DONE)**: Meme generator with permalink sharing — HTML5 Canvas builder, 5 gradient themes, GCS object storage upload, `memes` table, `/meme/:slug` page
- **Task 4 (DONE)**: Memberships & payments — Stripe integration, `/pricing` page, `SubscriptionPanel` in profile, Fact of the Day email job, webhooks, Stripe sync schema
- **Task 5**: Store affiliate links, Google Analytics/AdSense, "Fact of the Day" email

### Admin Interface
- Frontend: `/admin` route tree — Dashboard, Facts (bulk import), Users, Billing
- Backend: `artifacts/api-server/src/routes/admin.ts` — all routes require `requireAdmin` middleware
- **First-time setup**: Set the `ADMIN_USER_IDS` environment variable to your Replit user ID (comma-separated for multiple). Your user ID is displayed on your profile page after logging in. There is no automatic self-promotion mechanism — admin access must be explicitly granted.
- **Bulk import**: `POST /api/admin/facts/import` (JSON array) or `POST /api/admin/facts/import-csv` (CSV string)
- **Embedding backfill**: `POST /api/admin/facts/backfill-embeddings` — accepts `x-api-key` header or admin session; requires `OPENAI_API_KEY` set

### AI Duplicate Detection (pgvector)
Pure vector-based duplicate checking via pgvector cosine similarity:
- Generates 384-dim embeddings using `text-embedding-3-small` via a direct `OPENAI_API_KEY`
- Searches `facts.embedding vector(384)` with IVFFlat cosine index (threshold 0.92)
- Every new fact gets its embedding stored asynchronously after creation
- If the embedding call fails (key not set, network error) the duplicate check is skipped and the submission proceeds
- **Requires**: `OPENAI_API_KEY` set as an environment secret (direct OpenAI key — the Replit proxy does NOT support `/embeddings`)
- **Backfill existing facts**: `POST /api/admin/facts/backfill-embeddings` with `x-api-key: <ADMIN_API_KEY>` header

### Duplicate Review Workflow
When a fact is flagged as a duplicate at submission time, the user can:
1. **Submit for Review** — calls `POST /api/facts/submit-review`, stores the fact in `pending_reviews` with the matching fact ID and similarity score
2. **Force Submit** — submits with `skipDuplicateCheck: true`, bypasses the check entirely

Admin review panel at `/admin/reviews`:
- Lists all pending/approved/rejected reviews
- Side-by-side comparison of submitted fact vs flagged duplicate
- Admin can approve (inserts the fact to DB, notifies user) or reject (notifies user)
- Optional admin note is sent to the user via email and activity feed

### Activity Feed
Every logged-in user has a personal activity feed at `/activity`:
- Tracks: fact submissions, review submissions, review approvals/rejections, comments, votes, system messages
- Stored in the `activity_feed` table; unread count shown in navbar
- `POST /api/activity-feed/mark-read` marks all as read

### AI Video Generation (fal.ai)
The app supports animating meme images into short videos using fal.ai's Kling image-to-video model:
- **Endpoint**: `POST /api/videos/generate` — accepts `{ imageUrl, factId }` or `{ imageBase64, factId }`; returns `{ videoUrl }`
- **API key**: `FAL_AI_API_KEY` must be set as a Replit secret (never sent to the browser)
- If `FAL_AI_API_KEY` is not set, the endpoint returns 503 with a clear error message
- If `imageBase64` is provided instead of a URL, the backend uploads it to fal.ai storage and gets a public URL before calling the model
- **UI surfaces**: "Generate Video" button on meme permalink pages (`/meme/:slug`) and in MemeBuilder
- **Model**: `fal-ai/kling-video/v2.6/standard/image-to-video` — 5-second clips, 16:9 aspect ratio
- Route ordering matters: `videosRouter` must come before `importRouter` in `routes/index.ts` because `importRouter` applies global `requireApiKey` middleware that would intercept unmatched routes
- Route ordering matters in `memes.ts`: specific routes like `/memes/ai-user/image` must be registered BEFORE wildcard routes like `/memes/:slug/image`, otherwise the wildcard captures the specific path first

### Error Reporting (Sentry)
End-to-end error monitoring for backend (Node/Express) and frontend (React).
- **Backend init**: `artifacts/api-server/src/instrument.ts` (imported as the very first line of `src/index.ts` so OpenTelemetry can patch http/express/pg before they load). Per-request user-id is attached via `Sentry.getIsolationScope().setUser({id})` middleware in `app.ts` so concurrent requests don't leak user context. `Sentry.setupExpressErrorHandler` runs after all routes; a JSON-only fallback handler returns `{error, eventId}` instead of HTML stack traces.
- **Frontend init**: `artifacts/overhype-me/src/lib/sentry.ts` (imported first in `main.tsx`). App is wrapped in `Sentry.ErrorBoundary` with the branded `SentryFallback` component. User id is synced from `useAuth()` in `AuthProfileSync`. `tracePropagationTargets` is restricted to `/api/` to keep distributed-tracing headers off third-party fetches (Stripe, fal.ai, Resend).
- **PII off everywhere**: `sendDefaultPii: false`; `beforeSend` strips cookies, `Authorization`/`Cookie` headers, and filters `password`/`token`/`email`/`secret` from request bodies. Only the user `id` (UUID, not PII) is attached.
- **Sample rates**: traces 10% in production, 100% in development. Sentry init is a documented no-op when DSN is unset, so missing secrets disable reporting cleanly.
- **Source maps**: `build.mjs` (esbuild) and `vite.config.ts` add `sentryEsbuildPlugin` / `sentryVitePlugin` gated on `SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT_*`. Maps are uploaded to Sentry then deleted (`filesToDeleteAfterUpload`) so they're never served to end users. Note: `@opentelemetry/*` is intentionally bundled (not externalized) in the API build because @sentry/node depends on it transitively and pnpm's virtual store isn't reachable from `dist/` at runtime. `@workspace/db` declares `@opentelemetry/api` as a direct dep so the same drizzle-orm variant is shared with the API server.
- **Required env vars**: `SENTRY_DSN_BACKEND`, `VITE_SENTRY_DSN` (runtime); `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT_BACKEND`, `SENTRY_PROJECT_FRONTEND` (build-time, source-map upload). Release version comes from `REPLIT_DEPLOYMENT_ID` or `REPLIT_GIT_COMMIT_SHA`.

### Email Notifications (Resend)
Resend is integrated via `artifacts/api-server/src/lib/email.ts`:
- Requires `RESEND_API_KEY` secret; `RESEND_FROM_EMAIL` env var overrides sender (default: `noreply@overhype.me`)
- When key is not set, emails are logged to stdout (graceful dev fallback)
- Emails sent: email verification, email change confirmation, password reset, review approved/rejected

### Auth Strategy
- **Dual auth**: Replit OIDC + local username/password login
- Replit OIDC login opens in a popup window (fixes iframe cross-origin issues), callback closes popup and refreshes opener
- Local auth: `POST /api/auth/register` (username, password, optional email), `POST /api/auth/local-login` (username, password) — uses bcryptjs hashing
- Login page at `/login` with both options
- Users table has `username` (unique, varchar 50) and `password_hash` columns
- Frontend: `useAuth()` from `@workspace/replit-auth-web` for session state; Navbar links to `/login` page
- Auth middleware in `artifacts/api-server/src/app.ts`
- Local auth routes in `artifacts/api-server/src/routes/localAuth.ts`
- **Never** use generated API client hooks for auth — always use `useAuth()` from the lib

### API Proxy
- API server runs on its own PORT (default 8080)
- Vite proxies `/api` → API server (see `artifacts/overhype-me/vite.config.ts`)
- In app code: always use relative `/api/...` paths (Vite handles the proxy)

### Database Schema (lib/db/src/schema/)
- `users` — Replit user profiles synced on login
- `sessions` — express-session store
- `facts` — user-submitted facts with upvotes/downvotes/score; `embedding vector(384)` column + IVFFlat cosine index for semantic duplicate detection (populated when `OPENAI_API_KEY` is set)
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
│   └── overhype-me/          # React+Vite frontend — @workspace/overhype-me (dark theme, orange accents)
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
