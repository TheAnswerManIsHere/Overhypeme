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
- `limit` (but not `windowMs` — see §3) may be an async function evaluated per request. [Changelog](https://express-rate-limit.mintlify.app/reference/changelog)
- `passOnStoreError: true` — built-in option that allows the request through if the `Store` throws.
- `ipKeyGenerator(ip: string, ipv6Subnet = 56)` — an exported helper that returns the IP as-is for IPv4, or the `/56` CIDR subnet for IPv6 (so a client with many addresses in one subnet gets one bucket, not one per address), with a specific carve-out for IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) to avoid them collapsing into one shared `::/56` bucket. This exact gap was CVE-2026-30827 in this package before the carve-out existed — using the exported helper rather than a naive raw-string key is the reason this design isn't exposed to it. [Advisory](https://github.com/express-rate-limit/express-rate-limit/security/advisories/GHSA-46wh-pxpv-q5gq)

Considered and rejected: `@acpr/rate-limit-postgresql`, a third-party Postgres store (1.1k weekly downloads, not published under the `express-rate-limit` org's own npm scope). Rejected because it needs its own DB connection config and its own table — a new migration and a second DB connection path, when we can reuse the existing table and `db` client with ~30 lines of code that mirror an already-proven pattern.

### 2. Custom `Store`: reuse `rate_limit_counters`, don't add a table

New file `artifacts/api-server/src/lib/globalRateLimitStore.ts`. Implements the `Store` interface using the same atomic `INSERT ... ON CONFLICT DO UPDATE` shape already proven in `checkSharedRateLimit` (`sharedRateLimiter.ts:51-68`) against the same `rate_limit_counters` table and the same `db` client.

Kept as a standalone implementation rather than sharing code with `checkSharedRateLimit` — that function also tracks `nearLimit`, which doesn't apply here, and the `Store` interface's return shape differs from `checkSharedRateLimit`'s. Two similar small SQL blocks read more clearly than a shared abstraction built for two callers with different needs.

**Key namespacing and hashing:** the resolved, subnet-normalized key (§3) gets a `"grl:"` prefix, then is SHA-256 hashed for `key_hash` (the primary key) — same as `checkSharedRateLimit`. **Unlike `checkSharedRateLimit`, `key_raw` does not store the plaintext key.** Round-2 finding: `checkSharedRateLimit`'s own `key_raw` column is fine to leave unhashed because its key is already a composite (`rl|endpoint|ip:x|uid:y|to:z`), but this Store's key is *only* a client IP — persisting it verbatim in a column every API request writes to would be exactly the raw-IP storage `transientRenderLog.ts` deliberately avoids (it salts and hashes via `hashIp`, `transientRenderLog.ts:68-69`, before ever touching the DB). `key_raw` here stores `` `grl:${hashIp(resolvedKey)}` `` — the same salted digest, not the address — retaining the "which namespace is this row from" legibility `key_raw` exists for without persisting anything address-shaped. A test asserts no raw IPv4/IPv6 address appears in either column.

**Window is captured via `init(options)`, not the constructor.** `rateLimit()` calls `init(options)` once at setup, synchronously, before the middleware handles any request — `options.windowMs` is read there and stored on the instance for every subsequent `increment` call to compute `expires_at`.

**On a DB error, `increment`/`decrement`/`resetKey` let the exception propagate** (they do not catch-and-degrade internally) — `passOnStoreError: true` on the `rateLimit()` config is what turns that into "let the request through." This is deliberate: this middleware is explicitly "a generous backstop, not the real protection" — the narrow per-feature limiters and Cloudflare's edge-level rate limiting rules (`docs/cloudflare-rate-limits.md`) are the actual defense and are untouched by a Store outage. Fail-closed here would mean a transient DB hiccup — pool exhaustion, a slow query, a brief network blip — turns into an API-wide 429 storm on every route, including ones that touch no database at all. That's a worse outage than the backstop it would be protecting. **Telemetry still needs to see the error** (§3), so the one place a `try`/`catch` appears around a Store call is telemetry-only and always rethrows — never swallows.

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

**Row lifetime:** `purgeExpiredRateLimitCounters()` (`sharedRateLimiter.ts:83`) already exists but had **no production caller** — only test callers, and the one existing test (`rateLimit.test.ts:55-57`) calls it without creating rows or asserting anything, so it never actually verified the delete behavior either. Fixed two ways: (1) wired the existing function into an hourly job mirroring `jobs/transientRenderPurger.ts`'s self-rescheduling `setTimeout` pattern exactly — same schedule-at-top-of-hour shape, same try/catch-log-then-reschedule resilience so one failed run can't silently stop all future cleanup (`index.ts:221-234`/`:407`); new `jobs/rateLimitCounterPurger.ts` + matching `index.ts` registration. (2) A real test for the new job, mirroring `phase4.purger.test.ts`'s exact pattern (insert active + expired counter rows, run the purger, assert only expired rows are gone) plus a test that a thrown error during one scheduled run doesn't prevent the next — and the pre-existing trivial `rateLimit.test.ts` purge test is strengthened the same way while touching this area, rather than left as a known-weak neighbor.

**Telemetry, redesigned from round 1's version to fix a real architectural problem it had:** round 1 tried to have the Store itself track "allowed" outcomes, but the Store's `increment()` only returns a hit count — it doesn't know whether that count is *under* the limit, because the limit is resolved separately (and asynchronously, per §3) by the middleware after `increment()` returns. Fixed by moving counting to where each outcome is actually observable:
- A thin wrapper middleware around `globalLimiter` increments `globalRateLimitMetrics.total` for every request that reaches it (i.e., every request not already `skip`-exempted).
- `blocked` increments inside the `handler` (§3) — the one place a block is actually decided.
- `storeError` increments via a `try { ... } catch (err) { globalRateLimitMetrics.storeError++; logger.warn({ err }, "..."); throw err; }` wrapper around each Store method's real logic — rethrowing is required, or `passOnStoreError` silently stops working.
- `allowed` is not separately tracked — it's `total - blocked - storeError`, computed when reporting rather than incremented at a nonexistent hook. This avoids inventing a hook the package doesn't provide.

No raw client IPs in any metric or log line — only counts and, on block/error, the request path.

### 3. Wiring in `app.ts`

```ts
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { GlobalRateLimitStore, globalRateLimitMetrics } from "./lib/globalRateLimitStore";
import { ipFromRequest } from "./lib/transientRenderLog";
import { getConfigInt } from "./lib/adminConfig";
import { logger } from "./lib/logger";

const GLOBAL_RATE_WINDOW_MS = parsePositiveInt(process.env.GLOBAL_RATE_WINDOW_MS, 60_000);
const HEALTH_PATHS = new Set(["/api/healthz", "/api/health", "/api/health/queues"]);

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  limit: () => getConfigInt("global_rate_limit_max", 600),
  store: new GlobalRateLimitStore(),
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  passOnStoreError: true,
  standardHeaders: true, // RateLimit-* / Retry-After response headers
  skip: (req) => isPublicAssetRequest(req) || HEALTH_PATHS.has(req.path) || req.path === "/api/config",
  handler: (req, res) => {
    globalRateLimitMetrics.blocked++;
    logger.warn({ path: req.path }, "global rate limit exceeded");
    res.status(429).json({ error: "Too many requests. Please slow down." });
  },
});

// Mounted at the TOP level, not nested inside `app.use("/api", ...)` — see the
// mount-point note below for why this isn't cosmetic.
app.use((req, res, next) => {
  globalRateLimitMetrics.total++;
  globalLimiter(req, res, next);
});
app.use("/api", router);
```

Changes from round 1, each closing a specific finding:

- **Mount point moved out of the `/api` nesting (round-2 finding, P1 — a real bug, not a style choice):** round 1's `app.use("/api", globalLimiter, router)` runs `globalLimiter` *inside* the `/api` mount, where Express strips the mount prefix — so `req.path` inside it was `/healthz`, not `/api/healthz`, and `HEALTH_PATHS`/`PUBLIC_ASSET_PATH_PATTERNS` (both written expecting the full `/api/...` path) never matched anything. The health and asset exemptions from round 1 looked correct on paper and did nothing. Fixed by mounting `globalLimiter` as its own top-level `app.use()`, immediately before `app.use("/api", router)`, matching how the *existing* CSRF-cookie `isPublicAssetRequest` check at `app.ts:217` already works (also a top-level, unnested `app.use()`) — so `req.path` carries the full path in both places, consistently, with no `req.originalUrl` workaround needed. The integration test now asserts the Store is never invoked for exempt paths (checked via the Store's own hit count, not just "no 429"), not merely that fail-open would have masked the bug.
- **`keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req))`** (round-1 P1, round-2 found the fix incomplete): `ipFromRequest` resolves the trusted address (`CF-Connecting-IP` first, per `docs/cloudflare-rate-limits.md:86-105` — not `req.ip`/XFF); `ipKeyGenerator` (§1) then normalizes it the way the package's own default generator would, so IPv6 clients can't split one subnet across many buckets. Composing the two closes both the spoofing gap (round 1) and the normalization gap (round 2) with the trusted address as the input to the package's own normalizer, not a hand-rolled one.
- **`skip` adds `/api/config`** (round-2 finding, P2): `/api/config` (`app.ts:299-308`) is registered before the router mount and ends its own response without `next()`, so it was already unreachable by any router-nested middleware in round 1's version — but round 1's "must not change" wording implied every non-exempt route gets the new ceiling, which this route silently didn't. Made explicit rather than an accidental byproduct of registration order: it's public, read-only, served from a 60-second in-memory cache (`getPublicConfig`), and carries no abuse surface worth protecting — listed in §5 as a named exemption with that rationale, not left implicit.
- **`handler`**: the package's default 429 response is plain text; every existing limiter in this codebase returns `{ error: "..." }` JSON, and multiple frontend callers parse error bodies with `res.json()`. `standardHeaders: true` keeps the standard `RateLimit-*`/`Retry-After` response headers explicit rather than relying on the package default.
- **`limit` as `() => getConfigInt("global_rate_limit_max", 600)`** — see the config-source and provisioning notes below.

**Config source and provisioning for the tunable ceiling:** `limit` reads the live (60-second-cached) `admin_config` value via `getConfigInt`, matching this repo's established pattern for exactly this kind of value (`transient_renders.retention_days`, `pricing_refresh_interval_ms`). **Round 2 found this incomplete on its own: `getConfigInt` only reads a row that already exists — nothing provisioned one, and `routes/admin.ts:2220-2228` 404s on a missing key, so the admin UI would have had nothing to show and David could never actually tune it live, which was the entire point of moving off an env var.** Fixed with a new migration seeding `global_rate_limit_max` (integer, default `600`, `min_value: 1`) using this repo's existing idempotent seed pattern (`ON CONFLICT (key) DO UPDATE SET label = ..., description = ..., data_type = ...` — deliberately *not* overwriting `value` on conflict, so a value David has already tuned survives a future migration re-run, matching `migrations/0014_legendary_generation_limit.sql`'s exact shape). `windowMs` stays a plain env var (`GLOBAL_RATE_WINDOW_MS`, default 60 000) — not moved to `admin_config` — since it isn't the value expected to need live tuning, and a changing window mid-flight would create rollover edge cases in already-open counter rows that aren't worth the complexity for a value with no real reason to move.

**Default value and validating it against real traffic shapes — not just "600 eventually blocks":** `global_rate_limit_max` default **600 requests/minute per IP**. This is a coarse ceiling meant to catch gross abuse/scraping; the existing narrow limiters (30/min general, 5/min fact-submit, etc.) remain the actual per-feature protection. Two separate questions round 2 correctly split apart, each with its own answer:
- **Can the system afford the extra write at scale?** Answered by the load budget in §5 — concrete numbers, not "representative."
- **Does 600/min risk blocking legitimate shared-IP traffic (office/school/carrier NAT)?** This can't be fully answered pre-deploy without production traffic data this repo has no shadow-sampling infrastructure to collect, and building that infrastructure isn't proportionate to a generous, already-tunable backstop value. The honest, explicit answer is a **documented post-rollout decision rule** rather than a pre-deploy synthetic test standing in for one: for the first 72 hours after rollout, `globalRateLimitMetrics.blocked` and the per-block `logger.warn` path field are monitored; if any single path shows a sustained block rate above 5/hour, or a support/bug report cites unexpected 429s from normal use, `global_rate_limit_max` is raised via `admin_config` immediately — no deploy required, which is the entire reason this value was moved off an env var. This is a deliberate choice given the infrastructure gap, not an unaddressed finding — flagged to David as a real trade-off rather than asserted as fully resolved.

Same mount-point-adjacent behavior as before: the Stripe webhook (`app.post("/api/stripe/webhook", ...)`, registered earlier at the top level) stays naturally exempt — it ends its response before this middleware is ever reached.

### 4. Files touched

- `artifacts/api-server/package.json` and the regenerated root `pnpm-lock.yaml` — add `express-rate-limit`.
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new: the `Store` implementation, `globalRateLimitMetrics`.
- `lib/db/migrations/00XX_global_rate_limit_max_config.sql` — new: idempotent seed of the `global_rate_limit_max` admin_config row.
- `artifacts/api-server/src/lib/rateLimit.ts` — add `GLOBAL_RATE_WINDOW_MS`, `HEALTH_PATHS`.
- `artifacts/api-server/src/app.ts` — wire the global limiter as its own top-level `app.use()`, immediately before the `/api` router mount (not nested inside it).
- `artifacts/api-server/src/jobs/rateLimitCounterPurger.ts` — new, mirrors `jobs/transientRenderPurger.ts`; `index.ts` gets the matching `scheduleRateLimitCounterPurger()` call.
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new: Store unit tests (increment/decrement/resetKey semantics, key hashing with no raw-IP persistence, window/expiry rollover), plus a real concurrency test (parallel `increment` against both a fresh key and an about-to-expire key, asserting no lost increments and exactly one rollover).
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new: a real-`app` integration test (following `csrf.integration.test.ts`'s existing pattern) with an injectable low limit — proves 429/JSON-body/headers, that the Store is never called for `skip`-exempt paths (not just "no 429"), IPv6 subnet collapsing and IPv4-mapped-IPv6 handling via `ipKeyGenerator`, and `passOnStoreError` via a forced Store error.
- `artifacts/api-server/src/__tests__/rateLimitCounterPurger.test.ts` — new: mirrors `phase4.purger.test.ts`'s pattern (active + expired rows, run the purger, assert the boundary), plus a scheduler-resilience test (a thrown error on one run doesn't stop the next). Also strengthens the pre-existing trivial purge assertion in `rateLimit.test.ts:55-57` while touching this area.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — add the resolution.

### 5. Must not change

- **The existing narrow limiters' own behavior and thresholds are unchanged** — `checkSharedRateLimit`, `createRateLimiter`, `createFactSubmitRateLimiter` keep exactly their current limits, keys, and responses. This global middleware is an *additional*, much coarser layer above them.
- **Explicitly exempt, and reachable regardless of this middleware's Store state:** `/api/healthz`, `/api/health`, `/api/health/queues` (liveness/readiness), the existing public crawler-asset patterns (`isPublicAssetRequest`), and `/api/config` (public, cached, no abuse surface — see §3).
- **Every other route may now receive a 429 it could not receive before**, past the configured ceiling — this is the feature, not a regression.
- No new table/schema migration for `rate_limit_counters` — reuses it as-is. (The new `admin_config` seed migration is data-only, not a schema change.)
- No change to the Stripe webhook's exemption (preserved by registration order).
- No raw client IP addresses persisted in `rate_limit_counters` or emitted in metrics/logs (§2).

## Verification

1. `pnpm run typecheck` / `pnpm run build` — clean. `pnpm install --frozen-lockfile` succeeds with the new dependency and updated lockfile.
2. New `GlobalRateLimitStore` unit tests pass, including the concurrency test and the no-raw-IP-persisted assertion.
3. New real-`app` integration test passes: 429 + JSON body + headers past an injected low limit; `skip`-exempt paths never touch the Store at all (asserted via hit count, not inferred from absence of a 429); IPv6 subnet/IPv4-mapped handling via `ipKeyGenerator`; a forced Store error passes the request through per `passOnStoreError`.
4. New purger tests pass: active rows survive, expired rows are deleted, a thrown error on one scheduled run doesn't block the next.
5. Full existing test suite (`pnpm run test` in `api-server`, plus the E2E Smoke path) — no new failures. (This step only confirms nothing else broke — see §3, it doesn't validate the 600/min default; that's step 7.)
6. Local CodeQL re-scan confirms `js/missing-rate-limiting` drops from 213 to 0.
7. **Load budget — concrete numbers, run before this is considered done:**
   - Workload A ("many unique keys"): 500 concurrent requests spread across 200 distinct client keys, sustained 30s.
   - Workload B ("one busy shared key"): 500 concurrent requests against a single client key, sustained 30s (the real contention case for the `INSERT ... ON CONFLICT` path).
   - Pass criteria for both: p95 latency added by the Store's upsert ≤ 15ms per request; sustained pool usage ≤ 16 of the pool's 20 connections (`lib/db/src/index.ts`'s `POOL_MAX_DEFAULT`); 0% error rate attributable to the Store.
8. Manual: hit an `/api` route past the configured ceiling from one IP against a real running instance, confirm a 429 with the expected JSON body and headers; confirm the existing narrow limiters (e.g. `ai.ts`'s 30/min) still fire independently; confirm `/api/healthz` and `/api/config` keep responding through it.
9. Post-rollout (not pre-deploy — see §3's NAT-traffic note): monitor blocked-request telemetry for 72 hours; raise `global_rate_limit_max` via `admin_config` immediately if a sustained (>5/hour) block pattern or a legitimate-use report appears.
