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
- The `try`/`catch` wraps **only** `store.increment` (`dist/index.cjs:896-910`),
  so nothing else in the middleware may reject. With `passOnStoreError: true` a
  Store throw calls `next()` — the request is admitted uncounted. With
  `passOnStoreError: false` it re-throws inside `handleAsyncErrors`, i.e.
  `next(error)`. This plan uses `false`; §2 explains why the choice cannot be
  made here at all.
- `ipKeyGenerator(ip, ipv6Subnet = 56)` normalizes IPv6 to a `/56` with an
  IPv4-mapped carve-out (the CVE-2026-30827 bug class).
- v8 supports Express 5 (this repo runs `express@5.2.1`).

Rejected: `@acpr/rate-limit-postgresql` — needs its own connection config and table.

## 2. `GlobalRateLimitStore`: reuse `rate_limit_counters`

New file `artifacts/api-server/src/lib/globalRateLimitStore.ts`. Same atomic
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING` shape already proven in
`checkSharedRateLimit` (`sharedRateLimiter.ts:51-68`), against the same table —
but **not** the same client: see *Acquisition is bounded* below for why this Store
owns a small dedicated pool instead of borrowing the shared `db`.

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

**Acquisition is bounded by a small dedicated pool (round-11 finding, P1).**
The Store does **not** use the shared `db` client. My §6 argument — "the existing
limiter already makes this exact call" — was true about the *call* and wrong about
the *scope*: `checkSharedRateLimit` guards specific routes, whereas this
middleware runs on **every** `/api/*` request before routing, including requests
to nonexistent paths. The shared pool sets no `connectionTimeoutMillis`
(`lib/db/src/index.ts:72-88`), so during a database stall every one of those
requests joins `pg-pool`'s `_pendingQueue` and never reaches the error path — an
unbounded backlog of open requests, and a materially broader failure mode than the
narrow limiter has.

So the Store owns a dedicated `pg.Pool`: same `DATABASE_URL`, `max: 4`,
`connectionTimeoutMillis: 2_000`, plus its own `pool.on("error", …)` idle-client
handler mirroring `lib/db/src/index.ts:90-95` (round-12 finding — without it an
`ECONNRESET` on an idle client of *this* pool is an uncaught exception that
crashes the process; the shared pool has had that handler all along and the
dedicated one inherited nothing). It also carries the shared pool's
`idleTimeoutMillis: 60_000` and `maxLifetimeSeconds: 3600`, which are tuned for
the same Neon auto-suspend behavior — the general shape of the round-12 miss was
specifying the pool by the two properties I was thinking about and silently
defaulting everything else, not just the absent `error` listener.

**And the same shape again in round 13, one property further down:**
`allowExitOnIdle` defaults to `false` (`pg-pool@3.13.0/index.js:92`), and only
when it is `true` does the pool `unref()` idle clients and their timers
(`index.js:417-424`). The shared pool sets it under the Node test runner
precisely so suites don't hang for `idleTimeoutMillis` after finishing
(`lib/db/src/index.ts:79-87`) — and this plan adds three new real-DB suites
against a pool that had neither that setting nor a close path. So the dedicated
pool reuses the same `isNodeTestRunner` detection, **and** the Store exposes a
`close()` that ends the pool, called where ownership ends (test teardown, and
the server's shutdown path alongside the existing purger cleanup). §5 asserts
the test process exits promptly after a Store query rather than after 60s.

### Failure policy: contention fails closed, outage fails open

**Two rounds of history, because the shape of the mistake is the useful part.**
Round 11 claimed "the only thing that fails a request open is the database itself
being unreachable." Round 12 disproved it: `pg-pool` applies
`connectionTimeoutMillis` whenever `_isFull()`
(`pg-pool@3.13.0/index.js:199-225`), not only when the database is unreachable,
so four concurrent slow upserts saturated the pool and every further request was
admitted uncounted. Round 12's fix branched on a `lastSuccessAt` timestamp —
recent success meant contention, no recent success meant outage. Round 13
disproved *that* on two counts: `pg-pool` **queues** excess callers in
`_pendingQueue` for the full 2s rather than shedding them (verified at
`index.js:216-231`), so nothing was actually being shed; and an idle instance is
indistinguishable from an unhealthy one under a traffic-derived signal, so the
first contention after 10 quiet seconds would fail open.

Rounds 8 through 12 all had the same defect underneath: they inferred
*contention* from a **symptom** — a timeout, a stale timestamp — instead of
knowing it directly. The fix is to stop inferring.

**Contention is a fact the Store already has.** It owns the pool, so it can count
its own in-flight calls and refuse the (N+1)-th *before* `pool.connect()` is ever
reached:

```ts
const MAX_IN_FLIGHT = 4;      // == the dedicated pool's `max`

class GlobalRateLimitStore implements Store {
  private inFlight = 0;

  async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
    if (this.inFlight >= MAX_IN_FLIGHT) {
      // Contention, known rather than inferred. Nothing has been queued and no
      // connection attempted — this returns in microseconds.
      throw new RateLimiterUnavailableError();
    }
    this.inFlight++;
    try {
      return await this.upsert(key);
    } catch (err) {
      this.noteStoreError(err);   // counter + ≤1 log line/sec/process
      // We were admitted, so the pool was not full: this is the database
      // failing, not local load. Fail open — a DB incident must not also take
      // the whole API down.
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    } finally {
      this.inFlight--;
    }
  }
}
```

Node's single-threaded event loop makes the check-then-increment pair atomic —
there is no `await` between them, so no interleaving is possible.

**What this buys, beyond fixing the two round-13 findings.** Because
`MAX_IN_FLIGHT` equals the pool's `max`, the pool can never be oversubscribed, so
`_pendingQueue` stays empty and `connectionTimeoutMillis` becomes a backstop that
should never fire. The two states are now *disjoint by construction* rather than
told apart by a heuristic: contention is "the counter is at its bound," and
everything reaching the `catch` genuinely got a connection and genuinely failed.
That deletes `lastSuccessAt`, `DB_HEALTHY_WINDOW_MS`, the startup probe, and the
idle-versus-unhealthy ambiguity along with them — three findings resolved by
removing machinery rather than adding more.

**Why this is not the round-9 concurrency gate wearing a new hat.** It has the
same shape and the opposite behavior, which is the entire point. Round 9's gate
failed requests **open** when its permits ran out, so holding permits *was* the
bypass. This one fails them **closed**: an attacker who saturates the Store gets
503s, and the 503 path costs no connection, no query, no row, no write. A gate is
only a bypass if exhausting it is rewarded.

**The residual, stated rather than engineered around:** when the database is
genuinely failing, this limiter stops limiting. That is deliberate — failing
closed across a real outage would convert a database blip into a total site
outage — and the existing narrow limiters have the identical property.

**How the two outcomes leave the Store.** `passOnStoreError` is **`false`** so
the package's own catch never makes the policy call; the fail-open branch returns
normally and the fail-closed branch throws. Verified against the packaged source
(`dist/index.cjs:896-910`): with `false`, a Store throw becomes `throw error`
inside `handleAsyncErrors`, i.e. `next(error)`. A four-argument error middleware
mounted immediately after the limiter turns `RateLimiterUnavailableError` into a
`503` with `Retry-After` and re-`next(err)`s anything else. Because Express
propagates errors *forward* from where they are thrown, an error handler at that
position sees limiter errors and not router errors.

**Error telemetry** increments a process-local `storeErrorThisInstance` counter
and logs **at most one line per second per process**. Under an outage every
request reaches this path, so an unthrottled log turns an outage into an
unbounded log stream (round-10 finding).

**Write amplification, and what bounds it.** This middleware turns every
non-exempt `/api/*` request into one DB write, including requests it goes on to
reject — the package increments before it compares (`dist/index.cjs:896`, `:992`).
That is inherent to the shape CodeQL requires. The bound is `MAX_IN_FLIGHT`: at
most 4 writes in flight per instance, with excess rejected immediately rather
than queued. A flood costs a small fixed write rate and a large number of cheap
rejections.

### Shedding must not destroy in-flight work (round-13 finding, P1)

The 503 above, and the ordinary 429, both reach clients that were not the cause.
`GodModeLoadingTakeover.tsx:129-166` increments one consecutive-error counter on
**any** non-OK poll response and, at `MAX_CONSECUTIVE_ERRORS = 5`, puts a
still-running video job into terminal `failed`. So five shed polls — 2.5 seconds
at the real cadence — make a real user abandon a job the backend is completing.

That is a pre-existing client defect this plan would weaponize, so this plan
fixes it: **both pollers treat `429` and `503` as retryable** and do not count
them toward terminal failure, honoring `Retry-After` where present. Concretely,
`GodModeLoadingTakeover.tsx` and `PulidLoadingTakeover.tsx` distinguish
"server asked us to slow down" from "the request failed," backing off on the
former and leaving the job in its running state.

This matters beyond the 503: a genuine over-limit **429 already** kills in-flight
jobs today under any ceiling, which is part of why §3's derivation had to treat
the ceiling as a cliff. With retryability in place, crossing the ceiling degrades
throughput instead of destroying work. §3 keeps its derived 12,000 anyway — the
derivation is about not throttling legitimate users at all, and is sound on its
own terms — but the failure past it is no longer a cliff.

**Row lifetime.** `purgeExpiredRateLimitCounters()` (`sharedRateLimiter.ts:83-85`)
is a single unbounded `DELETE` of every expired row — wiring it as-is would not
produce the bounded batches this plan promises (round-11 finding). So
`sharedRateLimiter.ts` **is** modified: the function gains a `limit` parameter and
returns the number of rows deleted, so the caller can loop. The hourly job mirrors
`jobs/transientRenderPurger.ts`'s self-rescheduling pattern and calls it with
≤1,000 until it returns zero, so a large backlog never sits in one long
transaction. Existing callers (there are none in production — that is the other
half of this fix) keep working via a default. **No advisory lock** — see §6.

## 3. Wiring in `app.ts`

```ts
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { GlobalRateLimitStore } from "./lib/globalRateLimitStore";
import { ipFromRequest } from "./lib/transientRenderLog";

// Same env-var convention as the existing narrow limiters (rateLimit.ts's
// RATE_WINDOW_MS / RATE_MAX), reusing parsePositiveInt. Deliberately NOT an
// admin_config row — see §6.
//
// THE DEFAULT IS DERIVED FROM THIS REPO'S REAL POLLING WORKLOAD, not from a
// page-load estimate (round-11 finding, P1 — the estimate was wrong by ~20×).
// There are TWO 500 ms pollers, not one (round-12 finding — I derived 6,000
// from the first and never looked for a second):
//   • GodModeLoadingTakeover.tsx:80,166 → /api/memes/video-jobs/:id
//   • PulidLoadingTakeover.tsx:27,93    → /api/memes/pulid-jobs/:id
// Each is 120 req/min for ONE active job.
//
// Crossing the ceiling is not a slow page. The video poller throws on a
// non-OK response and MAX_CONSECUTIVE_ERRORS = 5 (:127) marks the job
// **failed** — 2.5 seconds of 429s kills in-flight generations for everyone
// behind that IP. The Pulid poller has no such counter: its catch only feeds
// a visual fallback and it keeps polling (`:87-94`), so a blocked tab retries
// at 2 req/s indefinitely, and every retry is counted (the package increments
// before it compares). It does not lock the IP out — the fixed window still
// resets — but an open tab permanently consumes 120 req/min of the budget.
//
// Derivation, with the arithmetic shown because round 11's version had none:
//   50 concurrent polling jobs behind one IP × 120 req/min  = 6,000
//   ordinary browsing by those same 50 users, ~60 req/min each = 3,000
//   → 9,000, ×1.33 margin                                   ≈ 12,000/min
// Round 11 stopped at 6,000, which is *exactly* the polling term and leaves
// literally zero headroom for the page loads those 50 users are also making.
//
// 12,000/min is 200 req/s sustained from one address. That is a coarse ceiling,
// and deliberately so: the harm is asymmetric. Too low destroys real users'
// in-flight jobs within seconds; too high only makes a gross-abuse backstop
// coarser, while the narrow limiters (30/min general, 5/min fact-submit) go on
// doing the actual per-feature protection. GLOBAL_RATE_MAX exists for the case
// where operational data says otherwise.
const GLOBAL_RATE_WINDOW_MS = parsePositiveInt(process.env.GLOBAL_RATE_WINDOW_MS, 60_000);
const GLOBAL_RATE_MAX = parsePositiveInt(process.env.GLOBAL_RATE_MAX, 12_000);

// Express's default routing is neither strict nor case-sensitive (verified:
// express@5.2.1, with no `strict routing` or `case sensitive routing` override
// in this repo), so `/api/healthz/` AND `/API/HEALTHZ` both reach the same
// handler. Registration and exemption must normalize identically on both axes
// or the exemption silently misses valid spellings (round-8 and round-11
// findings — the case axis was missed when the slash axis was fixed).
function normalizeRoutePath(path: string): string {
  const lowered = path.toLowerCase();
  return lowered.length > 1 && lowered.endsWith("/") ? lowered.slice(0, -1) : lowered;
}

// The installed router dispatches HEAD to a GET handler when no explicit HEAD
// handler exists (router@2.2.0, lib/route.js:64-66 and :111-112), so a GET-only
// exemption would let `HEAD /api/healthz` consume the Store and be blocked at
// the ceiling — the shape an uptime probe actually sends.
const SAFE_READ_METHODS = ["GET", "HEAD"] as const;

// The exemption list is now EXACTLY two entries, and the rule that produces it
// is "the whole request path is cheap," not "the final handler looks cheap"
// (round-11 findings, P1×2 — I had applied that rule to the health routes and
// then failed to apply it to the two exemptions I kept).
//
// NOT exempt, deliberately:
//   • /api/health and /api/health/queues — real queries (routes/health.ts:21-29
//     sorts stripe_processed_events; /health/queues aggregates via laneHealth()).
//   • isPublicAssetRequest's crawler-asset patterns — `og.ts:130-159` and
//     `memes.ts:601-660` query Postgres and render/fetch image data, and the
//     pattern also matches the authenticated `/api/memes/ai-user/image` handler
//     (`memes.ts:560-581`), which does ownership checks plus object-storage
//     work. Varying slugs or query params misses caches and drives all of it
//     unmetered. That predicate exists for the CSRF-cookie decision, where it is
//     correct; reusing it here imported a resource-exhaustion hole. The global
//     limiter no longer consults it at all — at 12,000/min a real crawler is
//     nowhere near the ceiling.
const EARLY_EXEMPT_ROUTES: ReadonlyArray<{ methods: readonly string[]; path: string }> = [
  { methods: SAFE_READ_METHODS, path: "/api/healthz" },  // liveness — see mount note
  { methods: ["POST"], path: "/api/stripe/webhook" },     // own signature gate
];
// On the webhook exemption specifically. WebhookHandlers.processWebhook
// (webhookHandlers.ts:1106) calls getStripeSync() at :1120 BEFORE signature
// verification at :1122, so unauthenticated callers reach isLiveMode() →
// getConfigStringRaw → adminConfig.
//
// My round-12 answer was that adminConfig's 60s TTL cache (adminConfig.ts:22)
// bounds this to one read per minute per process. Round 13 showed that is
// wrong, and the reason is worth keeping: `loadAll()` (adminConfig.ts:32-39)
// checks `_cache`, awaits the query, and only THEN assigns `_cache` — there is
// no in-flight promise. With an empty or just-expired cache, N concurrent
// callers all miss and all issue the query. A TTL cache bounds the STEADY
// STATE, not the stampede, and I read the steady-state bound as if it were a
// concurrency bound. getStripeSync (stripeClient.ts:102-107) has the same gap
// and is worse: concurrent misses each run buildStripeSync(), which constructs
// another StripeSync — and another pg pool (stripeClient.ts:96, `max: 2`).
//
// So the exemption is kept but its precondition is now MADE TRUE rather than
// asserted: both paths are single-flighted (§4), so a concurrent forged burst
// at cold start or TTL expiry collapses to one query and one construction.
// With that in place a forged request costs a ≤100 kB raw body (body-parser's
// default, unoverridden at app.ts:148) and one HMAC verification — CPU,
// bounded, no per-request DB. What would invalidate it: removing either
// single-flight, raising the raw-body limit, or new DB work moving ahead of
// the signature check.

function isExemptRequest(req: Request): boolean {
  const path = normalizeRoutePath(req.originalUrl.split("?")[0]);
  return EARLY_EXEMPT_ROUTES.some(
    (r) => r.methods.includes(req.method) && r.path === path,
  );
}

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  limit: GLOBAL_RATE_MAX,          // a constant — not an async DB read
  store: new GlobalRateLimitStore(),
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  passOnStoreError: false,         // policy lives in the Store — see §2
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isExemptRequest(req),
  handler: (req, res) => {
    logBlockedThrottled({ path: req.originalUrl.split("?")[0] }, "global rate limit exceeded");
    res.set("Cache-Control", "no-store");
    res.status(429).json({ error: "Too many requests. Please slow down." });
  },
});

// `/api/healthz` is RE-REGISTERED here, immediately after cors() and before
// the parsers/auth chain (round-11 finding, P1). Exempting it from the limiter
// does not make its request path cheap: `app.ts:181-264` still runs JSON and
// urlencoded parsing, cookie parsing, and `authMiddleware`, and any caller can
// attach a fabricated `sid` cookie or Bearer token to force a session lookup
// plus its cleanup query (`authMiddleware.ts:64-83`, `auth.ts:149-177`) on
// every exempt request. An exemption that skips the meter but not the work is
// the same unmetered-DB-path defect as the health routes, just quieter.
// Registering the handler ahead of that chain makes the exemption honest —
// liveness stays reachable under Store failure AND costs nothing to serve.
app.get("/api/healthz", healthzHandler);
app.head("/api/healthz", healthzHandler);

// Mounted immediately after the app-level cors() call (app.ts:180) — early
// enough that a rejected request never pays for body parsing, CSRF, or
// authMiddleware's DB session lookup, but late enough that its 429 carries
// correct CORS headers.
//
// PREFLIGHT: an ACCEPTED origin's OPTIONS never reaches here — with the default
// preflightContinue:false, cors() answers it and ends the response. A REJECTED
// origin's preflight DOES reach here (round-12 finding; confirmed in
// cors@2.8.6 lib/index.js:222-228, where the origin callback returning false
// takes the `if (err2 || !origin) { next(err2) }` branch and falls through
// rather than answering). Those requests are metered like any other
// unauthenticated traffic, which is the intended behavior: exempting OPTIONS
// would hand an attacker a one-word bypass. The DB cost of metering them is
// bounded by §2's write-amplification note.
app.use("/api", globalLimiter);
app.use("/api", globalRateLimitErrorHandler);   // 503 on RateLimiterUnavailableError
```

**Mount-shape notes:**

- **Direct-passed, not wrapped.** `rateLimit(...)` goes to `app.use()` as its own
  argument — CodeQL's model is pattern-sensitive, and this matches the original
  213→0 proof exactly.
- **`req.originalUrl`, not `req.path`.** `app.use("/api", ...)` strips the prefix
  from `req.path` inside the middleware — the mechanism that broke exemption
  matching in round 1. Every exemption comparison here runs on the normalized
  `originalUrl` path, and nothing else consumes it, so there is only one mount
  depth to get right.
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
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new: the `Store`; its
  dedicated `pg.Pool` (`max: 4`, `connectionTimeoutMillis: 2_000`, idle `error`
  handler, `idleTimeoutMillis`/`maxLifetimeSeconds`, test-runner
  `allowExitOnIdle`); the `MAX_IN_FLIGHT` admission bound and
  `RateLimiterUnavailableError`; a `close()` shutdown path; the process-local
  `storeErrorThisInstance` counter and throttled error log.
- `artifacts/api-server/src/lib/adminConfig.ts` — **single-flight `loadAll()`**
  (round-13 finding, P1). It currently checks `_cache`, awaits the query, then
  assigns — so concurrent callers on an empty or just-expired cache all query.
  Hold the in-flight promise and have concurrent misses await it. This is in
  scope because the Stripe-webhook exemption's bound depends on it; it also
  benefits every other config reader.
- `artifacts/api-server/src/lib/stripeClient.ts` — **single-flight
  `getStripeSync()`** for the same reason, and worse consequence: concurrent
  misses each run `buildStripeSync()`, constructing another `StripeSync` **and
  another pg pool** (`:96`, `max: 2`) — which the connection budget above does
  not account for more than once.
- `artifacts/overhype-me/src/components/meme-builder/wizard/step2-video/GodModeLoadingTakeover.tsx`
  and `.../step2-image/PulidLoadingTakeover.tsx` — **treat `429`/`503` as
  retryable** rather than counting them toward terminal failure (round-13
  finding, P1). Without this, five shed polls mark a still-running job `failed`.
- `lib/db/src/index.ts` — **the pool-budget derivation must be updated, not just
  consumed** (round-12 finding). The comment at `:45-67` derives
  `max = min(20, floor(398 / max_instances))` and concludes 20 is "safe for any
  autoscale ceiling up to 19 instances" — a figure computed *for* 20 connections
  per instance. The corrected derivation counts **every** pool in the process,
  not only the ones this plan introduces — round 13's finding, and it is right:
  I first recorded 16 by adding the limiter's 4 to the shared 20 and setting the
  Stripe pool aside as someone else's pre-existing omission. Postgres does not
  care whose omission it is, and `16 × 26 = 416` still exceeds the budget.

  ```
    20  shared pool        (lib/db/src/index.ts)
     4  limiter pool       (this plan)
     2  StripeSync pool    (stripeClient.ts:96)
    ──
    26  per instance  →  floor(398 / 26) = 15 instances   (15 × 26 = 390 ✓)
  ```

  The comment is rewritten to enumerate all three and record **15**, so the next
  person to add a pool updates a total instead of rediscovering one. The shared
  pool's `max` stays 20 — lowering it would break the "double the five lanes'
  worst case of 10" property the comment derives, and that property is
  load-bearing where the ceiling figure is not. `DB_POOL_MAX` remains the escape
  hatch above 15 instances. Leaving the comment stale would be worse than the
  connections it undercounts: it is the only written record of this budget.
- `artifacts/api-server/src/lib/sharedRateLimiter.ts` — `purgeExpiredRateLimitCounters()`
  gains a `limit` parameter and returns the deleted-row count, so the new job can
  loop in bounded batches (round-11 finding: as written it is one unbounded
  `DELETE`, and this file was missing from the list).
- `artifacts/api-server/src/lib/rateLimit.ts` — add `GLOBAL_RATE_WINDOW_MS` /
  `GLOBAL_RATE_MAX` beside the existing `RATE_WINDOW_MS` / `RATE_MAX`, one place
  to look.
- `artifacts/api-server/src/app.ts` — mount after `cors()`, scoped to `/api`,
  direct-passed; `EARLY_EXEMPT_ROUTES` + `normalizeRoutePath` (slash **and**
  case); re-register `/api/healthz` ahead of the parser/auth chain. The global
  limiter no longer calls `isPublicAssetRequest` at all, so that helper keeps its
  current `Request`-taking signature and its CSRF-cookie call site is untouched —
  one fewer change than earlier revisions of this plan proposed.
- `artifacts/api-server/src/jobs/rateLimitCounterPurger.ts` — new, mirrors
  `jobs/transientRenderPurger.ts`; `index.ts` gets `scheduleRateLimitCounterPurger()`.
- `artifacts/api-server/src/index.ts` — boot-time `IP_HASH_SALT` assertion.
- `artifacts/api-server/src/__tests__/globalRateLimitStore.test.ts` — new.
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new.
- `artifacts/api-server/src/__tests__/rateLimitCounterPurger.test.ts` — new.
- `artifacts/api-server/src/__tests__/index.saltGuard.test.ts` — new.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — record the
  resolution: the global middleware is what clears the alerts, and why.

**No migration. No `admin_config` row.**

## 5. Verification

1. **In the repository's required cold-build order** (round-11 finding — the root
   `build` script does not run API codegen, so starting at `typecheck` on a clean
   checkout fails on missing/stale generated libs):
   `pnpm --filter @workspace/api-spec run codegen` → `pnpm run typecheck:libs` →
   `pnpm typecheck` → `pnpm run build`. `pnpm install --frozen-lockfile` succeeds.
2. **Store unit tests:** increment/decrement/resetKey semantics; both persisted
   columns salted (neither equals the unsalted digest); window/expiry rollover; a
   real concurrency test proving the single-statement upsert is atomic under
   parallel increments, not just sequentially.
3. **Integration tests against the real `app`,** with an injected low limit: 429 +
   JSON body + `Cache-Control: no-store` + `RateLimit-*` headers past the ceiling;
   **exactly at the ceiling is allowed and at ceiling+1 is blocked** (the package
   blocks on `>`, not `>=`); no `X-RateLimit-*` legacy headers; exempt routes never
   touch the Store (asserted by Store hit count) for **both `GET` and `HEAD`**;
   wrong-method-on-exempt-path is *not* exempt; **canonical, trailing-slash, and
   mixed-case spellings all behave identically**, asserted against the actually
   registered routes; `/api/health` and `/api/health/queues` **are** metered;
   **an OG/meme asset flood with randomized slugs, and `/api/memes/ai-user/image`,
   are metered** (the exemption they used to get is gone); trusted-IP resolution
   order proven against actual bucket sharing; `ipKeyGenerator` IPv6/IPv4-mapped
   handling; a sustained blocked burst produces bounded log volume; CORS headers
   present on the 429; preflight behavior asserted by Store hit count across all
   three origin cases — **allowed** (answered by `cors()`, never reaches the Store),
   **absent**, and **rejected** (falls through and *is* metered).
3a. **The webhook exemption's bound, asserted rather than argued** — and the
   burst must be **concurrent**, against both an **empty** and a **just-expired**
   cache (round-13 finding: a serial burst passes on a TTL cache alone, which is
   why my round-12 rebuttal survived a round it shouldn't have). Assert an
   invalid-signature burst issues **one** `admin_config` query and constructs
   **one** `StripeSync`, and that an over-limit raw body is rejected by
   body-parser before the handler.
3d. **Dedicated-pool lifecycle:** emitting an idle-client `error` on the Store's
   pool does not crash the process and the pool recovers on the next request
   (round-12 finding; mirrors `lib/db/src/index.ts:90-95`). And the round-13
   half: **a test process that has run a Store query exits promptly** rather
   than hanging for `idleTimeoutMillis`, via test-runner `allowExitOnIdle` plus
   an explicit `close()`.
3b. **The polling case, because it is what the ceiling is derived from:** a
   simulated shared IP running N concurrent pollers at the real 500 ms cadence —
   **both** `/api/memes/video-jobs/:id` and `/api/memes/pulid-jobs/:id`, since the
   ceiling now accounts for two — stays under the ceiling at the documented
   capacity and never trips `MAX_CONSECUTIVE_ERRORS`.
3c. **The failure-policy matrix. This boundary has produced a defect in rounds 9,
   11, 12 and 13, so it gets asserted counts and peak measurements, not
   latencies:**
   - *Healthy contention.* Drive concurrency well past `MAX_IN_FLIGHT` (the 500
     -concurrent load case below is the same scenario at scale). Assert every
     shed request returns **503**; that requests **admitted past the ceiling
     number zero** — the bypass rounds 9, 11 and 12 each produced in a different
     shape; that the **peak** `_pendingQueue` depth and peak open-request count
     stay at their bounds rather than growing with offered load (the round-13
     finding: `pg-pool` queues rather than sheds, so "bounded" has to be
     measured, not asserted); and that the 503 path issues no query.
   - *Genuine outage.* Stop the database, assert requests are admitted (fail
     open) and the log stays ≤1 line/sec/process.
   - *Recovery.* Bring it back; assert enforcement resumes immediately.
   - *Idle, then contention.* Leave the instance idle well past any staleness
     interval, then drive contention: assert **503**, not fail-open. This is the
     round-13 case that killed the `lastSuccessAt` design, and it must keep
     failing if a traffic-derived health signal is ever reintroduced.
   - *Shed responses do not destroy work.* Five consecutive 503s (and separately
     five 429s) to a running video-job poller leave the job running and recover
     on the sixth — the pre-existing client defect this plan fixes.
4. **Purger tests:** active vs. expired boundary; bounded-batch deletion of a large
   synthetic backlog; a thrown error on one run doesn't block the next.
5. **Boot-time salt guard matrix — both positive branches, not just one**
   (round-11 finding: a guard accidentally reduced to the Replit check would pass a
   Replit-only matrix while a conventional deploy silently used the fallback salt).
   Throws for `REPLIT_DEPLOYMENT=1` with `NODE_ENV` unset **and** for
   `NODE_ENV=production` with `REPLIT_DEPLOYMENT` unset, each with a missing salt
   and a too-short salt; does not throw with a valid salt, or in test/CI and local
   development.
6. **Full existing suite + E2E Smoke** — no new failures, and specifically no 429s
   and no 503s from this limiter. CI runs ~170 test files against one local server
   from one IP, so this is the empirical check that 12,000/min clears real CI
   volume. If it doesn't, raise the default rather than special-casing `NODE_ENV`.
7. **Local CodeQL re-scan** of the final code confirms `js/missing-rate-limiting`
   drops 213 → 0.
8. **Load check:** 500 concurrent requests over 200 distinct keys and over 1 shared
   key, 30s each. Pass: p95 added latency ≤ 15ms; shared-pool usage ≤ 16 of 20
   connections; dedicated-pool usage ≤ 4 **and peak `_pendingQueue` depth ≈ 0**
   (the admission bound should mean the pool is never oversubscribed, so this is
   the measurement that catches the round-13 queueing defect if it returns); 0%
   requests admitted past the ceiling.
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
  scraper" — a question that only mattered for staging the flip.

  **Correction (round-11, P1): the argument I first gave for why dropping it was
  safe was wrong.** I wrote that 600/min is "~100× a busy logged-in user's
  page-load pattern," so a NAT would need ~100 simultaneous users to reach it.
  That estimate ignored polling entirely. `GodModeLoadingTakeover.tsx:80` polls
  every 500 ms during video generation — 120 req/min for a single active job — so
  the real figure was about **five** concurrent users, not 100, and crossing the
  ceiling would have marked their in-flight jobs failed within 2.5 seconds
  (`MAX_CONSECUTIVE_ERRORS = 5`). The conclusion (drop the discriminator) still
  holds, but it now rests on a ceiling **derived from that measured workload**
  rather than on a guess. Recorded rather than quietly amended, because the
  original number is what justified the removal at the time. Round 12 then found
  the derivation itself incomplete — a *second* 500 ms poller
  (`PulidLoadingTakeover.tsx`) and a 6,000 figure that was exactly the polling
  term with zero browsing headroom — which is why §3 now shows the arithmetic and
  lands at 12,000/min.
- **The dry-run rollout flag.** Directly conflicted with `AGENTS.md:133-134`
  ("Pre-launch: features ship on-by-default, no rollout flags"). Removing it
  resolves the conflict rather than seeking an exception.
- **The `admin_config`-backed ceiling** (`global_rate_limit_max`), its 2-second
  single-flighted cache, the debug-overlay bypass, the PATCH validation fixes, and
  the seed migration. All existed to make the ceiling live-tunable. An env var
  matches what the existing narrow limiters already do; changing it needs a deploy,
  which is acceptable for a backstop set well above real usage. This also removes
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
  `pool.connect()`, which stranded waiters in `pg-pool`'s queue. Neither survives.

  **Correction (round-11, P1): my replacement argument was also wrong, in the same
  way as the ceiling estimate.** I wrote that the Store would just make "the same
  plain `db` call `checkSharedRateLimit` has been making in production all along."
  That was true of the *call* and false about the *scope*: the narrow limiter
  guards specific routes, while this one runs on every `/api/*` request before
  routing, including nonexistent paths. With no `connectionTimeoutMillis` on the
  shared pool, a database stall would queue all of them unboundedly and never
  reach the error path. §2 now gives the Store a dedicated `max: 4`,
  `connectionTimeoutMillis: 2_000` pool, which bounds acquisition by construction
  without an application-level permit scheme.

  **That boundary then took three more rounds, and the arc is worth keeping in
  one piece rather than as a stack of corrections.** Round 12 showed a full pool
  rejects on `connectionTimeoutMillis` regardless of database health
  (`pg-pool/index.js:199-225`), so the dedicated pool reproduced the round-9
  bypass in a different costume. Round 13 showed that the `lastSuccessAt`
  timestamp meant to tell contention from outage could not do it either — an
  idle instance looks identical to an unhealthy one — and that `pg-pool`
  *queues* excess callers for the full timeout (`index.js:216-231`) rather than
  shedding them, so the design's central claim was false in both directions at
  once.

  Every one of those attempts inferred contention from a **symptom**: a timeout,
  a permit count, a stale clock. §2 stops inferring — the Store counts its own
  in-flight calls and refuses the (N+1)-th before touching the pool, so
  contention is a fact it holds rather than a diagnosis it makes. That single
  change subsumes `runBounded`, the round-9 gate, the round-11 pool timeout, and
  the round-12 health signal, and it is safe where the round-9 gate was not for
  one reason: **exhausting it is punished (503), not rewarded (admitted
  uncounted).** A gate is only a bypass if running it out gets you through.

  **The residual that genuinely remains:** when the database itself fails, this
  limiter stops limiting. That is the right choice for a backstop, and the
  existing narrow limiters share it exactly.
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
12,000/min per IP is unremarkable, so **the recommendation is to leave them covered**
and close the roadmap item.
