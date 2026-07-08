# Overhype Me — Crash-Loop Handoff

**Last updated:** 2026-07-08 00:05  
**Project:** `artifacts/overhype-me` (Chuck Norris-style facts app)  
**Repo:** pnpm monorepo — frontend at `artifacts/overhype-me/`, API at `artifacts/api-server/`

---

## Current Status

**All known crashes and 403 errors are fixed.** The app has survived multiple Vite WebSocket reconnects in the current session with no error boundary and no 403s. All tests pass.

---

## What Was Fixed (All Committed, All Verified)

### 1. Button-in-button nesting (commit `aff956ca`)
`artifacts/overhype-me/src/components/layout/Navbar.tsx` — `<UserAvatar>` (itself a `<button>`) was nested inside another `<button>`. Invalid HTML caused Chrome to crash the renderer.

### 2. Duplicate `POST /api/route-stats` handler
`artifacts/api-server/src/routes/admin.ts` had a handler for the same route that shadowed the real one in `routeStats.ts`. Every per-visit analytics post had been silently returning 400 for months. Consolidated both payload shapes into `routeStats.ts`, deleted the dead handler, fixed the route-key allowlist.  
**Verified:** 14/14 route-stats tests pass.

### 3. `lazyWithRetry` — infinite reload loop broken
`artifacts/overhype-me/src/lib/lazy-retry.ts` called `window.location.reload()` with no exit condition. Added a 10-second sessionStorage timestamp guard — at most one reload per 10-second window. If within the cooldown and imports still fail, the promise rejects to the Sentry ErrorBoundary instead of looping.  
**Verified:** 805/805 frontend tests pass.

### 4. esbuild OS-thread panic — GOMAXPROCS + pre-bundling
**Root cause:** Vite's dev server (with `noDiscovery: true`) transforms heavy deps on-demand. Admin/moderation pages import `recharts` (which pulls in a forest of `d3-*` sub-packages) and `lucide-react` (thousands of icon files). Each on-demand transform spawns esbuild goroutines; a concurrent burst of these transforms at first admin-page load pushed esbuild past the container's OS thread limit. The supervisor restarted Vite before any output was written to stderr, so the panic was invisible in the workflow logs.

**Fix 1 — `artifacts/overhype-me/package.json`:**  
`GOMAXPROCS=4` → `GOMAXPROCS=2` in the `dev` script. Halves the number of OS threads Go allocates for its scheduler, reducing the ceiling before the panic threshold.

**Fix 2 — `artifacts/overhype-me/vite.config.ts`:**  
Added `recharts` and `lucide-react` to `optimizeDeps.include`. esbuild now pre-bundles them once at startup instead of in a burst on first admin-page load. Collapsing recharts into a single artifact also bundles all its `d3-*` sub-deps in one pass.  
**Observed result:** Vite startup time dropped from 2208ms → 412ms and the proxy WebSocket reconnects (which were caused by the Vite process becoming unresponsive during the esbuild burst) are no longer followed by an error boundary.

### 5. `POST /api/route-stats` CSRF race → 403 on first page load
**Root cause:** `POST /api/route-stats` is a cookie-session request (has SID cookie, no Bearer header), so the CSRF double-submit middleware in `artifacts/api-server/src/app.ts` applied to it. The CSRF cookie is issued in one middleware and validated in the next, but on the very first page load the POST fires concurrently with the first GET — before the browser has received (and stored) the `Set-Cookie` from that GET response. Result: the POST has no `csrf_token` cookie to echo back as the `x-csrf-token` header → 403 "Invalid CSRF token" on every cold load.

**Fix — `artifacts/api-server/src/app.ts`:**  
Added `/api/route-stats` to `ORIGIN_EXEMPT_PATHS`. This exempts it from both the origin-validation check and the CSRF double-submit check. This is safe: route-stats is a pure analytics endpoint that accepts only a fixed allowlist of route keys, carries no auth-sensitive mutation, and was already open to unauthenticated callers.  
**Verified:** 14/14 route-stats tests still pass after the exemption. Live POST now returns 200/204 on first load with no 403s.

---

## Key Files Changed

| File | Change |
|------|--------|
| `artifacts/overhype-me/package.json` | `GOMAXPROCS=4` → `GOMAXPROCS=2` in `dev` script |
| `artifacts/overhype-me/vite.config.ts` | Added `recharts`, `lucide-react` to `optimizeDeps.include` |
| `artifacts/overhype-me/src/lib/lazy-retry.ts` | 10s sessionStorage cooldown guard on `window.location.reload()` |
| `artifacts/overhype-me/src/components/layout/Navbar.tsx` | Removed button-in-button nesting |
| `artifacts/api-server/src/app.ts` | Added `/api/route-stats` to `ORIGIN_EXEMPT_PATHS` |
| `artifacts/api-server/src/routes/routeStats.ts` | Both payload shapes handled; working |
| `artifacts/api-server/src/routes/admin.ts` | Dead `POST /api/route-stats` handler removed |

---

## Diagnostic Commands

```bash
# Confirm route-stats endpoint works (no 403):
D=$REPLIT_DEV_DOMAIN
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://$D/api/route-stats" \
  -H 'Content-Type: application/json' -d '{"route":"home"}'          # 204
curl -s -X POST "https://$D/api/route-stats" \
  -H 'Content-Type: application/json' -d '{"counts":{"home":1}}'     # {"accepted":1}

# Run route-stats tests (must run from api-server dir):
(cd artifacts/api-server && TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test src/__tests__/routes.routeStats.test.ts)

# Run all frontend tests (via workflow — don't run while canvas preview is open):
# restart_workflow "sentry-tests"
```

---

## Environment Notes

- **Monorepo:** pnpm workspaces. Frontend: `@workspace/overhype-me`. API: `@workspace/api-server`. DB: `@workspace/db`.
- **Database:** PostgreSQL via Drizzle ORM. Migrations in `lib/db/src/migrations/`.
- **Auth:** Cookie-based sessions. Bearer token in localStorage is a legacy fallback — middleware checks cookie first if Bearer is stale.
- **Stripe:** Integration installed, test mode. Webhook stale in dev (benign).
- **Sentry:** `VITE_SENTRY_DSN` env var. `tracesSampleRate: 1.0` in dev.
- **Long test suites:** Foreground `pnpm test | tail` gets killed. Run Node test files from a subshell `(cd artifacts/api-server && node ...)` and redirect to a file; run Vitest via the `sentry-tests` workflow.
- **OpenAI:** Uses direct `OPENAI_API_KEY`. Do NOT add a Replit AI proxy fallback.
- **esbuild + noDiscovery:** `optimizeDeps.noDiscovery: true` prevents Vite from scanning all deps at startup (avoids goroutine panic). CJS packages and heavy admin deps must be listed explicitly in `optimizeDeps.include`; everything else is transformed on-demand. If new heavy deps cause crashes after admin-page visits, add them to `include`.
