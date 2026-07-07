# Overhype Me — Crash-Loop Handoff

**Date:** 2026-07-07  
**Project:** `artifacts/overhype-me` (Chuck Norris-style facts app)  
**Repo:** pnpm monorepo — frontend at `artifacts/overhype-me/`, API at `artifacts/api-server/`

---

## Current Status

The canvas preview iframe is stuck in a crash/reload loop — the Vite WebSocket reconnects every ~1–2 seconds. **The root cause is identified but not yet fixed.**

---

## Root Cause (Confirmed)

### The Loop Mechanism

The app uses a custom `lazyWithRetry` wrapper around `React.lazy` for **every** route:

**`artifacts/overhype-me/src/lib/lazy-retry.ts`**

```ts
export function lazyWithRetry<T>(factory) {
  return lazy(() =>
    factory().catch(() =>
      new Promise((resolve) => {
        setTimeout(() => {
          factory()
            .then(resolve)
            .catch(() => {
              window.location.reload();   // <-- THE LOOP
            });
        }, 400);
      })
    )
  );
}
```

**`artifacts/overhype-me/src/App.tsx` line 2:**
```ts
import { lazyWithRetry as lazy } from "@/lib/lazy-retry";
```
Every route (`Home`, `Search`, `FactDetail`, `Login`, etc.) is wrapped in this.

### The Trigger

The browser console log (captured during the live loop) shows:
```
[vite] server connection lost. Polling for restart...
```
The Vite dev server is **periodically crashing and restarting**. When it restarts, all existing JS chunk URLs (e.g. `/src/pages/Home.tsx?t=1234`) become stale/404.

### The Loop Chain

1. Vite restarts → old chunk URLs 404
2. A lazy-loaded route's `import()` fails
3. `lazyWithRetry` waits 400ms, retries — still fails (Vite not yet stable)
4. `window.location.reload()` is called
5. Page reloads, tries to load the same lazy route → still stale → fails again → step 3
6. **Infinite loop at ~1.3s cadence** (400ms wait + reload overhead)

There is **no guard** in `lazyWithRetry` to stop reloading if the page was already reloaded for this reason.

### Why Vite Itself Is Crashing

This is still unknown. The `artifacts/overhype-me: web` workflow is marked RUNNING but produces no new log output — the log file stopped updating at 22:39 (earlier HMR edits). Possible causes to investigate:
- Memory pressure / OOM in the Vite/Node process
- File watcher hitting OS limits (too many inotify watches in a large monorepo)
- The dev-supervisor script (`scripts/dev-supervisor.sh`) silently restarting it
- A file change triggering a full Vite restart (check `vite.config.ts` for watched files)

---

## The Fix Needed

### Fix 1 — Break the reload loop in `lazyWithRetry` (high priority)

Add a `sessionStorage` guard so a single chunk never triggers more than one full-page reload per session:

```ts
import { lazy } from "react";

export function lazyWithRetry<T extends React.ComponentType<object>>(
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch(
      () =>
        new Promise<{ default: T }>((resolve) => {
          setTimeout(() => {
            factory()
              .then(resolve)
              .catch(() => {
                const key = `lazy-reload:${factory.toString().slice(0, 80)}`;
                if (!sessionStorage.getItem(key)) {
                  sessionStorage.setItem(key, "1");
                  window.location.reload();
                }
                // If already reloaded, leave the promise unsettled so
                // the Suspense boundary stays open rather than looping.
              });
          }, 400);
        }),
    ),
  );
}
```

This caps the loop at **one reload per route per session** instead of infinite.

### Fix 2 — Investigate why Vite restarts (medium priority)

Check:
- `artifacts/overhype-me/vite.config.ts` — look for `server.watch` settings or anything that could cause self-invalidation
- `scripts/dev-supervisor.sh` — understand the crash threshold / restart policy
- Run the overhype-me workflow in isolation and watch for OOM kills or file-watcher errors in stderr
- Try setting `server.hmr: { overlay: false }` and `server.watch: { usePolling: false }` in vite config

---

## What Was Fixed This Session (Committed)

These are done — don't redo them.

### 1. Button-in-button nesting (commit `aff956ca`)

**File:** `artifacts/overhype-me/src/components/layout/Navbar.tsx`  
The `<UserAvatar>` was rendered inside a `<button>`, and `<UserAvatar>` itself rendered a `<button>`. Invalid HTML — Chrome would crash the renderer. Fixed by removing the outer button wrapper.

### 2. Duplicate POST `/api/route-stats` handler (latest commit)

**Problem:** Two Express handlers registered for the same route:
- `artifacts/api-server/src/routes/admin.ts` → handled `{ counts: {...} }` shape, registered **first** in `routes/index.ts`
- `artifacts/api-server/src/routes/routeStats.ts` → handled `{ route: string }` shape, but was **shadowed**

Result: every per-visit post from the frontend returned 400 silently for months.

**Fix:** Consolidated both shapes into `routeStats.ts`, deleted the duplicate handler from `admin.ts`. Also fixed the allowlist — `onboard` and `login` were accepted by the frontend's `normalizePathToRouteKey` but rejected by the server.

**Verified:** 14/14 tests pass, live curl confirms 204 / 200 / 400 responses as expected.

---

## Key Files

| File | Purpose |
|------|---------|
| `artifacts/overhype-me/src/lib/lazy-retry.ts` | **Root cause** — the reload loop lives here |
| `artifacts/overhype-me/src/App.tsx` | Every route uses `lazyWithRetry` |
| `artifacts/overhype-me/vite.config.ts` | Check for watch/HMR config causing Vite restarts |
| `scripts/dev-supervisor.sh` | Manages process restart policy for all workflows |
| `artifacts/api-server/src/routes/routeStats.ts` | Fixed POST handler (both shapes) |
| `artifacts/api-server/src/routes/admin.ts` | Duplicate handler removed |
| `artifacts/api-server/src/__tests__/routes.routeStats.test.ts` | 14 tests covering both payload shapes |

---

## Diagnostic Commands

```bash
# Watch the live loop in real time (api-server logs)
# Look for repeating GET /api/auth/user + GET /api/users/me pairs every ~1-2s

# Check if overhype-me Vite server is actually crashing
# The workflow shows RUNNING but produces no new log — check the actual process:
ps aux | grep vite

# Confirm the endpoint is working correctly now
D=$REPLIT_DEV_DOMAIN
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://$D/api/route-stats" \
  -H 'Content-Type: application/json' -d '{"route":"home"}'          # expect 204
curl -s -X POST "https://$D/api/route-stats" \
  -H 'Content-Type: application/json' -d '{"counts":{"home":1}}'     # expect {"accepted":1}

# Run the route-stats tests (single-file, detached — foreground gets killed)
cd artifacts/api-server
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test src/__tests__/routes.routeStats.test.ts
```

---

## Environment Notes

- **Monorepo:** pnpm workspaces. Frontend: `@workspace/overhype-me`. API: `@workspace/api-server`. DB: `@workspace/db`.
- **Database:** PostgreSQL via Drizzle ORM. Migrations in `lib/db/src/migrations/`.
- **Auth:** Cookie-based sessions. Bearer token in localStorage is a legacy fallback — middleware checks cookie first if Bearer is stale.
- **Stripe:** Integration installed, test mode. Webhook may be stale (last event >1769h old — benign in dev).
- **Sentry:** Configured via `VITE_SENTRY_DSN`. In dev, `tracesSampleRate: 1.0`.
- **Long test suites:** Foreground `pnpm test | tail` gets killed. Run Node test files detached + poll; run Vitest via the `sentry-tests` workflow (note: that workflow has a pre-existing failure unrelated to this issue — `vmThreads` config).
- **OpenAI:** Uses direct `OPENAI_API_KEY` env var — do NOT add a Replit AI proxy fallback.
