# Global DB-backed rate limiter (satisfy CodeQL `js/missing-rate-limiting`)

## Context

CodeQL flags 213 `js/missing-rate-limiting` alerts across this repo's API routes. This repo already has real rate limiting — `checkSharedRateLimit` (`artifacts/api-server/src/lib/sharedRateLimiter.ts`), a DB-backed window counter, called either inline or via `createRateLimiter`'s Express-middleware wrapper (`artifacts/api-server/src/lib/rateLimit.ts`) — but CodeQL's `js/missing-rate-limiting` query only recognizes a hardcoded list of known npm packages (`express-rate-limit`, `express-brute`, `express-limiter`, `rate-limiter-flexible`, `@fastify/rate-limit`) as satisfying the check. It has no extension mechanism, so no amount of correctly-functioning custom code will ever clear it — confirmed empirically this session (`checkSharedRateLimit` registered as real Express middleware still gets flagged).

**Proven locally, three times as the design changed shape:**
1. Original proof: `import { rateLimit } from "express-rate-limit"` + `app.use("/api", rateLimit({...}), router)` — 213 → 0.
2. Round-2's revised (function-wrapped) mount shape — re-scanned after Codex flagged that CodeQL is pattern-sensitive and a wrapper could break recognition: still 0.
3. **This plan's actual final shape** (early-mounted, direct-passed `rateLimit(...)`, a separate non-wrapping counting middleware — see §3): re-scanned after this round's mount-order changes: **also 0.** All three scans used the CLI + database infra already set up in this session's scratchpad.

**Why not ship the simplest version as-is:** this repo's existing rate limiting is deliberately DB-backed (`rate_limit_counters` table) specifically so counts are correct across multiple server processes/instances, not per-process. This plan closes that gap: same proven CodeQL-satisfying shape, backed by a custom `Store` that reuses the existing DB table.

**Outcome:** all 213 alerts clear, no change to any existing narrow rate limiter's behavior, no new table/schema migration.

## Design

### 1. New dependency: `express-rate-limit` (^8.5.1)

Verified externally against current docs:
- Current version 8.5.1 (May 2026), actively maintained. [npm](https://www.npmjs.com/package/express-rate-limit)
- v8's `Store` interface: required async `increment(key: string): Promise<{ totalHits: number; resetTime: Date }>`, `decrement(key: string): Promise<void>`, `resetKey(key: string): Promise<void>`; optional sync `init(options)`. [Wiki](https://github.com/express-rate-limit/express-rate-limit/wiki/Creating-Your-Own-Store)
- v8 supports Express 5. [Release notes](https://github.com/express-rate-limit/express-rate-limit/releases)
- `limit` (but not `windowMs` — see §3) may be an async function evaluated per request. [Changelog](https://express-rate-limit.mintlify.app/reference/changelog)
- `passOnStoreError: true` — built-in option that allows the request through if the `Store` throws.
- `ipKeyGenerator(ip: string, ipv6Subnet = 56)` — normalizes IPv6 to a `/56` subnet, with an IPv4-mapped-IPv6 carve-out (the CVE-2026-30827 bug class). [Advisory](https://github.com/express-rate-limit/express-rate-limit/security/advisories/GHSA-46wh-pxpv-q5gq)
- `handler` signature is `(req, res, next, options)` — `next` is available, used for dry-run mode (§3). [Search-confirmed against the package's configuration reference.]

Considered and rejected: `@acpr/rate-limit-postgresql` (needs its own DB connection/table).

### 2. Custom `Store`: reuse `rate_limit_counters`, don't add a table

New file `artifacts/api-server/src/lib/globalRateLimitStore.ts`. Implements the `Store` interface using the same atomic `INSERT ... ON CONFLICT DO UPDATE` shape already proven in `checkSharedRateLimit` (`sharedRateLimiter.ts:51-68`).

**Both persisted columns are salted digests — round 3 finding, not just `key_raw`.** Round 2 fixed `key_raw` to store a salted hash instead of the plaintext key, but left `key_hash` (the primary key) as plain, unsalted `sha256("grl:" + resolvedKey)` — over the whole IPv4 space (~4 billion addresses) that's a cheaply precomputable rainbow table, so "no raw address stored" didn't actually mean "not recoverable." Both columns are now derived from the same salted digest: `key_hash = sha256("grl:" + hashIp(resolvedKey))`, `key_raw = "grl:" + hashIp(resolvedKey)` (reusing `hashIp`, `transientRenderLog.ts:68-69` — the existing salt, not a new one). Tests assert neither column equals the unsalted digest, not just that it doesn't equal the literal address.

**Production must not silently run on the dev fallback salt (round-5 finding, P2; round-6 correction of the production predicate):** `hashIp` (`transientRenderLog.ts:31-41`) falls back to a fixed, repository-known string (`overhype-dev-transient-render-salt-v1`) whenever `IP_HASH_SALT` is missing or under 16 characters — logged as a WARN, not enforced. That gap already existed for `transientRenderLog.ts`'s own usage, but this plan is about to route *every API request's* client key through the same function, materially raising the value of closing it now rather than deferring it again. Fixed with a boot-time assertion (`artifacts/api-server/src/index.ts`, alongside the app's other startup checks) that throws before the server starts accepting traffic if the environment is production and `IP_HASH_SALT` is missing or shorter than 16 characters. **Round-6 finding:** the round-5 version checked only `NODE_ENV === "production"`, but this repo's actual autoscale deployment (per `.replit`) doesn't set `NODE_ENV` — the established canonical production predicate elsewhere in this codebase (`securityHeaders.ts:44-47`'s `isProductionEnv()`, `lib/siteUrl.ts`, `lib/devAdminLogin.ts` — all three already use the identical check) is `process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production"`. The guard now uses that exact predicate rather than a narrower one-off, so the real Replit production process is actually covered, not just a hypothetical `NODE_ENV=production` deploy. This is a repo-wide fix (it protects `transientRenderLog.ts`'s existing usage too, not just this plan's new Store), scoped to a boot-time check rather than a per-request check, since the salt can't change during a process's lifetime. §4 adds a boot-time test matrix: deployment-with-unset-`NODE_ENV` (must throw without the salt), ordinary test/CI environment (must not throw), local development (must not throw).

**Window is captured via `init(options)`, not the constructor**, called once at setup before any request is handled.

**On a DB error, `increment`/`decrement`/`resetKey` let the exception propagate** — `passOnStoreError: true` (§3) is what turns that into "let the request through," not internal catch-and-degrade logic. The one `try`/`catch` in the Store is telemetry-only (increments `storeError`, logs, **rethrows** — required, or `passOnStoreError` silently breaks).

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

**Concurrency:** same single-statement `INSERT ... ON CONFLICT ... RETURNING` already proven atomic in `checkSharedRateLimit`. Verified with a real concurrency test (§5), not just sequential logic.

**Row lifetime:** `purgeExpiredRateLimitCounters()` (`sharedRateLimiter.ts:83`) had no production caller and no real test. Fixed: wired into an hourly job mirroring `jobs/transientRenderPurger.ts`'s exact self-rescheduling pattern (`jobs/rateLimitCounterPurger.ts` + `index.ts` registration), with a real test mirroring `phase4.purger.test.ts` (active + expired rows, assert the boundary) plus a scheduler-resilience test (a thrown error on one run doesn't block the next). Also strengthens the pre-existing trivial `rateLimit.test.ts:55-57` purge assertion while touching this area.

### 3. Wiring in `app.ts` — mount point, exemptions, and the dry-run rollout

**Mounted early (but after CORS), and scoped, and pattern-verified against CodeQL — addressed together because they interact:**

- **Early, but after the app-level `cors()` call — not right after `securityHeaders()` (round-4 finding, P2, correcting round 3's own position):** round 3 moved the mount to immediately after `securityHeaders()` (`app.ts:82`), before CORS. That's wrong: an allowed cross-origin request that gets rejected by this limiter would receive a 429 with **no `Access-Control-Allow-Origin` header**, since `cors()` (`app.ts:173-180`) hadn't run yet — the browser would surface an opaque CORS failure instead of the intended JSON 429, defeating the whole point of a documented error contract. Fixed by moving the mount to immediately **after** the app-level `cors()` call (`app.ts:180`), not before it. This still satisfies the original "early" goal — `cors()` itself does no DB work or parsing, it's an origin string comparison — so a rejected request still avoids paying for body parsing, CSRF, and `authMiddleware`'s DB session lookup; it just also now gets correct CORS headers on its 429. **Preflight (`OPTIONS`) requests never reach this middleware at all**, without any extra `skip` logic: verified against the `cors` package's current docs — with the default `preflightContinue: false` (this repo's config doesn't override it), `app.use(cors(...))` terminates every `OPTIONS` preflight itself and never calls `next()`, so by the time a preflight would reach our mount point it's already answered. ([cors README](https://github.com/expressjs/cors#configuration-options): "When using this middleware as an application level middleware... pre-flight requests are already handled for all routes.")
- **Scoped (round-3 finding, P2 — a regression introduced by round 2's own fix):** round 2 fixed the mount-stripping bug by moving to an *unscoped* top-level `app.use()`, which then ran for every request reaching the app, not just `/api/*`. Fixed by scoping to `app.use("/api", ...)` while keeping the exemption predicates working correctly — see the next point for how.
- **`req.originalUrl`, not `req.path`, for exemption matching:** mounting via `app.use("/api", ...)` strips the prefix from `req.path` inside the middleware — the exact mechanism that broke round 1's exemptions in the first place. Rather than reintroduce that bug by scoping back to `/api`, the exemption check here reads `req.originalUrl.split("?")[0]` (always the full, un-stripped path) instead of `req.path`. `isPublicAssetRequest` is refactored to accept an explicit path string (`isPublicAssetRequest(method, path)`) rather than a `Request`, so both call sites — the existing top-level CSRF-cookie check (passing `req.path`, correct there since it's unmounted) and this new one (passing the `originalUrl` path) — get the right value for their own mount depth from one shared implementation, instead of one of them being silently wrong again.
- **Direct-passed, not wrapped, and CodeQL-reverified (round-3 finding, P1):** `rateLimit(...)` is passed directly to `app.use()` as its own middleware argument — `app.use("/api", countGlobalLimiterRequest, globalLimiter)` — not invoked from inside a wrapping arrow function. The wrapped shape from round 2's fix was independently re-scanned and still cleared CodeQL (0 alerts), but there's no reason to keep the indirection once a direct-pass shape works too, and direct-passing is the closer match to the original proof, less exposed to a future CodeQL model becoming stricter about indirection. **This exact final shape — early mount, `/api`-scoped, direct-passed — was itself re-scanned locally and clears at 0** (see Context).
- **Exemptions are method+path pairs, not path-only (round-5 finding, P2):** `HEALTH_PATHS`/`EARLY_EXEMPT_PATHS` were plain path sets, unlike `isPublicAssetRequest` (which already checks `SAFE_METHODS`). `POST /api/healthz` or `POST /api/config` matched the path-only exemption and skipped the limiter entirely — an unmetered way to push arbitrarily many bodies through parsing even though no real route handles that method on those paths. Fixed by exempting explicit `(method, path)` pairs (`EARLY_EXEMPT_ROUTES`, below) instead of bare path sets; a wrong-method request to an exempt path now falls through to the limiter like any other route.
- **Both self-rescue admin endpoints are exempt, not just the ceiling's (round-5 finding, P2):** round 4 only exempted `PATCH /api/admin/config/global_rate_limit_max`. The rollout's own described emergency path — flipping `global_rate_limit_dry_run` back to `true` from an already-blocked admin IP — requires `PATCH /api/admin/config/global_rate_limit_dry_run`, which wasn't exempt; raising the ceiling first is only an indirect workaround (it might still be below the bucket's current count, or stale on other instances) rather than the actual rollback action working directly. Both PATCH routes are now listed in `EARLY_EXEMPT_ROUTES`.

```ts
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import {
  GlobalRateLimitStore,
  globalRateLimitMetrics,
  recordBlockedOutcome, // in-memory, non-blocking — see the fleet-metrics note below
} from "./lib/globalRateLimitStore";
import { ipFromRequest } from "./lib/transientRenderLog";
import { getGlobalRateLimitRolloutConfig } from "./lib/globalRateLimitStore"; // see the rollout-config note below
import { logger } from "./lib/logger";

const GLOBAL_RATE_WINDOW_MS = parsePositiveInt(process.env.GLOBAL_RATE_WINDOW_MS, 60_000);
// (method, path) pairs, not bare paths — round-5 finding: a path-only set let
// a wrong-method request (e.g. POST /api/healthz) bypass the limiter even
// though no real route handles that method there.
const EARLY_EXEMPT_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/api/healthz" },
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/api/health/queues" },
  { method: "POST", path: "/api/stripe/webhook" },
  { method: "GET", path: "/api/config" },
  { method: "PATCH", path: "/api/admin/config/global_rate_limit_max" }, // ceiling self-rescue — see §5
  { method: "PATCH", path: "/api/admin/config/global_rate_limit_dry_run" }, // dry-run self-rescue — round-5 finding
];

function isExemptRequest(req: Request): boolean {
  const path = req.originalUrl.split("?")[0];
  if (isPublicAssetRequest(req.method, path)) return true;
  return EARLY_EXEMPT_ROUTES.some((r) => r.method === req.method && r.path === path);
}

function countGlobalLimiterRequest(req: Request, res: Response, next: NextFunction): void {
  if (isExemptRequest(req)) return next();
  globalRateLimitMetrics.totalThisInstance++; // process-local — see the metrics note below
  next();
}

// Headers express-rate-limit may have already set on `res` before `handler`
// runs, under either the draft-6 (individual headers) or draft-7 (combined
// header) shape `standardHeaders: true` can resolve to — stripped as a
// superset since removeHeader on an absent header is a no-op either way.
// `legacyHeaders: false` (below) means the X-RateLimit-* set should never be
// set in the first place; still listed here as defense in depth against a
// future package-default change (round-5 finding).
const STANDARD_RATE_LIMIT_HEADERS = [
  "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", // draft-6
  "RateLimit", "RateLimit-Policy",                              // draft-7
  "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", // legacy
  "Retry-After",
];

// Throttles the per-block WARN log to at most one line/second/process (round-5
// finding, P2): during a sustained-abuse burst every request past the ceiling
// would otherwise emit its own WARN, turning an unbounded request stream into
// an unbounded log stream. The DB-backed day-bucketed counters (below) are the
// real decision signal; this log line is an operational breadcrumb and loses
// no decision-relevant information by being throttled.
let lastBlockLogAt = 0;
function logBlockedThrottled(fields: Record<string, unknown>, msg: string): void {
  const now = Date.now();
  if (now - lastBlockLogAt < 1000) return;
  lastBlockLogAt = now;
  logger.warn(fields, msg);
}

// Ceiling for the ceiling itself (round-6 finding, P2): the migration seeds
// `max_value = MAX_GLOBAL_RATE_LIMIT` on the admin_config row so future
// admin PATCHes are bounded, and this same constant is the read-time clamp
// — one number, not two that could drift. 1,000,000 req/min/IP is far above
// any legitimate ceiling (600 default); it exists only to make a stale
// excessive stored value harmless, the same way the floor makes a stale
// zero/negative value harmless.
const MAX_GLOBAL_RATE_LIMIT = 1_000_000;

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  // `getGlobalRateLimitRolloutConfig()` — see the rollout-config note below
  // for why this replaced separate getConfigIntRaw/getConfigBooleanFresh
  // calls (round-6 findings, P1+P2). Clamped to [1, MAX_GLOBAL_RATE_LIMIT]
  // (round-5 + round-6): a stored value of 0/negative/excessive would parse
  // successfully and pass straight through otherwise, and the migration
  // deliberately never rewrites an existing `value` (§4), so a stale
  // out-of-range row must be made harmless at read time.
  limit: async () => {
    const { max } = await getGlobalRateLimitRolloutConfig();
    return Math.min(MAX_GLOBAL_RATE_LIMIT, Math.max(1, max));
  },
  store: new GlobalRateLimitStore(),
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false, // round-5 finding: the default-true X-RateLimit-* set otherwise survives a dry-run response
  skip: (req) => isExemptRequest(req),
  handler: async (req, res, next) => {
    const path = req.originalUrl.split("?")[0];
    // Fast, bounded-query-volume, debug-overlay-bypassing read — see the
    // rollout-config note below for why this isn't a genuinely uncached
    // per-request read (that was round 5/6's design, and two round-6
    // findings correctly showed why it was wrong).
    const { dryRun } = await getGlobalRateLimitRolloutConfig();
    if (dryRun) {
      // Zero-impact means zero impact: express-rate-limit has already set
      // RateLimit-*/Retry-After headers on `res` by this point (before
      // `handler` is invoked), and a client that honors them would throttle
      // itself even though nothing was actually blocked. Strip them before
      // falling through.
      for (const header of STANDARD_RATE_LIMIT_HEADERS) res.removeHeader(header);
      recordBlockedOutcome("dry_run"); // in-memory, non-blocking — see below
      logBlockedThrottled({ path, mode: "dry_run" }, "global rate limit would have blocked (dry-run)");
      return next(); // observe, don't enforce — see the rollout note below
    }
    recordBlockedOutcome("enforced");
    logBlockedThrottled({ path, mode: "enforced" }, "global rate limit exceeded");
    res.set("Cache-Control", "no-store");
    res.status(429).json({ error: "Too many requests. Please slow down." });
  },
});

// Mounted after the app-level cors() call, not right after securityHeaders()
// — see the mount-point note above for why.
app.use("/api", countGlobalLimiterRequest, globalLimiter);
```

**Fleet-wide metrics: decoupled from the response path, batched, and time-bucketed (round-4 P1 redesign, further corrected by round-5 P1/P2 findings — this has now failed twice in different ways, so the current design is explained in full):**

- **Round 4's version was itself a correctness *and* a latency bug.** Persisting `blockedDryRun`/`blockedEnforced` fleet-wide fixed the process-local problem (round 4), but doing it via an `await`ed upsert to one shared reserved row, *inside the response path*, meant every instance serialized on that row during exactly the traffic this middleware exists to absorb — an over-limit burst. `passOnStoreError` does not cover this: that option only governs the rate-limit `Store`'s own calls, not an arbitrary DB call made inside `handler`, so a slow/contended metric write directly added to response latency for every blocked request, and the `.catch()` only suppressed the *error*, not the *wait*.
- **Fixed by moving the DB write out of the response path entirely.** `recordBlockedOutcome(mode)` in `globalRateLimitStore.ts` is now a synchronous, in-memory increment of a per-process pending counter (`pendingBlockedDryRun` / `pendingBlockedEnforced`) — no `await`, no DB call, no pool contention, on `handler`'s critical path. `handler` returns to the client immediately regardless of database state.
- **A separate periodic flush (every 10s, its own `setInterval`, not the hourly purger) drains the pending counters into the database**, once per interval per instance: capture-and-zero the in-memory counter (safe without a lock — Node is single-threaded, so nothing can increment between the read and the reset), then a single `INSERT ... ON CONFLICT (key_hash) DO UPDATE SET count = count + $pending` per non-zero counter — the same atomic upsert shape the Store already uses, now writing an *additive delta* instead of a per-request `+1`. This turns "one row-lock acquisition per blocked request, fleet-wide" into "at most one write per instance per 10 seconds," independent of burst size.
- **A failed flush restores the captured delta rather than discarding it (round-6 finding, P2):** round 5's capture-and-zero was correct for the crash case but silently dropped data on an ordinary transient DB failure too (exactly the kind the new query-timeout wrapper, below, now makes more frequent under real DB degradation). Fixed: on a rejected flush, the captured delta is added back onto whatever the pending counter has accumulated since (`pendingBlockedX += capturedDelta`) rather than discarded, so the next successful flush drains the full backlog. This is bounded by actual request volume during the outage (the same bound the DB row itself would have), not unbounded growth. A test drives a failed flush followed by a successful one and asserts no count is lost.
- **The flush interval is `unref()`'d and independently disposable (round-6 finding, P2):** matching the existing pattern (`shutdown.ts`'s `forceExitTimer.unref()`) rather than introducing a new one — an unreffed timer doesn't keep the Node process alive on its own, so test processes that import `app.ts` still exit deterministically once their own work is done. `globalRateLimitStore.ts` also exports `stopFleetMetricsFlush()`/an injectable interval hook so integration tests can start/stop the flush loop explicitly rather than relying on ambient timing.
- **Pending metrics are flushed on graceful shutdown, not just left to the next interval (round-6 finding, P2):** on a routine autoscale SIGTERM (not a crash), `src/shutdown.ts`'s `attachShutdownHandlers` calls `onClose()` and exits — inspected the actual code and confirmed `onClose` is invoked synchronously with no await, so an async flush added there wouldn't be waited on as-is. `attachShutdownHandlers`'s contract is extended to accept an `onClose` that may return a `Promise`, awaited before `safeExit(0)` — still bounded by the existing `gracePeriodMs` force-exit timer as the safety net if the flush itself hangs, so this doesn't weaken the existing shutdown-timeout guarantee. `index.ts`'s `onClose` now calls the new `flushPendingFleetMetrics()` before logging "Server closed." Repeated short-lived autoscale cycling was round 6's specific concern — this closes it directly rather than accepting the loss as given.
- **Trade-off that remains, stated plainly:** a hard process kill (not a graceful SIGTERM — e.g. an OOM kill or `SIGKILL`) still loses up to ~10 seconds of pending counts, since there's no hook to intercept an unclean termination. Acceptable for an approximate operational decision signal, not acceptable if this were a security-enforcing count (it isn't; enforcement itself doesn't depend on these counters at all).
- **Keys are day-bucketed, not eternal (round-5 finding, P2 — overflow):** `rate_limit_counters.count` is a plain Postgres `integer` (`lib/db/src/schema/rateLimit.ts:6`), and round 4's design used one eternal row per outcome with a 2099 sentinel expiry — under sustained abuse (the exact scenario this middleware targets) that row's count climbs forever and would eventually overflow `int4` (2,147,483,647), after which every further increment throws and the "decision-critical" count silently freezes. Fixed by keying on `grl:metrics:blocked_{dry_run,enforced}:YYYY-MM-DD` (UTC date computed at flush time) — a fresh key each day means no single row can approach the 32-bit ceiling (at a wildly pessimistic 10,000 blocked req/sec sustained for 24h, one day's bucket is ~864M, still under `int4`'s max), and it removes the "never expire" special case entirely: each day-bucket row gets a real, generous expiry (35 days) and is cleaned up by the ordinary purger like every other row — no purger exemption list needed.
- **The day-bucketing doubles as the decision signal round 5 asked for (P2 — "expose distribution, not just a total"):** a single cumulative number can't distinguish a scraper (concentrated, growing) from steady low-level shared-NAT background (flat, spread out). The metrics endpoint now returns the last 7 UTC days of `{ date, blockedDryRun, blockedEnforced }` as a time series instead of one opaque total — round-4's "never reset across the flip" property still holds (a day's bucket just gets both sub-counts if the flip happens mid-day; nothing is manually zeroed). Complementing the trend, the endpoint also computes a **live snapshot gauge** — `distinctBucketsOverLimitNow`: `SELECT count(*) FROM rate_limit_counters WHERE key_raw LIKE 'grl:%' AND key_raw NOT LIKE 'grl:metrics:%' AND count >= <current limit> AND expires_at > now()` — **filtered on `key_raw`, not `key_hash` (round-6 finding, P1, a real bug in the round-5 version):** `key_hash` is *always* a 64-character SHA-256 hex digest for every row in this table, including the reserved metric rows — it never literally contains the `"grl:"` prefix, so a `key_hash LIKE 'grl:%'` predicate matched zero rows unconditionally and this gauge would have silently always returned 0 regardless of real traffic. `key_raw` is the column that actually carries the literal `"grl:"`-prefixed string for both real client rows (`` `grl:${hashIp(...)}` ``) and the reserved metric rows (`` `grl:metrics:...` ``), so filtering there is what makes the query correct — how many distinct client buckets are over the ceiling *right now*, from data the Store is already collecting (no new storage). A handful of buckets at a high count reads as a scraper; hundreds of buckets each barely over reads as shared-NAT background. Neither signal requires storing anything more identifying than what's already persisted. §4's test asserts this against actual persisted client rows, not just that the query executes.
- **These reserved-key rows are exempt from `key_raw` salting** — `key_raw` stores the literal reserved key string (e.g. `"grl:metrics:blocked_dry_run:2026-08-01"`), not a salted hash. The salting requirement (§2) exists to avoid persisting anything IP-derived; a static, date-suffixed operational label isn't IP-derived or otherwise sensitive — hashing it would only obscure an already-public, predictable constant for no privacy benefit. `key_hash` (the primary key) still stores `sha256(key)`, consistent with every other row's primary-key shape, so the exception is confined to `key_raw` and doesn't create two different primary-key conventions in one table.
- **Namespace collision is provably impossible, not just unlikely:** the reserved keys use a `"grl:metrics:"` sub-prefix that a real client key can never produce. Every real key is `` `grl:${hashIp(ipKeyGenerator(...))}` `` (§2/§3) — a `"grl:"` prefix immediately followed by a hex SHA-256 digest, which cannot contain the literal ASCII substring `"metrics:"` at that position by construction (a digest is `[0-9a-f]{64}`). A test asserts this directly by hashing a large sample of IPv4/IPv6/subnet strings and confirming none begins with `metrics:`.
- **`totalThisInstance` and `storeErrorThisInstance` stay in-memory and process-local**, explicitly labeled as such in both the metric object's field names and the endpoint response — they're context, not the safety-critical signal, and persisting them would add DB writes to a hot path (`total`) or a circular one (`storeError`, which fires when a DB call already failed) for no decision-relevant benefit.

**Observable sink:** `GET /api/admin/rate-limit-metrics` (behind existing admin auth) returns `{ blockedByDay: [{ date, blockedDryRun, blockedEnforced }, ...last 7 days], distinctBucketsOverLimitNow, totalThisInstance, storeErrorThisInstance }`, with the response documenting which fields are fleet-wide (DB-backed: `blockedByDay`, `distinctBucketsOverLimitNow`) and which are this-instance-only (`totalThisInstance`, `storeErrorThisInstance`) — so David isn't misled into reading the latter as a fleet total.

**Dry-run rollout — replaces the earlier "watch after the fact" plan with an actual pre-enforcement measurement (round-3 finding, Reconciliation):** round 2's post-rollout monitoring rule couldn't distinguish a scraper being correctly blocked from a legitimate shared-NAT population being incorrectly blocked — both produce the same "many blocks from one key" signal, and the plan had no way to tell them apart. Rather than invent a differentiation heuristic (path diversity, request timing, etc. — all guesses without real data), the rollout now has an actual **observe-before-enforce** phase: `global_rate_limit_dry_run` (new `admin_config` boolean, default `true`) makes `handler` count and log what *would* have been blocked but always calls `next()` instead of returning 429 while dry-run is active, with the enforcement headers stripped (see above) so the observe phase is genuinely zero-impact. This means the first deployment collects real, fleet-accurate block-rate *and* distribution data against real traffic, with zero user-facing risk, before a single legitimate request is ever actually rejected. David flips `global_rate_limit_dry_run` to `false` (live, no deploy) once the trend and distribution signals show no plausible false-positive pattern over an observation window — replacing the earlier "72 hours, then decide from imperfect signal" rule with "watch real fleet-wide dry-run data, then decide, on your own timeline."

**Fleet-consistency of the ceiling and the dry-run flag — `getGlobalRateLimitRolloutConfig()` (round-4 P2, revised twice more by round-5 and round-6 — this is the third design, explained in full because the first two each traded one failure mode for another):**

- **Round 4's version** used `adminConfig.ts`'s general 60-second cache for both values — fine for `limit` (read on every request, needs the cache for load reasons), wrong for the dry-run flag: `bustConfigCache()` only clears the instance that served the admin PATCH, so on autoscale, other instances would keep evaluating the *old* value for up to 60 seconds, a real risk in an emergency false→true rollback.
- **Round 5's fix** made `handler`'s dry-run check a genuinely uncached, per-request DB read (`getConfigBooleanFresh`) — this fixed the staleness problem but created a new one, caught in round 6: under a sustained over-limit burst (the exact traffic this middleware exists to handle), *every* blocked request now issued its own DB query before responding, recreating the exact response-path amplification problem the fleet-metrics batching redesign (above) had just eliminated for the metrics write. Round 6 separately caught that the *ceiling* (`limit`, still on the 60s cache) had never gotten the same fast-propagation fix the dry-run flag did — an emergency ceiling change could still take up to a minute to reach every instance.
- **Fixed by `getGlobalRateLimitRolloutConfig()`: one combined, short-TTL, single-flighted read for both values, decoupled from request volume.** A single `SELECT ... WHERE key IN ('global_rate_limit_max', 'global_rate_limit_dry_run')` (bypassing `adminConfig.ts`'s general cache and its `debug_mode_active` overlay entirely — reading `.value` directly, same rationale as the retired `getConfigIntRaw`/`getConfigBooleanFresh` raw-read convention) is cached for **2 seconds**, refreshed via the same single-flight pattern already used elsewhere in this plan (concurrent callers during a cache-miss window await one shared in-flight query, not one each). Both `limit` and `handler` call this one function. This bounds DB query volume to **at most one query per instance per 2 seconds, regardless of how many requests or blocked requests arrive in that window** — the amplification round 6 found is gone, because query volume no longer scales with traffic at all — while still propagating an emergency change (either the ceiling or the dry-run flag) to every autoscale instance within 2 seconds, an order of magnitude faster than the general cache's 60s TTL and fast enough for a real emergency rollback.
- **No PATCH-triggered invalidation-broadcast is needed.** A 2-second worst case is already short enough that building cross-instance cache-invalidation infrastructure (pub/sub, a version counter, etc.) isn't proportionate — the same reasoning round 4 already applied when it rejected building shadow-traffic infrastructure for the shared-NAT question. §5's multi-instance test simulates two instances' independent caches and asserts a PATCH's effect is visible on both within the 2-second bound, not just on the instance that served the write.
- **`EARLY_EXEMPT_ROUTES` above exempts both self-rescue PATCH routes** so an emergency rollback (raising the ceiling, or flipping dry-run back to `true`) can always reach the admin endpoint even from an already-blocked admin IP, regardless of this config-propagation mechanism.
- **Fails safe on any malformed stored value:** a `global_rate_limit_max` that isn't a valid positive integer falls back to the code default (600) before the `[1, MAX_GLOBAL_RATE_LIMIT]` clamp even applies; a `global_rate_limit_dry_run` that isn't exactly `"true"`/`"false"` falls back to `true` (stay in dry-run) — never coercing an unrecognized value toward enforcement. (The admin PATCH endpoint now also rejects a malformed boolean value at write time — round-6 finding, §4 — so this fallback is a defense-in-depth backstop, not the only guard.)

**`Cache-Control: no-store` on the enforced 429** (round-3 finding, folded in here): the earlier mount position was covered by the existing `noStore` middleware list (`app.ts`, later in the chain); the new earlier position isn't, so a 429 could otherwise be cached by an intermediate proxy and served stale to a since-recovered client. Set directly in `handler` rather than relying on the later `noStore` list, since this middleware now runs before it.

**Admin routes — genuinely open, not decided here (round-3 finding, P1, tagged Product Decision):** `current-roadmap.md:280-288` already records rate-limiting admin routes as an explicit, still-pending David decision. This plan's mount change (scoped to all of `/api`, moved earlier) would silently resolve that question by inclusion — every admin route now sits behind this ceiling too, including, worse, `/api/admin/config/:key` itself, the endpoint that raises the ceiling if it's ever set too low. Two things, kept separate:
- **Both self-rescue endpoints are exempted regardless of the broader answer** (`EARLY_EXEMPT_ROUTES` above) — a limiter that can trap its own escape hatch is a design defect independent of whether admin routes in general should be covered, so this part isn't waiting on David.
- **Whether the rest of `/api/admin/*` sits behind this ceiling is not decided by this plan.** That's the pre-existing open roadmap question, and this plan doesn't get to answer it by omission. Flagged to David as a real fork — see the PR thread.

**Bounded deadlines on every fail-open database call (round-5 finding, P1; round-6 correction of the mechanism, P2):** `passOnStoreError: true` (§2) only lets a request through *after* a Store call's promise rejects — but the shared `pg.Pool` (`lib/db/src/index.ts:72-88`) configures no `statement_timeout` or `connectionTimeoutMillis`, so a stalled socket or exhausted pool can leave `increment()` (and the config reads on this same request path) queued indefinitely rather than rejecting promptly.

- **Round 5's fix was wrong in scope.** Adding `statement_timeout`/`connectionTimeoutMillis` to the *shared* Pool config bounds every query on that pool, not just this middleware's — `migrate.ts`'s production migration runner, backfills, and batch jobs all obtain clients from the same pool (`lib/db/src/index.ts:99-107` and elsewhere), and any of their legitimately-longer-running statements would now be canceled at 10s, potentially breaking startup migrations or unrelated batch work. That's a real regression this plan should not cause just to fix its own fail-open latency.
- **Fixed by scoping the deadline to only this middleware's own database calls, in application code, not at the Postgres/pool-config level.** A small `withTimeout(promise, ms)` helper in `globalRateLimitStore.ts` races a DB call against a `setTimeout`-based rejection and is applied to: the Store's `increment`/`decrement`/`resetKey`, and the query inside `getGlobalRateLimitRolloutConfig()`'s single-flighted refresh (§3) — the one shared DB call behind both `limit` and `handler`. This achieves the same fail-open-within-single-digit-seconds guarantee round 5 wanted, without touching the shared Pool config or its blast radius — the deadline (5s) bounds wall-clock time regardless of *why* a call is slow (pool exhaustion, a stalled socket, or anything else), so it's not weaker than a pool-level timeout for this middleware's own purposes, just correctly scoped. The round-5 shared-Pool change is removed from this plan's files-touched list entirely — no changes to `lib/db/src/index.ts`.
- §4/§5 keep the never-resolving/pool-starved mock test from round 5, now asserting it against the `withTimeout` wrapper specifically, and add a case confirming an unrelated slow query on the shared pool (simulating a migration/backfill) is *not* affected.

**Purge coordination across autoscale instances (round-5 finding, P2; round-6 correction of the mechanism, P2×2):** `jobs/rateLimitCounterPurger.ts` (§2) is registered from `index.ts` in every process and aligned to the top of the hour — on autoscale, every live instance fires the same `DELETE WHERE expires_at < now()` concurrently, contending for the same row locks and pool capacity for redundant work (only one delete pass is actually useful). Fixed by wrapping the purge run in a Postgres advisory lock, with two round-6 corrections to the round-5 version:

- **The lock is acquired and released on one checked-out client, not separate pooled calls.** `pg_try_advisory_lock`/`pg_advisory_unlock` are session-scoped — issuing them as independent `db.execute(...)` calls (as round 5's description implied) can route each to a *different* pooled connection, meaning the unlock silently does nothing while the original session (still holding the lock) sits idle in the pool, permanently starving future purge cycles on whichever instance happened to acquire it first. Fixed: `pool.connect()` obtains one client; lock acquisition, every purge batch, and `pg_advisory_unlock` all run on that same client, released in `finally` (`client.release()`), whether the run succeeds or a batch throws partway through.
- **The lock key is a documented, reserved, two-integer namespace, not an arbitrary fixed value.** Postgres advisory locks share one database-wide namespace — an undocumented key risks a silent future collision with an unrelated feature. `RATE_LIMIT_PURGER_LOCK` is defined as a constant pair (e.g. `(0x52_4c_50, 1)` — a memorable classid derived from "RLP" plus a fixed object id) in `globalRateLimitStore.ts`, with a comment reserving that pair explicitly for this purger and instructing any future advisory-lock user in this codebase to pick a different pair.

The delete itself is also changed from one unbounded statement to a bounded-batch loop (delete up to 1,000 rows per statement, repeat until zero rows affected) so a large backlog doesn't hold locks for an extended single transaction. §5 adds a test asserting that only one of two concurrent purge-run simulations performs the delete, and a case covering a thrown error mid-batch still releases the lock (not just clean two-runner contention).

### 4. Files touched

- `artifacts/api-server/package.json` and the regenerated root `pnpm-lock.yaml` — add `express-rate-limit`.
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new: the `Store` implementation; `globalRateLimitMetrics` (process-local `totalThisInstance`/`storeErrorThisInstance`); `recordBlockedOutcome(mode)` (in-memory, non-blocking pending-counter increment — §3); the `unref()`'d 10s flush interval (plus `stopFleetMetricsFlush()`/`flushPendingFleetMetrics()` for tests and graceful shutdown — round-6 findings) that drains pending counts into day-bucketed `rate_limit_counters` rows via atomic delta-upsert, restoring the captured delta on a failed flush rather than discarding it (round-6 finding); `readFleetMetrics()` (last-7-days time series + the live `distinctBucketsOverLimitNow` gauge, now correctly filtered on `key_raw` — round-6 finding, P1) for the admin endpoint; `withTimeout()` (round-6 finding, P2, §3) — the scoped, application-level deadline wrapper replacing round 5's shared-Pool-config approach; `RATE_LIMIT_PURGER_LOCK` — the documented, reserved advisory-lock key pair; **`getGlobalRateLimitRolloutConfig()`** (round-6 findings, P1+P2, §3) — the combined, 2-second single-flighted, debug-overlay-bypassing read of `global_rate_limit_max`/`global_rate_limit_dry_run` that replaced separate `getConfigIntRaw`/`getConfigBooleanFresh` call sites, bounding DB query volume independent of request/block volume while still propagating an emergency change fleet-wide within 2 seconds.
- `lib/db/migrations/0095_global_rate_limit_max_config.sql` **and its `lib/db/migrations/meta/_journal.json` entry** — round-3 finding: the production migration runner (`migrate.ts:140-143`) only applies files with a matching journal entry; a SQL file alone is silently never run. Idempotent seed of `global_rate_limit_max` (default 600, `max_value: MAX_GLOBAL_RATE_LIMIT` — round-6 finding, P2) and `global_rate_limit_dry_run` (default `true`).
  - **`ON CONFLICT DO UPDATE` now repairs structural columns, not just the three round-3 had (round-4 finding, P2):** the conflict clause sets `label`/`description`/`data_type`/`min_value`/`max_value`/`is_public` unconditionally on every run while leaving `value` untouched. A stored `value` that's already out-of-bounds or non-numeric is deliberately left as-is by the migration; the read-time fallback (§3's `[1, MAX_GLOBAL_RATE_LIMIT]` clamp and `getGlobalRateLimitRolloutConfig`'s safe-default behavior) is what makes a malformed or out-of-range stored value harmless — clamping both ends now, not just the floor (round-6 correction of round 5's `Math.max`-only version).
  - **Registered as snapshot-exempt (round-4 finding, P2):** `0095_global_rate_limit_max_config` is added to `SNAPSHOT_EXEMPT_TAGS` with a comment stating it's pure DML.
- `artifacts/api-server/src/lib/adminConfig.ts` — **add single-flight refresh to `loadAll()`** (round-3 finding): concurrent callers await one shared in-flight promise instead of each issuing a query on a cache miss. (The ceiling and dry-run flag no longer read through this module's general cache at all — round-6 findings moved them to `globalRateLimitStore.ts`'s own dedicated, faster cache; `getConfigIntRaw`, used elsewhere in this codebase, is unaffected and unchanged.)
- `artifacts/api-server/src/routes/admin.ts` — new `GET /api/admin/rate-limit-metrics` route (existing admin-auth pattern) returning `{ blockedByDay, distinctBucketsOverLimitNow, totalThisInstance, storeErrorThisInstance }` (§3). **New (round-6 finding, P2):** the config PATCH handler (`admin.ts:2236-2266`) gets a `dataType === "boolean"` validation branch — today it validates `"integer"`/`"float"` but silently accepts any string for a boolean row (e.g. `"False"`, a typo), which `getConfigBooleanFresh` would then quietly fall back away from at read time while the admin PATCH itself returned 200. The new branch rejects (400) any value that isn't exactly the literal string `"true"` or `"false"`, matching the storage convention `getPublicConfig()` already assumes elsewhere. This isn't specific to `global_rate_limit_dry_run` — it's a real, general gap in the admin PATCH endpoint that this plan is what surfaces, so it's fixed at the endpoint level.
- `artifacts/api-server/src/app.ts` — mount early, immediately after the app-level `cors()` call, scoped to `/api`, direct-passed; refactor `isPublicAssetRequest` to take an explicit path argument; `EARLY_EXEMPT_ROUTES` as method+path pairs (round-5 finding).
- `artifacts/api-server/src/jobs/rateLimitCounterPurger.ts` — new, mirrors `jobs/transientRenderPurger.ts`, plus the advisory-lock-on-one-checked-out-client + bounded-batch delete loop described above (round-5/round-6 findings); `index.ts` gets the matching `scheduleRateLimitCounterPurger()` call. (Fleet-metric rows are day-bucketed with a real 35-day expiry, so this purger cleans them up like any other row — no exemption list needed.)
- `artifacts/api-server/src/index.ts` — **boot-time assertion** (round-5 finding, round-6 correction of the predicate, §2): throws before the server accepts traffic if the *canonical* production predicate (`REPLIT_DEPLOYMENT === "1" || NODE_ENV === "production"` — matching `securityHeaders.ts`'s existing `isProductionEnv()`, `siteUrl.ts`, `devAdminLogin.ts`) is true and `IP_HASH_SALT` is missing/short. `index.ts`'s shutdown `onClose` now also calls `flushPendingFleetMetrics()` (round-6 finding).
- `artifacts/api-server/src/shutdown.ts` — **`onClose` may now return a `Promise`, awaited before `safeExit(0)`** (round-6 finding, P2), still bounded by the existing `gracePeriodMs` force-exit timer as the safety net if the flush hangs. This is the one change in this plan outside the rate limiter's own files besides the admin-endpoint validation gap above — both are pre-existing, general gaps this plan's own requirements happened to surface, not scope creep.
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new: Store unit tests (increment/decrement/resetKey semantics, both persisted columns are salted, window/expiry rollover), a real concurrency test, and fleet-metrics tests: `recordBlockedOutcome`/flush produces the correct day-bucketed delta; a collision-impossibility test hashing a large sample of IPv4/IPv6/subnet strings and asserting none produces a `key_raw` beginning with `metrics:`; day-bucket rows get a real (not eternal) expiry and are deleted by the purger once past it; a failed flush followed by a successful one loses no count; `withTimeout()` rejects a never-resolving promise at its configured deadline and resolves normally otherwise; `distinctBucketsOverLimitNow` is asserted against real persisted client rows, not just that the query executes. **New (round-6, the two findings not in the round-6 trigger comment but caught in the same review pass):** `getGlobalRateLimitRolloutConfig()` issues at most one DB query per 2-second window regardless of concurrent-caller volume (single-flight proof, directly exercising the P1 amplification finding); a value written via one simulated instance's cache is visible to a second simulated instance's cache within the 2-second TTL, for both the ceiling and the dry-run flag (the P2 fleet-propagation finding).
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new: real-`app` integration test with an injectable low limit — 429/JSON-body/headers/no-store, exempt paths never touch the Store (asserted via hit count) including the non-`/api`-request case, `ipKeyGenerator` behavior, `passOnStoreError`, dry-run mode (blocked-but-passed-through, asserting **no** `RateLimit-*`/`X-RateLimit-*`/`Retry-After` headers survive), trusted-IP resolution order, CORS-position and preflight-never-touches-Store, dry-run→enforcement flip without counter reset, wrong-method-on-exempt-path, a never-resolving mock Store proving `withTimeout` (round-6-corrected) still reaches `next()` within budget, bounded WARN log volume under a sustained burst, `PATCH /api/admin/config/global_rate_limit_dry_run` reachability from an already-over-limit admin bucket. **New (round-6):** a slow unrelated query on the shared pool (simulating a migration/backfill) is unaffected by the rate limiter's own deadline (proves the scoped-`withTimeout` fix doesn't have round 5's blast radius); a sustained over-limit burst issues at most one `admin_config` query per 2 seconds regardless of burst size (the amplification finding, exercised end-to-end through the real middleware, not just the unit-level single-flight proof above).
- `artifacts/api-server/src/__tests__/rateLimitCounterPurger.test.ts` — new, mirrors `phase4.purger.test.ts`; a simulated two-instance concurrent purge run asserts only one actually performs the delete; a large synthetic backlog is deleted in bounded batches. **New (round-6):** a purge run that throws mid-batch still releases the advisory lock (asserted by a subsequent run successfully acquiring it), and the lock/unlock pair is asserted to run on the same checked-out client.
- `artifacts/api-server/src/__tests__/index.saltGuard.test.ts` (round-6 finding) — boot-time assertion matrix: production (`REPLIT_DEPLOYMENT=1`, `NODE_ENV` unset) without a valid salt throws; ordinary test/CI environment does not throw; local development does not throw.
- `lib/db/src/migrate.test.ts` (round-5 finding — corrects round 4's proposed path, which sat outside `lib/db/package.json`'s `src/**/*.test.ts` test glob) — covers the four row states against `0095`'s conflict clause, including an above-`max_value` row asserted against the *resolved, both-ends-clamped* limit (round-6 correction — round 5's version only exercised the floor). Verification names `pnpm --filter @workspace/db test` explicitly.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — add the resolution.

### 5. Must not change

- **The existing narrow limiters' own behavior and thresholds are unchanged.**
- **Explicitly exempt, reachable regardless of this middleware's Store state or configured ceiling:** health/liveness, the existing public crawler-asset patterns, `/api/config`, the Stripe webhook, and **both** admin self-rescue endpoints — matched on **method and path together**, not path alone.
- **Whether the rest of `/api/admin/*` is covered by this ceiling is an open product question, not settled by this plan.**
- **Ships in observe-only (dry-run) mode by default** — no request is actually blocked until `global_rate_limit_dry_run` is explicitly set to `false` (and only a validated `"true"`/`"false"` PATCH can ever change it — round-6 finding), and the dry-run response carries no `RateLimit-*`/`X-RateLimit-*`/`Retry-After` headers.
- **Mounted after the app-level `cors()` call, not before it.**
- No new table/schema migration for `rate_limit_counters`; the `count` column stays `integer` — fleet-metric keys are day-bucketed specifically so no row can approach overflow.
- No raw client IP addresses, and no unsalted digest of one, persisted anywhere or emitted in metrics/logs — enforced at boot for production using the **canonical** production predicate (round-6 correction), not just documented.
- **`blockedByDay`/`distinctBucketsOverLimitNow` are fleet-wide and DB-backed; `totalThisInstance`/`storeErrorThisInstance` are explicitly process-local** — the metrics endpoint response must keep labeling which is which. `distinctBucketsOverLimitNow` must be computed from `key_raw`, not `key_hash` — the latter is always a hash and can never match a `LIKE 'grl:%'` predicate (round-6 finding, P1).
- A migration re-run must never silently widen or remove `global_rate_limit_max`'s/`global_rate_limit_dry_run`'s bounds/type/visibility on an existing, partially-provisioned row — only `value` is left untouched across a re-run; every other column is repaired.
- **No DB call on the rate-limiter's own hot path is unbounded** — bounded via an application-level `withTimeout()` scoped to only this middleware's calls, not a shared-Pool-level timeout that would also cancel unrelated legitimate work (round-6 correction of round 5's approach — no changes to `lib/db/src/index.ts`'s Pool config).
- **The global ceiling and the dry-run flag never resolve through the `debug_mode_active` overlay.**
- **DB query volume for the ceiling/dry-run read must not scale with request or blocked-request volume** — `getGlobalRateLimitRolloutConfig()`'s 2-second single-flighted cache is what a per-request uncached read (round 5's design) would have violated under sustained abuse (round-6 finding, P1).
- **An emergency change to either `global_rate_limit_max` or `global_rate_limit_dry_run` must reach every autoscale instance within the 2-second cache TTL**, not the general `admin_config` cache's 60-second TTL (round-6 finding, P2 — the ceiling had never gotten this fix even after the dry-run flag did).
- **Pending fleet-metrics counts survive a graceful shutdown** (flushed in `onClose` before exit) — only an unclean process kill between flushes can lose up to ~10s of data, an accepted trade-off for an approximate signal, not a security-enforcing one.
- **The advisory-lock key pair reserved for the purger (`RATE_LIMIT_PURGER_LOCK`) must not be reused by any other feature** — it is this codebase's first advisory-lock user and establishes the convention.

## Verification

1. `pnpm run typecheck` / `pnpm run build` — clean. `pnpm install --frozen-lockfile` succeeds. `pnpm --filter @workspace/db check-snapshots` passes. `pnpm --filter @workspace/db test` passes.
2. New `GlobalRateLimitStore` unit tests pass, including concurrency, the salted-both-columns assertion, the fleet-metrics collision-impossibility test, day-bucket-rows-expire-and-get-purged, the failed-flush-restores-delta test, `withTimeout()`'s deadline behavior, `getGlobalRateLimitRolloutConfig()`'s bounded-query-volume single-flight proof, and its two-simulated-instance propagation-within-2-seconds proof for both the ceiling and the dry-run flag.
3. New real-`app` integration test passes: 429 (when not in dry-run) + JSON body + `Cache-Control: no-store` + headers past an injected low limit; dry-run mode logs/counts but never blocks and carries no rate-limit-related headers at all; exempt paths (including non-`/api` paths and wrong-method-on-exempt-path) never touch the Store; trusted-IP precedence proven against actual bucket sharing; `ipKeyGenerator` IPv6/IPv4-mapped handling; `passOnStoreError` via a forced Store error and via a never-resolving mock proving `withTimeout` makes fail-open actually fast **without affecting an unrelated slow query on the shared pool** (round-6); CORS-position and preflight-never-touches-Store; dry-run→enforcement flip without counter reset; the dry-run-flag rollback PATCH is reachable from an already-blocked admin bucket; a sustained blocked burst produces a bounded WARN log volume **and at most one `admin_config` query per 2 seconds regardless of burst size** (round-6, end-to-end proof of the amplification fix).
4. New purger tests pass, including day-bucket rows expiring normally, the advisory-lock single-runner proof under simulated multi-instance concurrency **on one checked-out client**, and **lock release after a mid-batch throw** (round-6).
5. New boot-time salt-guard test matrix passes (round-6): production-with-unset-`NODE_ENV` throws without a valid salt; test/CI and local dev do not throw.
6. **Migration test**, run via `pnpm --filter @workspace/db test`: the four-row-state matrix plus an above-maximum row, each asserted against the repaired conflict clause and the *resolved, both-ends-clamped* limit value.
7. Full existing test suite + E2E Smoke — no new failures.
8. Local CodeQL re-scan of the actual final code confirms `js/missing-rate-limiting` drops from 213 to 0.
9. **Load budget — concrete numbers:**
   - Workload A: 500 concurrent requests / 200 distinct keys, sustained 30s.
   - Workload B: 500 concurrent requests / 1 shared key, sustained 30s.
   - Workload C: a cold/expired `admin_config` cache burst, proving the single-flight fix results in one refresh query, not N.
   - Workload D: an over-limit burst proving response-path latency is unaffected by the fleet-metrics flush, **and asserting the total `admin_config` query count for the run stays at or near `duration_seconds / 2` (the rollout-config cache's TTL) regardless of burst size — not proportional to request count** (round-6 finding, P1).
   - Pass criteria for all four: p95 latency added ≤ 15ms; sustained pool usage ≤ 16 of 20 connections; 0% Store-attributable error rate.
10. Manual: hit an `/api` route past the ceiling from one IP, confirm dry-run logs a would-be-block (throttled to ≤1/sec) without actually 429ing and the response carries no rate-limit headers; flip `global_rate_limit_dry_run` to `false` locally (and confirm an invalid PATCH value like `"False"` is rejected — round-6), confirm an actual 429 with the right body/headers/CORS headers; confirm the narrow limiters and all exempt method+path routes are unaffected; confirm `GET /api/admin/rate-limit-metrics` returns a 7-day trend plus a *non-zero* live distinct-buckets gauge when over-limit client rows actually exist (round-6 — proving the query fix, not just that it runs); confirm setting `debug_mode_active` + a `debugValue` on `global_rate_limit_max` has no effect on the actual enforced ceiling; send SIGTERM mid-flush-interval and confirm pending counts are still persisted (round-6).
11. Post-flip-to-enforcement: continue monitoring `blockedByDay`/`distinctBucketsOverLimitNow` after enforcement is enabled; the dry-run data is what justifies the initial default, not a blind 72-hour post-enforcement watch.
