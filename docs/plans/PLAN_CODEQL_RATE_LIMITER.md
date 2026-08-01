# Global DB-backed rate limiter (satisfy CodeQL `js/missing-rate-limiting`)

## Context

CodeQL flags 213 `js/missing-rate-limiting` alerts across this repo's API routes. This repo already has real rate limiting — `checkSharedRateLimit` (`artifacts/api-server/src/lib/sharedRateLimiter.ts`), a DB-backed window counter, called either inline or via `createRateLimiter`'s Express-middleware wrapper (`artifacts/api-server/src/lib/rateLimit.ts`) — but CodeQL's `js/missing-rate-limiting` query only recognizes a hardcoded list of known npm packages (`express-rate-limit`, `express-brute`, `express-limiter`, `rate-limiter-flexible`, `@fastify/rate-limit`) as satisfying the check. It has no extension mechanism, so no amount of correctly-functioning custom code will ever clear it — confirmed empirically this session (`checkSharedRateLimit` registered as real Express middleware still gets flagged).

**Proven locally this session:** building a CodeQL database against a copy of the repo with one addition — `import { rateLimit } from "express-rate-limit"` and `app.use("/api", rateLimit({ windowMs: 60_000, limit: 30 }), router)` in `app.ts` — took the alert count from 213 to 0 in a full local scan. That proof used `express-rate-limit`'s default in-memory `MemoryStore`.

**Why not ship that as-is:** this repo's existing rate limiting is deliberately DB-backed (`rate_limit_counters` table) specifically so counts are correct across multiple server processes/instances, not per-process. Wiring the CodeQL-satisfying middleware to the default in-memory store would be a real regression of that guarantee for the one rate limiter CodeQL can see, even though it's cosmetically "the same fix." This plan closes that gap: same proven CodeQL-satisfying shape, backed by a custom `Store` that reuses the existing DB table.

**Outcome:** all 213 alerts clear (re-verified via local CodeQL scan before calling this done), no change to any existing narrow rate limiter's behavior, no new migration.

## Design

### 1. New dependency: `express-rate-limit` (^8.5.1)

Verified externally against current docs:
- Current version 8.5.1 (May 2026), actively maintained. [npm](https://www.npmjs.com/package/express-rate-limit)
- v8's `Store` interface: required async `increment(key: string): Promise<{ totalHits: number; resetTime: Date }>`, `decrement(key: string): Promise<void>`, `resetKey(key: string): Promise<void>`; optional sync `init(options)`. [Wiki](https://github.com/express-rate-limit/express-rate-limit/wiki/Creating-Your-Own-Store)
- v8 supports Express 5. [Release notes](https://github.com/express-rate-limit/express-rate-limit/releases)
- `limit` (but not `windowMs`, in this plan's design — see §3) may be an async function evaluated per request. [Changelog](https://express-rate-limit.mintlify.app/reference/changelog)
- `passOnStoreError: true` — a built-in option that allows the request through if the `Store` throws, instead of the default fail-closed behavior. This is the mechanism for round-1's Store-availability finding (§3).

Considered and rejected: `@acpr/rate-limit-postgresql`, a third-party Postgres store (1.1k weekly downloads, not published under the `express-rate-limit` org's own npm scope). Rejected because it needs its own DB connection config and its own table — a new migration and a second DB connection path, when we can reuse the existing table and `db` client with ~30 lines of code that mirror an already-proven pattern.

### 2. Custom `Store`: reuse `rate_limit_counters`, don't add a table

New file `artifacts/api-server/src/lib/globalRateLimitStore.ts`. Implements the `Store` interface using the same atomic `INSERT ... ON CONFLICT DO UPDATE` shape already proven in `checkSharedRateLimit` (`sharedRateLimiter.ts:51-68`) against the same `rate_limit_counters` table and the same `db` client.

Kept as a standalone implementation rather than sharing code with `checkSharedRateLimit` — that function also tracks `nearLimit`, which doesn't apply here, and the `Store` interface's return shape differs from `checkSharedRateLimit`'s. Two similar small SQL blocks read more clearly than a shared abstraction built for two callers with different needs.

**Key namespacing:** every key this Store hashes gets a `"grl:"` prefix before hashing, so it can never collide with `checkSharedRateLimit`'s own `"rl|..."`-prefixed keys even though they share one table.

**Window is captured via `init(options)`, not the constructor** (round-1 finding: the earlier sketch had `new GlobalRateLimitStore()` with nowhere for `increment` to learn the configured window). `rateLimit()` calls `init(options)` once at setup, synchronously, before the middleware handles any request — `options.windowMs` is read there and stored on the instance for every subsequent `increment` call to compute `expires_at`.

**On a DB error, `increment`/`decrement`/`resetKey` let the exception propagate** (they do not catch-and-degrade internally) — `passOnStoreError: true` on the `rateLimit()` config is what turns that into "let the request through," not custom logic in the Store. This is a deliberate choice, not an oversight (round-1 finding, tagged Product Decision): this middleware is explicitly "a generous backstop, not the real protection" (§3) — the narrow per-feature limiters and Cloudflare's edge-level rate limiting rules (`docs/cloudflare-rate-limits.md`) are the actual defense and are untouched by a Store outage. Fail-closed here would mean a transient DB hiccup — pool exhaustion, a slow query, a brief network blip — turns into an API-wide 429 storm on every route, including ones that touch no database at all. That's a worse outage than the backstop it would be protecting.

```ts
class GlobalRateLimitStore implements Store {
  private windowMs = 60_000;
  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
  }
  async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> { ... }
  async decrement(key: string): Promise<void> { ... }
  async resetKey(key: string): Promise<void> { ... }
}
```

**Concurrency:** the underlying SQL is the same single-statement `INSERT ... ON CONFLICT (key_hash) DO UPDATE ... RETURNING` already proven atomic in `checkSharedRateLimit` — Postgres serializes conflicting writes to the same row at the statement level, so no additional locking is needed. Verified with a real concurrency test, not just sequential logic (§5).

**Row lifetime:** `purgeExpiredRateLimitCounters()` (`sharedRateLimiter.ts:83`) already exists but round-1 review found it has **no production caller today** — only test callers. Mounting this Store on every `/api` request means a `rate_limit_counters` row per distinct client IP, so this table needs bounded growth once it's live-traffic-sized, not just at the narrow limiters' current low cardinality. Fixed by wiring an hourly purge job mirroring `jobs/transientRenderPurger.ts`'s existing self-rescheduling `setTimeout` pattern (`index.ts:221-234`, registered at `index.ts:407`) — new `scheduleRateLimitCounterPurger()` calling the existing `purgeExpiredRateLimitCounters()` on the same hourly cadence. This incidentally fixes the same unbounded-growth gap for the narrow limiters' own rows too, which were never purged in production either.

**Telemetry:** the existing `rateLimitMetrics` object in `sharedRateLimiter.ts` (hits/nearLimit/blocked) isn't reused here (per §2's "kept standalone" reasoning), so a sibling `globalRateLimitMetrics` object (allowed/blocked/storeError counters, no raw IPs — low-cardinality, matching the existing object's shape) is added alongside it, plus a `logger.warn` line on block and on Store error. This closes round-1's finding that operators would otherwise have no way to tell a badly-tuned ceiling from real abuse, or notice the Store failing, after deployment.

### 3. Wiring in `app.ts`

```ts
import { rateLimit } from "express-rate-limit";
import { GlobalRateLimitStore, globalRateLimitMetrics } from "./lib/globalRateLimitStore";
import { ipFromRequest } from "./lib/transientRenderLog";
import { getConfigInt } from "./lib/adminConfig";
import { logger } from "./lib/logger";

const GLOBAL_RATE_WINDOW_MS = parsePositiveInt(process.env.GLOBAL_RATE_WINDOW_MS, 60_000);

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  limit: () => getConfigInt("global_rate_limit_max", 600),
  store: new GlobalRateLimitStore(),
  keyGenerator: (req) => ipFromRequest(req),
  passOnStoreError: true,
  standardHeaders: true, // RateLimit-* / Retry-After response headers
  skip: (req) => isPublicAssetRequest(req) || HEALTH_PATHS.has(req.path),
  handler: (req, res) => {
    globalRateLimitMetrics.blocked++;
    logger.warn({ path: req.path }, "global rate limit exceeded");
    res.status(429).json({ error: "Too many requests. Please slow down." });
  },
});

app.use("/api", globalLimiter, router);
```

Changes from the round-1 sketch, each closing a specific finding:

- **`keyGenerator: ipFromRequest`** (round-1 finding, P1): the package's default `keyGenerator` reads `req.ip`, which honors Express's `trust proxy`-derived `X-Forwarded-For` chain — `docs/cloudflare-rate-limits.md:86-105` documents that origin abuse controls must **not** trust that chain (a client bypassing Cloudflare can forge it) and must use `CF-Connecting-IP` instead. `ipFromRequest` (`transientRenderLog.ts:58`) already implements exactly this resolution order (`CF-Connecting-IP` → `req.ip` → socket → `"unknown"`) and is reused as-is rather than re-implemented.
- **`skip` for health checks and public assets** (round-1 finding, P1): `/api/healthz` and `/api/health` must stay reachable independent of this Store — a liveness probe that can fail because an *unrelated* rate-limit counter write is slow or down is a regression of the whole point of a liveness check, and `routes/health.ts`'s `/health` handler is itself already designed to return 200 even when its own optional DB read fails. `PUBLIC_ASSET_PATH_PATTERNS`/`isPublicAssetRequest` already exists in `app.ts` (used for the CSRF-cookie-issuance skip) and is reused for the same crawler-facing paths (`/api/og/`, meme images, templates) rather than duplicated. `HEALTH_PATHS` is a small new `Set(["/api/healthz", "/api/health", "/api/health/queues"])` constant next to it.
- **`handler`** (round-1 finding, P2): the package's default 429 response is plain text; every existing limiter in this codebase returns `{ error: "..." }` JSON (`rateLimit.ts:36`, `:65`), and multiple frontend callers parse error bodies with `res.json()`. A custom `handler` keeps that contract instead of silently swapping in a body frontend code can't parse. `standardHeaders: true` keeps the standard `RateLimit-*`/`Retry-After` response headers (on by default in v8 — set explicitly here so it's not silently lost if a future edit removes an implicit default).
- **`limit` as `() => getConfigInt("global_rate_limit_max", 600)`** — see below.

Same mount point as the proven local-scan fix (`app.ts:310`, immediately replacing the current `app.use("/api", router)`). The Stripe webhook (`app.post("/api/stripe/webhook", ...)`, registered earlier at the top level) is naturally exempt — Express dispatches it before reaching this middleware, same as it's already exempt from the router.

**Config source for the tunable ceiling** (round-1 finding, tagged Product Decision): the earlier sketch used a plain `GLOBAL_RATE_MAX` env var. Round-1 review correctly pointed out this repo already has a live-tunable operational-config path (`admin_config` via `getConfigInt`, used by e.g. `transient_renders.retention_days` and `pricing_refresh_interval_ms` in `index.ts`) for exactly this shape of value — one expected to need adjustment from real traffic data without a redeploy. `limit` accepts an async function in v8, so `limit: () => getConfigInt("global_rate_limit_max", 600)` reads the live (60s-cached) config value per request, falling back to `600` if the key is unset or the DB read fails (`getConfigInt`'s own existing fail-open behavior — see `adminConfig.ts:77-88`). `windowMs` stays a plain env var (`GLOBAL_RATE_WINDOW_MS`, default 60 000) rather than also going dynamic: unlike the count ceiling, the window isn't expected to need live tuning, and a changing window mid-flight would create rollover edge cases in already-open counter rows that aren't worth the complexity for a value with no real reason to move.

**Default value — generous backstop, not a real throttle:** `global_rate_limit_max` default **600 requests/minute per IP**. This is a coarse ceiling meant to catch gross abuse/scraping; the existing narrow limiters (30/min general, 5/min fact-submit, etc.) remain the actual per-feature protection and are unchanged by this work. 600/min is far above any legitimate single-IP usage pattern but low enough to mean something against a scraper. Because it's now `admin_config`-backed, it can be tuned from real traffic after rollout without a deploy — the empirical validation in §5 replaces guessing the right number up front.

### 4. Files touched

- `artifacts/api-server/package.json` and the regenerated root `pnpm-lock.yaml` — add `express-rate-limit`. (Round-1 finding: every CI job installs with `pnpm install --frozen-lockfile`; the lockfile has to ship in the same change or install fails before anything else runs.)
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new: the `Store` implementation, `globalRateLimitMetrics`.
- `artifacts/api-server/src/lib/rateLimit.ts` — add `GLOBAL_RATE_WINDOW_MS`, `HEALTH_PATHS`.
- `artifacts/api-server/src/app.ts` — wire the global limiter at the existing `/api` mount point.
- `artifacts/api-server/src/jobs/rateLimitCounterPurger.ts` — new, mirrors `jobs/transientRenderPurger.ts`; `index.ts` gets the matching `scheduleRateLimitCounterPurger()` call.
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new: Store unit tests (increment/decrement/resetKey semantics, key-prefix collision avoidance, window/expiry rollover) **plus a real concurrency test** (parallel `increment` calls against both a fresh key and an about-to-expire key, asserting no lost increments and exactly one rollover) — round-1 finding: sequential tests alone don't exercise the `INSERT ... ON CONFLICT` contention this Store's whole design is motivated by.
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new: a real-`app` integration test (following `csrf.integration.test.ts`'s existing pattern of importing the actual `app`, per round-1's finding that most route tests mount isolated routers and never exercise this middleware at all) with an injectable low limit — proves the 429/JSON-body/headers behavior, the health/asset `skip` exemptions, and `passOnStoreError` (by forcing a Store error) directly, rather than inferring correctness from full-suite request volume.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — add the resolution: the global middleware is what actually clears the CodeQL alerts, and why (the query only recognizes specific packages, not correct behavior).

### 5. Must not change

Round-1 finding (P1, tagged Product Decision): the earlier wording — "no behavior change to any existing route's actual rate limiting" — was imprecise enough to read as contradicting this plan's own purpose, since a global 429 ceiling is new behavior on every route by construction. Restated precisely:

- **The existing narrow limiters' own behavior and thresholds are unchanged** — `checkSharedRateLimit`, `createRateLimiter`, `createFactSubmitRateLimiter` keep exactly their current limits, keys, and responses. This global middleware is an *additional*, much coarser layer above them, not a replacement.
- **Liveness/health and public crawler-asset endpoints are explicitly exempt** (`skip`, §3) — these must remain reachable regardless of the Store's state, which is a stronger guarantee than "unaffected," and is why they're called out separately rather than folded into "every route is affected the same way."
- **Every other route may now receive a 429 it could not receive before**, past 600 req/min from one IP — this is the feature, not a regression, and is explicitly in scope.
- No new migration — reuses `rate_limit_counters` as-is.
- No change to the Stripe webhook's exemption (preserved by registration order, not a new special case).

## Verification

1. `pnpm run typecheck` / `pnpm run build` — clean.
2. New `GlobalRateLimitStore` unit tests pass, including the concurrency test (§4).
3. New real-`app` integration test passes: 429 + JSON body + headers past an injected low limit; health/asset paths never 429 regardless of limit; a forced Store error is passed through (not blocked) per `passOnStoreError`.
4. Full existing test suite (`pnpm run test` in `api-server`, plus the E2E Smoke path) — no new failures. (Round-1 correction: this is *not* the mechanism that validates the 600/min default — `run-tests-sharded.sh` gives each shard its own database and most route tests mount isolated routers rather than the real `app`, so full-suite volume was never going to approach 600 on a shared bucket either way. This step only confirms nothing else broke.)
5. Local CodeQL re-scan (the CLI + database infra already set up in this session's scratchpad) confirms `js/missing-rate-limiting` drops from 213 to 0, same rigor as the proven local proof.
6. **Load budget** (round-1 finding: functional tests alone don't show this is affordable) — a representative parallel load check against the new Store, covering both many-unique-keys and one-busy-shared-key shapes, with explicit p95 latency, connection-pool-saturation, and error-rate budgets that must pass before this is considered done. Every `/api` request now does one additional contended Postgres upsert; this has to be shown cheap enough, not assumed.
7. Manual: hit an `/api` route >600 times/minute from one IP against a real running instance, confirm a 429 with the expected JSON body and headers; confirm the existing narrow limiters (e.g. `ai.ts`'s 30/min) still fire independently and unaffected; confirm `/api/healthz` keeps responding through it.
