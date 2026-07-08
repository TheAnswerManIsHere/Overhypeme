# Overhype Me — Crash/Reload Loop: Root Cause Analysis & Fix

**App:** Overhype Me (Chuck Norris-style facts app), `artifacts/overhype-me` (frontend) + `artifacts/api-server` (backend)
**Symptom:** The canvas/browser preview got stuck reloading itself every ~1–2 seconds, sometimes settling into a Sentry "Something Broke" error boundary instead of the real page.
**Status:** Fixed and verified. Four distinct, independent bugs stacked on top of each other and had to be found and fixed one at a time before the loop actually stopped.

---

## TL;DR

There was no single cause. Four separate bugs combined to produce the loop:

| # | Bug | Effect |
|---|-----|--------|
| 1 | Invalid HTML: a `<button>` nested inside another `<button>` | Crashed the React renderer on the nav bar |
| 2 | An unguarded `window.location.reload()` in the lazy-route retry helper | Turned any transient chunk-load failure into an **infinite** reload loop |
| 3 | esbuild ran out of OS threads pre-bundling heavy admin dependencies (`recharts`, `lucide-react`) on demand | Made the Vite dev server intermittently unresponsive, which is what *triggered* the chunk-load failures in the first place |
| 4 | A CSRF double-submit race on the analytics endpoint `POST /api/route-stats` | Caused a 403 on every cold page load (a secondary symptom, not part of the reload loop itself, but discovered during the same investigation) |

Each of these was fixed independently, and the loop only fully went away once all four were addressed — fixing the reload guard alone stopped the *infinite* loop but the app still hit an error boundary on every Vite reconnect until the esbuild root cause was also fixed.

---

## Background: how lazy-loaded routes normally fail safely

Every route in `App.tsx` is loaded with a custom wrapper, `lazyWithRetry`, instead of bare `React.lazy`:

```ts
// artifacts/overhype-me/src/App.tsx
import { lazyWithRetry as lazy } from "@/lib/lazy-retry";
```

This exists to paper over two ordinary situations:
1. **Dev-server restart** — Vite restarts mid-navigation, so the browser's in-flight request for a JS chunk 404s. Waiting ~400ms and retrying usually succeeds once Vite is back up.
2. **Post-deploy stale chunk** — a tab that's been open since before a production deploy asks for a chunk URL that no longer exists. A full page reload fixes this because it re-fetches the current HTML.

The intent was reasonable. The implementation was not safe.

---

## Bug 1 — Invalid button-in-button HTML (renderer crash)

**File:** `artifacts/overhype-me/src/components/layout/Navbar.tsx`

The nav bar rendered the account avatar like this:

```tsx
<button onClick={() => setLocation("/profile")} aria-label="Go to profile">
  <AccountMenuAvatarTrigger avatarUrl={...} fallbackInitial={...} />
</button>
```

But `AccountMenuAvatarTrigger` itself renders `UserAvatar`, which renders its own `<button type="button">`. The result was `<button><button>...</button></button>` — invalid HTML per spec (interactive content cannot nest). Browsers don't reliably recover from this; it produced renderer crashes, which is one of the things that can present as "the page keeps reloading."

**Fix (commit `aff956ca`):**
- Added an `onClick` prop to `UserAvatar` and threaded it through `AccountMenuAvatarTrigger`.
- Removed the outer `<button>` wrapper in `Navbar.tsx` entirely — the avatar's own button now handles the click and navigates directly.

```tsx
<AccountMenuAvatarTrigger avatarUrl={...} fallbackInitial={...} onClick={() => setLocation("/profile")} />
```

No more nested interactive elements.

---

## Bug 2 — Unbounded `window.location.reload()` in `lazyWithRetry` (the actual infinite loop)

**File:** `artifacts/overhype-me/src/lib/lazy-retry.ts`

This was the mechanism that turned a one-time hiccup into a runaway loop. The original code:

```ts
export function lazyWithRetry<T>(factory) {
  return lazy(() =>
    factory().catch(() =>
      new Promise((resolve) => {
        setTimeout(() => {
          factory()
            .then(resolve)
            .catch(() => {
              window.location.reload();   // <-- no guard at all
            });
        }, 400);
      })
    )
  );
}
```

**The loop, step by step:**
1. Something (see Bug 3) makes the Vite dev server briefly unresponsive.
2. A lazy route's `import()` fails.
3. `lazyWithRetry` waits 400ms and retries — still fails, because the server hasn't recovered yet.
4. It calls `window.location.reload()` unconditionally.
5. The freshly reloaded page immediately tries to load the *same* route chunk → same failure → same 400ms wait → reload again.
6. Repeat forever, at roughly a 1.3-second cadence (400ms delay + reload overhead).

There was **no state carried across the reload** to say "we already tried this" — every reload started from a blank slate, so the loop had no natural exit condition.

**Fix, in two iterations (commits `4749c6bc` → `b0f6404d`):**

The final version adds a `sessionStorage`-backed cooldown timestamp. Because a page reload wipes all in-memory state, the guard has to live somewhere that survives the reload — `sessionStorage` does.

```ts
const RELOAD_FLAG = "lazy-retry:reloaded-at";
const RELOAD_COOLDOWN_MS = 10_000;

// ...on second failure:
const storedAt = sessionStorage.getItem(RELOAD_FLAG);
const lastReloadAge = storedAt ? Date.now() - Number(storedAt) : Infinity;

if (lastReloadAge < RELOAD_COOLDOWN_MS) {
  // Reloaded very recently and still failing — stop looping. Reject so the
  // Sentry ErrorBoundary shows a fallback with a manual "Reload Page" button
  // instead of silently reloading again.
  reject(err);
  return;
}

sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
window.location.reload();
```

Behavior after the fix:
- First failure in a 10-second window → one reload, as before (handles the two legitimate cases described above).
- Any *additional* failure within 10 seconds of that reload → the promise is rejected instead of reloading again, which surfaces the Sentry error boundary with a manual retry button rather than looping silently.
- This caps the reload rate at once per 10 seconds no matter what's actually broken upstream — turning an infinite tight loop into, at worst, an error screen the user can act on.

This fix alone stopped the *infinite* reload loop, but the app still hit the error boundary on every Vite reconnect — because the real reason imports were failing (Bug 3) hadn't been fixed yet.

---

## Bug 3 — esbuild thread exhaustion on heavy admin dependencies (the actual trigger)

This is the one that took the longest to find, because the failure was invisible: the process supervisor restarted Vite before anything could be written to its own log, so nothing showed up in workflow logs.

**Root cause:** the Vite dev server config used `optimizeDeps.noDiscovery: true` to avoid a startup-time dependency-scanning crash, which meant most packages were transformed **on demand** the first time they were imported, rather than pre-bundled at startup. The admin/moderation pages import `recharts` (which pulls in a large tree of `d3-*` sub-packages) and `lucide-react` (thousands of individual icon files). The first time an admin page loaded, all of these needed on-demand transforms fired at once, each spawning its own esbuild goroutine. That concurrent burst pushed esbuild past the container's OS thread limit, and it panicked — silently, because the crash happened faster than anything could be flushed to stderr, and the supervisor immediately restarted the process.

From the Vite dev server's perspective this looked like: brief unresponsiveness → chunk requests fail/timeout → exactly the condition that triggers Bug 2's retry-then-reload path.

**Fix (commit `389f5fab`), two parts:**

1. **`artifacts/overhype-me/vite.config.ts`** — pre-bundle the heavy packages explicitly instead of letting them hit the on-demand path:
   ```ts
   optimizeDeps: {
     noDiscovery: true,
     include: [
       "react", "react-dom", "react-dom/client",
       "recharts",
       "lucide-react",
     ],
   },
   ```
   This makes esbuild process these dependencies once, at server startup, instead of in a concurrent burst when an admin page first loads.

2. **`artifacts/overhype-me/package.json`** — lowered `GOMAXPROCS=4` to `GOMAXPROCS=2` in the dev script, halving the number of OS threads Go allocates for its scheduler and giving more headroom before hitting the panic threshold.

**Observed result:** Vite startup time dropped from ~2.2s to ~0.4s, and — critically — the app was observed surviving multiple Vite WebSocket reconnects in a row with no error boundary and no reload loop.

---

## Bug 4 — CSRF race on `POST /api/route-stats` (secondary symptom, same investigation)

Not part of the reload loop itself, but found and fixed in the same session because it also produced a visible error (a 403) on every cold page load, and initially looked related.

**Root cause 1 — duplicate handler (commit `19abc3f0`):** two Express handlers were registered for the same path:
- `artifacts/api-server/src/routes/admin.ts` had a `{ counts: {...} }` shaped handler, registered *first* in `routes/index.ts`.
- `artifacts/api-server/src/routes/routeStats.ts` had a `{ route: string }` shaped handler, which was silently shadowed and never ran.

This meant every per-visit analytics POST had been returning 400 for months, unnoticed because the failure was silent and non-fatal to the UI. Fix: consolidated both payload shapes into `routeStats.ts` using a `z.union` schema, deleted the dead handler from `admin.ts`, and fixed the route-key allowlist (it was missing `onboard` and `login`, which the frontend sent but the server rejected).

**Root cause 2 — CSRF double-submit race (commit `389f5fab`):** `POST /api/route-stats` is a cookie-session request, so it went through the CSRF double-submit-cookie middleware in `artifacts/api-server/src/app.ts`. On the very first page load, this POST fires **concurrently** with the page's first GET — before the browser has received and stored the `Set-Cookie` header (containing the CSRF token) from that GET. So the POST has no CSRF cookie to echo back as the `x-csrf-token` header, and gets a 403 on every cold load.

**Fix:** added `/api/route-stats` to `ORIGIN_EXEMPT_PATHS` in `app.ts`. This is safe because the endpoint only accepts a fixed allowlist of route keys, performs no auth-sensitive mutation, and was already intentionally open to unauthenticated callers — CSRF protection provided no real security benefit here, only a race condition.

---

## Why it took multiple passes to actually fix

Each bug masked or was masked by another, which is why this needed several rounds of investigation:

- Fixing Bug 1 (button nesting) removed one crash source, but the reload loop continued because Bug 2 had no guard against *any* trigger, not just this one.
- Fixing Bug 2 (adding the cooldown) stopped the infinite loop, but the app then consistently showed a Sentry error boundary on every Vite reconnect — because Bug 3 (the actual reason imports were failing) was still there, just now surfaced as an error screen instead of a spinning reload.
- Bug 3 was invisible in logs because the crash happened before the process could write anything to stderr; it was only found by reasoning about *which pages* triggered it (admin/moderation, which import the heavy chart and icon libraries) and cross-referencing with the `noDiscovery: true` config.
- Bug 4 was found in parallel because it produced its own visible error (403) that initially looked like it might be related to the reload loop, but turned out to be an unrelated, pre-existing issue in the same request path.

## Verification

- 14/14 API tests pass for `routes.routeStats.test.ts` (covers both the `{ route }` and `{ counts }` payload shapes, the allowlist, and edge cases like invalid/negative/oversized deltas).
- 805/805 frontend tests pass, including new coverage for the `lazyWithRetry` cooldown-guard behavior.
- Live `curl` checks confirm `POST /api/route-stats` returns 204/200 with no CSRF 403 on a cold load.
- The app was observed surviving multiple real Vite WebSocket reconnects in the live preview with no reload loop and no error boundary.

## Files touched (all commits)

| File | Change |
|------|--------|
| `artifacts/overhype-me/src/components/UserAvatar.tsx` | Added `onClick` passthrough |
| `artifacts/overhype-me/src/components/layout/AccountMenu.tsx` | Threaded `onClick` through `AccountMenuAvatarTrigger` |
| `artifacts/overhype-me/src/components/layout/Navbar.tsx` | Removed invalid nested `<button>` wrapper |
| `artifacts/overhype-me/src/lib/lazy-retry.ts` | Added 10-second sessionStorage cooldown guard on `window.location.reload()` |
| `artifacts/overhype-me/vite.config.ts` | Added `recharts`, `lucide-react` to `optimizeDeps.include` |
| `artifacts/overhype-me/package.json` | `GOMAXPROCS=4` → `GOMAXPROCS=2` in the `dev` script |
| `artifacts/api-server/src/routes/routeStats.ts` | Consolidated both payload shapes, fixed allowlist |
| `artifacts/api-server/src/routes/admin.ts` | Removed dead duplicate `POST /route-stats` handler |
| `artifacts/api-server/src/app.ts` | Exempted `/api/route-stats` from CSRF/origin checks |
| `artifacts/api-server/src/__tests__/routes.routeStats.test.ts` | Added tests for both payload shapes and edge cases |
