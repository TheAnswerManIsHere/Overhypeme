# Global rate limiter (satisfy CodeQL `js/missing-rate-limiting`)

> **Design decision (David, 2026-08-04).** This plan spent rounds 4-14 building a
> DB-backed `Store`, and that one decision produced a P1 on the same boundary —
> what the Store does when a database call doesn't complete — in rounds 9, 11,
> 12, 13 **and** 14, with the finding count going 8 → 6 → 6 → 10. Round 14's
> version was worse than the bug it replaced: four hung queries would have wedged
> an in-process counter and returned 503 to every request indefinitely, turning a
> database stall into a total outage.
>
> Every one of those defects came from making a limiter write to Postgres on the
> hot path of every API request. CodeQL is satisfied by the package being present
> and mounted; the original 213→0 proof used the package's built-in in-memory
> store and needed none of that machinery. David's call was to ship that, and to
> route the genuine repository bugs the loop uncovered to their own bugfix PRs
> rather than lose them. §5 records what was removed and §6 is that queue.

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
in a full local scan, using the default `MemoryStore`. This plan ships that exact
shape, so the original proof is the operative one; §4 re-runs it regardless.

**Outcome:** 213 alerts clear; no existing limiter's behavior changes; no new
table, no migration, no new database connection, no rollout flag.

## 1. Dependency: `express-rate-limit` (^8.5.1)

Verified against the packaged source, not docs or memory:

- **Over-limit is `totalHits > limit`** (`dist/index.cjs:992`), so a configured
  limit of N allows N and blocks the (N+1)-th.
- `config.skip` is evaluated **before** `store.increment` (`:887-890`) — exempt
  paths genuinely never touch the store.
- `ipKeyGenerator(ip, ipv6Subnet = 56)` normalizes IPv6 to a `/56` with an
  IPv4-mapped carve-out (the CVE-2026-30827 bug class).
- v8 supports Express 5 (this repo runs `express@5.2.1`).

### What `MemoryStore` actually does, since it is now load-bearing

Read from the packaged source rather than assumed, because "in-memory" is exactly
the kind of choice that hides an unbounded-growth problem:

- **Memory is bounded, not unbounded.** It keeps two maps and rotates them:
  `init()` sets `setInterval(windowMs)` and `clearExpired()` is just
  `previous = current; current = new Map()`. A key is therefore retained for at
  most **two windows** (2 minutes here) after its last request, then dropped in
  bulk. There is no per-key timer and no scan. A flood from many distinct
  addresses costs a `Map` entry per address seen in a 2-minute span — a short
  string plus `{totalHits, resetTime}` — not a permanent leak.
- **The interval is `unref()`'d** (`init()`), so it never holds the event loop
  open and needs no shutdown hook or test-mode handling.
- **`localKeys = true`** — the package's own declaration that counts do not
  cross instances. That is the property we are knowingly trading away; see §5.
- `windowMs` must be ≤ `SET_TIMEOUT_MAX`; 60,000 is far inside it.

**`passOnStoreError` is irrelevant here** and is left at its default. It exists
to decide what happens when a store throws; `MemoryStore.increment` does a map
lookup and an integer increment, with no I/O and nothing to fail. The entire
failure-policy question that consumed rounds 9-14 does not arise, because there
is no failure to have a policy about.

Rejected: `@acpr/rate-limit-postgresql` and a hand-written DB `Store` — see §5.

## 2. Wiring in `app.ts`

```ts
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { ipFromRequest } from "./lib/transientRenderLog";
import { healthzHandler } from "./routes/health";

// Same env-var convention as the existing narrow limiters (rateLimit.ts's
// RATE_WINDOW_MS / RATE_MAX), reusing parsePositiveInt.
//
// THE DEFAULT IS DERIVED FROM THIS REPO'S REAL POLLING WORKLOAD, not from a
// page-load estimate. There are TWO 500 ms pollers, each 120 req/min for ONE
// active job:
//   • GodModeLoadingTakeover.tsx:80,166 → /api/memes/video-jobs/:id
//   • PulidLoadingTakeover.tsx:27,93    → /api/memes/pulid-jobs/:id
//
// Crossing the ceiling is not a slow page today: the video poller throws on a
// non-OK response and MAX_CONSECUTIVE_ERRORS = 5 (:127) marks a still-running
// job **failed**, so 2.5 seconds of 429s destroys in-flight generations for
// everyone behind that IP. That is a pre-existing client defect — it fires on
// any 429 under any ceiling — and it is §6's first queue item rather than this
// plan's, but it is why the ceiling below is set generously.
//
// Derivation:
//   50 concurrent polling jobs behind one IP × 120 req/min   = 6,000
//   ordinary browsing by those same 50 users, ~60 req/min ea = 3,000
//   → 9,000, ×1.33 margin                                   ≈ 12,000/min
const GLOBAL_RATE_WINDOW_MS = parsePositiveInt(process.env.GLOBAL_RATE_WINDOW_MS, 60_000);
const GLOBAL_RATE_MAX = parsePositiveInt(process.env.GLOBAL_RATE_MAX, 12_000);

// Express's default routing is neither strict nor case-sensitive (verified:
// express@5.2.1, no `strict routing` or `case sensitive routing` override in
// this repo), so `/api/healthz/` AND `/API/HEALTHZ` both reach the same
// handler. Registration and exemption must normalize identically on both axes
// or the exemption silently misses valid spellings.
function normalizeRoutePath(path: string): string {
  const lowered = path.toLowerCase();
  return lowered.length > 1 && lowered.endsWith("/") ? lowered.slice(0, -1) : lowered;
}

// The installed router dispatches HEAD to a GET handler when no explicit HEAD
// handler exists (router@2.2.0, lib/route.js:64-66 and :111-112), so a GET-only
// exemption would let `HEAD /api/healthz` be blocked at the ceiling — the shape
// an uptime probe actually sends.
const SAFE_READ_METHODS = ["GET", "HEAD"] as const;

// Exactly two exemptions, and the rule producing them is "the whole request
// path is cheap," never "the final handler looks cheap."
//
// NOT exempt, deliberately:
//   • /api/health and /api/health/queues — real queries (routes/health.ts:21-29
//     sorts stripe_processed_events; /health/queues aggregates via laneHealth()).
//   • isPublicAssetRequest's crawler-asset patterns — og.ts:130-159 and
//     memes.ts:601-660 query Postgres and render/fetch image data, and the
//     pattern also matches the authenticated /api/memes/ai-user/image handler
//     (memes.ts:560-581). That predicate answers "is this a public crawler
//     asset" for the CSRF-cookie decision, where it is correct; it is not a
//     proxy for "is this cheap." The limiter does not consult it at all.
const EARLY_EXEMPT_ROUTES: ReadonlyArray<{ methods: readonly string[]; path: string }> = [
  { methods: SAFE_READ_METHODS, path: "/api/healthz" },
  { methods: ["POST"], path: "/api/stripe/webhook" },  // own signature gate
];

function isExemptRequest(req: Request): boolean {
  const path = normalizeRoutePath(req.originalUrl.split("?")[0]);
  return EARLY_EXEMPT_ROUTES.some(
    (r) => r.methods.includes(req.method) && r.path === path,
  );
}

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  limit: GLOBAL_RATE_MAX,
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isExemptRequest(req),
  handler: (req, res) => {
    logBlockedThrottled({ path: req.originalUrl.split("?")[0] }, "global rate limit exceeded");
    res.set("Cache-Control", "no-store");
    res.status(429).json({ error: "Too many requests. Please slow down." });
  },
});

// `/api/healthz` is RE-REGISTERED here, after cors() and before the
// parser/auth chain. Exempting it from the limiter does not make its request
// path cheap: app.ts:181-264 still runs JSON and urlencoded parsing, cookie
// parsing, and authMiddleware, and any caller can attach a fabricated `sid`
// cookie or Bearer token to force a session lookup plus its cleanup write
// (authMiddleware.ts:64-83, auth.ts:149-177). An exemption that skips the
// meter but not the work is the defect, and it is independent of which store
// the limiter uses.
//
// This imports the CANONICAL handler rather than redefining one. It is
// currently inline at routes/health.ts:11-14; that expression moves to an
// exported `healthzHandler` which the health router keeps using, so there is
// exactly one implementation and a future response-schema change cannot leave
// the early copy stale while the router's tests still pass.
app.get("/api/healthz", healthzHandler);
app.head("/api/healthz", healthzHandler);

// Mounted immediately after the app-level cors() call (app.ts:180) — early
// enough that a rejected request never pays for body parsing, CSRF, or
// authMiddleware's DB session lookup, but late enough that its 429 carries
// correct CORS headers.
//
// PREFLIGHT: an ACCEPTED origin's OPTIONS never reaches here — with the
// default preflightContinue:false, cors() answers it and ends the response. A
// REJECTED origin's preflight DOES reach here (cors@2.8.6 lib/index.js:222-228:
// the origin callback returning false takes the `if (err2 || !origin)` branch
// and falls through rather than answering). Those are metered like any other
// unauthenticated traffic, deliberately — exempting OPTIONS would hand an
// attacker a one-word bypass.
app.use("/api", globalLimiter);
```

**Mount-shape notes:**

- **Direct-passed, not wrapped.** `rateLimit(...)` goes to `app.use()` as its own
  argument — CodeQL's model is pattern-sensitive, and this matches the original
  213→0 proof exactly.
- **`req.originalUrl`, not `req.path`.** `app.use("/api", ...)` strips the prefix
  from `req.path` inside the middleware. Every exemption comparison runs on the
  normalized `originalUrl` path, so there is one mount depth to get right.
- **Exemptions are method+path pairs**, not bare paths: a path-only set would let
  `POST /api/healthz` skip the limiter even though no route handles that method.
- **`Cache-Control: no-store` on the 429**, set directly — this mount runs before
  the existing `noStore` middleware list, so a 429 could otherwise be cached by an
  intermediate proxy and served to a since-recovered client.
- **The block log is throttled** to ≤1 line/second/process; a sustained burst past
  the ceiling would otherwise turn an unbounded request stream into an unbounded
  log stream.

### What per-instance counting means, stated plainly

`MemoryStore.localKeys = true`: each autoscale instance counts independently, so
one IP's effective allowance is up to `instances × 12,000/min` rather than
12,000/min, depending on how the load balancer spreads that IP's requests.

This is the trade being made, and it is acceptable **for this limiter
specifically**:

- It is a **backstop against gross abuse**, not a per-feature throttle. The real
  protection is the existing narrow limiters — 30/min general, 5/min fact-submit
  — which are DB-backed, fleet-correct, and completely untouched by this plan.
- The ceiling is already ~100× realistic single-IP usage. A limit that is loose
  by a further single-digit multiple is still a limit, and the abuse it exists to
  stop is orders of magnitude past it.
- **The derivation above is unchanged by this**, because it was always the
  worst case: all of one IP's traffic arriving at one instance. Per-instance
  counting can only make the effective ceiling *looser* than derived, never
  tighter, so no legitimate user is throttled by this choice.

If fleet-wide global counting is ever genuinely needed, the correct answer is a
shared counter in a store built for hot-path reads and writes, not Postgres —
which is a different project with a different justification, not a variation on
this one.

## 3. Files touched

- `artifacts/api-server/package.json` + regenerated root `pnpm-lock.yaml` — add
  `express-rate-limit`.
- `artifacts/api-server/src/lib/rateLimit.ts` — add `GLOBAL_RATE_WINDOW_MS` /
  `GLOBAL_RATE_MAX` beside the existing `RATE_WINDOW_MS` / `RATE_MAX`, one place
  to look.
- `artifacts/api-server/src/routes/health.ts` — extract the inline `/healthz`
  handler (`:11-14`) to an exported `healthzHandler`; the router keeps using it.
  No behavior change.
- `artifacts/api-server/src/app.ts` — mount after `cors()`, scoped to `/api`,
  direct-passed; `EARLY_EXEMPT_ROUTES` + `normalizeRoutePath`; re-register
  `/api/healthz` (both methods) ahead of the parser/auth chain.
- `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts` — new.
- `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` — record
  the resolution: the global middleware clears the alerts, and why the query
  cannot be satisfied by correct custom code.

**No migration. No new table or table usage. No `admin_config` row. No new
database connection. No changes to `lib/db/src/index.ts`, `sharedRateLimiter.ts`,
or any existing limiter.**

## 4. Verification

1. **In the repository's required cold-build order** (the root `build` script
   does not run API codegen, so starting at `typecheck` on a clean checkout fails
   on missing/stale generated libs):
   `pnpm --filter @workspace/api-spec run codegen` → `pnpm run typecheck:libs` →
   `pnpm typecheck` → `pnpm run build`. `pnpm install --frozen-lockfile` succeeds.
2. **Integration tests against the real `app`,** with an injected low limit:
   - 429 + JSON body + `Cache-Control: no-store` + `RateLimit-*` headers past the
     ceiling; **exactly at the ceiling is allowed and ceiling+1 is blocked** (the
     package compares with `>`, not `>=`); no `X-RateLimit-*` legacy headers.
   - Exempt routes are never metered, for **both `GET` and `HEAD`**;
     wrong-method-on-an-exempt-path is *not* exempt; **canonical, trailing-slash
     and mixed-case spellings behave identically**, asserted against the actually
     registered routes.
   - `/api/health` and `/api/health/queues` **are** metered; an OG/meme asset
     flood with randomized slugs and `/api/memes/ai-user/image` **are** metered.
   - `/api/healthz` served by the early registration returns the **same response
     as the health router's**, so the single-handler claim is enforced rather
     than asserted.
   - Trusted-IP resolution order proven against actual bucket sharing;
     `ipKeyGenerator` IPv6 `/56` and IPv4-mapped handling.
   - CORS headers present on the 429; preflight asserted across all three origin
     cases — **allowed** (answered by `cors()`, never metered), **absent**, and
     **rejected** (falls through and *is* metered).
   - A sustained blocked burst produces bounded log volume.
3. **The polling case, because it is what the ceiling is derived from:** a
   simulated shared IP running the documented capacity of concurrent pollers at
   the real 500 ms cadence — **both** `/api/memes/video-jobs/:id` and
   `/api/memes/pulid-jobs/:id`, plus representative browsing on the same address
   — receives **zero 429s**. Not "does not trip `MAX_CONSECUTIVE_ERRORS`":
   zero. The plan claims this workload is never throttled, so that is the
   assertion.
4. **Memory behavior, since in-memory is the design choice:** drive traffic from
   a large number of distinct keys, then assert the store's entry count returns
   to ~0 within two windows of the traffic stopping (the `previous`/`current`
   rotation), and that the process holds no timer preventing exit.
5. **Full existing suite + E2E Smoke** — no new failures, and specifically no
   429s from this limiter. CI runs ~170 test files against one local server from
   one IP, so this is the empirical check that 12,000/min clears real CI volume.
   If it doesn't, raise the default rather than special-casing `NODE_ENV`.
6. **Local CodeQL re-scan** of the final code confirms `js/missing-rate-limiting`
   drops 213 → 0.
7. **Load check, measured on admitted requests:** 500 concurrent requests over
   200 distinct keys and over 1 shared key, 30s each. Pass: p95 added latency
   ≤ 2 ms on requests the limiter allowed, reported separately from any 429s so
   rejections cannot flatter the percentile.
8. **Manual:** exceed the ceiling from one IP, confirm the 429 body, headers and
   CORS; confirm the narrow limiters still fire independently; confirm exempt
   routes are unaffected.

## 5. What was removed, and why that's safe

The DB-backed `Store` and everything built to make it safe: the dedicated
`pg.Pool` and its lifecycle, the `MAX_IN_FLIGHT` admission bound, the
contention-versus-outage failure policy, `RateLimiterUnavailableError` and its
503 path, the connection-budget recalculation, the `rate_limit_counters` purger,
the salted `hashIp` key derivation and its boot-time salt assertion, and the
`sharedRateLimiter.ts` batching change.

**What that machinery bought:** fleet-wide counting — addressed above.

**What it cost, recorded because it is the actual lesson.** Fourteen review
rounds, of which rounds 9-14 each produced a P1 on one boundary: what the Store
does when a database call doesn't complete. Every fix was sound against the
finding it answered and wrong in a way the next round found:

| Round | Mechanism | How it failed |
|---|---|---|
| 9 | Application-level permit gate | Exhausting permits **admitted requests uncounted** — hold the permits, bypass the limiter |
| 11 | Dedicated pool + `connectionTimeoutMillis` | `pg-pool` applies that timeout whenever the pool is full, not only when the DB is unreachable — same bypass |
| 12 | `lastSuccessAt` health signal | Cannot distinguish an **idle** instance from an unhealthy one; and `pg-pool` *queues* excess callers rather than shedding them |
| 13 | `MAX_IN_FLIGHT` admission bound | The timeout bounds **checkout only**; four post-checkout hangs wedge the counter and 503 every request forever |

Round 13's version was worse than the bypass it replaced: it converted a
database stall into a total site outage. Each attempt inferred contention from a
*symptom* — a timeout, a permit count, a stale clock — and the one that stopped
inferring introduced a global concurrency cap on the entire API instead.

None of this exists with an in-memory store. There is no connection to exhaust,
no query to hang, no failure to have a policy about, and no write on the hot path
of every request.

Also removed earlier in the plan's life, and still removed: fleet metrics and an
admin metrics endpoint, a shared-NAT discriminator, a dry-run rollout flag (which
conflicted with `AGENTS.md:133-134`), an `admin_config`-backed ceiling with its
cache and rescue routes, and the purger's advisory lock. Their reasoning is in
the round-10 scope-reset history on this branch.

## 6. Real bugs found along the way — separate bugfix PRs

David's instruction (2026-08-04) was to keep these rather than lose them with the
machinery. **None is caused by this plan; all exist in `main` today**, and each
goes to its own `/bugfix` branch and PR, not here.

1. **Both job pollers mark live jobs dead on transient errors.**
   `GodModeLoadingTakeover.tsx:129-166` increments one counter on *any* non-OK
   poll response and at `MAX_CONSECUTIVE_ERRORS = 5` sets terminal `failed` on a
   job the backend is still running. A 429, a 502 from a restart, or a dropped
   connection all destroy real work in 2.5 seconds. Note `Step2Video.tsx:516-521`
   owns the fetch and reduces every failure to `new Error(\`poll: ${status}\`)`,
   discarding the status code and all headers — so the fix needs a typed retry
   classification there, not just a change in the takeover. `PulidLoadingTakeover`
   has the opposite defect: it never gives up at all.
2. **`adminConfig.loadAll()` has a cache stampede and a stale-fill race.**
   `adminConfig.ts:32-39` checks `_cache`, awaits the query, then assigns, with no
   in-flight promise: concurrent callers on an empty or just-expired cache all
   query. Worse, `bustConfigCache()` can clear the cache while an older read is in
   flight, and that read then repopulates it with pre-write rows for another 60
   seconds — which affects the immediate `stripe_live_mode` refresh at
   `routes/admin.ts:2328-2341`. Needs a single-flight **with a generation counter**
   so only the current generation may publish.
3. **`getStripeSync()` is not mode-scoped or rejection-safe.**
   `stripeClient.ts:102-107` has no single-flight, so concurrent misses each run
   `buildStripeSync()` — constructing extra `StripeSync` instances *and* extra pg
   pools (`:96`, `max: 2`). A `stripe_live_mode` flip mid-flight can republish a
   superseded client after `invalidateStripeSync()`, and `buildStripeSync()`
   re-reads the mode independently for the secret and webhook secret instead of
   using the mode captured at entry.
4. **The autoscale connection budget is unenforced and slightly wrong.**
   `.replit` selects `deploymentTarget = "autoscale"` with no maximum instance
   count, so `lib/db/src/index.ts:45-67`'s "safe up to 19 instances" is a comment
   that cannot fail. It also omits the `StripeSync` pool's `max: 2`, making the
   real per-instance total 22 and the honest ceiling `floor(398/22)` = 18. Wants
   either a deployment cap or a boot-validated instance-count input deriving
   `DB_POOL_MAX`.
5. **`IP_HASH_SALT` can silently fall back in production.** `hashIp` falls back to
   a repository-known string when the salt is missing or under 16 characters,
   logged only as a WARN. This plan no longer hashes IPs, but
   `transientRenderLog.ts`'s existing usage still does. Wants a boot assertion on
   the canonical production predicate
   (`REPLIT_DEPLOYMENT === "1" || NODE_ENV === "production"`), tested on **both**
   branches of that `||`.
6. **`purgeExpiredRateLimitCounters()` is one unbounded `DELETE`**
   (`sharedRateLimiter.ts:83-85`) with no production caller. Either wire it up
   with a bounded batch size *and* a per-run budget, or delete it — but it should
   not sit in the tree looking like live cleanup.

Items 1-3 are user-visible or correctness bugs and should go first. Items 4-6 are
latent.

## 7. Open question for David

**Does `/api/admin/*` sit behind this ceiling?** It does by default, since the
limiter mounts at `/api`. `current-roadmap.md:280-288` records this as a pending
decision, so this plan flags it rather than settling it silently — but the sharp
edge is gone: with a code-constant ceiling there is no admin endpoint whose
throttling could lock an operator out of fixing the throttle. Admin routes behind
12,000/min per IP is unremarkable, so **the recommendation is to leave them
covered** and close the roadmap item.
