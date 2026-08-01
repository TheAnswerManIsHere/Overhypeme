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

```ts
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import {
  GlobalRateLimitStore,
  globalRateLimitMetrics,
  incrementFleetMetricCounter,
  readFleetMetricCounters,
  METRIC_BLOCKED_DRY_RUN,
  METRIC_BLOCKED_ENFORCED,
} from "./lib/globalRateLimitStore";
import { ipFromRequest } from "./lib/transientRenderLog";
import { getConfigInt, getConfigBooleanFresh } from "./lib/adminConfig";
import { logger } from "./lib/logger";

const GLOBAL_RATE_WINDOW_MS = parsePositiveInt(process.env.GLOBAL_RATE_WINDOW_MS, 60_000);
const HEALTH_PATHS = new Set(["/api/healthz", "/api/health", "/api/health/queues"]);
// Registration-order exemptions made explicit now that the limiter runs
// earlier than they do — see the mount-point note above.
const EARLY_EXEMPT_PATHS = new Set([
  "/api/stripe/webhook",
  "/api/config",
  "/api/admin/config/global_rate_limit_max", // the ceiling's own self-rescue endpoint — see §5
]);

function isExemptRequest(req: Request): boolean {
  const path = req.originalUrl.split("?")[0];
  return (
    isPublicAssetRequest(req.method, path) ||
    HEALTH_PATHS.has(path) ||
    EARLY_EXEMPT_PATHS.has(path)
  );
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
const STANDARD_RATE_LIMIT_HEADERS = [
  "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", // draft-6
  "RateLimit", "RateLimit-Policy",                              // draft-7
  "Retry-After",
];

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  limit: () => getConfigInt("global_rate_limit_max", 600),
  store: new GlobalRateLimitStore(),
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  passOnStoreError: true,
  standardHeaders: true,
  skip: (req) => isExemptRequest(req),
  handler: async (req, res, next) => {
    const path = req.originalUrl.split("?")[0];
    // Uncached, authoritative read — deliberately bypasses adminConfig.ts's
    // 60s cache. `handler` only runs on an already-over-limit request (a
    // low-volume path by construction, unlike `limit` above which runs on
    // every request and needs the cache), so the extra query is cheap, and
    // it's the one place fleet-wide staleness would actually be dangerous:
    // an autoscaled instance serving a stale cached `false` for up to 60s
    // after David flips the flag to true (emergency rollback) would keep
    // enforcing on that instance regardless. See the fleet-consistency note
    // below.
    const dryRun = await getConfigBooleanFresh("global_rate_limit_dry_run", true);
    if (dryRun) {
      // Zero-impact means zero impact: express-rate-limit has already set
      // RateLimit-*/Retry-After headers on `res` by this point (before
      // `handler` is invoked), and a client that honors them would throttle
      // itself even though nothing was actually blocked. Strip them before
      // falling through.
      for (const header of STANDARD_RATE_LIMIT_HEADERS) res.removeHeader(header);
      await incrementFleetMetricCounter(METRIC_BLOCKED_DRY_RUN).catch((err) =>
        logger.warn({ err }, "[globalRateLimit] dry-run metric increment failed"),
      );
      logger.warn({ path, mode: "dry_run" }, "global rate limit would have blocked (dry-run)");
      return next(); // observe, don't enforce — see the rollout note below
    }
    await incrementFleetMetricCounter(METRIC_BLOCKED_ENFORCED).catch((err) =>
      logger.warn({ err }, "[globalRateLimit] enforced metric increment failed"),
    );
    logger.warn({ path, mode: "enforced" }, "global rate limit exceeded");
    res.set("Cache-Control", "no-store");
    res.status(429).json({ error: "Too many requests. Please slow down." });
  },
});

// Mounted after the app-level cors() call, not right after securityHeaders()
// — see the mount-point note above for why.
app.use("/api", countGlobalLimiterRequest, globalLimiter);
```

**Fleet-wide metrics, not a process-local object (round-4 finding, P1 — round 3's design was a real correctness bug, not just an observability gap):** this app deploys on Replit's autoscale target (`.replit`: `deploymentTarget = "autoscale"`), so multiple instances run concurrently. Round 3's `globalRateLimitMetrics` was a single in-memory object per process — every instance had its own `blocked` count, the metrics endpoint returned whichever instance happened to answer the GET, and dry-run-would-have-blocked and real 429s incremented the *same* counter, making them indistinguishable even within one instance. Both problems are fixed by splitting the metric and moving the safety-critical half to the database:

- **`blockedDryRun` and `blockedEnforced` are two separate counters, persisted in `rate_limit_counters` itself** (not a new table) under two reserved, non-IP keys (`grl:metrics:blocked_dry_run`, `grl:metrics:blocked_enforced`), incremented atomically via the exact same `INSERT ... ON CONFLICT (key_hash) DO UPDATE SET count = count + 1` shape the Store already uses — a new `incrementFleetMetricCounter()` helper in `globalRateLimitStore.ts`, not a new SQL pattern. Because every autoscale instance writes to and reads from the same Postgres database, these two counts are fleet-wide-accurate by construction, regardless of which instance answers the metrics GET — no distributed-counter or invalidation-broadcast machinery needed. These are the two numbers David's flip-to-enforcement decision actually depends on, so they're the ones that must not lie.
- **These reserved rows are exempt from `key_raw` salting** — unlike every other row in this table, `key_raw` here stores the literal reserved key string (`"grl:metrics:blocked_dry_run"`), not a salted hash. The salting requirement (§2) exists to avoid persisting anything IP-derived; a static operational counter name isn't IP-derived or otherwise sensitive, so hashing it would only obscure an already-public constant for no privacy benefit. `key_hash` (the primary key) still stores `sha256(key)`, consistent with every other row's primary-key shape.
- **These rows never expire, and need no special-casing in the purger:** `expiresAt` is set to a fixed far-future sentinel (`2099-01-01T00:00:00Z`) at creation, so `purgeExpiredRateLimitCounters()`'s existing `WHERE expires_at < now()` naturally never matches them — no exemption list or extra query needed in the purge job.
- **`totalThisInstance` and `storeErrorThisInstance` stay in-memory and process-local**, explicitly labeled as such in both the metric object's field names and the endpoint response. Two reasons this is the right scope rather than making everything fleet-wide: (1) `total` increments on *every* non-exempt request (not just over-limit ones), so persisting it to the DB would add a write to the same hot path §5's load budget already treats as sensitive — disproportionate for a number that's context, not a decision input; (2) `storeError` fires when a Store DB call has already failed, so persisting it via *another* DB write is circular and could itself fail during exactly the outage it's trying to record — it stays a best-effort local diagnostic, not a safety-critical count.

**Observable sink:** `GET /api/admin/rate-limit-metrics` (behind existing admin auth) returns `{ blockedDryRun, blockedEnforced, totalThisInstance, storeErrorThisInstance }`, with the response body itself documenting which two fields are fleet-wide (DB-backed) and which two are this-instance-only (in-memory) — so David isn't misled into reading `totalThisInstance` as a fleet total.

**Dry-run rollout — replaces the earlier "watch after the fact" plan with an actual pre-enforcement measurement (round-3 finding, Reconciliation):** round 2's post-rollout monitoring rule couldn't distinguish a scraper being correctly blocked from a legitimate shared-NAT population being incorrectly blocked — both produce the same "many blocks from one key" signal, and the plan had no way to tell them apart. Rather than invent a differentiation heuristic (path diversity, request timing, etc. — all guesses without real data), the rollout now has an actual **observe-before-enforce** phase: `global_rate_limit_dry_run` (new `admin_config` boolean, default `true`) makes `handler` count and log what *would* have been blocked but always calls `next()` instead of returning 429 while dry-run is active, with the enforcement headers stripped (see above) so the observe phase is genuinely zero-impact. This means the first deployment collects real, fleet-accurate block-rate data against real traffic, with zero user-facing risk, before a single legitimate request is ever actually rejected. David flips `global_rate_limit_dry_run` to `false` (live, no deploy) once `blockedDryRun` shows no plausible false-positive pattern over an observation window — replacing the earlier "72 hours, then decide from imperfect signal" rule with "watch real fleet-wide dry-run data, then decide, on your own timeline." Because `blockedDryRun`/`blockedEnforced` are cumulative DB counters that are never reset on this transition (no epoch needed — flipping the flag just means future blocks start incrementing the other counter), the before/after comparison across the flip is directly readable from the same endpoint with no special "transition mode."

**Fleet-consistency of the flip itself (round-4 finding, P2):** `adminConfig.ts`'s cache is process-local and `bustConfigCache()` only clears the instance that served the admin PATCH — on autoscale, other instances would keep evaluating the *old* `global_rate_limit_dry_run` value for up to the cache's 60-second TTL after David's change, which is a real risk in an emergency false→true rollback (some instances would keep enforcing on stale data for up to a minute). Fixed by having `handler`'s dry-run check read `getConfigBooleanFresh()` — an uncached, always-live DB read — rather than the cached `getConfigInt`/`getConfigString` path the ceiling (`limit`) uses. This is deliberately asymmetric: `limit` is read on every request and needs the cache for load reasons (§5's Workload C); the dry-run flag is only read inside `handler`, which by construction only runs on an already-over-limit request — a rare enough path that an uncached read per occurrence is cheap, and it's exactly the read where staleness has real safety consequences. `getConfigBooleanFresh` also fails safe on any malformed stored value (see the migration-repair note in §4) by returning `defaultValue` (`true`, i.e. stay in dry-run) for anything that isn't the literal string `"true"` or `"false"` — never coercing an unrecognized value toward enforcement.

**`Cache-Control: no-store` on the enforced 429** (round-3 finding, folded in here): the earlier mount position was covered by the existing `noStore` middleware list (`app.ts`, later in the chain); the new earlier position isn't, so a 429 could otherwise be cached by an intermediate proxy and served stale to a since-recovered client. Set directly in `handler` rather than relying on the later `noStore` list, since this middleware now runs before it.

**Admin routes — genuinely open, not decided here (round-3 finding, P1, tagged Product Decision):** `current-roadmap.md:280-288` already records rate-limiting admin routes as an explicit, still-pending David decision. This plan's mount change (scoped to all of `/api`, moved earlier) would silently resolve that question by inclusion — every admin route now sits behind this ceiling too, including, worse, `/api/admin/config/:key` itself, the endpoint that raises the ceiling if it's ever set too low. Two things, kept separate:
- **The self-rescue endpoint is exempted regardless of the broader answer** (`EARLY_EXEMPT_PATHS` above) — a limiter that can trap its own escape hatch is a design defect independent of whether admin routes in general should be covered, so this part isn't waiting on David.
- **Whether the rest of `/api/admin/*` sits behind this ceiling is not decided by this plan.** That's the pre-existing open roadmap question, and this plan doesn't get to answer it by omission. Flagged to David as a real fork — see the PR thread.

### 4. Files touched

- `artifacts/api-server/package.json` and the regenerated root `pnpm-lock.yaml` — add `express-rate-limit`.
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new: the `Store` implementation, `globalRateLimitMetrics` (process-local `totalThisInstance`/`storeErrorThisInstance`), and the fleet-wide `incrementFleetMetricCounter()`/`readFleetMetricCounters()` pair (§3) reusing `rate_limit_counters` via two never-expiring reserved keys.
- `lib/db/migrations/0095_global_rate_limit_max_config.sql` **and its `lib/db/migrations/meta/_journal.json` entry** — round-3 finding: the production migration runner (`migrate.ts:140-143`) only applies files with a matching journal entry; a SQL file alone is silently never run. Idempotent seed of `global_rate_limit_max` (default 600) and `global_rate_limit_dry_run` (default `true`).
  - **`ON CONFLICT DO UPDATE` now repairs structural columns, not just the three round-3 had (round-4 finding, P2):** round 3's clause only refreshed `label`/`description`/`data_type` on conflict, deliberately leaving `value` untouched so a live-tuned value survives a re-run — correct for `value`, but it also left `min_value`/`max_value`/`is_public` untouched, and `admin.ts`'s PATCH-time bounds check (`admin.ts:2244-2250`) only enforces a bound when the corresponding column is **non-null**. A row left over from a partial/aborted prior deploy attempt — e.g. one with `min_value` still `NULL` — would silently accept a negative or unbounded `global_rate_limit_max` via the admin UI forever, since nothing would ever repair `min_value` back to `1`. Fixed: the conflict clause now also sets `min_value`, `max_value`, `is_public` unconditionally on every run (these are validation/visibility *metadata*, not something David tunes — only `value` is meant to survive a re-run untouched). A stored `value` that's already out-of-bounds or non-numeric is deliberately left as-is by the migration (repairing it silently would be a hidden behavior change); the read-time fallback (`getConfigInt`/`getConfigBooleanFresh` returning `defaultValue` on a parse failure, §3) is what makes a malformed stored value harmless rather than the migration trying to "fix" it.
  - **Registered as snapshot-exempt (round-4 finding, P2):** `lib/db/scripts/check-migration-snapshots.ts`'s `SNAPSHOT_EXEMPT_TAGS` requires every journal entry to either have a generated snapshot or an explicit exemption with a one-line reason; a DML-only `admin_config` seed has no schema delta and thus no snapshot to generate. `0095_global_rate_limit_max_config` is added to that list (same pattern as `0094_worker_lane_heartbeats`'s neighbors), with a comment stating it's pure DML. Missing this would make `check-snapshots` fail the moment this migration is added to the journal.
- `artifacts/api-server/src/lib/adminConfig.ts` — add `getConfigBoolean` (mirrors `getConfigInt`'s shape, cached) for the ceiling-adjacent boolean reads that don't need live-consistency, plus **`getConfigBooleanFresh`** (round-4 finding, P2, §3): an uncached, always-live single-row read used only by `handler`'s dry-run check, returning `defaultValue` for a missing row, DB error, *or* any stored value that isn't the literal string `"true"`/`"false"` — never coercing malformed data toward enforcement. **Also add single-flight refresh to `loadAll()`** (round-3 finding, P2): `loadAll()` has no in-flight-request dedup, so every concurrent request arriving while the 60-second cache is expired/missing issues its own full `admin_config` SELECT — fine at the function's previous low call volume, a real periodic burst now that it's on every `/api` request's hot path. Fixed with the standard single-flight pattern (concurrent callers await one shared in-flight promise instead of each issuing a query); this benefits every existing caller, not just this one. A load-test scenario (§5) exercises a cold/expired-cache burst specifically. (`getConfigBooleanFresh` deliberately bypasses this cache entirely — see §3's fleet-consistency note for why.)
- `artifacts/api-server/src/app.ts` — mount early, **immediately after the app-level `cors()` call** (not right after `securityHeaders()` — round-4 correction of round 3's position, see §3), scoped to `/api`, direct-passed; refactor `isPublicAssetRequest` to take an explicit path argument.
- `artifacts/api-server/src/routes/admin.ts` — new `GET /api/admin/rate-limit-metrics` route (existing admin-auth pattern) returning `{ blockedDryRun, blockedEnforced, totalThisInstance, storeErrorThisInstance }` (§3).
- `artifacts/api-server/src/jobs/rateLimitCounterPurger.ts` — new, mirrors `jobs/transientRenderPurger.ts`; `index.ts` gets the matching `scheduleRateLimitCounterPurger()` call. (The two reserved fleet-metric rows use a far-future `expiresAt` and are never touched by this purger — no exemption list needed, see §3.)
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new: Store unit tests (increment/decrement/resetKey semantics, both persisted columns are salted — not equal to the unsalted digest, not just not-the-literal-address — window/expiry rollover), plus a real concurrency test, plus tests for `incrementFleetMetricCounter`/`readFleetMetricCounters` (atomic increment under concurrency, never-expiring rows survive a purger run).
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new: real-`app` integration test with an injectable low limit — 429/JSON-body/headers/no-store, exempt paths never touch the Store (asserted via hit count) including the non-`/api`-request case (proves the scoping fix), `ipKeyGenerator` behavior, `passOnStoreError`, dry-run mode (blocked-but-passed-through, and asserts `RateLimit-*`/`Retry-After` headers are absent from the dry-run response — round-4 finding), **and the trusted-IP resolution order restored from round 1** — `CF-Connecting-IP` wins over a spoofed `X-Forwarded-For`, and the dev/test fallback still works, asserted against the actual resulting Store bucket/key, not just that some value was picked. **New (round-4 findings):** an allowed-origin request that exceeds the limit still carries `Access-Control-Allow-Origin` on its 429 (proves the CORS-position fix); an `OPTIONS` preflight to a rate-limited path never touches the Store (proves it's terminated by `cors()` before reaching the limiter); a dry-run→enforcement flip mid-test (toggle the config row directly, no server restart) shows `blockedDryRun` stop incrementing and `blockedEnforced` start, without either counter resetting.
- `artifacts/api-server/src/__tests__/rateLimitCounterPurger.test.ts` — new, mirrors `phase4.purger.test.ts`; includes a case asserting the two reserved fleet-metric rows are never deleted regardless of how long they've existed.
- `lib/db/migrations/meta/global_rate_limit_migration.test.ts` (or the repo's existing convention for migration-behavior tests, wherever prior seed migrations like `0014`/`0080` are tested) — **new (round-4 finding, P2):** covers four row states against `0095`'s conflict clause — missing (created with defaults + bounds), existing-valid (a different `value` from a prior tune is preserved, `min_value`/`max_value`/`is_public`/`label`/`description`/`data_type` are (re-)set correctly), existing-malformed (`value` is non-numeric or out-of-bounds — preserved as-is by the migration, but bounds are now correctly enforced going forward via `admin.ts`'s PATCH check and `getConfigInt`/`getConfigBooleanFresh` fail safely on read), existing-partial (a row missing only `min_value`/`is_public` — both get repaired without touching `value`).
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — add the resolution.

### 5. Must not change

- **The existing narrow limiters' own behavior and thresholds are unchanged.**
- **Explicitly exempt, reachable regardless of this middleware's Store state or configured ceiling:** `/api/healthz`, `/api/health`, `/api/health/queues`, the existing public crawler-asset patterns, `/api/config`, the Stripe webhook, and `/api/admin/config/global_rate_limit_max` specifically (the self-rescue path — see §3).
- **Whether the rest of `/api/admin/*` is covered by this ceiling is an open product question, not settled by this plan** — see §3's admin-routes note. This plan does not silently resolve `current-roadmap.md`'s pending decision.
- **Ships in observe-only (dry-run) mode by default** — no request is actually blocked until `global_rate_limit_dry_run` is explicitly set to `false`, and the dry-run response carries no rate-limit-related headers (§3, round-4 finding).
- **Mounted after the app-level `cors()` call, not before it** (round-4 correction) — an allowed-origin request must always receive correct CORS headers, including on a 429.
- No new table/schema migration for `rate_limit_counters` (the `admin_config` seed migration is data-only, and is registered in `SNAPSHOT_EXEMPT_TAGS` — round-4 finding).
- No raw client IP addresses, and no unsalted digest of one, persisted anywhere or emitted in metrics/logs. (The two reserved fleet-metric keys are a documented, deliberate exception to salting — they are static operational labels, not IP-derived — see §3.)
- **`blockedDryRun`/`blockedEnforced` are fleet-wide and DB-backed; `totalThisInstance`/`storeErrorThisInstance` are explicitly process-local** — the metrics endpoint response must keep labeling which is which (round-4 finding), not present all four as equivalent.
- A migration re-run must never silently widen or remove `global_rate_limit_max`'s/`global_rate_limit_dry_run`'s bounds/type/visibility on an existing, partially-provisioned row (round-4 finding) — only `value` is left untouched across a re-run; every other column is repaired.

## Verification

1. `pnpm run typecheck` / `pnpm run build` — clean. `pnpm install --frozen-lockfile` succeeds. `pnpm --filter @workspace/db check-snapshots` passes (confirms the round-4 snapshot-exempt-tag fix).
2. New `GlobalRateLimitStore` unit tests pass, including concurrency, the salted-both-columns assertion, and the fleet-metric-counter tests (atomic increment, never-expires).
3. New real-`app` integration test passes: 429 (when not in dry-run) + JSON body + `Cache-Control: no-store` + headers past an injected low limit; dry-run mode logs/counts but never blocks *and carries no `RateLimit-*`/`Retry-After` headers* (round-4 finding); exempt paths (including non-`/api` paths, proving the scoping fix) never touch the Store; trusted-IP precedence (`CF-Connecting-IP` over spoofed XFF, dev fallback) proven against actual bucket sharing; `ipKeyGenerator` IPv6/IPv4-mapped handling; `passOnStoreError` via a forced Store error; **an allowed-origin over-limit request still carries `Access-Control-Allow-Origin` on its 429** (round-4 finding); **an `OPTIONS` preflight to a rate-limited path never touches the Store** (round-4 finding); **a dry-run→enforcement flip mid-test moves future blocks from `blockedDryRun` to `blockedEnforced` without resetting either counter** (round-4 finding).
4. New purger tests pass, including the reserved fleet-metric rows surviving a purge run regardless of age.
5. **Migration test (expanded, round-4 finding):** the four-row-state matrix from §4 — missing, existing-valid, existing-malformed, existing-partial — each asserted against the repaired conflict clause; confirms both rows are visible/editable via the admin config endpoint after a fresh apply.
6. Full existing test suite + E2E Smoke — no new failures (confirms nothing else broke; does not validate the 600/min default — see step 8).
7. Local CodeQL re-scan of the actual final code (not just the scratchpad proof already run for this plan — the real diff, once written) confirms `js/missing-rate-limiting` drops from 213 to 0.
8. **Load budget — concrete numbers:**
   - Workload A: 500 concurrent requests / 200 distinct keys, sustained 30s.
   - Workload B: 500 concurrent requests / 1 shared key, sustained 30s.
   - Workload C (round-3 addition): a cold/expired `admin_config` cache burst — many concurrent requests arriving the instant the 60s cache expires — proving the single-flight fix results in one refresh query, not N.
   - Pass criteria for all three: p95 latency added ≤ 15ms; sustained pool usage ≤ 16 of 20 connections; 0% Store-attributable error rate.
9. Manual: hit an `/api` route past the ceiling from one IP, confirm dry-run logs a would-be-block without actually 429ing and the response carries no rate-limit headers; flip `global_rate_limit_dry_run` to `false` locally, confirm an actual 429 with the right body/headers/CORS headers; confirm the narrow limiters and `/api/healthz`/`/api/config`/the self-rescue admin endpoint are unaffected; confirm a non-`/api` request never increments `globalRateLimitMetrics.totalThisInstance`; confirm `GET /api/admin/rate-limit-metrics` clearly labels fleet-wide vs. process-local fields.
10. Post-flip-to-enforcement (not pre-deploy — the dry-run phase *is* the pre-deploy evidence now): continue monitoring `blockedDryRun`/`blockedEnforced` (fleet-wide, DB-backed — accurate regardless of which autoscale instance answers the metrics GET) after enforcement is enabled; the dry-run data is what justifies the initial default, not a blind 72-hour post-enforcement watch.
