# Global DB-backed rate limiter (satisfy CodeQL `js/missing-rate-limiting`)

## Context

CodeQL flags 213 `js/missing-rate-limiting` alerts across this repo's API routes. This repo already has real rate limiting — `checkSharedRateLimit` (`artifacts/api-server/src/lib/sharedRateLimiter.ts`), a DB-backed window counter, called either inline or via `createRateLimiter`'s Express-middleware wrapper (`artifacts/api-server/src/lib/rateLimit.ts`) — but CodeQL's `js/missing-rate-limiting` query only recognizes a hardcoded list of known npm packages (`express-rate-limit`, `express-brute`, `express-limiter`, `rate-limiter-flexible`, `@fastify/rate-limit`) as satisfying the check. It has no extension mechanism, so no amount of correctly-functioning custom code will ever clear it — confirmed empirically this session (`checkSharedRateLimit` registered as real Express middleware still gets flagged).

**Proven locally this session:** building a CodeQL database against a copy of the repo with one addition — `import { rateLimit } from "express-rate-limit"` and `app.use("/api", rateLimit({ windowMs: 60_000, limit: 30 }), router)` in `app.ts` — took the alert count from 213 to 0 in a full local scan. That proof used `express-rate-limit`'s default in-memory `MemoryStore`.

**Why not ship that as-is:** this repo's existing rate limiting is deliberately DB-backed (`rate_limit_counters` table) specifically so counts are correct across multiple server processes/instances, not per-process. Wiring the CodeQL-satisfying middleware to the default in-memory store would be a real regression of that guarantee for the one rate limiter CodeQL can see, even though it's cosmetically "the same fix." This plan closes that gap: same proven CodeQL-satisfying shape, backed by a custom `Store` that reuses the existing DB table.

**Outcome:** all 213 alerts clear (re-verified via local CodeQL scan before calling this done), no change to any existing narrow rate limiter's behavior, no new migration.

## Design

### 1. New dependency: `express-rate-limit` (^8.5.1)

Verified externally (not from memory) against current docs, since this is a material SDK claim:
- Current version 8.5.1 (May 2026), actively maintained. [npm](https://www.npmjs.com/package/express-rate-limit)
- v8's `Store` interface (verified against the [official wiki](https://github.com/express-rate-limit/express-rate-limit/wiki/Creating-Your-Own-Store)): required async methods `increment(key: string): Promise<{ totalHits: number; resetTime: Date }>`, `decrement(key: string): Promise<void>`, `resetKey(key: string): Promise<void>`; optional sync `init(options)`.
- v8 explicitly supports Express 5 (this repo's `express: "^5"`) — peer deps were loosened for the Express 5 beta and it's been stable since. [Release notes](https://github.com/express-rate-limit/express-rate-limit/releases)

Considered and rejected: `@acpr/rate-limit-postgresql`, a third-party Postgres store (1.1k weekly downloads, not published under the `express-rate-limit` org's own npm scope). Rejected because it needs its own DB connection config and its own table — a new migration and a second DB connection path, when we can reuse the existing table and `db` client with ~30 lines of code that mirror an already-proven pattern.

### 2. Custom `Store`: reuse `rate_limit_counters`, don't add a table

New file `artifacts/api-server/src/lib/globalRateLimitStore.ts`. Implements the `Store` interface using the same atomic `INSERT ... ON CONFLICT DO UPDATE` shape already proven in `checkSharedRateLimit` (`sharedRateLimiter.ts:51-68`) against the same `rate_limit_counters` table (`lib/db/src/schema/rateLimit.ts`) and the same `db` client.

Kept as a standalone ~30-line implementation rather than sharing code with `checkSharedRateLimit` — that function also tracks `nearLimit`/`rateLimitMetrics`, which don't apply here, and the `Store` interface's return shape (`{totalHits, resetTime}`) differs from `checkSharedRateLimit`'s (`{allowed, count, limit, resetAt, nearLimit}`). Two similar small SQL blocks read more clearly than a shared abstraction built for two callers with different needs.

**Key namespacing:** every key this Store hashes gets a `"grl:"` prefix before hashing, so it can never collide with `checkSharedRateLimit`'s own `"rl|..."`-prefixed keys even though they share one table.

```ts
class GlobalRateLimitStore implements Store {
  async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> { ... }
  async decrement(key: string): Promise<void> { ... }
  async resetKey(key: string): Promise<void> { ... }
}
```

### 3. Wiring in `app.ts`

```ts
import { rateLimit } from "express-rate-limit";
import { GlobalRateLimitStore } from "./lib/globalRateLimitStore";

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  limit: GLOBAL_RATE_MAX,
  store: new GlobalRateLimitStore(),
});

app.use("/api", globalLimiter, router);
```

Same mount point as the proven local-scan fix (`app.ts:310`, immediately replacing the current `app.use("/api", router)`). The Stripe webhook (`app.post("/api/stripe/webhook", ...)`, registered earlier at the top level) is naturally exempt — Express dispatches it before reaching this middleware, same as it's already exempt from the router.

**Env-configurable**, matching the existing `RATE_WINDOW_MS`/`RATE_MAX` convention in `rateLimit.ts` (reuse `parsePositiveInt`): new `GLOBAL_RATE_WINDOW_MS` / `GLOBAL_RATE_MAX`.

**Default value — generous backstop, not a real throttle:** propose **600 requests/minute per IP**. This is a coarse ceiling meant to catch gross abuse/scraping; the existing narrow limiters (30/min general, 5/min fact-submit, etc.) remain the actual per-feature protection and are unchanged by this work. 600/min is far above any legitimate single-IP usage pattern (a logged-in user's page load, even a busy one) but low enough to mean something against a scraper.

**Concrete risk to verify empirically, not assume:** express-rate-limit's default `keyGenerator` is IP-only (no user/session awareness, unlike `checkSharedRateLimit`'s key which includes `userId`). In CI, the full API test suite runs ~170 test files against one local server from one IP, backed by a real (test) Postgres — meaning every test file's requests would share one counter bucket for the first time (existing limiters are scoped per-user/per-endpoint and mostly avoid this). Implementation is not done until the full local test suite (`pnpm run test` in `api-server`) and the E2E Smoke path are run against the change with no new 429-related failures. If 600/min turns out to be too tight for CI's request volume within its run window, raise the default rather than special-case `NODE_ENV` — a config knob is simpler than environment-conditional logic for something that isn't actually security-sensitive to get slightly wrong.

### 4. Files touched

- `artifacts/api-server/package.json` — add `express-rate-limit` dependency.
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new, the `Store` implementation.
- `artifacts/api-server/src/lib/rateLimit.ts` — add `GLOBAL_RATE_WINDOW_MS`/`GLOBAL_RATE_MAX` env-configurable constants (same file as the existing `RATE_WINDOW_MS`/`RATE_MAX`, for one place to look).
- `artifacts/api-server/src/app.ts` — wire the global limiter at the existing `/api` mount point.
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new, unit tests for the Store (increment/decrement/resetKey semantics, key-prefix collision avoidance with `checkSharedRateLimit`'s keys, window/expiry rollover) following the existing `rateLimit.test.ts` pattern.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — add the resolution: the global middleware is what actually clears the CodeQL alerts, and why (the query only recognizes specific packages, not correct behavior).

### 5. Must not change

- No behavior change to any existing route's actual rate limiting — `checkSharedRateLimit`, `createRateLimiter`, `createFactSubmitRateLimiter` are untouched.
- No new migration — reuses `rate_limit_counters` as-is.
- No change to the Stripe webhook's exemption (naturally preserved by registration order, not a new special case).

## Verification

1. `pnpm run typecheck` / `pnpm run build` — clean.
2. New unit tests for `GlobalRateLimitStore` pass.
3. Full existing test suite (`pnpm run test` in `api-server`, plus the E2E Smoke path) — no new failures, specifically no 429s from the global limiter. This is the empirical check for the CI-volume risk above.
4. Local CodeQL re-scan (the CLI + database infra already set up in this session's scratchpad) confirms `js/missing-rate-limiting` drops from 213 to 0, same rigor as the proven local proof.
5. Manual: hit an `/api` route >600 times/minute from one IP in a local run, confirm a 429; confirm the existing narrow limiters (e.g. `ai.ts`'s 30/min) still fire independently and unaffected.
