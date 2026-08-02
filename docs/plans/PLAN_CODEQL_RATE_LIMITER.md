# Global DB-backed rate limiter (satisfy CodeQL `js/missing-rate-limiting`)

> **Scope reset (David, 2026-08-02).** Rounds 4-10 grew this plan to 525 lines
> — fleet metrics, a shared-NAT discriminator, a dry-run rollout, a rollout-config
> cache, an admin-configurable ceiling, a concurrency gate, a bounded-cancellation
> subsystem. Round 10 returned 13 findings, five of them P1, and three of those
> were defects *created by* the rounds-8-and-9 fixes. David's call was to cut back
> to the original goal. This document is that reduction, rewritten rather than
> patched. What the removed machinery was for, and why removing it is safe rather
> than merely cheaper, is recorded in §6 so the reasoning isn't lost.

## Context

CodeQL flags 213 `js/missing-rate-limiting` alerts across this repo's API routes.
This repo already has real rate limiting — `checkSharedRateLimit`
(`artifacts/api-server/src/lib/sharedRateLimiter.ts`), a DB-backed window counter,
called inline or via `createRateLimiter`'s Express-middleware wrapper — but the
query only recognizes a hardcoded list of npm packages (`express-rate-limit`,
`express-brute`, `express-limiter`, `rate-limiter-flexible`,
`@fastify/rate-limit`). It has no extension mechanism, so no amount of
correctly-functioning custom code will ever clear it. Confirmed empirically:
`checkSharedRateLimit` registered as genuine Express middleware still gets flagged.

**Proven locally:** adding `import { rateLimit } from "express-rate-limit"` plus
`app.use("/api", rateLimit({...}), router)` took the alert count from **213 to 0**
in a full local scan. This plan ships that exact shape, so the original proof is
the operative one; §5 re-runs it against the final code regardless.

**Why not the default store:** this repo's rate limiting is deliberately DB-backed
so counts are correct across autoscale instances rather than per-process. Wiring
the CodeQL-satisfying middleware to the in-memory default would be a real
regression of that guarantee for the one limiter CodeQL can see. This plan keeps
the proven shape and backs it with a `Store` over the existing table.

**Outcome:** 213 alerts clear, no existing limiter's behavior changes, no new
table, no new migration, no rollout flag.

## 1. Dependency: `express-rate-limit` (^8.5.1)

Verified against the packaged source, not docs or memory:

- `Store` interface: async `increment(key) → {totalHits, resetTime}`,
  `decrement(key)`, `resetKey(key)`; optional sync `init(options)`.
- **Over-limit is `totalHits > limit`** (`dist/index.cjs:992`), so a configured
  limit of N allows N and blocks the (N+1)-th.
- `config.skip` is evaluated **before** `store.increment` — exempt paths genuinely
  never touch the Store.
- `passOnStoreError: true` allows the request through if the Store throws; its
  `catch` wraps **only** `store.increment`, so nothing else in the middleware may
  reject.
- `ipKeyGenerator(ip, ipv6Subnet = 56)` normalizes IPv6 to a `/56` with an
  IPv4-mapped carve-out (the CVE-2026-30827 bug class).
- v8 supports Express 5 (this repo runs `express@5.2.1`).

Rejected: `@acpr/rate-limit-postgresql` — needs its own connection config and table.

## 2. `GlobalRateLimitStore`: reuse `rate_limit_counters`

New file `artifacts/api-server/src/lib/globalRateLimitStore.ts`. Same atomic
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING` shape already proven in
`checkSharedRateLimit` (`sharedRateLimiter.ts:51-68`), against the same table and
the same `db` client.

**Both persisted columns are salted digests.** `key_hash = sha256("grl:" +
hashIp(key))` and `key_raw = "grl:" + hashIp(key)`, reusing `hashIp`
(`transientRenderLog.ts:68-69`) and its existing salt. An unsalted digest over the
~4-billion-address IPv4 space is a cheaply precomputable rainbow table, so
"no raw address stored" would not have meant "not recoverable." Tests assert
neither column equals the unsalted digest.

**Production must not run on the dev fallback salt.** `hashIp` falls back to a
repository-known string when `IP_HASH_SALT` is missing or under 16 characters,
logged as a WARN. That gap predates this plan, but this plan routes *every API
request's* client key through the function. Boot-time assertion in
`index.ts` throws before the server accepts traffic when the canonical production
predicate (`REPLIT_DEPLOYMENT === "1" || NODE_ENV === "production"` — matching
`securityHeaders.ts`'s `isProductionEnv()`, `siteUrl.ts`, `devAdminLogin.ts`) is
true and the salt is missing or short. Repo-wide fix; protects
`transientRenderLog.ts`'s existing usage too.

**Window comes from `init(options)`**, called once at setup.

**Store errors propagate.** `passOnStoreError: true` is what turns a throw into
"let the request through"; the one `try`/`catch` is telemetry-only and **rethrows**
(swallowing it silently breaks `passOnStoreError`). That telemetry increments a
process-local `storeErrorThisInstance` counter and logs **at most one line per
second per process** — under a database outage every request reaches this path, so
an unthrottled log turns an outage into an unbounded log stream (round-10 finding).

**Row lifetime.** `purgeExpiredRateLimitCounters()` (`sharedRateLimiter.ts:83`)
has no production caller and no real test. Wire it into an hourly job mirroring
`jobs/transientRenderPurger.ts`'s self-rescheduling pattern, deleting in bounded
batches (≤1,000 rows/statement, repeat until zero) so a large backlog never sits
in one long transaction. **No advisory lock** — see §6.

## 3. Wiring in `app.ts`

```ts
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { GlobalRateLimitStore } from "./lib/globalRateLimitStore";
import { ipFromRequest } from "./lib/transientRenderLog";

// Same env-var convention as the existing narrow limiters (rateLimit.ts's
// RATE_WINDOW_MS / RATE_MAX), reusing parsePositiveInt. Deliberately NOT an
// admin_config row — see §6.
const GLOBAL_RATE_WINDOW_MS = parsePositiveInt(process.env.GLOBAL_RATE_WINDOW_MS, 60_000);
const GLOBAL_RATE_MAX = parsePositiveInt(process.env.GLOBAL_RATE_MAX, 600);

// Express's default non-strict routing means a trailing slash reaches the same
// handler (verified: express@5.2.1, no `strict routing` override in this repo),
// so registration and exemption must normalize identically.
function normalizeRoutePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// The installed router dispatches HEAD to a GET handler when no explicit HEAD
// handler exists (router@2.2.0, lib/route.js:64-66 and :111-112), so a GET-only
// exemption would let `HEAD /api/healthz` consume the Store and be blocked at
// the ceiling — the shape an uptime probe actually sends.
const SAFE_READ_METHODS = ["GET", "HEAD"] as const;

// Only genuinely DB-free routes are exempt. /api/health and /api/health/queues
// are NOT here: they run real queries (routes/health.ts:21-29 sorts
// stripe_processed_events; /health/queues aggregates via laneHealth()), so
// exempting them would be an unmetered database-exhaustion path. They sit behind
// the ceiling like any other route — 600/min is far above any monitor's cadence.
const EARLY_EXEMPT_ROUTES: ReadonlyArray<{ methods: readonly string[]; path: string }> = [
  { methods: SAFE_READ_METHODS, path: "/api/healthz" },   // liveness, no DB
  { methods: ["POST"], path: "/api/stripe/webhook" },      // own signature gate
];

function isExemptRequest(req: Request): boolean {
  const path = normalizeRoutePath(req.originalUrl.split("?")[0]);
  if (isPublicAssetRequest(req.method, path)) return true;
  return EARLY_EXEMPT_ROUTES.some(
    (r) => r.methods.includes(req.method) && r.path === path,
  );
}

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  limit: GLOBAL_RATE_MAX,          // a constant — not an async DB read
  store: new GlobalRateLimitStore(),
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isExemptRequest(req),
  handler: (req, res) => {
    logBlockedThrottled({ path: req.originalUrl.split("?")[0] }, "global rate limit exceeded");
    res.set("Cache-Control", "no-store");
    res.status(429).json({ error: "Too many requests. Please slow down." });
  },
});

// Mounted immediately after the app-level cors() call (app.ts:180) — early
// enough that a rejected request never pays for body parsing, CSRF, or
// authMiddleware's DB session lookup, but late enough that its 429 carries
// correct CORS headers. Preflight never reaches here: with the default
// preflightContinue:false, app.use(cors(...)) answers OPTIONS itself.
app.use("/api", globalLimiter);
```

**Mount-shape notes:**

- **Direct-passed, not wrapped.** `rateLimit(...)` goes to `app.use()` as its own
  argument — CodeQL's model is pattern-sensitive, and this matches the original
  213→0 proof exactly.
- **`req.originalUrl`, not `req.path`.** `app.use("/api", ...)` strips the prefix
  from `req.path` inside the middleware — the mechanism that broke exemption
  matching in round 1. `isPublicAssetRequest` takes an explicit `(method, path)`
  so both its call sites get the right value for their own mount depth from one
  implementation.
- **Exemptions are method+path pairs**, not bare paths: a path-only set let
  `POST /api/healthz` skip the limiter even though no route handles that method.
- **`Cache-Control: no-store` on the 429**, set directly — this mount runs before
  the existing `noStore` middleware list, so a 429 could otherwise be cached by an
  intermediate proxy and served to a since-recovered client.
- **The block log is throttled** to ≤1 line/second/process; a sustained burst past
  the ceiling would otherwise turn an unbounded request stream into an unbounded
  log stream.

## 4. Files touched

- `artifacts/api-server/package.json` + regenerated root `pnpm-lock.yaml` — add
  `express-rate-limit`.
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new: the `Store`, the
  process-local `storeErrorThisInstance` counter, and the throttled error log.
- `artifacts/api-server/src/lib/rateLimit.ts` — add `GLOBAL_RATE_WINDOW_MS` /
  `GLOBAL_RATE_MAX` beside the existing `RATE_WINDOW_MS` / `RATE_MAX`, one place
  to look.
- `artifacts/api-server/src/app.ts` — mount after `cors()`, scoped to `/api`,
  direct-passed; refactor `isPublicAssetRequest` to take an explicit path;
  `EARLY_EXEMPT_ROUTES` + `normalizeRoutePath`.
- `artifacts/api-server/src/jobs/rateLimitCounterPurger.ts` — new, mirrors
  `jobs/transientRenderPurger.ts`; `index.ts` gets `scheduleRateLimitCounterPurger()`.
- `artifacts/api-server/src/index.ts` — boot-time `IP_HASH_SALT` assertion.
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new.
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new.
- `artifacts/api-server/src/__tests__/rateLimitCounterPurger.test.ts` — new.
- `artifacts/api-server/src/__tests__/index.saltGuard.test.ts` — new.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — record the
  resolution: the global middleware is what clears the alerts, and why.

**No migration. No `admin_config` row. No changes to `lib/db/src/index.ts`.**

## 5. Verification

1. `pnpm run typecheck` / `pnpm run build` clean; `pnpm install --frozen-lockfile`
   succeeds.
2. **Store unit tests:** increment/decrement/resetKey semantics; both persisted
   columns salted (neither equals the unsalted digest); window/expiry rollover; a
   real concurrency test proving the single-statement upsert is atomic under
   parallel increments, not just sequentially.
3. **Integration tests against the real `app`,** with an injected low limit: 429 +
   JSON body + `Cache-Control: no-store` + `RateLimit-*` headers past the ceiling;
   **exactly at the ceiling is allowed and at ceiling+1 is blocked** (the package
   blocks on `>`, not `>=`); no `X-RateLimit-*` legacy headers; exempt routes never
   touch the Store (asserted by Store hit count) for **both `GET` and `HEAD`**;
   wrong-method-on-exempt-path is *not* exempt; trailing-slash spellings behave
   identically to canonical ones; `/api/health` and `/api/health/queues` **are**
   metered; trusted-IP resolution order proven against actual bucket sharing;
   `ipKeyGenerator` IPv6/IPv4-mapped handling; `passOnStoreError` via a forced
   Store error; a sustained blocked burst produces bounded log volume; CORS headers
   present on the 429 and preflight never reaches the Store.
4. **Purger tests:** active vs. expired boundary; bounded-batch deletion of a large
   synthetic backlog; a thrown error on one run doesn't block the next.
5. **Boot-time salt guard matrix:** production (`REPLIT_DEPLOYMENT=1`, `NODE_ENV`
   unset) without a valid salt throws; test/CI and local dev do not.
6. **Full existing suite + E2E Smoke** — no new failures, and specifically no 429s
   from this limiter. CI runs ~170 test files against one local server from one IP,
   so this is the empirical check that 600/min clears real CI volume. If it doesn't,
   raise the default rather than special-casing `NODE_ENV`.
7. **Local CodeQL re-scan** of the final code confirms `js/missing-rate-limiting`
   drops 213 → 0.
8. **Load check:** 500 concurrent requests over 200 distinct keys and over 1 shared
   key, 30s each. Pass: p95 added latency ≤ 15ms, sustained pool usage ≤ 16 of 20
   connections, 0% Store-attributable error rate.
9. **Manual:** exceed the ceiling from one IP, confirm the 429 body/headers/CORS;
   confirm the narrow limiters still fire independently; confirm exempt routes are
   unaffected.

## 6. What was removed, and why that's safe

Recording this so the reduction isn't re-litigated, and so a future reader knows
these were considered rather than overlooked.

- **Fleet metrics + the `/api/admin/rate-limit-metrics` endpoint.** Existed only to
  inform a dry-run→enforce decision. With no dry-run there is nothing to decide, so
  the hour-bucketed rows, per-process cumulative writes, saturation markers, and
  `int8` conversion all go. `storeErrorThisInstance` stays as a process-local
  counter because it costs nothing.
- **The shared-NAT discriminator.** Redesigned in rounds 5, 7, 8, 9 and still
  broken at round 10: Sybil-controllable (signup allows 10 registrations/IP/hour
  and issues a session immediately), ~63% false-negative at its own 8-user
  threshold, and persisting per-bucket sketches contradicted the aggregate-only
  privacy invariant. It existed to answer "is this over-limit bucket a NAT or a
  scraper" — a question that only mattered for staging the flip. **The residual
  risk is now handled by the ceiling itself:** 600 req/min from a single IP is
  ~100× a busy logged-in user's page-load pattern, so a shared NAT would need
  ~100 simultaneously-active users to reach it. If that ever shows up, the
  response is to raise `GLOBAL_RATE_MAX`.
- **The dry-run rollout flag.** Directly conflicted with `AGENTS.md:133-134`
  ("Pre-launch: features ship on-by-default, no rollout flags"). Removing it
  resolves the conflict rather than seeking an exception.
- **The `admin_config`-backed ceiling** (`global_rate_limit_max`), its 2-second
  single-flighted cache, the debug-overlay bypass, the PATCH validation fixes, and
  the seed migration. All existed to make the ceiling live-tunable. An env var
  matches what the existing narrow limiters already do; changing it needs a deploy,
  which is acceptable for a backstop set ~100× above real usage. This also removes
  the round-10 P1 where a rejecting config read became a JSON 500 and failed
  requests *closed* during a database outage — there is no longer a config read on
  the request path at all.
- **The self-rescue routes and `rescueLimiter`.** Existed because an
  admin-configurable ceiling could trap the endpoint that fixes it. With a
  code-constant ceiling there is no escape hatch to trap.
- **`runBounded()` / the deadline-and-cancellation subsystem and the concurrency
  gate.** Three rounds of P1s lived here, and round 10 found the gate had become an
  **enforcement bypass**: past 4 concurrent checkouts the Store threw,
  `passOnStoreError` admitted the request uncounted, and an attacker could hold the
  permits open deliberately. The gate existed only because round 9 raced
  `pool.connect()`, which stranded waiters in `pg-pool`'s queue. This plan does
  neither: the Store makes the same plain `db` call `checkSharedRateLimit` has been
  making in production all along.
  **The honest residual:** under a stalled database, `increment()` can hang, and
  `passOnStoreError` only fails open once it rejects. That is a real property — and
  it is a property the **existing** limiter already has on every request it guards.
  Adding a limiter with the same characteristic is not a regression, and bounding
  it properly is a repo-wide concern about every DB call, not something this plan
  should solve for one caller by adding machinery that proved more dangerous than
  the risk. Flagged as a separate follow-up rather than silently dropped.
- **The purger's advisory lock.** Added to stop autoscale instances running
  redundant hourly deletes; rounds 8-10 then spent three findings on session
  lifetime, release ownership, and lock reentrancy. `DELETE WHERE expires_at <
  now()` is idempotent, so concurrent runs are redundant rather than incorrect, and
  `transientRenderPurger` already runs uncoordinated per process — established
  precedent in this repo. Bounded batches keep each run short.

## 7. Open question for David

**Does `/api/admin/*` sit behind this ceiling?** It does by default, since the
limiter mounts at `/api`. `current-roadmap.md:280-288` records this as a pending
decision, so this plan flags it rather than settling it silently — but the sharp
edge is gone: with a code-constant ceiling there is no admin endpoint whose
throttling could lock an operator out of fixing the throttle. Admin routes behind
600/min per IP is unremarkable, so **the recommendation is to leave them covered**
and close the roadmap item.
