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

**Production must not silently run on the dev fallback salt (round-5 finding, P2):** `hashIp` (`transientRenderLog.ts:31-41`) falls back to a fixed, repository-known string (`overhype-dev-transient-render-salt-v1`) whenever `IP_HASH_SALT` is missing or under 16 characters — logged as a WARN, not enforced. That gap already existed for `transientRenderLog.ts`'s own usage, but this plan is about to route *every API request's* client key through the same function, materially raising the value of closing it now rather than deferring it again. Fixed with a boot-time assertion (`artifacts/api-server/src/index.ts`, alongside the app's other startup checks) that throws before the server starts accepting traffic if `NODE_ENV === "production"` and `IP_HASH_SALT` is missing or shorter than 16 characters — turning a silently-degraded privacy guarantee into a deploy-time failure. This is a repo-wide fix (it protects `transientRenderLog.ts`'s existing usage too, not just this plan's new Store), scoped to a boot-time check rather than a per-request check, since the salt can't change during a process's lifetime.

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
import { getConfigIntRaw, getConfigBooleanFresh } from "./lib/adminConfig";
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

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  // getConfigIntRaw (not getConfigInt) — bypasses adminConfig.ts's debug-mode
  // overlay (round-5 finding, P2): this is global infrastructure capacity,
  // not a feature flag, and must never silently pick up a QA/test override
  // via `debug_mode_active`. Clamped to a floor of 1 (round-5 finding, P2):
  // getConfigIntRaw only falls back to the default on a parse failure
  // (NaN) — a stored value of 0 or negative would parse successfully and
  // either block everything or behave unpredictably, and the migration
  // deliberately never rewrites an existing `value` (§4), so a stale
  // out-of-range row must be made harmless at read time, not assumed fixed
  // upstream.
  limit: () => Math.max(1, getConfigIntRaw("global_rate_limit_max", 600)),
  store: new GlobalRateLimitStore(),
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false, // round-5 finding: the default-true X-RateLimit-* set otherwise survives a dry-run response
  skip: (req) => isExemptRequest(req),
  handler: async (req, res, next) => {
    const path = req.originalUrl.split("?")[0];
    // Uncached, authoritative, debug-overlay-bypassing read (round-4 P2 +
    // round-5 P2): `handler` only runs on an already-over-limit request, so
    // the extra query is cheap, and it's the read where fleet-wide cache
    // staleness or a debug-mode override would be actively dangerous. See
    // the fleet-consistency note below.
    const dryRun = await getConfigBooleanFresh("global_rate_limit_dry_run", true);
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
- **A separate periodic flush (every 10s, its own `setInterval`, not the hourly purger) drains the pending counters into the database**, once per interval per instance: capture-and-zero the in-memory counter (safe without a lock — Node is single-threaded, so nothing can increment between the read and the reset), then a single `INSERT ... ON CONFLICT (key_hash) DO UPDATE SET count = count + $pending` per non-zero counter — the same atomic upsert shape the Store already uses, now writing an *additive delta* instead of a per-request `+1`. This turns "one row-lock acquisition per blocked request, fleet-wide" into "at most one write per instance per 10 seconds," independent of burst size. **Trade-off, stated plainly:** up to ~10 seconds of pending counts are lost if a process crashes between flushes — acceptable for an approximate operational decision signal, not acceptable if this were a security-enforcing count (it isn't; enforcement itself doesn't depend on these counters at all).
- **Keys are day-bucketed, not eternal (round-5 finding, P2 — overflow):** `rate_limit_counters.count` is a plain Postgres `integer` (`lib/db/src/schema/rateLimit.ts:6`), and round 4's design used one eternal row per outcome with a 2099 sentinel expiry — under sustained abuse (the exact scenario this middleware targets) that row's count climbs forever and would eventually overflow `int4` (2,147,483,647), after which every further increment throws and the "decision-critical" count silently freezes. Fixed by keying on `grl:metrics:blocked_{dry_run,enforced}:YYYY-MM-DD` (UTC date computed at flush time) — a fresh key each day means no single row can approach the 32-bit ceiling (at a wildly pessimistic 10,000 blocked req/sec sustained for 24h, one day's bucket is ~864M, still under `int4`'s max), and it removes the "never expire" special case entirely: each day-bucket row gets a real, generous expiry (35 days) and is cleaned up by the ordinary purger like every other row — no purger exemption list needed.
- **The day-bucketing doubles as the decision signal round 5 asked for (P2 — "expose distribution, not just a total"):** a single cumulative number can't distinguish a scraper (concentrated, growing) from steady low-level shared-NAT background (flat, spread out). The metrics endpoint now returns the last 7 UTC days of `{ date, blockedDryRun, blockedEnforced }` as a time series instead of one opaque total — round-4's "never reset across the flip" property still holds (a day's bucket just gets both sub-counts if the flip happens mid-day; nothing is manually zeroed). Complementing the trend, the endpoint also computes a **live snapshot gauge** — `distinctBucketsOverLimitNow`: `SELECT count(*) FROM rate_limit_counters WHERE key_hash LIKE 'grl:%' AND key_hash NOT LIKE 'grl:metrics:%' AND count >= <current limit> AND expires_at > now()` — how many distinct client buckets are over the ceiling *right now*, from data the Store is already collecting (no new storage). A handful of buckets at a high count reads as a scraper; hundreds of buckets each barely over reads as shared-NAT background. Neither signal requires storing anything more identifying than what's already persisted.
- **These reserved-key rows are exempt from `key_raw` salting** — `key_raw` stores the literal reserved key string (e.g. `"grl:metrics:blocked_dry_run:2026-08-01"`), not a salted hash. The salting requirement (§2) exists to avoid persisting anything IP-derived; a static, date-suffixed operational label isn't IP-derived or otherwise sensitive — hashing it would only obscure an already-public, predictable constant for no privacy benefit. `key_hash` (the primary key) still stores `sha256(key)`, consistent with every other row's primary-key shape, so the exception is confined to `key_raw` and doesn't create two different primary-key conventions in one table.
- **Namespace collision is provably impossible, not just unlikely:** the reserved keys use a `"grl:metrics:"` sub-prefix that a real client key can never produce. Every real key is `` `grl:${hashIp(ipKeyGenerator(...))}` `` (§2/§3) — a `"grl:"` prefix immediately followed by a hex SHA-256 digest, which cannot contain the literal ASCII substring `"metrics:"` at that position by construction (a digest is `[0-9a-f]{64}`). A test asserts this directly by hashing a large sample of IPv4/IPv6/subnet strings and confirming none begins with `metrics:`.
- **`totalThisInstance` and `storeErrorThisInstance` stay in-memory and process-local**, explicitly labeled as such in both the metric object's field names and the endpoint response — they're context, not the safety-critical signal, and persisting them would add DB writes to a hot path (`total`) or a circular one (`storeError`, which fires when a DB call already failed) for no decision-relevant benefit.

**Observable sink:** `GET /api/admin/rate-limit-metrics` (behind existing admin auth) returns `{ blockedByDay: [{ date, blockedDryRun, blockedEnforced }, ...last 7 days], distinctBucketsOverLimitNow, totalThisInstance, storeErrorThisInstance }`, with the response documenting which fields are fleet-wide (DB-backed: `blockedByDay`, `distinctBucketsOverLimitNow`) and which are this-instance-only (`totalThisInstance`, `storeErrorThisInstance`) — so David isn't misled into reading the latter as a fleet total.

**Dry-run rollout — replaces the earlier "watch after the fact" plan with an actual pre-enforcement measurement (round-3 finding, Reconciliation):** round 2's post-rollout monitoring rule couldn't distinguish a scraper being correctly blocked from a legitimate shared-NAT population being incorrectly blocked — both produce the same "many blocks from one key" signal, and the plan had no way to tell them apart. Rather than invent a differentiation heuristic (path diversity, request timing, etc. — all guesses without real data), the rollout now has an actual **observe-before-enforce** phase: `global_rate_limit_dry_run` (new `admin_config` boolean, default `true`) makes `handler` count and log what *would* have been blocked but always calls `next()` instead of returning 429 while dry-run is active, with the enforcement headers stripped (see above) so the observe phase is genuinely zero-impact. This means the first deployment collects real, fleet-accurate block-rate *and* distribution data against real traffic, with zero user-facing risk, before a single legitimate request is ever actually rejected. David flips `global_rate_limit_dry_run` to `false` (live, no deploy) once the trend and distribution signals show no plausible false-positive pattern over an observation window — replacing the earlier "72 hours, then decide from imperfect signal" rule with "watch real fleet-wide dry-run data, then decide, on your own timeline."

**Fleet-consistency of the flip itself (round-4 P2, its own fix corrected by round-5 P2):** `adminConfig.ts`'s cache is process-local and `bustConfigCache()` only clears the instance that served the admin PATCH — on autoscale, other instances would keep evaluating the *old* `global_rate_limit_dry_run` value for up to the cache's 60-second TTL after David's change, a real risk in an emergency false→true rollback. Fixed by having `handler`'s dry-run check read `getConfigBooleanFresh()` — an uncached, always-live, debug-overlay-bypassing DB read — rather than the cached path `limit` uses (which needs the cache for load reasons, §5's Workload C). **Round-5 correction: the rollback PATCH itself must be reachable in the first place** — `EARLY_EXEMPT_ROUTES` above now exempts `PATCH /api/admin/config/global_rate_limit_dry_run` directly, not just the ceiling's PATCH route, so the actual rollback action works even from an already-blocked admin IP rather than depending on the indirect (and not always sufficient) workaround of raising the ceiling first. `getConfigBooleanFresh` also fails safe on any malformed stored value (see the migration-repair note in §4) by returning `defaultValue` (`true`, i.e. stay in dry-run) for anything that isn't the literal string `"true"` or `"false"` — never coercing an unrecognized value toward enforcement, and never resolving through the debug-mode overlay (same rationale as `getConfigIntRaw` above).

**`Cache-Control: no-store` on the enforced 429** (round-3 finding, folded in here): the earlier mount position was covered by the existing `noStore` middleware list (`app.ts`, later in the chain); the new earlier position isn't, so a 429 could otherwise be cached by an intermediate proxy and served stale to a since-recovered client. Set directly in `handler` rather than relying on the later `noStore` list, since this middleware now runs before it.

**Admin routes — genuinely open, not decided here (round-3 finding, P1, tagged Product Decision):** `current-roadmap.md:280-288` already records rate-limiting admin routes as an explicit, still-pending David decision. This plan's mount change (scoped to all of `/api`, moved earlier) would silently resolve that question by inclusion — every admin route now sits behind this ceiling too, including, worse, `/api/admin/config/:key` itself, the endpoint that raises the ceiling if it's ever set too low. Two things, kept separate:
- **Both self-rescue endpoints are exempted regardless of the broader answer** (`EARLY_EXEMPT_ROUTES` above) — a limiter that can trap its own escape hatch is a design defect independent of whether admin routes in general should be covered, so this part isn't waiting on David.
- **Whether the rest of `/api/admin/*` sits behind this ceiling is not decided by this plan.** That's the pre-existing open roadmap question, and this plan doesn't get to answer it by omission. Flagged to David as a real fork — see the PR thread.

**Bounded deadlines on every fail-open database call (round-5 finding, P1):** `passOnStoreError: true` (§2) only lets a request through *after* a Store call's promise rejects — but the shared `pg.Pool` (`lib/db/src/index.ts:72-88`) configures no `statement_timeout` or `connectionTimeoutMillis`, so a stalled socket or exhausted pool can leave `increment()` (and the config reads on this same request path — `limit`'s `getConfigIntRaw`, `handler`'s `getConfigBooleanFresh`) queued indefinitely rather than rejecting promptly. `passOnStoreError`'s fail-open guarantee is only as good as how fast the query actually fails, and today nothing bounds that. Fixed by adding `statement_timeout: 10_000` and `connectionTimeoutMillis: 5_000` to the shared Pool config in `lib/db/src/index.ts` — **a deliberate, explicitly-scoped exception to "no changes outside the rate-limiter's own files" (§5):** this is a real, pre-existing gap in the whole app's resilience posture, not something scoped to only this middleware's queries, and fixing it centrally (one Pool config) is safer than adding a bespoke per-query timeout mechanism just for the rate limiter. The thresholds are chosen generously — 10s/5s is far above any of this repo's fast rate-limiter/config queries, but still turns "hang forever" into "fail open within single-digit seconds" for the exact outage modes (pool exhaustion, a stalled socket) `passOnStoreError` was designed to handle. §5 adds a test using a deliberately never-resolving/pool-starved mock to prove a request still reaches `next()` within the timeout budget, not just on immediate rejection (round-5's own critique of the round-4-era Store-failure test).

**Purge coordination across autoscale instances (round-5 finding, P2):** `jobs/rateLimitCounterPurger.ts` (§2) is registered from `index.ts` in every process and aligned to the top of the hour — on autoscale, every live instance fires the same `DELETE WHERE expires_at < now()` concurrently, contending for the same row locks and pool capacity for redundant work (only one delete pass is actually useful). Fixed by wrapping the purge run in a Postgres advisory lock (`pg_try_advisory_lock`, released in a `finally`) — an instance that doesn't acquire the lock logs and skips that hour's run rather than racing the one that did, using the existing DB connection with no new infrastructure. The delete itself is also changed from one unbounded statement to a bounded-batch loop (delete up to 1,000 rows per statement, repeat until zero rows affected) so a large backlog doesn't hold locks for an extended single transaction. §5 adds a test asserting that only one of two concurrent purge-run simulations performs the delete.

### 4. Files touched

- `artifacts/api-server/package.json` and the regenerated root `pnpm-lock.yaml` — add `express-rate-limit`.
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new: the `Store` implementation; `globalRateLimitMetrics` (process-local `totalThisInstance`/`storeErrorThisInstance`); `recordBlockedOutcome(mode)` (in-memory, non-blocking pending-counter increment — §3); the 10s flush interval that drains pending counts into day-bucketed `rate_limit_counters` rows via atomic delta-upsert; `readFleetMetrics()` (last-7-days time series + the live `distinctBucketsOverLimitNow` gauge query) for the admin endpoint.
- `lib/db/migrations/0095_global_rate_limit_max_config.sql` **and its `lib/db/migrations/meta/_journal.json` entry** — round-3 finding: the production migration runner (`migrate.ts:140-143`) only applies files with a matching journal entry; a SQL file alone is silently never run. Idempotent seed of `global_rate_limit_max` (default 600) and `global_rate_limit_dry_run` (default `true`).
  - **`ON CONFLICT DO UPDATE` now repairs structural columns, not just the three round-3 had (round-4 finding, P2):** the conflict clause sets `label`/`description`/`data_type`/`min_value`/`max_value`/`is_public` unconditionally on every run (validation/visibility *metadata*, not something David tunes) while leaving `value` untouched, so a live-tuned value survives a re-run but a partial/stale row's missing bounds get repaired. A stored `value` that's already out-of-bounds or non-numeric is deliberately left as-is by the migration; the read-time fallback (§3's `Math.max(1, getConfigIntRaw(...))` clamp and `getConfigBooleanFresh`'s safe-default behavior) is what makes a malformed or out-of-range stored value harmless — **round-5 correction:** round 4 claimed `getConfigInt`'s NaN-only fallback was sufficient, but a stored `0`/negative/excessive integer parses successfully and isn't NaN, so it would have passed through unclamped; the `Math.max(1, ...)` at the `limit` call site (§3) is what actually closes this, not the migration or the getter alone.
  - **Registered as snapshot-exempt (round-4 finding, P2):** `lib/db/scripts/check-migration-snapshots.ts`'s `SNAPSHOT_EXEMPT_TAGS` requires every journal entry to either have a generated snapshot or an explicit exemption with a one-line reason; a DML-only `admin_config` seed has no schema delta and thus no snapshot to generate. `0095_global_rate_limit_max_config` is added to that list, with a comment stating it's pure DML.
- `artifacts/api-server/src/lib/adminConfig.ts` — **`getConfigIntRaw` already exists** (bypasses the debug-mode overlay, `adminConfig.ts:193-203`) and is now used for `global_rate_limit_max` instead of `getConfigInt` (round-5 finding, P2 — the debug overlay must never silently apply a QA/test ceiling to real traffic). Add **`getConfigBooleanFresh`** (round-4 finding, §3): an uncached, always-live single-row read used only by `handler`'s dry-run check, reading `row.value` directly (never `row.debugValue` — same debug-overlay-bypass rationale as `getConfigIntRaw`, round-5 correction of round 4's version which didn't specify this), returning `defaultValue` for a missing row, DB error, or any stored value that isn't the literal string `"true"`/`"false"`. **Also add single-flight refresh to `loadAll()`** (round-3 finding, P2): concurrent callers await one shared in-flight promise instead of each issuing a query on a cache miss.
- `lib/db/src/index.ts` — **add `statement_timeout: 10_000` and `connectionTimeoutMillis: 5_000` to the shared `pg.Pool` config** (round-5 finding, P1, §3) — the one change in this plan that touches shared DB infrastructure rather than the rate limiter's own files, justified because `passOnStoreError`'s fail-open guarantee is only as fast as the query's failure, and nothing bounded that before this fix.
- `artifacts/api-server/src/app.ts` — mount early, **immediately after the app-level `cors()` call**, scoped to `/api`, direct-passed; refactor `isPublicAssetRequest` to take an explicit path argument; `EARLY_EXEMPT_ROUTES` as method+path pairs (round-5 finding, replacing round 3/4's path-only sets).
- `artifacts/api-server/src/routes/admin.ts` — new `GET /api/admin/rate-limit-metrics` route (existing admin-auth pattern) returning `{ blockedByDay, distinctBucketsOverLimitNow, totalThisInstance, storeErrorThisInstance }` (§3).
- `artifacts/api-server/src/jobs/rateLimitCounterPurger.ts` — new, mirrors `jobs/transientRenderPurger.ts`, **plus a Postgres advisory lock around the purge run and a bounded-batch delete loop** (round-5 finding, P2, §3) so only one autoscale instance's scheduled run performs the delete per cycle; `index.ts` gets the matching `scheduleRateLimitCounterPurger()` call. (Fleet-metric rows are day-bucketed with a real 35-day expiry — round-5 correction of round 4's never-expiring sentinel — so this purger now cleans them up like any other row; no exemption list needed.)
- `artifacts/api-server/src/index.ts` — **boot-time assertion** (round-5 finding, P2, §2): throws before the server accepts traffic if `NODE_ENV === "production"` and `IP_HASH_SALT` is missing/short, closing the same gap for `transientRenderLog.ts`'s pre-existing usage of `hashIp` too.
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new: Store unit tests (increment/decrement/resetKey semantics, both persisted columns are salted, window/expiry rollover), a real concurrency test, and fleet-metrics tests: `recordBlockedOutcome`/flush produces the correct day-bucketed delta; a collision-impossibility test hashing a large sample of IPv4/IPv6/subnet strings and asserting none produces a `key_raw` beginning with `metrics:`; day-bucket rows get a real (not eternal) expiry and are deleted by the purger once past it.
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new: real-`app` integration test with an injectable low limit — 429/JSON-body/headers/no-store, exempt paths never touch the Store (asserted via hit count) including the non-`/api`-request case, `ipKeyGenerator` behavior, `passOnStoreError`, dry-run mode (blocked-but-passed-through, asserting **no** `RateLimit-*`/`X-RateLimit-*`/`Retry-After` headers survive — round-4/round-5 findings), trusted-IP resolution order (round 1), CORS-position and preflight-never-touches-Store (round 4), dry-run→enforcement flip without counter reset. **New (round-5 findings):** a wrong-method request to an exempt path (`POST /api/healthz`) is *not* exempt and does touch the Store; a request racing a deliberately never-resolving mock Store still reaches `next()` within the configured timeout budget (proves the round-5 P1 deadline fix, not just immediate-rejection fail-open); a sustained burst of blocked requests produces a bounded number of WARN log lines (throttle proof); `PATCH /api/admin/config/global_rate_limit_dry_run` from an already-over-limit admin bucket still reaches the handler (rollback-path reachability).
- `artifacts/api-server/src/__tests__/rateLimitCounterPurger.test.ts` — new, mirrors `phase4.purger.test.ts`; **new (round-5 finding):** a simulated two-instance concurrent purge run asserts only one actually performs the delete (advisory-lock proof), and a large synthetic backlog is deleted in bounded batches rather than one statement.
- `lib/db/src/migrate.test.ts` (round-5 finding, P2 — corrects round 4's proposed path, which sat outside `lib/db/package.json`'s `src/**/*.test.ts` test glob and would never actually run) — covers the four row states against `0095`'s conflict clause: missing (created with defaults + bounds), existing-valid (a different `value` preserved, bounds/metadata repaired), existing-malformed (`value` non-numeric or out-of-bounds — preserved as-is by the migration; the *resolved* limit is asserted via `getConfigIntRaw` + the `Math.max(1, ...)` clamp, not just that the migration ran), existing-partial (only `min_value`/`is_public` missing — repaired without touching `value`). Verification names `pnpm --filter @workspace/db test` explicitly so this is confirmed to actually execute.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — add the resolution.

### 5. Must not change

- **The existing narrow limiters' own behavior and thresholds are unchanged.**
- **Explicitly exempt, reachable regardless of this middleware's Store state or configured ceiling:** health/liveness, the existing public crawler-asset patterns, `/api/config`, the Stripe webhook, and **both** admin self-rescue endpoints (`global_rate_limit_max` and `global_rate_limit_dry_run` PATCH routes) — matched on **method and path together** (round-5 finding), not path alone.
- **Whether the rest of `/api/admin/*` is covered by this ceiling is an open product question, not settled by this plan** — see §3's admin-routes note.
- **Ships in observe-only (dry-run) mode by default** — no request is actually blocked until `global_rate_limit_dry_run` is explicitly set to `false`, and the dry-run response carries no `RateLimit-*`/`X-RateLimit-*`/`Retry-After` headers.
- **Mounted after the app-level `cors()` call, not before it** — an allowed-origin request must always receive correct CORS headers, including on a 429.
- No new table/schema migration for `rate_limit_counters` (the `admin_config` seed migration is data-only, registered in `SNAPSHOT_EXEMPT_TAGS`); the `count` column stays `integer` — fleet-metric keys are day-bucketed specifically so no row can approach overflow, rather than widening the column.
- No raw client IP addresses, and no unsalted digest of one, persisted anywhere or emitted in metrics/logs — enforced at boot for production, not just documented (round-5 finding). (The reserved fleet-metric keys are a documented, deliberate exception to salting — static, date-suffixed operational labels, not IP-derived, and provably non-colliding with any real client key — see §3.)
- **`blockedByDay`/`distinctBucketsOverLimitNow` are fleet-wide and DB-backed; `totalThisInstance`/`storeErrorThisInstance` are explicitly process-local** — the metrics endpoint response must keep labeling which is which.
- A migration re-run must never silently widen or remove `global_rate_limit_max`'s/`global_rate_limit_dry_run`'s bounds/type/visibility on an existing, partially-provisioned row — only `value` is left untouched across a re-run; every other column is repaired.
- **No DB call on the rate-limiter's response path is unbounded** — every fail-open path (`increment`, the config reads, the fleet-metrics flush) is either off the response path entirely (the flush) or bounded by the shared Pool's `statement_timeout`/`connectionTimeoutMillis`.
- **The global ceiling and the dry-run flag never resolve through the `debug_mode_active` overlay** — both are infrastructure capacity/rollout controls, not feature flags a QA debug session should be able to silently shift for real production traffic.

## Verification

1. `pnpm run typecheck` / `pnpm run build` — clean. `pnpm install --frozen-lockfile` succeeds. `pnpm --filter @workspace/db check-snapshots` passes. `pnpm --filter @workspace/db test` passes (confirms the round-5 migration-test-location fix actually runs it).
2. New `GlobalRateLimitStore` unit tests pass, including concurrency, the salted-both-columns assertion, the fleet-metrics collision-impossibility test, and day-bucket-rows-expire-and-get-purged.
3. New real-`app` integration test passes: 429 (when not in dry-run) + JSON body + `Cache-Control: no-store` + headers past an injected low limit; dry-run mode logs/counts but never blocks *and carries no rate-limit-related headers at all* (standard, draft-7, or legacy); exempt paths (including non-`/api` paths and the wrong-method-on-exempt-path case — round-5) never touch the Store; trusted-IP precedence proven against actual bucket sharing; `ipKeyGenerator` IPv6/IPv4-mapped handling; `passOnStoreError` via a forced Store error **and via a never-resolving mock proving the timeout deadline is what makes fail-open actually fast** (round-5 P1); CORS-position and preflight-never-touches-Store; dry-run→enforcement flip without counter reset; **the dry-run-flag rollback PATCH is reachable from an already-blocked admin bucket** (round-5); **a sustained blocked burst produces a bounded WARN log volume** (round-5).
4. New purger tests pass, including day-bucket rows expiring normally and **the advisory-lock single-runner proof under simulated multi-instance concurrency** (round-5).
5. **Migration test**, run via `pnpm --filter @workspace/db test` (round-5 — corrected location): the four-row-state matrix, each asserted against the repaired conflict clause and the *resolved, clamped* limit value, not just the migration's own idempotency.
6. Full existing test suite + E2E Smoke — no new failures (confirms nothing else broke; does not validate the 600/min default — see step 8).
7. Local CodeQL re-scan of the actual final code (not just the scratchpad proof already run for this plan — the real diff, once written) confirms `js/missing-rate-limiting` drops from 213 to 0.
8. **Load budget — concrete numbers:**
   - Workload A: 500 concurrent requests / 200 distinct keys, sustained 30s.
   - Workload B: 500 concurrent requests / 1 shared key, sustained 30s.
   - Workload C: a cold/expired `admin_config` cache burst, proving the single-flight fix results in one refresh query, not N.
   - Workload D (round-5 addition): an over-limit burst (many requests already past the ceiling) proving the response-path latency is unaffected by the fleet-metrics flush — i.e. proving the round-5 P1 decoupling fix, not just that metrics eventually land in the DB.
   - Pass criteria for all four: p95 latency added ≤ 15ms; sustained pool usage ≤ 16 of 20 connections; 0% Store-attributable error rate.
9. Manual: hit an `/api` route past the ceiling from one IP, confirm dry-run logs a would-be-block (throttled to ≤1/sec) without actually 429ing and the response carries no rate-limit headers; flip `global_rate_limit_dry_run` to `false` locally, confirm an actual 429 with the right body/headers/CORS headers; confirm the narrow limiters and all exempt method+path routes are unaffected; confirm a non-`/api` request never increments `globalRateLimitMetrics.totalThisInstance`; confirm `GET /api/admin/rate-limit-metrics` returns a 7-day trend plus the live distinct-buckets gauge, clearly labeling fleet-wide vs. process-local fields; confirm setting `debug_mode_active` + a `debugValue` on `global_rate_limit_max` has no effect on the actual enforced ceiling.
10. Post-flip-to-enforcement (not pre-deploy — the dry-run phase *is* the pre-deploy evidence now): continue monitoring `blockedByDay`/`distinctBucketsOverLimitNow` (fleet-wide, DB-backed) after enforcement is enabled; the dry-run data is what justifies the initial default, not a blind 72-hour post-enforcement watch.
