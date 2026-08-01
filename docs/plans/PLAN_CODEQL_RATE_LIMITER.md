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
- **Over-limit is `totalHits > limit`, not `>=` — verified against the packaged source, not docs or memory (round-7).** `npm pack express-rate-limit@8.5.1` → `dist/index.cjs:992`: `if (totalHits > limit) { ... config.handler(...) }`, and `:919`: `remaining: Math.max(limit - totalHits, 0)`. So a configured `limit` of N **allows** N requests and blocks the (N+1)-th; a bucket sitting at exactly N has produced zero blocked requests. This is what the metrics gauge's predicate must match (§3). The same read confirms two properties the plan already relies on: `config.skip` is evaluated **before** `store.increment` (so exempt paths genuinely never touch the Store), and `passOnStoreError`'s catch wraps **only** `store.increment` (so it does not cover any other DB call made inside `handler` — the premise of the fleet-metrics and rollout-config designs).

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
- **Both self-rescue admin endpoints must stay reachable (round-5 finding, P2) — but via a dedicated bounded limiter, not an unconditional exemption (round-7 finding, P1, correcting rounds 4-6):** round 4 exempted `PATCH /api/admin/config/global_rate_limit_max`; round 5 added `PATCH /api/admin/config/global_rate_limit_dry_run` (the rollback path — raising the ceiling first is only an indirect workaround, since it might still be below the bucket's current count). Both were placed in `EARLY_EXEMPT_ROUTES`, i.e. **unconditionally exempt for every caller**.

  That is a real hole, and it is worse than the general "should admin routes be limited" question because it is a hole this plan itself creates. These exemptions are evaluated *before* cookie parsing, body parsing, and `authMiddleware` — the limiter cannot tell an admin from anyone else at that point, so "exempt the admin rescue path" actually means "exempt this path for the entire internet." An unauthenticated attacker can then hammer either path indefinitely, and each request still pays for body parsing and `authMiddleware`'s DB session lookup before `requireAdmin` rejects it. The limiter's own escape hatch becomes the one guaranteed-unmetered route into the database — precisely the resource-exhaustion path the middleware exists to close.

  **Fixed by metering the rescue paths separately instead of exempting them.** The two PATCH routes leave `EARLY_EXEMPT_ROUTES` and get their own `rateLimit()` instance, `rescueLimiter`, mounted on just those routes ahead of the global one:

  - **Its own key namespace** (`grl:rescue:` — see §2's prefix rule), so an admin IP that has already exhausted its *global* bucket still arrives at the rescue route with a full, independent budget. This is what actually preserves emergency access; the old exemption preserved it by preserving nothing.
  - **A fixed, code-constant ceiling (30/min/IP) — not read from `admin_config` at all.** A rescue path whose own limit is configured through the very table it exists to repair is circular; a stale or malformed ceiling value must never be able to lock the operator out of fixing that value. 30/min is generous for a human flipping a flag and still caps an attacker at ~1/2s of parse+auth work per IP.
  - **Never dry-run-gated.** `global_rate_limit_dry_run` governs the global limiter's rollout, not this one. The rescue limiter enforces from day one, because its job is protecting a route, not measuring a rollout.
  - **`passOnStoreError: true`, same as the global limiter.** Stated as a deliberate trade-off, not an oversight: during a DB outage the rescue limiter fails open, so the flood is unmetered exactly when the database is already unhealthy. Accepted because the alternative — failing closed — means a database blip locks the operator out of the endpoint that fixes rate limiting, which is the worse of the two failures for a rescue path specifically.

  **The other exemptions are left as unconditional exemptions, deliberately.** The finding is scoped to the rescue paths because they are the ones that reach expensive work: the health routes do no DB or auth work at all, `/api/config` is served from `adminConfig.ts`'s cache, and the Stripe webhook has its own signature gate and predates this plan. None of them is a cheap way to force a DB session lookup, which is what makes the admin PATCH paths different.

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
// Round-9 finding (P2): the installed router (router@2.2.0, via express@5.2.1)
// dispatches HEAD to a matching GET handler when no explicit HEAD handler is
// registered — verified at `lib/route.js:64-66` and `:111-112`, both of which
// rewrite `head` to `get`. So `HEAD /api/healthz` reaches the real GET route
// while a GET-only exemption misses it: the request consumes the global Store
// and can be blocked at the ceiling, breaking the invariant that health and
// /api/config stay reachable regardless of Store state. GET-only escape routes
// therefore exempt HEAD too, from the same matcher.
const SAFE_READ_METHODS = ["GET", "HEAD"] as const;
const EARLY_EXEMPT_ROUTES: ReadonlyArray<{ methods: readonly string[]; path: string }> = [
  { methods: SAFE_READ_METHODS, path: "/api/healthz" },
  { methods: SAFE_READ_METHODS, path: "/api/health" },
  { methods: SAFE_READ_METHODS, path: "/api/health/queues" },
  { methods: ["POST"], path: "/api/stripe/webhook" }, // no GET route, so no HEAD dispatch
  { methods: SAFE_READ_METHODS, path: "/api/config" },
  // NOTE (round-7 finding, P1): the two admin self-rescue PATCH routes are
  // deliberately NOT here. An unconditional exemption is evaluated before
  // auth, so it exempts the whole internet, not admins. They get
  // `rescueLimiter` below instead — bounded, independently keyed, reachable.
];

// The self-rescue routes: metered, not exempt. Fixed code-constant ceiling
// (never read from admin_config — a rescue path must not depend on the table
// it repairs), own key namespace so an admin whose global bucket is exhausted
// still has budget here, and never dry-run-gated.
const RESCUE_ROUTES = [
  "/api/admin/config/global_rate_limit_max",
  "/api/admin/config/global_rate_limit_dry_run",
];
const rescueLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  store: new GlobalRateLimitStore({ keyPrefix: "grl:rescue:" }),
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  passOnStoreError: true, // deliberate: see the rescue-limiter note above
  standardHeaders: true,
  legacyHeaders: false,
});

// Round-8 finding (P2): Express runs with non-strict routing by default and
// this repo sets no `strict routing` override (verified against the installed
// express@5.2.1), so `PATCH /api/admin/config/global_rate_limit_max/` DOES
// match the registered rescue route — but an exact-string predicate misses
// it. That spelling would run rescueLimiter and then fall into the global
// limiter too: metered twice, and unusable as a rescue path exactly when the
// admin's global bucket is exhausted. Registration and exemption must derive
// from ONE normalized matcher, not two spellings of the same intent.
function normalizeRoutePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function isRescueRequest(method: string, path: string): boolean {
  return method === "PATCH" && RESCUE_ROUTES.includes(normalizeRoutePath(path));
}

// Exempt *from the global limiter*. For EARLY_EXEMPT_ROUTES that means
// unmetered; for the rescue routes it means "metered by rescueLimiter
// instead," which is why they are two lists and not one.
function isExemptRequest(req: Request): boolean {
  const path = normalizeRoutePath(req.originalUrl.split("?")[0]);
  if (isPublicAssetRequest(req.method, path)) return true;
  if (isRescueRequest(req.method, path)) return true;
  // Normalized on both sides, for the same trailing-slash reason as the
  // rescue routes: `GET /api/healthz/` reaches the same handler.
  return EARLY_EXEMPT_ROUTES.some((r) => r.methods.includes(req.method) && r.path === path);
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
// an unbounded log stream. The DB-backed hour-bucketed counters (below) are the
// real decision signal; this log line is an operational breadcrumb and loses
// no decision-relevant information by being throttled.
let lastBlockLogAt = 0;
function logBlockedThrottled(fields: Record<string, unknown>, msg: string): void {
  const now = Date.now();
  if (now - lastBlockLogAt < 1000) return;
  lastBlockLogAt = now;
  logger.warn(fields, msg);
}

// Ceiling for the ceiling itself (round-6 finding, P2; value lowered by a
// round-7 finding): the migration seeds `max_value = MAX_GLOBAL_RATE_LIMIT`
// on the admin_config row so future admin PATCHes are bounded, and this same
// constant is the read-time clamp — one number, not two that could drift.
//
// Round 7 lowered this from 1,000,000 to 100,000. The old value was picked as
// "absurdly high, therefore harmless," but it is also the number that bounds
// how much *allowed* traffic the metric counters must survive, and Codex
// correctly used it as the input to an overflow proof (§3, fleet metrics).
// 100,000 req/min/IP is still ~166× the 600 default and far beyond any
// legitimate ceiling anyone would set; it exists only to make a stale
// excessive stored value harmless, the same way the floor makes a stale
// zero/negative value harmless. Narrowing it costs nothing real and shrinks
// the worst case every downstream bound has to absorb.
const MAX_GLOBAL_RATE_LIMIT = 100_000;

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
// — see the mount-point note above for why. The rescue limiter is registered
// first so a rescue PATCH is metered by it (and only it) before the global
// limiter's skip predicate lets that path through.
for (const path of RESCUE_ROUTES) app.patch(path, rescueLimiter);
app.use("/api", countGlobalLimiterRequest, globalLimiter);
```

**Fleet-wide metrics: decoupled from the response path, and idempotent by construction.**

This subsystem was corrected in rounds 4, 5, 6 and 7. Rather than carry four layers of "my previous version was wrong," what follows is the final design stated once, with only the reasoning that explains a genuinely non-obvious choice. The two constraints that drove every revision: **the DB write must never sit on the response path** (round 4 — an `await`ed upsert to one shared row serialized every instance during exactly the burst this middleware exists to absorb; `passOnStoreError` does not cover it, since that option governs only the `Store`'s own calls, and a `.catch()` suppresses the error but not the wait), and **the persisted count must survive every failure mode without silently lying** (rounds 5-7).

- **Recording is synchronous and in-memory.** `recordBlockedOutcome(mode)` increments a per-process counter. No `await`, no DB call, no pool contention on `handler`'s critical path; `handler` returns to the client regardless of database state.

- **The counter is keyed by `(outcome, UTC hour)` at *record* time, and holds a per-process cumulative-since-boot total** — not a since-last-flush delta. This single choice is what fixes three separate findings, and it is the non-obvious part of the design, so: the flush writes an **absolute** value (`SET count = EXCLUDED.count`), not an additive delta (`SET count = count + $delta`).
  - **Idempotent under ambiguous commit (round-7 finding, P2).** With additive deltas, a flush whose transaction commits but whose response is lost to a connection error is indistinguishable from one that never ran — retrying double-counts, and *not* retrying loses data. There is no client-side way out of that ambiguity, which is why rounds 5-6 kept trading one of those failures for the other. Writing an absolute cumulative removes the ambiguity entirely: replaying the same write is a no-op by construction, so the retry is always safe and no deduplication table, flush identity, or weakened metric contract is needed.
  - **No restore-on-failure logic at all.** Round 6's "add the captured delta back on a rejected flush" existed only because the delta had been zeroed out of memory. A cumulative total is never zeroed, so a failed flush needs no compensation — the next flush writes the same (or a larger) cumulative and the backlog is gone. Round 6's restore path is superseded and removed, not retained.
  - **Correct attribution across an hour/day boundary (round-7 finding, P2).** The bucket is chosen when the request is *recorded*, not when it is flushed, so a flush that fails at 23:59:58 and succeeds at 00:00:03 still writes the earlier requests to the earlier bucket. The previous design computed the key at flush time and would have misattributed them, distorting exactly the trend the enforcement decision reads.
  - **Cost:** one row per `(process, outcome, hour)` rather than one per `(outcome, day)`. The process identity is a random UUID generated at boot (not an instance ID — a restarted instance must not overwrite its predecessor's row). At autoscale scale that is on the order of hundreds to a few thousand rows per week, all covered by the ordinary purger; the metrics endpoint sums across processes. Cheap, and it buys idempotency that nothing else here does.

- **Overflow headroom is now structural rather than argued (round-7 finding, P2).** Round 5 moved off an eternal row to day buckets; round 6 justified that with a plausibility argument ("10,000 blocked req/sec sustained is a wild overestimate"). Codex correctly rejected the argument rather than the number: the configured ceiling is what bounds *allowed* traffic, and at the old `MAX_GLOBAL_RATE_LIMIT` a distributed burst could cross `int4` within one day-bucket without violating any configured bound. Three independent changes, so the result does not rest on any single estimate:
  1. **Hour buckets, not day** — 24× more headroom per row, and better resolution for the decision anyway.
  2. **Per-process rows** — the fleet's blocked traffic is divided across processes rather than summed into one row.
  3. **`MAX_GLOBAL_RATE_LIMIT` lowered to 100,000** (§3 above), shrinking the worst case every bound has to absorb.
  4. **A saturation clamp as the backstop, with the marker persisted (round-9 finding, P2).** The in-memory cumulative is clamped at 2,000,000,000 rather than allowed to overflow. Round 8 set only a **per-process in-memory** flag while the endpoint advertised `saturated` as fleet-wide and DB-backed — so on autoscale the instance serving `GET /api/admin/rate-limit-metrics` would usually report `saturated: false`, and once the saturated process exited the flag vanished entirely, leaving clamped counts in the database looking complete. That defeats the visible-degradation guarantee which is the whole reason retaining `int4` is acceptable. Fixed: saturation writes a reserved absolute marker row per `(process, hour)` — `grl:metrics:saturated:<processId>:<YYYY-MM-DDTHH>`, value `1`, same idempotent absolute-write shape as every other metric row — and the endpoint reports `saturated: true` if any marker exists in the queried window, regardless of which instance serves the request or whether the originating process still exists. §5 asserts the behaviour at the real integer boundary **and** that a second instance observes `saturated: true` after the originating process is gone.

- **A shared-NAT discriminator, with a decision rule (round-5/round-7 finding, P2; round-8 correction of where the identity comes from, P1).** Codex has now three times pushed on this, and each round found the previous answer inadequate for a different reason. Rounds 4-5 offered better *aggregation* (day buckets, a bucket-count gauge), which cannot separate "one scraper" from "many users behind one NAT" at all — both are a single high-count bucket. Round 7 added a real discriminator but sourced the identity from the **raw `sid` cookie, read before authentication** — and round 8 correctly showed that is worse than no signal.

  **Why the round-7 version was unusable:** `sid` is an opaque random key (`auth.ts:8`, `createSession` at `:138` — `crypto.randomBytes(32).toString("hex")`) whose association with a user exists *only* in the `sessions` table, established by the DB lookup in `authMiddleware` (`:64-105`). The client can put any string in that cookie. So a single over-limit caller could rotate eight fabricated `sid` values and pin its own bucket into `overlimit_shared` — the class whose whole purpose is to say "don't enforce, this is a legitimate population." The discriminator was directly attacker-controllable in the direction of suppressing enforcement, which is the one direction that matters.

  **Fixed by collecting the identity only after `authMiddleware` has validated it.** The counting middleware no longer parses cookies at all. Instead, when a request is over-limit **and dry-run lets it through**, `handler` stamps the bucket's key hash onto `res.locals.grlOverLimitBucket`; a small middleware registered **after `authMiddleware`** then reads `req.user?.id` — a value that exists only because a session row was found in the database — and records that validated identity against the stamped bucket. A request with a forged or absent `sid` contributes **no** identity, so it cannot move any bucket out of the single/anonymous class.

  This ordering works precisely because the discriminator is only meaningful during the dry-run phase: in dry-run the request continues down the chain and reaches `authMiddleware`, so the validated identity is available. Under enforcement the request is rejected at the limiter and never reaches auth — but by then the rollout decision this signal informs has already been made, so there is nothing to collect.

  **Round-9 finding, P2: reducing to a class per process per interval destroys the very cardinality the signal is made of.** Round 8's design classified each bucket locally and persisted only the class count. But eight authenticated users behind one NAT, spread across eight autoscale instances — or simply across eight 10-second intervals on one instance — each produce a *local* view of one identity, so the fleet records **eight `overlimit_single` observations** instead of one `overlimit_shared` bucket. That is exactly the scraper-shaped signal the decision rule reads as "safe to enforce," and the error is in the unsafe direction. The union has to survive aggregation, which means the *sketch* must be persisted, not the conclusion.

  **Fixed with a 31-bit union sketch per (bucket, hour), OR-merged in the database.** For each over-limit bucket the process maintains a 31-bit word: bit `i` is set when a validated identity with `hash(userId) mod 31 == i` is observed. At flush time the word is written to a reserved row keyed `grl:ident:<bucketHash>:<YYYY-MM-DDTHH>` with

  ```sql
  ON CONFLICT (key_hash) DO UPDATE SET count = rate_limit_counters.count | EXCLUDED.count
  ```

  Bitwise OR is **associative, commutative and idempotent**, so it unions correctly across every instance and every interval *and* stays consistent with this plan's absolute-write discipline — replaying a flush is a no-op, exactly like the cumulative counters (§ above). It needs no schema change: the word lives in the existing `integer` column, and 31 bits keeps it clear of `int4`'s sign bit.

  **Classification moves to read time**, from the unioned word rather than a local view. Distinct-identity count is estimated by linear counting, `n̂ = -m·ln(1 − c/m)` with `m = 31` and `c = popcount`, which corrects the collision under-count that a raw popcount would suffer (at 8 distinct identities ≈ 7.2 bits set, estimating back to ≈ 8.0). A saturated word (`c = 31`) reads as "many." The estimator's error at the ≥8 threshold is small enough for a go/no-go decision and is stated in the plan rather than assumed.

  **Privacy is unchanged or better:** what's persisted is a 31-bit lossy sketch of salted identity hashes — strictly less recoverable than the per-process sets it replaces, and per-bucket rows carry no identity, only the sketch. The 1,000-bucket-per-process-per-interval cap and its overflow counter still apply, and the in-memory per-bucket `Set` is gone entirely (a single 31-bit word replaces it), so the memory bound tightens.

  §5 tests the case that motivated this: eight users **split across simulated instances and across intervals** must classify the bucket `overlimit_shared` — not eight `overlimit_single` observations. The old "all eight in one local set" test is kept as the degenerate case, not the only one.

  The three persisted class counts are now derived at read time from the sketches:
  - `overlimit_single` — ≤1 distinct identity (indistinguishable from a single client or an anonymous scraper)
  - `overlimit_shared` — ≥8 distinct identities (a population, not a client)
  - `overlimit_ambiguous` — in between

  **The decision rule this produces, stated so David is not left to invent one:** flip `global_rate_limit_dry_run` to `false` when, over the observation window, `overlimit_shared` is ~0 and the over-limit population is dominated by `overlimit_single`. A material `overlimit_shared` count means the ceiling is genuinely catching populations rather than clients, and the correct response is to raise the ceiling (or make the limiter identity-aware) — **not** to flip.

  **The signal now fails in the safe direction.** Because only DB-validated identities count, an attacker can no longer manufacture `overlimit_shared` to suppress enforcement. The worst they can do is contribute nothing and be classified `overlimit_single` — which reads as "enforce," not "hold off."

  **Residual limit, stated plainly rather than buried:** this discriminates *authenticated* populations. A NAT carrying only logged-out traffic still classifies as `overlimit_single`, because there is no validated identity to count. That residue is real and is the one part of the shared-NAT question this data cannot answer; it goes to David as an explicit acceptance (§*Open questions*), rather than being presented as solved.

  §5 tests the attack directly: arbitrary, duplicate, prefix-colliding, and malformed `sid` cookies must never move a bucket out of the single/anonymous class, while eight genuinely distinct authenticated sessions must classify it `overlimit_shared`.

- **The live gauge counts buckets that actually exceeded the ceiling (round-7 finding, P2).** `distinctBucketsOverLimitNow` is
  `SELECT count(*) FROM rate_limit_counters WHERE key_raw ~ '^grl:[0-9a-f]{64}$' AND count > <current limit> AND expires_at > now()`.

  **The predicate is a positive allowlist, not a denylist of reserved namespaces (round-8 finding, P2).** Rounds 6-7 used `LIKE 'grl:%' AND NOT LIKE 'grl:metrics:%'`, which silently began matching the `grl:rescue:` rows the moment round 7 introduced `rescueLimiter` — and since `express-rate-limit` increments a bucket *before* the limit check (so it keeps counting even while returning 429s), an unauthenticated flood of a rescue route could push a rescue row past the global ceiling and inflate a gauge that is supposed to count globally-limited *client* buckets. Adding `AND NOT LIKE 'grl:rescue:%'` would fix this instance and rot again at the next namespace, so the predicate instead **positively matches the one shape a real global client row can have**: the `grl:` prefix followed by exactly a 64-char hex digest (§2). Every reserved namespace — present or future — is excluded by construction rather than by remembering to add a clause. §5's gauge test persists a `grl:rescue:` row above the threshold and asserts it is **not** counted.

  Two earlier corrections are also folded in here. **`key_raw`, not `key_hash` (round-6, P1):** `key_hash` is always a 64-char SHA-256 digest for every row in this table, so `key_hash LIKE 'grl:%'` matched zero rows unconditionally and the gauge would have silently always read 0; `key_raw` is the column that actually carries the literal prefix. **`count > limit`, not `count >= limit` (round-7):** verified directly against the packaged source — `express-rate-limit@8.5.1` (`dist/index.cjs:992`) blocks on `if (totalHits > limit)` and computes `remaining: Math.max(limit - totalHits, 0)`, so a bucket sitting at exactly the ceiling has produced **zero** blocked requests. Counting it as over-limit inflated the gauge precisely at the threshold David is evaluating. §5 covers both the equal-to-limit and limit-plus-one cases with real persisted rows.

- **The flush loop: every 10s, `unref()`'d, single-flighted, and drained on shutdown.** The interval is `unref()`'d (matching `shutdown.ts`'s existing `forceExitTimer.unref()`) so test processes importing `app.ts` still exit deterministically. `flushPendingFleetMetrics()` is **single-flighted** — a module-level in-flight promise that a concurrent caller awaits rather than starting a second overlapping write (round-7 finding, P2: the periodic interval and the shutdown drain could otherwise run simultaneously). `stopFleetMetricsFlush()` clears the interval and is exported for tests and for shutdown.

- **The graceful-shutdown sequence is specified, not implied (round-7 finding, P2).** Round 6 said only that `index.ts`'s `onClose` calls the flush. That was underspecified in two ways Codex caught by reading `shutdown.ts:56-65`: the interval was never stopped (so a periodic flush could still be mid-write when the process exits), and `clearTimeout(forceExitTimer)` runs *before* `onClose` — so simply awaiting an async `onClose` would have removed the grace-period bound entirely, exactly the guarantee round 6 claimed to preserve. The full ordering, all of it tested:
  1. `shutdown.ts` awaits an `onClose` that may return a `Promise`, and **`clearTimeout(forceExitTimer)` moves to after that promise settles** — so the force-exit timer stays armed for the whole hook and a hung flush still hits `gracePeriodMs` → `onTimeout` → `safeExit(1)` instead of hanging forever.
  2. `onClose` calls `stopFleetMetricsFlush()` first (no new flush can start),
  3. then `await flushPendingFleetMetrics()`, which joins an already-running flush via the single-flight promise rather than racing it,
  4. then performs the final drain (a no-op if the joined flush already covered it — absolute writes make the extra pass free).

- **Remaining trade-off, stated plainly:** a hard kill (`SIGKILL`, OOM) still loses up to ~10s of counts, since no hook can intercept it. Acceptable for an approximate operational signal; enforcement itself does not read these counters at all.

- **Reserved-key rows are exempt from `key_raw` salting.** `key_raw` stores the literal reserved key (e.g. `"grl:metrics:blocked_dry_run:<processId>:2026-08-01T14"`), not a salted hash: the salting requirement (§2) exists to avoid persisting anything IP-derived, and an operational label is not. `key_hash` still stores `sha256(key)`, so the exception is confined to one column and does not create two primary-key conventions.

- **Namespace collision is provably impossible.** Every real client key is `` `grl:${hashIp(...)}` `` — the prefix followed by a hex SHA-256 digest, which cannot contain the literal substring `"metrics:"` or `"rescue:"` at that position by construction (`[0-9a-f]{64}`). A test asserts it over a large sample of IPv4/IPv6/subnet inputs.

- **`totalThisInstance`/`storeErrorThisInstance` stay process-local**, labelled as such in the field names and the endpoint response — context, not the decision signal. Persisting them would put a DB write on a hot path (`total`) or a circular one (`storeError`, which fires when a DB call has already failed).

**Observable sink:** `GET /api/admin/rate-limit-metrics` (behind existing admin auth) returns

```jsonc
{
  // fleet-wide, DB-backed, summed across processes; hour rows rolled up to days
  "blockedByDay": [{ "date": "2026-08-01", "blockedDryRun": 0, "blockedEnforced": 0 }],
  "overLimitClassByDay": [{ "date": "2026-08-01", "single": 0, "shared": 0, "ambiguous": 0 }],
  "distinctBucketsOverLimitNow": 0,
  "saturated": false,          // true if any process hit the clamp — counts are a floor
  // this-instance only
  "totalThisInstance": 0,
  "storeErrorThisInstance": 0
}
```

The response documents which fields are fleet-wide and which are process-local, so David isn't misled into reading the latter as a fleet total, and `overLimitClassByDay` is what the enforcement-flip decision rule above is read from.

**Every numeric field is converted from Postgres's `int8` before it leaves `readFleetMetrics()` (round-9 finding, P2).** `count(*)` and `sum(integer)` both return `int8`, and `pg@8.20.0` parses `int8` as a **string** by default (it does not install a type parser for OID 20, precisely because `int8` can exceed `Number.MAX_SAFE_INTEGER`). Codex confirmed this empirically against the configured database. Left alone, the endpoint would emit `"blockedEnforced": "1234"` — silently breaking numeric comparisons, sorting, and any chart on the admin surface, while looking correct in a casual read of the JSON. `readFleetMetrics()` therefore performs an explicit **range-checked** conversion on every aggregate: parse, reject `NaN`, and assert the value is within `Number.MAX_SAFE_INTEGER` before returning a `number` (a sum that exceeded it would indicate the saturation path above had already failed, so it surfaces as an error rather than a silently-lossy float). §5's endpoint test asserts the JSON value **types**, not only the values — the assertion that would have caught this.

**Dry-run rollout — replaces the earlier "watch after the fact" plan with an actual pre-enforcement measurement (round-3 finding, Reconciliation):** round 2's post-rollout monitoring rule couldn't distinguish a scraper being correctly blocked from a legitimate shared-NAT population being incorrectly blocked — both produce the same "many blocks from one key" signal, and the plan had no way to tell them apart. Rather than invent a differentiation heuristic (path diversity, request timing, etc. — all guesses without real data), the rollout now has an actual **observe-before-enforce** phase: `global_rate_limit_dry_run` (new `admin_config` boolean, default `true`) makes `handler` count and log what *would* have been blocked but always calls `next()` instead of returning 429 while dry-run is active, with the enforcement headers stripped (see above) so the observe phase is genuinely zero-impact. This means the first deployment collects real, fleet-accurate block-rate *and* distribution data against real traffic, with zero user-facing risk, before a single legitimate request is ever actually rejected. David flips `global_rate_limit_dry_run` to `false` (live, no deploy) once the trend and distribution signals show no plausible false-positive pattern over an observation window — replacing the earlier "72 hours, then decide from imperfect signal" rule with "watch real fleet-wide dry-run data, then decide, on your own timeline."

**Fleet-consistency of the ceiling and the dry-run flag — `getGlobalRateLimitRolloutConfig()` (round-4 P2, revised twice more by round-5 and round-6 — this is the third design, explained in full because the first two each traded one failure mode for another):**

- **Round 4's version** used `adminConfig.ts`'s general 60-second cache for both values — fine for `limit` (read on every request, needs the cache for load reasons), wrong for the dry-run flag: `bustConfigCache()` only clears the instance that served the admin PATCH, so on autoscale, other instances would keep evaluating the *old* value for up to 60 seconds, a real risk in an emergency false→true rollback.
- **Round 5's fix** made `handler`'s dry-run check a genuinely uncached, per-request DB read (`getConfigBooleanFresh`) — this fixed the staleness problem but created a new one, caught in round 6: under a sustained over-limit burst (the exact traffic this middleware exists to handle), *every* blocked request now issued its own DB query before responding, recreating the exact response-path amplification problem the fleet-metrics batching redesign (above) had just eliminated for the metrics write. Round 6 separately caught that the *ceiling* (`limit`, still on the 60s cache) had never gotten the same fast-propagation fix the dry-run flag did — an emergency ceiling change could still take up to a minute to reach every instance.
- **Fixed by `getGlobalRateLimitRolloutConfig()`: one combined, short-TTL, single-flighted read for both values, decoupled from request volume.** A single `SELECT ... WHERE key IN ('global_rate_limit_max', 'global_rate_limit_dry_run')` (bypassing `adminConfig.ts`'s general cache and its `debug_mode_active` overlay entirely — reading `.value` directly, same rationale as the retired `getConfigIntRaw`/`getConfigBooleanFresh` raw-read convention) is cached for **2 seconds**, refreshed via the same single-flight pattern already used elsewhere in this plan (concurrent callers during a cache-miss window await one shared in-flight query, not one each). Both `limit` and `handler` call this one function. This bounds DB query volume to **at most one query per instance per 2 seconds, regardless of how many requests or blocked requests arrive in that window** — the amplification round 6 found is gone, because query volume no longer scales with traffic at all — while still propagating an emergency change (either the ceiling or the dry-run flag) to every autoscale instance within 2 seconds, an order of magnitude faster than the general cache's 60s TTL and fast enough for a real emergency rollback.
- **No PATCH-triggered invalidation-broadcast is needed.** A 2-second worst case is already short enough that building cross-instance cache-invalidation infrastructure (pub/sub, a version counter, etc.) isn't proportionate — the same reasoning round 4 already applied when it rejected building shadow-traffic infrastructure for the shared-NAT question. §5's multi-instance test simulates two instances' independent caches and asserts a PATCH's effect is visible on both within the 2-second bound, not just on the instance that served the write.
- **`rescueLimiter` above keeps both self-rescue PATCH routes reachable** — on an independent key namespace and a fixed code-constant ceiling — so an emergency rollback (raising the ceiling, or flipping dry-run back to `true`) works even from an already-blocked admin IP, regardless of this config-propagation mechanism. Crucially it is *metered*, not exempt: the round-7 finding was that an unconditional exemption evaluated before auth is an exemption for everyone.
- **Fails safe on any malformed stored value:** a `global_rate_limit_max` that isn't a valid positive integer falls back to the code default (600) before the `[1, MAX_GLOBAL_RATE_LIMIT]` clamp even applies; a `global_rate_limit_dry_run` that isn't exactly `"true"`/`"false"` falls back to `true` (stay in dry-run) — never coercing an unrecognized value toward enforcement. (The admin PATCH endpoint now also rejects a malformed boolean value at write time — round-6 finding, §4 — so this fallback is a defense-in-depth backstop, not the only guard.)
- **`getGlobalRateLimitRolloutConfig()` never rejects — a refresh failure must not fail the request closed (round-8 finding, P1).** The function is awaited from the `limit` option and from `handler`, and `passOnStoreError` covers **only** `store.increment` (§1, confirmed in the packaged source). So a rejection here propagates out of the middleware as an unhandled async rejection and lands in the fallback error handler as a **JSON 500** — meaning a database outage during a cache refresh would fail *every* refreshing request closed at the global limiter, the exact opposite of this plan's fail-open posture and worse than the outage itself. Fixed by making the function total:
  - **Warm-but-stale wins over failing.** If a refresh rejects or times out while a previous value is cached, the last known-good value is retained and returned (with its staleness logged, throttled). An emergency change propagating a few seconds late is strictly better than a 500.
  - **Cold failure returns the safe code defaults** — `max: 600`, `dryRun: true`. Both are the conservative direction: a normal ceiling, and *stay in observe-only*.
  - **A failed refresh must not increase refresh concurrency.** The single-flight promise is cleared on settle either way, and a failure does not trigger an immediate retry — the next caller after the TTL retries, so an outage produces at most the same ~1 query/instance/2s as healthy operation, never a retry storm against an already-struggling database.
  - §5 covers both a **rejecting** and a **never-settling** refresh, asserting downstream routing is still reached within the deadline and that refresh concurrency does not rise.

**`Cache-Control: no-store` on the enforced 429** (round-3 finding, folded in here): the earlier mount position was covered by the existing `noStore` middleware list (`app.ts`, later in the chain); the new earlier position isn't, so a 429 could otherwise be cached by an intermediate proxy and served stale to a since-recovered client. Set directly in `handler` rather than relying on the later `noStore` list, since this middleware now runs before it.

**Admin routes — genuinely open, not decided here (round-3 finding, P1, tagged Product Decision):** `current-roadmap.md:280-288` already records rate-limiting admin routes as an explicit, still-pending David decision. This plan's mount change (scoped to all of `/api`, moved earlier) would silently resolve that question by inclusion — every admin route now sits behind this ceiling too, including, worse, `/api/admin/config/:key` itself, the endpoint that raises the ceiling if it's ever set too low. Two things, kept separate:
- **Both self-rescue endpoints stay reachable regardless of the broader answer** — via `rescueLimiter`, not an exemption (round-7 finding, P1). A limiter that can trap its own escape hatch is a design defect independent of whether admin routes in general should be covered, so this part isn't waiting on David; but the escape hatch must not itself be an unmetered pre-auth route into the database, which is what the exemption version was.
- **Whether the rest of `/api/admin/*` sits behind this ceiling is not decided by this plan.** That's the pre-existing open roadmap question, and this plan doesn't get to answer it by omission. Flagged to David as a real fork — see the PR thread.

**Bounded deadlines on every fail-open database call (round-5 finding, P1; round-6 correction of the mechanism, P2):** `passOnStoreError: true` (§2) only lets a request through *after* a Store call's promise rejects — but the shared `pg.Pool` (`lib/db/src/index.ts:72-88`) configures no `statement_timeout` or `connectionTimeoutMillis`, so a stalled socket or exhausted pool can leave `increment()` (and the config reads on this same request path) queued indefinitely rather than rejecting promptly.

- **Round 5's fix was wrong in scope.** Adding `statement_timeout`/`connectionTimeoutMillis` to the *shared* Pool config bounds every query on that pool, not just this middleware's — `migrate.ts`'s production migration runner, backfills, and batch jobs all obtain clients from the same pool (`lib/db/src/index.ts:99-107` and elsewhere), and any of their legitimately-longer-running statements would now be canceled at 10s, potentially breaking startup migrations or unrelated batch work. That's a real regression this plan should not cause just to fix its own fail-open latency.
- **Round 6's fix was correctly scoped but did not actually bound anything (round-7 finding, P1).** A `withTimeout(promise, ms)` helper stops *awaiting* a promise; it does not cancel the `pg` operation behind it. The request fails open on schedule, but the query stays queued on the shared pool and may still execute later. Under exactly the conditions the deadline exists for — pool exhaustion, a stalled socket — sustained traffic then builds an unbounded backlog of abandoned-but-live operations competing for the same 20 connections, and abandoned rollout-config refreshes can overlap subsequent ones. Codex was right that this is a P1 and that "bounded" was an overclaim; a timeout that leaves the work running is a latency fix wearing a resource-safety label.
- **Round 7's fix bounded the statement but not the transaction (round-8 finding, P1).** `SET LOCAL statement_timeout` isn't in force until `BEGIN` and the `SET` itself have completed, and it does nothing for `COMMIT` or an error-path `ROLLBACK`. A stalled socket during any of those three phases fell back to the outer wall-clock guard — which, being a plain promise race, cancelled nothing. The checked-out client and its open transaction stayed live while the caller returned, which is the same abandoned-work backlog round 7 was supposed to have eliminated, just relocated to the transaction-control phases. **The `release()`-based cleanup was also wrong on its own terms**, for the reason under *Purge coordination* below: a non-error `release()` returns the client to the idle pool rather than ending it.
- **Fixed with real, operation-scoped cancellation: `runBounded()`.** Every DB call this middleware makes goes through one helper in `globalRateLimitStore.ts`. Round 9 corrected two of its four parts — both because a *mechanism* assumption was wrong, not because the reasoning was — so each is stated with what was verified in the installed source.

  1. **Acquisition is gated, not raced (round-9 finding, P1 — replacing round 8's race).** Round 8 raced `pool.connect()` against a deadline and released any late client destructively. That does not bound acquisition at all. Verified in `pg-pool@3.13.0` (`index.js:200-231`): when the pool is full, `connect()` pushes a `PendingItem` onto `_pendingQueue`, and the **only** code that removes a waiter is the `connectionTimeoutMillis` timer — which this repo's shared pool does not set (`lib/db/src/index.ts:72-88`), so the `!this.options.connectionTimeoutMillis` branch is the one taken and there is no removal path at all. Abandoning the promise leaves the waiter queued forever; under sustained limiter traffic against an exhausted pool the FIFO grows without bound, and every abandoned waiter *later* checks out a client only to destroy it — turning a fail-open into unbounded queue growth plus connection churn.

     Fixed by **never enqueuing in the first place**: a limiter-owned concurrency gate (`MAX_CONCURRENT_LIMITER_CHECKOUTS = 4`, a small fraction of the pool's 20) is taken *before* calling `pool.connect()`. If the gate is full, the call fails fast without touching the pool, and `passOnStoreError`/the config fallback turn that into fail-open immediately. This is strictly better than a race: it bounds `_pendingQueue` growth, bounds churn, and makes fail-open *faster* under exhaustion rather than slower. Setting `connectionTimeoutMillis` on the shared pool would also remove waiters, but it would apply to migrations and batch jobs too — the blast radius round 5 was already corrected for.
  2. **Execution is bounded server-side.** On the checked-out client: `BEGIN` → `SET LOCAL statement_timeout = <ms>` → `SET LOCAL idle_in_transaction_session_timeout = <ms>` → the statement → `COMMIT` (`ROLLBACK` on error). Postgres cancels a slow statement itself and `pg` rejects with `57014`.
  3. **The transport-stall case is bounded by Postgres, not by our socket (round-9 finding, P1 — correcting round 8's overclaim).** Round 8 said destroying the client "terminates the backend, cancelling the statement and rolling back the transaction." Verified in `pg@8.20.0` (`client.js:718-723`): with an active query, `end()` calls `connection.stream.destroy()` — it destroys the **local** socket and returns without waiting for anything server-side. On a clean local socket the backend does notice and exit promptly; but on the failure this deadline actually targets — a transport stall or network partition, where `BEGIN` reached Postgres and neither its reply nor the FIN gets back — the backend can sit **idle in transaction** until a server-side timeout. So "no outstanding database operation after the caller returns" was false precisely for the case it was written for. Three changes, and one honest weakening:
     - **`SET LOCAL idle_in_transaction_session_timeout`** inside the transaction is the primary server-enforced bound. It needs no client at all: if we vanish, Postgres terminates the backend and rolls the transaction back on its own schedule. This is the part that actually holds under a partition.
     - **Best-effort active termination.** `pg` exposes the backend PID as `client.processID` (`client.js:341`), captured at checkout. On the outer deadline the limiter issues a best-effort `SELECT pg_terminate_backend($pid)` on a *different* connection (subject to the same gate, and never awaited by the request). That collapses the window from "until the server timeout" to "immediately," when the network permits.
     - **Destructive local release** still happens, for the reason it was added: to keep a possibly-poisoned client out of the pool.
     - **Weakened contract, stated plainly:** between the outer deadline and either the terminate landing or `idle_in_transaction_session_timeout` firing, a backend *may* remain idle in an open transaction. It holds no row locks this plan cares about (the limiter's writes are single-statement upserts), and it is bounded — but it is not zero, and the plan no longer claims it is.
  4. **Leaves the shared pool untouched.** `SET LOCAL` is transaction-scoped and reverts at `COMMIT`/`ROLLBACK`; a destroyed client never returns to the pool. No change to `lib/db/src/index.ts`.

  Applied to the Store's `increment`/`decrement`/`resetKey`, `getGlobalRateLimitRolloutConfig()`'s refresh, the metrics flush, and each purge batch.
- **Release has exactly one owner (round-9 finding, P2).** `pg-pool` wraps release in `_releaseOnce` (`index.js:342,369`) and **throws on a second call**, so round 8's design — where `runBounded()` destructively releases on its outer deadline *and* the purger's `finally` also unlocks and releases the same client — would throw on the second release, masking the original error or producing an unhandled rejection. Fixed by splitting `runBounded()` into two modes: **owns-the-client** (Store, config refresh, metrics flush — it acquires and releases) and **borrows-a-client** (purge batches — it never releases). In borrow mode a deadline marks the client poisoned and returns; the purger's single `finally` performs **exactly one** release, destructive if poisoned. §5 asserts the stalled-batch path performs exactly one release.
- **The two deadlines have a defined relationship.** The inner `statement_timeout` sits strictly below the outer wall-clock deadline, so the ordinary slow-statement case always resolves Postgres-side with a clean rollback and a reusable client. The outer deadline is reached only when a phase `statement_timeout` cannot govern has stalled.
- §4/§5's tests assert the property, not the timing: a statement past its deadline rejects in budget with nothing lingering; stalled `BEGIN`/`COMMIT`/error-path `ROLLBACK` each leave no client behind — verified from a *separate* session. **Round-9 additions:** a simulated **transport fault** (socket dropped without server-side FIN, not merely a responsive local socket) asserts the backend is gone within the `idle_in_transaction_session_timeout` bound, from a second session; a pool-exhaustion burst asserts `_pendingQueue` length and connection-creation count both stay bounded; and the stalled-batch purge path is asserted to release exactly once.

**Purge coordination across autoscale instances (round-5 finding, P2; round-6 correction of the mechanism, P2×2):** `jobs/rateLimitCounterPurger.ts` (§2) is registered from `index.ts` in every process and aligned to the top of the hour — on autoscale, every live instance fires the same `DELETE WHERE expires_at < now()` concurrently, contending for the same row locks and pool capacity for redundant work (only one delete pass is actually useful). Fixed by wrapping the purge run in a Postgres advisory lock, with two round-6 corrections to the round-5 version:

- **The lock is acquired and released on one checked-out client, not separate pooled calls.** `pg_try_advisory_lock`/`pg_advisory_unlock` are session-scoped — issuing them as independent `db.execute(...)` calls (as round 5's description implied) can route each to a *different* pooled connection, meaning the unlock silently does nothing while the original session (still holding the lock) sits idle in the pool, permanently starving future purge cycles on whichever instance happened to acquire it first. Fixed: `pool.connect()` obtains one client; lock acquisition, every purge batch, and `pg_advisory_unlock` all run on that same client.
- **Release is destructive whenever unlock isn't positively confirmed (round-8 finding, P2 — correcting a false claim in round 7).** Round 7 asserted that `client.release()` "ends the session, so the lock drops even if `pg_advisory_unlock` never runs." That is simply **not true** for the installed `pg-pool@3.13.0`. Its `_release` reads `if (err || this.ending || !client._queryable || client._ending || client._poolUseCount >= maxUses) return this._remove(client, ...)` — an error-free release on a healthy client falls straight past that branch and returns the connection to the **idle pool**, session intact. So a hung, failed, or outer-deadline-abandoned `pg_advisory_unlock` would leave a pooled session holding the purger lock indefinitely, which is precisely the fleet-wide starvation the lock was supposed to make impossible. Fixed: the purger releases with `client.release(err)` — a **destructive** release that routes to `_remove` → `client.end()` → session terminated → Postgres drops the advisory lock — on every path where unlock completion is not positively confirmed (unlock threw, unlock never settled, the run deadline fired, or a batch threw before unlock). Only a confirmed-successful unlock takes the ordinary non-destructive release. Destroying one pooled connection per failed purge is a trivial cost against permanently wedging the fleet's cleanup.
- **The test must not be able to falsely pass, either (round-8 finding).** Advisory locks are **reentrant within a session**, so a test that re-acquires from the same pooled client would report success whether or not the lock was actually released. §5's test therefore verifies from a **distinct second database session** and asserts against `pg_locks` directly, rather than inferring release from a successful re-acquisition.
- **The lock key is a documented, reserved, two-integer namespace, not an arbitrary fixed value.** Postgres advisory locks share one database-wide namespace — an undocumented key risks a silent future collision with an unrelated feature. `RATE_LIMIT_PURGER_LOCK` is defined as a constant pair (e.g. `(0x52_4c_50, 1)` — a memorable classid derived from "RLP" plus a fixed object id) in `globalRateLimitStore.ts`, with a comment reserving that pair explicitly for this purger and instructing any future advisory-lock user in this codebase to pick a different pair.

The delete itself is also changed from one unbounded statement to a bounded-batch loop (delete up to 1,000 rows per statement, repeat until zero rows affected) so a large backlog doesn't hold locks for an extended single transaction.

- **The purge run is itself deadline-bounded, at two levels (round-7 finding, P2).** `pg_try_advisory_lock` makes *acquisition* non-blocking, but that only protects the instances that fail to acquire — it says nothing about the holder. A single `DELETE` that never settles would leave that session holding the lock indefinitely, and since every other instance politely skips on a failed `try`, the fleet-wide result is that **no instance ever purges again** while one stuck session sits in the pool. That's a worse outcome than the uncoordinated contention the lock was added to fix, so the lock needs a holder bound, not just a waiter bound. Fixed: each batch runs through `runBounded()` (above) on the lock-holding client, so `SET LOCAL statement_timeout` gives Postgres-side cancellation of a stuck `DELETE`; and the loop carries an overall run deadline (60s) after which it stops early and falls through to `finally`, leaving the remaining backlog to the next hourly run rather than holding the lock. Both paths reach the `finally` release — which is **destructive** unless the unlock was positively confirmed, per the bullet above (round-8 correction; the earlier claim that a plain `client.release()` ends the session was wrong).
- §5 tests the case Codex named specifically — a purge whose mid-batch statement never resolves, followed by a *successful* acquisition from another runner — not only the already-covered rejected-batch and clean-contention cases.

### 4. Files touched

- `artifacts/api-server/package.json` and the regenerated root `pnpm-lock.yaml` — add `express-rate-limit`.
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new, and the home of every mechanism in §3:
  - `GlobalRateLimitStore` — the `Store` implementation, now taking a `{ keyPrefix }` option so the global limiter (`grl:`) and `rescueLimiter` (`grl:rescue:`) share one class with independent key namespaces (round-7 finding, P1).
  - `runBounded()` (round-7 P1; round-8 P1; round-9 P1×2) — the deadline primitive, in two modes (**owns-the-client** vs **borrows-a-client**, so release always has exactly one owner — round-9 `_releaseOnce` finding). Acquisition goes through a **limiter-owned concurrency gate**, never a `pool.connect()` race that would strand waiters in `_pendingQueue` (round-9 P1). Execution is bounded by `SET LOCAL statement_timeout` **and** `SET LOCAL idle_in_transaction_session_timeout` — the latter being the only bound that survives a transport partition — plus a best-effort `pg_terminate_backend(client.processID)` on a separate connection and a destructive local release. **Replaces round 6's `withTimeout()`** (which cancelled nothing) and corrects round 7's non-destructive release and round 8's socket-destruction overclaim. Used by every DB call here.
  - `MAX_CONCURRENT_LIMITER_CHECKOUTS` (4 of the pool's 20) — the gate above; exceeding it fails fast into fail-open rather than queueing.
  - `recordBlockedOutcome(mode)` — synchronous in-memory increment, keyed `(outcome, UTC hour)` at record time, holding a **per-process cumulative** (round-7 findings: idempotent flush, correct hour/day attribution). Clamped at 2,000,000,000 with a `saturated` flag rather than allowed to overflow.
  - The identity discriminator: one **31-bit union sketch per (bucket, hour)** (≤1,000 buckets/process/interval, overflow counted), OR-merged in the database so cardinality survives aggregation across instances and intervals (round-9 finding, P2 — replacing the per-process class reduction, which destroyed exactly that). Fed **only** by DB-validated `req.user.id` values collected after `authMiddleware`, never the raw `sid` cookie (round-8 finding, P1). Classification is a **read-time** linear-counting estimate over the unioned word.
  - `readFleetMetrics()`'s **range-checked `int8` → `number` conversion** on every aggregate — `pg` returns `count(*)`/`sum(integer)` as strings (round-9 finding, P2).
  - `getGlobalRateLimitRolloutConfig()` is **total — it never rejects** (round-8 finding, P1): stale-but-known-good on a warm failure, safe code defaults (`600`/`dryRun: true`) on a cold one, with no retry amplification.
  - The `unref()`'d 10s flush interval, `stopFleetMetricsFlush()`, and a **single-flighted** `flushPendingFleetMetrics()` that a concurrent caller joins rather than racing (round-7 finding, P2). Writes absolute cumulative values (`SET count = EXCLUDED.count`), so a retry after an ambiguous commit is a no-op and **no restore-on-failure path exists** — round 6's delta-restore is superseded and removed.
  - `readFleetMetrics()` — hour rows rolled up to the last 7 days, the `overLimitClassByDay` series, the `saturated` flag, and the live `distinctBucketsOverLimitNow` gauge (filtered on `key_raw`, round-6 P1; `count > limit`, round-7).
  - `RATE_LIMIT_PURGER_LOCK` — the documented, reserved advisory-lock key pair.
  - `getGlobalRateLimitRolloutConfig()` — the combined, 2-second single-flighted, debug-overlay-bypassing read of `global_rate_limit_max`/`global_rate_limit_dry_run` (round-6 findings, P1+P2).
  - A boot-generated random process id (UUID) used in the metric row keys, so a restarted instance never overwrites its predecessor's row.
- `lib/db/migrations/0095_global_rate_limit_max_config.sql` **and its `lib/db/migrations/meta/_journal.json` entry** — round-3 finding: the production migration runner (`migrate.ts:140-143`) only applies files with a matching journal entry; a SQL file alone is silently never run. Idempotent seed of `global_rate_limit_max` (default 600, `max_value: MAX_GLOBAL_RATE_LIMIT` — round-6 finding, P2) and `global_rate_limit_dry_run` (default `true`).
  - **`ON CONFLICT DO UPDATE` now repairs structural columns, not just the three round-3 had (round-4 finding, P2):** the conflict clause sets `label`/`description`/`data_type`/`min_value`/`max_value`/`is_public` unconditionally on every run while leaving `value` untouched. A stored `value` that's already out-of-bounds or non-numeric is deliberately left as-is by the migration; the read-time fallback (§3's `[1, MAX_GLOBAL_RATE_LIMIT]` clamp and `getGlobalRateLimitRolloutConfig`'s safe-default behavior) is what makes a malformed or out-of-range stored value harmless — clamping both ends now, not just the floor (round-6 correction of round 5's `Math.max`-only version).
  - **Registered as snapshot-exempt (round-4 finding, P2):** `0095_global_rate_limit_max_config` is added to `SNAPSHOT_EXEMPT_TAGS` with a comment stating it's pure DML.
- `artifacts/api-server/src/lib/adminConfig.ts` — **add single-flight refresh to `loadAll()`** (round-3 finding): concurrent callers await one shared in-flight promise instead of each issuing a query on a cache miss. (The ceiling and dry-run flag no longer read through this module's general cache at all — round-6 findings moved them to `globalRateLimitStore.ts`'s own dedicated, faster cache; `getConfigIntRaw`, used elsewhere in this codebase, is unaffected and unchanged.)
- `artifacts/api-server/src/routes/admin.ts` — new `GET /api/admin/rate-limit-metrics` route (existing admin-auth pattern) returning the payload in §3. Plus two validation fixes to the config PATCH handler, both pre-existing general gaps that this plan's own requirements surfaced:
  - **Boolean values are validated at all (round-6 finding, P2).** The handler validates `"integer"`/`"float"` (`admin.ts:2238-2266`) but silently accepts any string for a boolean row (e.g. `"False"`, a typo), which the read path would then quietly fall back away from while the PATCH returned 200. New branch rejects (400) anything that isn't exactly `"true"` or `"false"`, matching the convention `getPublicConfig()` already assumes.
  - **Integer/float values are validated as whole strings (round-7 finding, P2).** Verified in the source: both the value path (`admin.ts:2238-2251`) and the debug-value path (`admin.ts:2277-2290`) validate with `parseInt`/`parseFloat` and then store **`rawValue`, the original string** (`admin.ts:2267`, `:2306`). `parseInt` stops at the first invalid character, so `"1e6"` → 1, `"1.5"` → 1, and `"600oops"` → 600 all pass validation — including the min/max bounds check, which runs against the *parsed* number while the *unparsed* string is what gets persisted. The concrete consequence for this plan: an emergency `global_rate_limit_max` PATCH of `"1e6"` reports success while the rollout reader either resolves a completely different ceiling or falls back to 600 — the emergency change silently doesn't happen, or worse, silently lowers the active ceiling. Fixed by requiring a canonical whole-string match (`/^-?\d+$/` for integer rows, a strict decimal pattern for float rows) before the bounds check, on **both** the value and debug-value paths. Like the boolean gap, this is general — it protects every existing integer config key, not just the new ones.
- `artifacts/api-server/src/app.ts` — mount early, immediately after the app-level `cors()` call, scoped to `/api`, direct-passed; refactor `isPublicAssetRequest` to take an explicit path argument; `EARLY_EXEMPT_ROUTES` as method+path pairs (round-5 finding); **`rescueLimiter` registered on the two self-rescue PATCH routes ahead of the global mount, replacing their unconditional exemption** (round-7 finding, P1); **`normalizeRoutePath()` shared by registration and exemption so a trailing-slash spelling can't be metered twice or slip past an exact-string predicate** (round-8 finding, P2); and a small middleware **after `authMiddleware`** that records the validated `req.user.id` against the bucket `handler` stamped on `res.locals` — the discriminator no longer reads the `Cookie` header at all (round-8 finding, P1).
- `artifacts/api-server/src/jobs/rateLimitCounterPurger.ts` — new, mirrors `jobs/transientRenderPurger.ts`, plus the advisory-lock-on-one-checked-out-client + bounded-batch delete loop described above (round-5/round-6 findings), each batch run through `runBounded()` and the whole run under a 60s deadline so a stuck holder can't starve the fleet (round-7 finding); `index.ts` gets the matching `scheduleRateLimitCounterPurger()` call. (Fleet-metric rows are hour-bucketed with a real 35-day expiry, so this purger cleans them up like any other row — no exemption list needed.)
- `artifacts/api-server/src/index.ts` — **boot-time assertion** (round-5 finding, round-6 correction of the predicate, §2): throws before the server accepts traffic if the *canonical* production predicate (`REPLIT_DEPLOYMENT === "1" || NODE_ENV === "production"` — matching `securityHeaders.ts`'s existing `isProductionEnv()`, `siteUrl.ts`, `devAdminLogin.ts`) is true and `IP_HASH_SALT` is missing/short. `index.ts`'s shutdown `onClose` now also calls `flushPendingFleetMetrics()` (round-6 finding).
- `artifacts/api-server/src/shutdown.ts` — **`onClose` may now return a `Promise`, awaited before `safeExit(0)`** (round-6 finding, P2), **and `clearTimeout(forceExitTimer)` moves from before the hook to after the awaited promise settles** (round-7 finding, P2). The current ordering (`shutdown.ts:62-66`) clears the timer first, so awaiting an async hook would have silently removed the grace-period bound this change claims to preserve — a hung flush would hang the process forever instead of hitting `gracePeriodMs`. With the move, the timer stays armed across the hook and a hung flush still force-exits via `onTimeout` → `safeExit(1)`. This and the admin-endpoint validation gaps are the only changes outside the rate limiter's own files — both pre-existing, general gaps this plan's requirements surfaced, not scope creep.
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new: Store unit tests (increment/decrement/resetKey semantics, both persisted columns salted, window/expiry rollover, the `keyPrefix` option isolating `grl:` from `grl:rescue:`), a real concurrency test, and:
  - **Fleet metrics:** `recordBlockedOutcome`/flush produces the correct `(process, outcome, hour)` row; the collision-impossibility test over a large IPv4/IPv6/subnet sample; metric rows get a real (not eternal) expiry and are purged.
  - **Idempotency (round-7):** replaying the same flush writes the same absolute value and does **not** double-count — the ambiguous-commit case, driven by simulating a commit whose response is lost.
  - **Boundary attribution (round-7):** a flush that fails just before an hour/day boundary and succeeds just after attributes the earlier requests to the earlier bucket.
  - **Overflow (round-7, extended round-9):** driven to the actual `int4` boundary — the clamp holds, no upsert throws, `saturated` becomes true; **and a second simulated instance observes `saturated: true` from the persisted marker after the originating process is gone** (round-9 — round 8's in-memory flag was invisible fleet-wide).
  - **Aggregate types (round-9):** `readFleetMetrics()` returns `number`, not the `int8` strings `pg` yields for `count(*)`/`sum(integer)`; the endpoint test asserts JSON value **types**, and an out-of-safe-range sum surfaces as an error rather than a lossy float.
  - **Cancellation (round-7 P1, round-8 P1, round-9 P1×2):** a statement past its deadline rejects in budget with nothing lingering; stalled `BEGIN`/`COMMIT`/error-path `ROLLBACK` each leave no client, open transaction, or query — all verified from a separate database session. **Round-9:** a simulated **transport fault** (socket dropped with no server-side FIN — the case local socket destruction does *not* cover) asserts the backend is gone within the `idle_in_transaction_session_timeout` bound; a **pool-exhaustion burst** asserts both `_pendingQueue` length and connection-creation count stay bounded (the gate, not a race); and a stalled purge batch performs **exactly one** release.
  - **Rollout-config totality (round-8, P1):** a rejecting refresh and a never-settling refresh both yield a usable config (stale-but-known-good when warm, `600`/`dryRun: true` when cold) rather than throwing, and neither raises refresh concurrency.
  - **Discriminator (round-7; round-8 P1; round-9 P2):** the read-time linear-counting classification, the 1,000-bucket cap and its overflow counter; the **forgery** case (arbitrary, duplicate, prefix-colliding, malformed `sid` cookies never move a bucket out of the single/anonymous class, while eight genuinely authenticated sessions do reach `overlimit_shared`); and **the aggregation case round 9 found — eight users split across simulated instances *and* across flush intervals must classify the bucket `overlimit_shared`, not produce eight `overlimit_single` observations.** The all-eight-in-one-process case is kept as the degenerate case, not the only one. Plus: OR-merging the same sketch twice is a no-op (idempotence).
  - **Gauge (round-7, extended round-8):** `distinctBucketsOverLimitNow` against real persisted rows at exactly the limit (must not count) and at limit+1 (must count), **plus a persisted `grl:rescue:` row above the threshold asserted not to be counted.**
  - **Rollout config (round-6):** at most one DB query per 2-second window regardless of concurrent-caller volume; a value written via one simulated instance's cache is visible to a second's within the TTL, for both the ceiling and the dry-run flag.
  - **Flush concurrency (round-7):** a shutdown drain overlapping a periodic flush joins it rather than issuing a second overlapping write.
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new: real-`app` integration test with an injectable low limit — 429/JSON-body/headers/no-store, exempt paths never touch the Store (asserted via hit count) including the non-`/api`-request case, `ipKeyGenerator` behavior, `passOnStoreError`, dry-run mode (blocked-but-passed-through, asserting **no** `RateLimit-*`/`X-RateLimit-*`/`Retry-After` headers survive), trusted-IP resolution order, CORS-position and preflight-never-touches-Store, dry-run→enforcement flip without counter reset, wrong-method-on-exempt-path, a never-resolving mock Store proving fail-open still reaches `next()` within budget, bounded WARN log volume under a sustained burst. **Round-6:** a slow unrelated query on the shared pool (simulating a migration/backfill) is unaffected by the limiter's own deadline (proving no round-5 blast radius); a sustained over-limit burst issues at most one `admin_config` query per 2 seconds regardless of burst size. **Round-7, the rescue-path finding (P1):** an *unauthenticated* burst against both rescue PATCH paths is metered by `rescueLimiter` and 429s after its ceiling — i.e. it does **not** reach body parsing/`authMiddleware` unbounded; an admin whose *global* bucket is already exhausted still reaches the rescue PATCH successfully (independent key namespace); the rescue limiter enforces while `global_rate_limit_dry_run` is `true`; and a malformed rescue PATCH value (`"1e6"`, `"False"`) is rejected 400 rather than stored. **Round-8:** both the canonical and the **trailing-slash** spelling of each rescue route are metered **exactly once** (by `rescueLimiter`, never additionally by the global limiter), and a *non*-rescue key (`PATCH /api/admin/config/some_other_key`) matches neither the rescue registration nor the rescue exemption; plus a rollout-config refresh failure yields downstream routing rather than a 500. **Round-9:** `HEAD` against each GET-only exempt route (`/api/healthz`, `/api/health`, `/api/health/queues`, `/api/config`) reaches the real handler **without touching the Store** — asserted against the actually-registered routes, since the router's HEAD→GET dispatch is what made the GET-only exemption wrong; and a pool-exhaustion burst leaves `_pendingQueue` and connection churn bounded.
- `artifacts/api-server/src/__tests__/rateLimitCounterPurger.test.ts` — new, mirrors `phase4.purger.test.ts`; a simulated two-instance concurrent purge run asserts only one actually performs the delete; a large synthetic backlog is deleted in bounded batches. **Round-6:** a purge run that throws mid-batch still releases the advisory lock (asserted by a subsequent run successfully acquiring it), and the lock/unlock pair is asserted to run on the same checked-out client. **Round-7:** a purge whose mid-batch statement *never resolves* (not merely rejects) is cancelled by its `SET LOCAL statement_timeout`, the run deadline releases the client, and a second runner then acquires the lock — the fleet-wide starvation case the reject-only test didn't cover. **Round-8:** the same scenarios re-asserted against **`pg_locks` from a distinct second database session**, because advisory locks are reentrant within a session and a same-session re-acquisition would pass whether or not the lock was actually released; plus a case where `pg_advisory_unlock` itself hangs, asserting the destructive `client.release(err)` terminates the session and the lock is gone.
- `artifacts/api-server/src/__tests__/index.saltGuard.test.ts` (round-6 finding) — boot-time assertion matrix: production (`REPLIT_DEPLOYMENT=1`, `NODE_ENV` unset) without a valid salt throws; ordinary test/CI environment does not throw; local development does not throw.
- `lib/db/src/migrate.test.ts` (round-5 finding — corrects round 4's proposed path, which sat outside `lib/db/package.json`'s `src/**/*.test.ts` test glob) — covers the four row states against `0095`'s conflict clause, including an above-`max_value` row asserted against the *resolved, both-ends-clamped* limit (round-6 correction — round 5's version only exercised the floor). Verification names `pnpm --filter @workspace/db test` explicitly.
- `artifacts/api-server/src/__tests__/shutdown.test.ts` (extended, round-7 finding, P2) — an async `onClose` is awaited before exit; the force-exit timer stays armed *across* the hook, so a hung `onClose` still force-exits at `gracePeriodMs` with `onTimeout` fired and code 1; a fast `onClose` clears the timer and exits 0. This is the assertion that would have caught the `clearTimeout`-ordering bug.
- `artifacts/api-server/src/__tests__/adminConfigValidation.test.ts` (round-6 + round-7 findings) — `"1e6"`, `"1.5"`, `"600oops"`, `" 600"` are rejected 400 on both the value and debug-value paths for an integer row; `"False"`/`"1"`/`""` rejected for a boolean row; canonical values still accepted; and the effective runtime ceiling is asserted *after* each rejected PATCH to prove the stored value never changed.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — add the resolution.

### 5. Must not change

- **The existing narrow limiters' own behavior and thresholds are unchanged.**
- **Unconditionally exempt, reachable regardless of this middleware's Store state or configured ceiling:** health/liveness, the existing public crawler-asset patterns, `/api/config`, and the Stripe webhook — matched on **method and path together**, not path alone. None of these reaches body parsing or a DB session lookup, which is why an unconditional exemption is safe for them.
- **The two admin self-rescue PATCH routes must stay reachable but must NOT be unconditionally exempt** (round-7 finding, P1). They are metered by `rescueLimiter`: an independent key namespace (so an exhausted global bucket doesn't block rescue), a fixed code-constant ceiling never read from `admin_config` (so the table being repaired can't disable its own repair path), and enforcement regardless of dry-run. An exemption evaluated before `authMiddleware` exempts the whole internet, not admins.
- **Whether the rest of `/api/admin/*` is covered by this ceiling is an open product question, not settled by this plan.**
- **Ships in observe-only (dry-run) mode by default** — no request is actually blocked by the *global* limiter until `global_rate_limit_dry_run` is explicitly set to `false` (and only a validated `"true"`/`"false"` PATCH can ever change it — round-6 finding), and the dry-run response carries no `RateLimit-*`/`X-RateLimit-*`/`Retry-After` headers. `rescueLimiter` is deliberately outside this: it enforces from day one.
- **Mounted after the app-level `cors()` call, not before it.**
- No new table/schema migration for `rate_limit_counters`; the `count` column stays `integer`. Overflow safety must not rest on a traffic-rate assumption (round-7 finding): it comes from hour buckets **and** per-process rows **and** the lowered `MAX_GLOBAL_RATE_LIMIT` **and** a saturation clamp that degrades visibly instead of throwing.
- No raw client IP addresses, and no unsalted digest of one, persisted anywhere or emitted in metrics/logs — enforced at boot for production using the **canonical** production predicate (round-6 correction), not just documented. The shared-NAT discriminator persists only three per-hour class counts; no identity, count of identities per bucket, or bucket-level detail is ever written.
- **`blockedByDay`/`overLimitClassByDay`/`distinctBucketsOverLimitNow`/`saturated` are fleet-wide and DB-backed; `totalThisInstance`/`storeErrorThisInstance` are explicitly process-local** — the metrics endpoint response must keep labeling which is which. `distinctBucketsOverLimitNow` must be computed from `key_raw`, not `key_hash` (round-6, P1), and must use `count > limit`, not `>=` — `express-rate-limit` allows the request that lands exactly on the ceiling (round-7).
- A migration re-run must never silently widen or remove `global_rate_limit_max`'s/`global_rate_limit_dry_run`'s bounds/type/visibility on an existing, partially-provisioned row — only `value` is left untouched across a re-run; every other column is repaired.
- **No DB call on the rate-limiter's own hot path may outlive its deadline** — and "bounded" means the operation is **cancelled server-side**, not merely un-awaited (round-7 finding, P1). Via `runBounded()`'s per-transaction `SET LOCAL statement_timeout` on a checked-out client, never via a shared-Pool-level timeout that would cancel unrelated legitimate work — no changes to `lib/db/src/index.ts`'s Pool config. **This must hold for the transaction-control phases too** (`BEGIN`/`COMMIT`/`ROLLBACK`), which `statement_timeout` cannot govern (round-8 finding, P1).
- **Local socket destruction is not server-side cancellation, and the plan must not claim it is** (round-9 finding, P1). `client.end()` destroys our socket and returns; under a transport partition the backend can remain idle in an open transaction. The server-enforced bound is `SET LOCAL idle_in_transaction_session_timeout`, with best-effort `pg_terminate_backend` to collapse the window — and the residual window is stated, not asserted away.
- **Connection acquisition must be gated, never raced** (round-9 finding, P1). `pg-pool` removes a queued waiter only via `connectionTimeoutMillis`, which this shared pool does not set — so abandoning a `connect()` promise strands the waiter permanently and creates unbounded queue growth plus connection churn. A limiter-owned concurrency gate fails fast into fail-open instead of enqueuing.
- **Every checked-out client has exactly one release owner** (round-9 finding, P2) — `pg-pool`'s `_releaseOnce` throws on a second release, so a deadline path and a `finally` path must not both release.
- **Persisted metric aggregates must be converted from `int8` with range checking before leaving `readFleetMetrics()`** (round-9 finding, P2) — `pg` returns them as strings.
- **A pooled client must never be returned to the pool in an uncertain state.** `pg-pool@3.13.0`'s `_release` destroys a client only when released *with an error* (or when the pool is ending) — an error-free release returns a live session to the idle pool. So any path where a transaction may still be open, or an advisory unlock is not positively confirmed, must use `client.release(err)` (round-8 finding).
- **The advisory lock's holder must be bounded, not just its waiters** (round-7 finding) — a stuck purge must never leave the fleet permanently unable to purge. Tests must verify release from a **distinct database session** via `pg_locks`, since advisory locks are reentrant within a session (round-8 finding).
- **`getGlobalRateLimitRolloutConfig()` must never reject** (round-8 finding, P1) — it is awaited from `limit` and `handler`, which `passOnStoreError` does not cover, so a rejection becomes a JSON 500 and fails requests *closed* during a database outage. Stale-but-known-good when warm, safe code defaults when cold, no retry amplification.
- **The over-limit gauge must positively match the global client key shape** (`^grl:[0-9a-f]{64}$`), not exclude reserved namespaces by denylist — `grl:rescue:` leaked through the round-6/7 predicate the moment it existed (round-8 finding).
- **Rescue-route registration and exemption must derive from one normalized matcher** — Express's default non-strict routing means a trailing-slash spelling reaches the same handler, and an exact-string exemption would leave it metered twice and unusable as a rescue path (round-8 finding).
- **The shared-NAT discriminator must consume only DB-validated identities** collected after `authMiddleware`, never the raw `sid` cookie — otherwise an attacker forges distinct session values to force `overlimit_shared` and suppress enforcement (round-8 finding, P1).
- **The discriminator must preserve distinct-identity cardinality across instances and across flush intervals** (round-9 finding, P2) — reducing to a class locally makes one shared NAT look like N separate single-identity clients, biasing toward enforcement. Hence a DB-OR-merged union sketch and read-time classification, never a per-process conclusion.
- **`saturated` must be persisted, not a per-process in-memory flag** (round-9 finding, P2) — the endpoint advertises it as fleet-wide, and the guarantee that makes retaining `int4` acceptable is that degradation is *visible* from any instance, including after the saturated process exits.
- **Exemptions for GET-only escape routes must also cover `HEAD`** (round-9 finding, P2) — the installed router dispatches `HEAD` to a `GET` handler when no explicit `HEAD` handler exists, so a GET-only exemption lets `HEAD /api/healthz` consume the Store and be blocked at the ceiling.
- **The global ceiling and the dry-run flag never resolve through the `debug_mode_active` overlay.**
- **DB query volume for the ceiling/dry-run read must not scale with request or blocked-request volume** — `getGlobalRateLimitRolloutConfig()`'s 2-second single-flighted cache is what a per-request uncached read (round 5's design) would have violated under sustained abuse (round-6 finding, P1).
- **An emergency change to either `global_rate_limit_max` or `global_rate_limit_dry_run` must reach every autoscale instance within the 2-second cache TTL**, not the general `admin_config` cache's 60-second TTL (round-6 finding, P2).
- **A config PATCH must never report success while storing a value the runtime resolves differently** — canonical whole-string validation for integer/float rows and exact `"true"`/`"false"` for boolean rows, on both the value and debug-value paths (round-6 + round-7 findings).
- **The metrics flush must be idempotent under an ambiguous commit** (round-7 finding) — absolute cumulative writes, never additive deltas with client-side restore.
- **Pending fleet-metrics counts survive a graceful shutdown**, via the specified ordering: stop the interval → join any in-flight flush → final drain, with the force-exit timer armed across the whole hook. Only an unclean process kill can lose up to ~10s of data — an accepted trade-off for an approximate signal, not a security-enforcing one.
- **The advisory-lock key pair reserved for the purger (`RATE_LIMIT_PURGER_LOCK`) must not be reused by any other feature** — it is this codebase's first advisory-lock user and establishes the convention.

## Verification

1. `pnpm run typecheck` / `pnpm run build` — clean. `pnpm install --frozen-lockfile` succeeds. `pnpm --filter @workspace/db check-snapshots` passes. `pnpm --filter @workspace/db test` passes.
2. New `GlobalRateLimitStore` unit tests pass — the full list in §4, including: concurrency; salted-both-columns; `keyPrefix` isolation; collision-impossibility; metric rows expire and are purged; **flush idempotency under a simulated ambiguous commit**; **hour/day-boundary attribution across a failed-then-successful flush**; **the `int4` boundary itself, asserting the clamp holds and `saturated` flips rather than an upsert throwing**; **`runBounded()` cancellation — a `pg_sleep` past its deadline rejects in budget AND `pg_stat_activity` shows no lingering active query**, plus the abandoned-`connect()` release; the discriminator's three-class reduction and both caps; the gauge at exactly-limit (not counted) and limit+1 (counted); `getGlobalRateLimitRolloutConfig()`'s single-flight and two-instance propagation proofs; and a shutdown drain joining an in-flight periodic flush rather than racing it.
3. New real-`app` integration test passes: 429 (when not in dry-run) + JSON body + `Cache-Control: no-store` + headers past an injected low limit; dry-run mode logs/counts but never blocks and carries no rate-limit-related headers at all; exempt paths (including non-`/api` paths and wrong-method-on-exempt-path) never touch the Store; trusted-IP precedence proven against actual bucket sharing; `ipKeyGenerator` IPv6/IPv4-mapped handling; `passOnStoreError` via a forced Store error and via a never-resolving mock proving fail-open is fast **without affecting an unrelated slow query on the shared pool** (round-6); CORS-position and preflight-never-touches-Store; dry-run→enforcement flip without counter reset; a sustained blocked burst produces bounded WARN volume **and at most one `admin_config` query per 2 seconds regardless of burst size** (round-6). **Round-7 rescue-path proofs (P1):** an unauthenticated burst on either rescue PATCH path is 429'd by `rescueLimiter` rather than reaching parsing/`authMiddleware` unbounded; an admin with an exhausted *global* bucket still reaches the rescue PATCH; `rescueLimiter` enforces while dry-run is `true`.
4. New purger tests pass, including metric rows expiring normally, the advisory-lock single-runner proof under simulated multi-instance concurrency **on one checked-out client**, **lock release after a mid-batch throw** (round-6), and **a never-resolving mid-batch statement followed by a successful acquisition from another runner** (round-7 — the fleet-starvation case).
5. New boot-time salt-guard test matrix passes (round-6): production-with-unset-`NODE_ENV` throws without a valid salt; test/CI and local dev do not throw.
5b. **Shutdown-ordering test passes (round-7):** a hung async `onClose` still force-exits at `gracePeriodMs` with `onTimeout` fired — proving the `clearTimeout` move preserved the grace bound rather than removing it.
5c. **Config-validation test passes (round-6 + round-7):** `"1e6"`/`"1.5"`/`"600oops"`/`" 600"` rejected on both value and debug-value paths; `"False"`/`"1"`/`""` rejected for booleans; the effective runtime ceiling is re-read after each rejection to prove nothing was stored.
6. **Migration test**, run via `pnpm --filter @workspace/db test`: the four-row-state matrix plus an above-maximum row, each asserted against the repaired conflict clause and the *resolved, both-ends-clamped* limit value.
7. Full existing test suite + E2E Smoke — no new failures.
8. Local CodeQL re-scan of the actual final code confirms `js/missing-rate-limiting` drops from 213 to 0.
9. **Load budget — concrete numbers:**
   - Workload A: 500 concurrent requests / 200 distinct keys, sustained 30s.
   - Workload B: 500 concurrent requests / 1 shared key, sustained 30s.
   - Workload C: a cold/expired `admin_config` cache burst, proving the single-flight fix results in one refresh query, not N.
   - Workload D: an over-limit burst proving response-path latency is unaffected by the fleet-metrics flush, **and asserting the total `admin_config` query count for the run stays at or near `duration_seconds / 2` (the rollout-config cache's TTL) regardless of burst size — not proportional to request count** (round-6 finding, P1).
   - Pass criteria for all four: p95 latency added ≤ 15ms; sustained pool usage ≤ 16 of 20 connections; 0% Store-attributable error rate.
10. Manual: hit an `/api` route past the ceiling from one IP, confirm dry-run logs a would-be-block (throttled to ≤1/sec) without actually 429ing and the response carries no rate-limit headers; flip `global_rate_limit_dry_run` to `false` locally (and confirm invalid PATCH values `"False"` and `"1e6"` are rejected — round-6/round-7), confirm an actual 429 with the right body/headers/CORS headers; confirm the narrow limiters and all exempt method+path routes are unaffected; confirm `GET /api/admin/rate-limit-metrics` returns the 7-day trend, the `overLimitClassByDay` series, and a *non-zero* live distinct-buckets gauge when over-limit client rows actually exist (round-6 — proving the query fix, not just that it runs); confirm setting `debug_mode_active` + a `debugValue` on `global_rate_limit_max` has no effect on the actual enforced ceiling; send SIGTERM mid-flush-interval and confirm pending counts are still persisted (round-6).
11. Post-flip-to-enforcement: continue monitoring `blockedByDay`/`overLimitClassByDay`/`distinctBucketsOverLimitNow` after enforcement is enabled; the dry-run data is what justifies the initial default, not a blind 72-hour post-enforcement watch.

## Open questions for David

1. **`/api/admin/*` route coverage.** Whether the rest of the admin surface sits behind this ceiling is a pre-existing open roadmap question (`current-roadmap.md:280-288`); this plan deliberately does not answer it by omission. The two self-rescue endpoints are handled either way (via `rescueLimiter`).
2. **The residual shared-NAT blind spot (round-7).** The discriminator classifies over-limit buckets by *authenticated* identity count, which answers the question for logged-in populations. A NAT carrying only logged-out traffic is indistinguishable from a single anonymous scraper, because there is no identity to count. Closing that would mean fingerprinting anonymous traffic — which this plan will not do on privacy grounds. So the ask is an explicit acceptance: **flip to enforcement on the authenticated-population signal, accepting that a purely-anonymous shared NAT above the ceiling would be blocked without warning.** At a 600/min default this is a narrow residue, but it is real and shouldn't be discovered after the fact.
