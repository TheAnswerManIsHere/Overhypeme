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

**Mounted early, and scoped, and pattern-verified against CodeQL — three separate round-3 findings, addressed together because they interact:**

- **Early (round-3 finding, P2):** the earlier design mounted right before the `/api` router, which is *after* `express.json`/`urlencoded`, both origin/CSRF checks, and `authMiddleware` (`authMiddleware.ts:73-105` does real session/user DB work). A request this limiter will ultimately reject still paid for body parsing and a DB-backed auth lookup first — exactly the cost a backstop against abuse shouldn't impose. Moved to immediately after `securityHeaders()` (`app.ts:82`), before the request logger, CORS, body parsing, CSRF, and auth.
- **Scoped (round-3 finding, P2 — a regression introduced by round 2's own fix):** round 2 fixed the mount-stripping bug by moving to an *unscoped* top-level `app.use()`, which then ran for every request reaching the app, not just `/api/*`. Fixed by scoping to `app.use("/api", ...)` while keeping the exemption predicates working correctly — see the next point for how.
- **`req.originalUrl`, not `req.path`, for exemption matching:** mounting via `app.use("/api", ...)` strips the prefix from `req.path` inside the middleware — the exact mechanism that broke round 1's exemptions in the first place. Rather than reintroduce that bug by scoping back to `/api`, the exemption check here reads `req.originalUrl.split("?")[0]` (always the full, un-stripped path) instead of `req.path`. `isPublicAssetRequest` is refactored to accept an explicit path string (`isPublicAssetRequest(method, path)`) rather than a `Request`, so both call sites — the existing top-level CSRF-cookie check (passing `req.path`, correct there since it's unmounted) and this new one (passing the `originalUrl` path) — get the right value for their own mount depth from one shared implementation, instead of one of them being silently wrong again.
- **Direct-passed, not wrapped, and CodeQL-reverified (round-3 finding, P1):** `rateLimit(...)` is passed directly to `app.use()` as its own middleware argument — `app.use("/api", countGlobalLimiterRequest, globalLimiter)` — not invoked from inside a wrapping arrow function. The wrapped shape from round 2's fix was independently re-scanned and still cleared CodeQL (0 alerts), but there's no reason to keep the indirection once a direct-pass shape works too, and direct-passing is the closer match to the original proof, less exposed to a future CodeQL model becoming stricter about indirection. **This exact final shape — early mount, `/api`-scoped, direct-passed — was itself re-scanned locally and clears at 0** (see Context).

```ts
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { GlobalRateLimitStore, globalRateLimitMetrics } from "./lib/globalRateLimitStore";
import { ipFromRequest } from "./lib/transientRenderLog";
import { getConfigInt, getConfigBoolean } from "./lib/adminConfig";
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
  globalRateLimitMetrics.total++;
  next();
}

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  limit: () => getConfigInt("global_rate_limit_max", 600),
  store: new GlobalRateLimitStore(),
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  passOnStoreError: true,
  standardHeaders: true,
  skip: (req) => isExemptRequest(req),
  handler: async (req, res, next) => {
    globalRateLimitMetrics.blocked++;
    logger.warn({ path: req.originalUrl.split("?")[0] }, "global rate limit exceeded");
    const dryRun = await getConfigBoolean("global_rate_limit_dry_run", true);
    if (dryRun) return next(); // observe, don't enforce — see the rollout note below
    res.set("Cache-Control", "no-store");
    res.status(429).json({ error: "Too many requests. Please slow down." });
  },
});

app.use("/api", countGlobalLimiterRequest, globalLimiter);
```

**Dry-run rollout — replaces the earlier "watch after the fact" plan with an actual pre-enforcement measurement (round-3 finding, Reconciliation):** round 2's post-rollout monitoring rule couldn't distinguish a scraper being correctly blocked from a legitimate shared-NAT population being incorrectly blocked — both produce the same "many blocks from one key" signal, and the plan had no way to tell them apart. Rather than invent a differentiation heuristic (path diversity, request timing, etc. — all guesses without real data), the rollout now has an actual **observe-before-enforce** phase: `global_rate_limit_dry_run` (new `admin_config` boolean, default `true`) makes `handler` count and log what *would* have been blocked but always calls `next()` instead of returning 429 while dry-run is active. This means the first deployment collects real block-rate data against real traffic, with zero user-facing risk, before a single legitimate request is ever actually rejected. David flips `global_rate_limit_dry_run` to `false` (live, no deploy) once the dry-run block log shows no plausible false-positive pattern over an observation window — replacing the earlier "72 hours, then decide from imperfect signal" rule with "watch the dry-run log, then decide from real evidence, on your own timeline." This is a materially stronger answer than the round-2 version, not a rewording of the same trade-off.

**`Cache-Control: no-store` on the enforced 429** (round-3 finding, folded in here): the earlier mount position was covered by the existing `noStore` middleware list (`app.ts`, later in the chain); the new earlier position isn't, so a 429 could otherwise be cached by an intermediate proxy and served stale to a since-recovered client. Set directly in `handler` rather than relying on the later `noStore` list, since this middleware now runs before it.

**Admin routes — genuinely open, not decided here (round-3 finding, P1, tagged Product Decision):** `current-roadmap.md:280-288` already records rate-limiting admin routes as an explicit, still-pending David decision. This plan's mount change (scoped to all of `/api`, moved earlier) would silently resolve that question by inclusion — every admin route now sits behind this ceiling too, including, worse, `/api/admin/config/:key` itself, the endpoint that raises the ceiling if it's ever set too low. Two things, kept separate:
- **The self-rescue endpoint is exempted regardless of the broader answer** (`EARLY_EXEMPT_PATHS` above) — a limiter that can trap its own escape hatch is a design defect independent of whether admin routes in general should be covered, so this part isn't waiting on David.
- **Whether the rest of `/api/admin/*` sits behind this ceiling is not decided by this plan.** That's the pre-existing open roadmap question, and this plan doesn't get to answer it by omission. Flagged to David as a real fork — see the PR thread.

### 4. Files touched

- `artifacts/api-server/package.json` and the regenerated root `pnpm-lock.yaml` — add `express-rate-limit`.
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new: the `Store` implementation, `globalRateLimitMetrics`.
- `lib/db/migrations/0095_global_rate_limit_max_config.sql` **and its `lib/db/migrations/meta/_journal.json` entry** — round-3 finding: the production migration runner (`migrate.ts:140-143`) only applies files with a matching journal entry; a SQL file alone is silently never run. Idempotent seed of `global_rate_limit_max` (default 600) and `global_rate_limit_dry_run` (default `true`), same `ON CONFLICT (key) DO UPDATE SET label/description/data_type` pattern as `migrations/0014_legendary_generation_limit.sql` (not overwriting `value`, so a live-tuned value survives a re-run).
- `artifacts/api-server/src/lib/adminConfig.ts` — add `getConfigBoolean` (mirrors `getConfigInt`'s shape) if it doesn't already exist; **add single-flight refresh to `loadAll()`** (round-3 finding, P2): `loadAll()` has no in-flight-request dedup, so every concurrent request arriving while the 60-second cache is expired/missing issues its own full `admin_config` SELECT — fine at the function's previous low call volume, a real periodic burst now that it's on every `/api` request's hot path. Fixed with the standard single-flight pattern (concurrent callers await one shared in-flight promise instead of each issuing a query); this benefits every existing caller, not just this one. A load-test scenario (§5) exercises a cold/expired-cache burst specifically.
- `artifacts/api-server/src/app.ts` — mount early (right after `securityHeaders()`), scoped to `/api`, direct-passed; refactor `isPublicAssetRequest` to take an explicit path argument.
- `artifacts/api-server/src/jobs/rateLimitCounterPurger.ts` — new, mirrors `jobs/transientRenderPurger.ts`; `index.ts` gets the matching `scheduleRateLimitCounterPurger()` call.
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new: Store unit tests (increment/decrement/resetKey semantics, both persisted columns are salted — not equal to the unsalted digest, not just not-the-literal-address — window/expiry rollover), plus a real concurrency test.
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new: real-`app` integration test with an injectable low limit — 429/JSON-body/headers/no-store, exempt paths never touch the Store (asserted via hit count) including the non-`/api`-request case (proves the scoping fix), `ipKeyGenerator` behavior, `passOnStoreError`, dry-run mode (blocked-but-passed-through), **and the trusted-IP resolution order restored from round 1** — `CF-Connecting-IP` wins over a spoofed `X-Forwarded-For`, and the dev/test fallback still works, asserted against the actual resulting Store bucket/key, not just that some value was picked.
- `artifacts/api-server/src/__tests__/rateLimitCounterPurger.test.ts` — new, mirrors `phase4.purger.test.ts`.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — add the resolution.

### 5. Must not change

- **The existing narrow limiters' own behavior and thresholds are unchanged.**
- **Explicitly exempt, reachable regardless of this middleware's Store state or configured ceiling:** `/api/healthz`, `/api/health`, `/api/health/queues`, the existing public crawler-asset patterns, `/api/config`, the Stripe webhook, and `/api/admin/config/global_rate_limit_max` specifically (the self-rescue path — see §3).
- **Whether the rest of `/api/admin/*` is covered by this ceiling is an open product question, not settled by this plan** — see §3's admin-routes note. This plan does not silently resolve `current-roadmap.md`'s pending decision.
- **Ships in observe-only (dry-run) mode by default** — no request is actually blocked until `global_rate_limit_dry_run` is explicitly set to `false`.
- No new table/schema migration for `rate_limit_counters` (the `admin_config` seed migration is data-only).
- No raw client IP addresses, and no unsalted digest of one, persisted anywhere or emitted in metrics/logs.

## Verification

1. `pnpm run typecheck` / `pnpm run build` — clean. `pnpm install --frozen-lockfile` succeeds.
2. New `GlobalRateLimitStore` unit tests pass, including concurrency and the salted-both-columns assertion.
3. New real-`app` integration test passes: 429 (when not in dry-run) + JSON body + `Cache-Control: no-store` + headers past an injected low limit; dry-run mode logs/counts but never blocks; exempt paths (including non-`/api` paths, proving the scoping fix) never touch the Store; trusted-IP precedence (`CF-Connecting-IP` over spoofed XFF, dev fallback) proven against actual bucket sharing; `ipKeyGenerator` IPv6/IPv4-mapped handling; `passOnStoreError` via a forced Store error.
4. New purger tests pass.
5. **Migration test:** run the repository's migration command against a database missing both new `admin_config` rows, confirm both are created with their default values and are then visible/editable via the admin config endpoint.
6. Full existing test suite + E2E Smoke — no new failures (confirms nothing else broke; does not validate the 600/min default — see step 8).
7. Local CodeQL re-scan of the actual final code (not just the scratchpad proof already run for this plan — the real diff, once written) confirms `js/missing-rate-limiting` drops from 213 to 0.
8. **Load budget — concrete numbers:**
   - Workload A: 500 concurrent requests / 200 distinct keys, sustained 30s.
   - Workload B: 500 concurrent requests / 1 shared key, sustained 30s.
   - Workload C (round-3 addition): a cold/expired `admin_config` cache burst — many concurrent requests arriving the instant the 60s cache expires — proving the single-flight fix results in one refresh query, not N.
   - Pass criteria for all three: p95 latency added ≤ 15ms; sustained pool usage ≤ 16 of 20 connections; 0% Store-attributable error rate.
9. Manual: hit an `/api` route past the ceiling from one IP, confirm dry-run logs a would-be-block without actually 429ing; flip `global_rate_limit_dry_run` to `false` locally, confirm an actual 429 with the right body/headers; confirm the narrow limiters and `/api/healthz`/`/api/config`/the self-rescue admin endpoint are unaffected; confirm a non-`/api` request never increments `globalRateLimitMetrics.total`.
10. Post-flip-to-enforcement (not pre-deploy — the dry-run phase *is* the pre-deploy evidence now): continue monitoring `globalRateLimitMetrics` after enforcement is enabled; the dry-run data is what justifies the initial default, not a blind 72-hour post-enforcement watch.
