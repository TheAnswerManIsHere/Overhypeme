---
name: Canvas reload-loop diagnosis
description: How to diagnose ~1.3s reload loops in the canvas preview iframe and the duplicate route registration pitfall
---

## Reload loops in the canvas preview
- Repeating "[vite] connecting…/connected." pairs every ~1-2s with no console errors = full page reloads of the iframe, most likely Chrome auto-reloading a crashed/killed renderer. The dying page emits no error logs.
- **How to apply:** correlate api-server request logs per cycle (how far the app gets before dying), check the vite server log for `page reload`/`full-reload` lines (rules out watcher churn), and remember screenshot tools carry no cookies — auth-only crashes won't reproduce unauthenticated.
- A loop can persist after the code fix because the crashed-iframe auto-reload can serve stale cached modules; a manual refresh of the preview ends it. Verify "fixed" by watching for the loop cadence to stop in api logs, not by code inspection alone.

## Duplicate Express route registration shadows silently
- Two `router.post` handlers for the same path across route files: whichever router is `use()`d first in routes/index.ts wins; the other is dead code that still passes its own unit tests.
- **Why:** POST /api/route-stats had a `{counts}` handler in admin.ts shadowing the `{route}` handler in routeStats.ts → every per-visit post 400'd silently for months.
- **How to apply:** when an endpoint misbehaves despite correct-looking code, curl the live server and compare the error body against the handler you're reading — a mismatched error string means another handler owns the path.
