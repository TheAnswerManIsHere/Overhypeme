# Overhype Me — Crash-Loop Handoff

**Last updated:** 2026-07-07 23:36  
**Project:** `artifacts/overhype-me` (Chuck Norris-style facts app)  
**Repo:** pnpm monorepo — frontend at `artifacts/overhype-me/`, API at `artifacts/api-server/`

---

## Current Status

The app still shows **"Something Broke"** (Sentry error boundary) immediately after every Vite WebSocket reconnect. The infinite reload loop is gone, but the underlying error that triggers the boundary has not been identified yet.

---

## What Has Been Fixed (All Committed)

### 1. Button-in-button nesting (commit `aff956ca`)
`artifacts/overhype-me/src/components/layout/Navbar.tsx` — `<UserAvatar>` (itself a `<button>`) was nested inside another `<button>`. Invalid HTML caused Chrome to crash the renderer. Fixed by removing the outer wrapper.

### 2. Duplicate `POST /api/route-stats` handler
`artifacts/api-server/src/routes/admin.ts` registered a `{ counts: {...} }` handler for the same route *first*, shadowing the `{ route: string }` handler in `routeStats.ts`. Every per-visit analytics post returned 400 silently. Fix: consolidated both payload shapes into `routeStats.ts`, deleted the dead handler in `admin.ts`, unified the route-key allowlist (added `onboard`, `login`). 14 API tests pass; live curls confirm 204 / 200 / 400.

### 3. `lazyWithRetry` — infinite reload loop broken
`artifacts/overhype-me/src/lib/lazy-retry.ts` called `window.location.reload()` with no exit condition. Fixed with a 10-second sessionStorage timestamp guard — at most one reload per 10-second window. If the cooldown is active and imports still fail, the promise is *rejected* (propagating to `Sentry.ErrorBoundary`) instead of looping. 805/805 frontend tests pass.

---

## The Remaining Problem

### Symptom
Every time the Vite WebSocket drops and reconnects, the Sentry ErrorBoundary fires ~872ms later. The user sees **"Something Broke"** and must click "Reload Page."

### What the logs show
```
# Browser console — repeating pattern every time Vite reconnects:
[vite] server connection lost. Polling for restart...
[vite] connecting...
[vite] connected.
# ~872ms later:
React ErrorBoundary: error = {}    ← Error with non-enumerable message/stack
```

The two previous error objects captured:
- `{}` — standard Error, message/stack non-enumerable (can't read via `%o`)
- `{"cause":{"name":"React ErrorBoundary SyntaxError"}}` — a SyntaxError caught and re-wrapped

### What is NOT the cause
- **The Vite process is not crashing.** `ps aux` confirms PID 312 has been running since 22:04 — same process, no restarts. The "server connection lost" is the *proxy WebSocket* dropping (Replit's canvas iframe proxy), not a Vite server exit.
- **Not a Vite full-reload.** There are no `[vite] page reload` or `full-reload` messages.
- **Not the route-stats API.** Those now return 204/200 correctly.

### Most likely cause (not yet confirmed)
The proxy WebSocket drop causes Vite's HMR client to reconnect. On reconnect, Vite may invalidate modules and attempt to re-fetch lazy-loaded route chunks. The chunk fetch fails (stale URL or brief 404 during the reconnect window). `lazyWithRetry`:
1. Catches the failure, waits 400ms, retries — still fails
2. Checks the sessionStorage timestamp — if < 10s since last reload → calls `reject(err)`
3. React's `Suspense` propagates the rejection to the Sentry `ErrorBoundary`
4. "Something Broke" screen appears

The 872ms timing (400ms delay + retry + async overhead) is consistent with this path.

**Alternative:** The `@replit/vite-plugin-runtime-error-modal` plugin (injected into every page) listens for `window` `error` and `unhandledrejection` events and sends them to the Vite server, which sends back a `type: "error"` HMR message. It's possible the plugin is intercepting the rejected lazy promise (before React handles it) and triggering something that causes the error boundary.

---

## Recommended Next Steps

### Step 1 — Identify the exact error (required before anything else)

Add `onError` to `Sentry.ErrorBoundary` in `artifacts/overhype-me/src/App.tsx`:

```tsx
<Sentry.ErrorBoundary
  onError={(error, componentStack, eventId) => {
    console.error("[ErrorBoundary caught]", error, componentStack);
  }}
  fallback={({ resetError }) => <SentryFallback resetError={resetError} />}
>
```

Reproduce the error (wait for a Vite reconnect or trigger one by saving a file), then read the browser console logs to get the actual error message and stack trace. This will tell you definitively whether it's from `lazyWithRetry` or something else.

### Step 2a — If confirmed as `lazyWithRetry` rejection

Change the `reject(err)` fallback to leave the promise **unsettled** (showing Suspense loading state) instead of propagating to the error boundary. Users see a brief blank loading state rather than "Something Broke":

```ts
// In lazy-retry.ts, replace:
reject(err);

// With:
// Leave unsettled — Suspense keeps showing its fallback (blank loading state).
// The user can manually refresh; no error boundary is shown.
// (The cooldown prevents a new reload from firing for 10s.)
```

The downside: if Vite never recovers, the user sees a blank page forever. Mitigate by adding a visible "Having trouble? Click to reload" link inside the Suspense fallback in `App.tsx`:

```tsx
<Suspense fallback={<ChunkLoadingFallback />}>
```

Where `ChunkLoadingFallback` shows a spinner for 3s then surfaces a reload button.

### Step 2b — If NOT from `lazyWithRetry`

Disable `runtimeErrorOverlay()` temporarily in `artifacts/overhype-me/vite.config.ts` to rule out the `@replit/vite-plugin-runtime-error-modal` plugin:

```ts
// Comment this out temporarily:
// runtimeErrorOverlay(),
```

If the error boundary stops firing, the plugin is intercepting something and sending it back as a Vite `type: "error"` message that somehow triggers a React error.

### Step 3 — Address the proxy WebSocket instability (root trigger)

The WebSocket drops appear to be caused by resource pressure from running tests. The `sentry-tests` workflow (vitest) consumes 121% CPU when running, causing the Replit proxy to drop connections. Two canvas iframes loading the same app simultaneously doubles the pressure.

- Don't run `sentry-tests` while the canvas preview is open
- Consider removing one of the two canvas iframes for the same app (canvas has both `artifact:v3:artifacts/chuck-norris-facts` and `artifact:v3:default-artifacts-overhype-me-web` pointing to the same Vite server)

---

## Key Files

| File | Status | Notes |
|------|--------|-------|
| `artifacts/overhype-me/src/lib/lazy-retry.ts` | **Modified** | 10s cooldown guard in place; `reject(err)` path is likely causing the boundary |
| `artifacts/overhype-me/src/App.tsx` | Unchanged | Add `onError` to `Sentry.ErrorBoundary` to capture real error |
| `artifacts/overhype-me/vite.config.ts` | Unchanged | Has `noDiscovery: true` (prevents thread panic); `runtimeErrorOverlay()` plugin suspect |
| `artifacts/api-server/src/routes/routeStats.ts` | **Modified** | Both payload shapes handled; working |
| `artifacts/api-server/src/routes/admin.ts` | **Modified** | Dead `POST /route-stats` handler removed |
| `artifacts/api-server/src/__tests__/routes.routeStats.test.ts` | **Modified** | 14 tests, all pass |
| `artifacts/overhype-me/src/__tests__/lazyWithRetry.test.ts` | **Modified** | 4 tests including new cooldown-guard test; all pass |

---

## Diagnostic Commands

```bash
# Check Vite process is still alive (should be same PID as at startup):
ps aux | grep vite | grep -v grep

# Get the actual error message — after adding onError to Sentry.ErrorBoundary,
# trigger a reconnect by saving any file, then run:
# refresh_all_logs (tool) and read the browser_console log file

# Confirm route-stats endpoint works:
D=$REPLIT_DEV_DOMAIN
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://$D/api/route-stats" \
  -H 'Content-Type: application/json' -d '{"route":"home"}'          # 204
curl -s -X POST "https://$D/api/route-stats" \
  -H 'Content-Type: application/json' -d '{"counts":{"home":1}}'     # {"accepted":1}

# Run route-stats tests (detached — foreground gets killed):
cd artifacts/api-server
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test src/__tests__/routes.routeStats.test.ts

# Run all frontend tests (via workflow, ~2 min):
# restart_workflow "sentry-tests"  ← but don't do this while canvas preview is open
```

---

## Environment Notes

- **Monorepo:** pnpm workspaces. Frontend: `@workspace/overhype-me`. API: `@workspace/api-server`. DB: `@workspace/db`.
- **Database:** PostgreSQL via Drizzle ORM. Migrations in `lib/db/src/migrations/`.
- **Auth:** Cookie-based sessions. Bearer token in localStorage is a legacy fallback — middleware checks cookie first if Bearer is stale.
- **Stripe:** Integration installed, test mode. Webhook stale in dev (benign).
- **Sentry:** `VITE_SENTRY_DSN` env var. `tracesSampleRate: 1.0` in dev.
- **Long test suites:** Foreground `pnpm test | tail` gets killed. Run Node test files detached + poll; run Vitest via the `sentry-tests` workflow.
- **OpenAI:** Uses direct `OPENAI_API_KEY`. Do NOT add a Replit AI proxy fallback.
- **Two canvas iframes:** Both `artifact:v3:artifacts/chuck-norris-facts` and `artifact:v3:default-artifacts-overhype-me-web` point to the same Vite server, doubling WebSocket connections and resource pressure.
