---
name: A module-level default-exported singleton evaluates on ANY import, and leaks across test files under --test-isolation=none
description: app.ts's `export default createApp()` ran as a side effect of importing only the named `createApp` export, letting one test file's env-var setup leak a stale singleton into another file in the same shard.
---

# Importing one named export still evaluates the whole module — including an eager singleton

**What went wrong (PR #308):** `app.ts` exported both a named factory and a
module-level singleton built from it:

```ts
export function createApp(): Express { /* ... */ }
const app: Express = createApp();
export default app;
```

A new test file added in the same PR imported only the named export:
`import { createApp } from "../app.js"`. That should be inert — but ES module
evaluation runs a module's **entire top-level code** the first time it is
imported, regardless of which binding the importer actually asks for. So
merely importing `createApp` also ran `const app = createApp();`, which reads
`process.env.ALLOWED_ORIGINS` at that moment and bakes it into the singleton.

This repo's test runner (`bash scripts/run-test.sh`) uses
`--test-isolation=none`: multiple test files share one process and one module
registry. `csrf.integration.test.ts` sets `ALLOWED_ORIGINS` in its own
`beforeEach` and expects a fresh app per test via a `getApp()` helper that
originally did `(await import("../app.js")).default` — but Node caches
module namespace objects, so that "fresh" import kept returning the **same**
singleton, frozen with whatever env was set at whichever test file first
imported `app.ts`. When the new rate-limiter test file's import order put it
before `csrf.integration.test.ts` in one `run-test.sh` invocation, the CSRF
tests silently got an app instance with an empty origin allowlist and 2 of
them failed rejecting a request that should have been allowed.

**Reproduced before trusting the fix:** reverted both files to the pre-fix
state and re-ran the two test files in the PR's own vulnerable order —
`not ok` on exactly the 2 predicted CSRF tests, nothing else. Confirms this
isn't a theoretical concern; it's load-bearing for this specific
`--test-isolation=none` runner.

**Fix — remove the singleton, don't just work around it in one test file:**
`app.ts` no longer default-exports (or eagerly constructs) an **Express app
instance** at module level. Every caller — the production entrypoint
(`index.ts`) and every test file — calls `createApp()` itself and gets an
independent instance reading whatever env is current *at that call*, not at
first-import time.

**Scoped claim, not a complete fix — a related, still-open gap remains.**
`app.ts` still has other top-level, env-reading state: `ORIGIN_EXEMPT_PATHS`
is a module-scope `Set`, conditionally gaining `/api/auth/dev-admin-login`
only via an `if (isDevAdminLoginEnabled())` block that runs once at import
time. `createApp()` itself re-checks `isDevAdminLoginEnabled()` fresh on
every call (to decide whether to mount the permissive dev-admin CORS
middleware), but `isOriginExempt()` — used by the origin-check middleware
`createApp()` registers — reads that same frozen-at-import `Set`. So in a
shared-process caller that imports `app.ts` before `ENABLE_DEV_ADMIN_LOGIN`
is set, then calls `createApp()` after: the permissive CORS gets mounted
(fresh check), but the origin-exemption never gets added (stale check) — a
cross-origin dev-admin-login POST would get permissive CORS headers and then
be rejected by the origin-check middleware anyway. This is the same species
of import-time-env-capture bug this note is about, just not what PR #308's
actual fix addressed (that fix targeted the app-instance singleton
specifically, not this `Set`). **Not fixed here** — tracked as its own
`deferred-work.md` entry (Codex review, PR #319's `/document` harvest) rather
than a drive-by code change inside a docs-only harvest PR.

**Rule:** a module meant to be imported by tests under a shared-process
runner (`--test-isolation=none`, or any setup where import order across
files isn't controlled) must never construct a stateful singleton — DB
client, Express app, cache, anything that reads mutable config — as a
top-level side effect, even behind a *named* export the caller doesn't
appear to be asking for. If a "fresh instance" helper is needed, it must call
a **factory function** each time, never memoize or return a cached
module-level value. When reviewing a file like this, check every top-level
`const x = someFactory();` for whether `x` (or a default export built from
it) is ever imported anywhere a test file's env-dependent setup could race
against it.
