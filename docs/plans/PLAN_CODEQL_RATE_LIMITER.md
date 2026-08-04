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

- **Retention is bounded by a two-map rotation.** `init()` sets
  `setInterval(windowMs)`, and `clearExpired()` is just
  `previous = current; current = new Map()`. A key is retained for at most **two
  windows** (2 minutes here) after its last request, then dropped in bulk. No
  per-key timer, no scan.
- **The interval is `unref()`'d**, so it never holds the event loop open and
  needs no shutdown hook or test-mode handling.
- **`localKeys = true`** — the package's own declaration that counts do not
  cross instances. See *What per-instance counting means* below.
- `windowMs` must be ≤ `SET_TIMEOUT_MAX`; 60,000 is far inside it.

### Peak cardinality is NOT bounded, and that needs a fix (round-15 finding, P1)

An earlier revision of this section claimed "memory is bounded, not unbounded."
**That was wrong, and wrong in the direction that matters.** The rotation bounds
*retention time*; it does not bound *peak entry count*. `getClient()` does an
unconditional `this.current.set(key, client)` for every previously unseen key,
with no cardinality ceiling and no heap check. So within a single window an
attacker sending one request each from N distinct addresses adds N entries.

At roughly 150-200 bytes per entry (Map overhead + key string + `{totalHits,
resetTime}`), one million distinct keys is on the order of 200 MB, and two maps
are live at once. **The scenario that produces it is precisely the gross-abuse
flood this limiter exists to backstop** — and IPv6 makes distinct `/56` keys
cheap for anyone with a real allocation. The failure is worse than the load that
causes it: a transient flood becomes an out-of-memory **crash**, and a crash is
persistent where the flood was not.

The proposed memory test would not have caught this either. It asserted entries
return to ~0 after traffic stops, which measures the rotation — the thing that
already worked — and never measures the peak.

**Fix: a bounded store, which is ~10 lines and reintroduces none of the
DB-backed store's problems.** `GlobalRateLimitStore` wraps the same two-map
rotation with a hard entry cap:

```ts
const MAX_TRACKED_KEYS = 100_000;   // total across BOTH maps

// The budget applies to current.size + previous.size, and eviction takes the
// true oldest across both — draining `previous` before `current`, since every
// entry in `previous` is older than every entry in `current` by construction.
//
// Capping `current` alone was the round-16 finding: `previous` holds up to a
// full window's keys at the same time, so a per-map cap admits ~2× the budget
// and §4's "never exceeds the cap" assertion could not have passed. JS Map is
// insertion-ordered, so the eviction itself stays O(1).
while (this.current.size + this.previous.size >= MAX_TRACKED_KEYS) {
  const victim = this.previous.size > 0 ? this.previous : this.current;
  victim.delete(victim.keys().next().value);
}
```

**One subtlety worth stating, since insertion order is not last-seen order.**
`getClient` promotes a key found in `previous` into `current` by re-inserting it,
so a long-lived caller keeps moving to the back of the queue and is evicted late
— which is the behavior we want. But a key that is *only* read (never
re-inserted) keeps its original position. That makes this FIFO-by-insertion
rather than a true LRU. The distinction doesn't matter here: eviction only
happens under a flood, and under a flood the entries being evicted are the
attacker's own by sheer volume.

**Why this is not a return to custom-Store territory.** What made the DB-backed
Store dangerous was **I/O on the hot path**: connections to exhaust, queries to
hang, failures needing a policy. This has none of that — it is a map insert with
an eviction branch. Its only new behavior is eviction, and **eviction fails
safe**: an evicted key's counter resets, so that caller gets a *looser* limit for
one window. It can never produce a wrongful 429 and never crashes the process.
An attacker can use eviction to reset their own counter, which is the same
outcome as the OOM it replaces, minus the outage.

**On the number itself.** I wrote that 100,000 is "far above any plausible count
of distinct legitimate addresses," and round 16 correctly pushed back that this
is unsupported — I have no production distinct-key measurement, and I'd tied the
cap to no explicit heap budget. Both halves of what makes a number defensible
were missing, and this plan has already been caught twice picking figures that
sounded reasonable.

What I can establish from here, stated as the basis rather than dressed up as a
derivation:

- **The heap side is computable.** ~150-200 bytes per entry × 100,000 total
  (the cap now spans both maps) ≈ **15-20 MB**, a fixed worst case rather than
  an estimate. That is the number to check against the deployment's memory
  budget.
- **The traffic side I cannot measure from here.** Distinct client addresses per
  instance per minute is a production quantity, and this environment has no
  access to it.

So the implementation step **must** record the observed figure before the cap is
final: instrument peak `current.size + previous.size` per instance for a normal
traffic period, then set the cap at a stated multiple of the observed peak,
bounded by the heap budget. If the observed peak turns out to be anywhere near
100,000, the number is wrong and the eviction policy needs to be revisited, not
just the constant. §4's "normal traffic never evicts" becomes a real acceptance
condition at that point instead of an assumption.

Until that measurement exists, **100,000 is a placeholder with a known heap cost
and an unknown safety margin** — which is a weaker statement than the one it
replaces, and the accurate one.

**The residual, stated rather than engineered around:** an attacker with enough
distinct source addresses can cycle the table and evade this backstop entirely.
That is inherent to per-IP limiting and equally true of the DB-backed design
(where it produced unbounded *rows* instead of unbounded heap). A limiter keyed
on IP cannot defend against an attacker who has many IPs; the narrow per-feature
limiters, which key on user and endpoint too, are what cover that case.

**`passOnStoreError` is irrelevant here** and is left at its default. It exists
to decide what happens when a store throws; the store above does a map lookup,
an integer increment and at most one eviction, with no I/O and nothing to fail.
The entire failure-policy question that consumed rounds 9-14 does not arise,
because there is no failure to have a policy about.

**CodeQL note:** the 213→0 proof used the default store, and this plan supplies
a custom one. The query models the `rateLimit()` call and its mount, not the
store — but that is an assumption, not a proof, so §4's local re-scan is what
actually confirms it. If a custom store were to break the model, falling back to
the stock `MemoryStore` is a one-line change and the cardinality risk returns as
a documented operational limit.

Rejected: `@acpr/rate-limit-postgresql` and a DB-backed `Store` — see §5.

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
// Crossing the ceiling is not a slow page: the video poller throws on a non-OK
// response and MAX_CONSECUTIVE_ERRORS = 5 (:127) marks a still-running job
// **failed**, so 2.5 seconds of 429s destroys in-flight generations for
// everyone behind that IP.
//
// I first called that a pre-existing defect and deferred it to §6. THAT WAS
// WRONG (round-15 finding, P1): `routes/videoJobs.ts:147` and
// `routes/pulidJobs.ts:386` have NO rate limiter today — verified, no
// createRateLimiter and no checkSharedRateLimit anywhere in either file. Those
// polls cannot receive a 429 until this plan mounts one. So this change does
// not merely inherit the defect, it CREATES the path that triggers it, and the
// client fix belongs in this change. See §2's retryable-response section.
//
// Derivation:
//   50 concurrent polling jobs behind one IP × 120 req/min   = 6,000
//   ordinary browsing by those same 50 users, ~60 req/min ea = 3,000
//   → 9,000, ×1.33 margin                                   ≈ 12,000/min
// These live in rateLimit.ts and are IMPORTED here — not redeclared (round-16
// finding). An earlier revision declared them inline in app.ts while §3 said
// they'd go beside the existing RATE_WINDOW_MS / RATE_MAX, which is two sources
// that can drift; and `parsePositiveInt` is private to that module anyway, so
// the inline version wouldn't have compiled. rateLimit.ts exports
// `createGlobalLimiter(overrides?)` — one factory, one source of truth, and the
// seam §4's tests use so the test and the mounted middleware cannot disagree
// about the ceiling.

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

// createGlobalLimiter() lives in rateLimit.ts and returns exactly this:
const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  limit: GLOBAL_RATE_MAX,
  // MOUNTING THE BOUNDED STORE IS NOT OPTIONAL (round-16 finding, P1). An
  // earlier revision specified the store in §1 and then omitted this line, so
  // implementing the plan literally would have selected the package's default
  // unbounded MemoryStore and left the entire eviction mechanism as dead code —
  // reopening the exact OOM path the round-15 revision existed to close. §4's
  // peak-cardinality test therefore exercises THIS limiter, not the store class
  // in isolation, so the two can never diverge again.
  store: new BoundedMemoryStore(MAX_TRACKED_KEYS),
  keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isExemptRequest(req),
  handler: (req, res) => {
    // See the log-volume note below: this helper is throttled, but it is not
    // the only line a rejected request produces.
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
- **Log volume needs the request logger handled too, not just my helper**
  (round-16 finding). Throttling `logBlockedThrottled` to ≤1 line/sec/process
  bounds *that* line — but `pinoHttp` is mounted at `app.ts:84-143`, ahead of
  CORS and this limiter, and emits a `logger.info()` on **every** response
  completion including each 429. So a sustained flood still produces one log
  line per rejected request no matter what my helper does. The plan therefore
  specifies suppression/sampling of limiter-429 completion logs in the
  `pinoHttp` config, and §4's burst assertion counts **total logger output**
  rather than calls to the new helper — the narrower assertion would have
  passed while the unbounded stream continued.

### A 429 must not destroy in-flight work (round-15 finding, P1)

Because this plan creates the polling routes' first 429 path, it also owns the
consequence. `GodModeLoadingTakeover.tsx:129-166` increments one
consecutive-error counter on **any** non-OK poll response and, at
`MAX_CONSECUTIVE_ERRORS = 5`, moves a still-running job to terminal `failed`.

The fix has to start one layer below the component. `Step2Video.tsx:514-521`
owns the fetch and reduces every failure to ``new Error(`poll: ${res.status}`)``
— the status survives only inside a message string and all headers are
discarded, so the takeover has nothing to branch on and no `Retry-After` to
honor. A fix written only in the component would be unimplementable, or
implemented by string-matching an error message.

So the poll API returns a **typed retry classification** rather than a bare
error, and the takeover backs off on retryable responses without incrementing
the terminal counter. Two properties that must both hold, because they pull in
opposite directions:

- **Only a limiter response is indefinitely retryable**, identified by
  **status `429`** (optionally corroborated by the limiter's own
  `RateLimit-*` headers) — **not** by the presence of `Retry-After`
  (round-16 finding). A persistent generic `503` may legitimately carry
  `Retry-After`, and treating that as retryable reopens the endless-loading-
  screen failure on the other side of the boundary this section claims to hold.
  Worse, the test I'd specified could have passed while the hole existed, simply
  because its 503 fixture omitted the header.
- A **persistent generic failure** still terminates via the existing five-error
  path. Blanket-retrying every 5xx would trade "kills live jobs" for "endless
  loading screen on a dead upstream," which is not an improvement.

`PulidLoadingTakeover.tsx` needs the mirror-image change: it has no terminal
counter at all and retries forever, so it gets the classification for its
back-off behavior rather than to prevent a false terminal state.

### What per-instance counting means, stated plainly

`MemoryStore.localKeys = true`: each autoscale instance counts independently, so
one IP's effective allowance is up to `instances × 12,000/min` rather than
12,000/min, depending on how the load balancer spreads that IP's requests.

An earlier revision said this loosens the ceiling by "a single-digit multiple."
**That figure was unsupported and is withdrawn** (round-15 finding):
`.replit:9-11` selects autoscale with **no maximum instance count**, so there is
no number to multiply by. The honest statement is that the fleet-wide allowance
for one IP is `instances × 12,000/min` with `instances` unbounded above, and no
load-balancer affinity guarantee that would concentrate one IP on one instance.

Stated without varnish: **this limiter provides CodeQL compliance and a
per-instance abuse ceiling. It does not provide a bounded fleet-wide abuse
ceiling.** That is a real limitation and it should not be sold as anything else.

Why it is nonetheless the right call here:

- The existing narrow limiters are DB-backed, fleet-correct, key on user and
  endpoint as well as IP, and are completely untouched by this plan. **But they
  cover far less of the API than I claimed** (round-16 finding, and the most
  consequential thing this whole loop has surfaced). Counted directly: **6 of 31
  route files** contain any limiter — `facts.ts`, `reviews.ts`, `admin.ts`,
  `adminTaxonomyHealth.ts`, `ai.ts`, `localAuth.ts` — and the 30/min
  `createRateLimiter()` is *instantiated inside `ai.ts`*, not applied API-wide.

  So "the narrow limiters are what actually stops abuse" is true for those six
  and **false for the other twenty-five**, which have no rate limiting of any
  kind today. That inverts this plan's framing rather than qualifying it: for
  most of this API the middleware is **not a backstop behind real protection —
  it is the first and only rate limiting those routes will ever have had.**

  Two consequences, both stated rather than smoothed over. It makes the change
  considerably more valuable than "CodeQL compliance." And it makes the
  unbounded-fleet limitation above matter *more*, because for twenty-five route
  files there is no fleet-correct layer underneath it. §7 puts this to David as
  a product question instead of settling it here.
- **The derivation is unaffected**, because it was always the worst case: all of
  one IP's traffic arriving at one instance. Per-instance counting can only make
  the effective ceiling *looser*, never tighter, so no legitimate user is
  throttled by this choice.
- The alternative that would fix it is fleet-wide shared state on the hot path
  of every request, which is exactly what rounds 4-14 spent fourteen review
  rounds failing to make safe on Postgres.

**What would make this bound real, if it ever needs to be:** an enforced
autoscale instance cap — which §6 item 4 already requires for an unrelated
reason (the connection budget depends on the same missing number). Once that
number exists and is enforced, the fleet-wide ceiling becomes `cap × 12,000` and
is quantifiable. Until then this section claims nothing about it.

If genuine fleet-wide counting is ever needed, the answer is a shared counter in
a store built for hot-path reads and writes — a different project with a
different justification, not a variation on this one.

## 3. Files touched

- `artifacts/api-server/package.json` + regenerated root `pnpm-lock.yaml` — add
  `express-rate-limit`.
- `artifacts/api-server/src/lib/rateLimit.ts` — add `GLOBAL_RATE_WINDOW_MS` /
  `GLOBAL_RATE_MAX` beside the existing `RATE_WINDOW_MS` / `RATE_MAX`, one place
  to look.
- `artifacts/api-server/src/lib/globalRateLimitStore.ts` — new, and *small*: the
  two-map rotation with a `MAX_TRACKED_KEYS` cap and oldest-first eviction. No
  I/O, no pool, no shutdown hook (the interval is `unref()`'d).
- **The polling-client fix, which this plan creates the need for** (round-15
  finding — these routes have no limiter today, so this change introduces their
  429 path):
  - `.../wizard/step2-video/Step2Video.tsx` — the poll API returns a typed retry
    classification instead of collapsing every failure into a status-only
    `Error`; status and `Retry-After` survive to the caller.
  - `.../wizard/step2-video/GodModeLoadingTakeover.tsx` — retryable responses
    back off without incrementing the terminal-failure counter; persistent
    generic failures still terminate.
  - `.../wizard/step2-image/PulidLoadingTakeover.tsx` — same classification,
    used for back-off (it has no terminal counter to protect).
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
2. **Integration tests against the real `app`,** with an injected low limit.
   **The injection needs an explicit seam, not an environment variable**
   (round-15 finding): `run-tests-sharded.sh` runs each shard with
   `--test-isolation=none`, `csrf.integration.test.ts:8` already imports the
   singleton `app`, and the limiter is constructed once at module evaluation. If
   another file in the same shard imports `app` first, setting
   `GLOBAL_RATE_MAX` in the new file changes nothing and the result depends on
   shard assignment and file order — a test that passes or fails by luck.

   **"A factory or an equivalent reset seam" was still underspecified**
   (round-16 finding, and the same defect as the compressed Stripe queue item:
   a description an implementer can satisfy while leaving the problem intact).
   A *reset* seam would make the imported-first case pass by mutating the
   module-cached singleton — and then leak the low limit and its store into
   every file executed afterward in the same shard. So the requirement is
   specific: an **instance-scoped factory** — `createApp()` / `createGlobalLimiter()`
   returning a fresh instance the test owns, with no mutation of the singleton.
   If a reset seam is used instead, it carries an explicit restoration contract
   with teardown. §4 tests **both orders**: the low-limit case with the real
   `app` imported first, *and* a default-ceiling case running after it, so
   neither execution order can share injected state. Cases:
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
4. **Memory behavior — peak, not just reclamation** (round-15 finding: the
   original version of this case measured only the part that already worked):
   - Drive traffic from **more than `MAX_TRACKED_KEYS` distinct keys** and
     assert the entry count never exceeds the cap and peak heap stays bounded.
     This is the case that fails if the cap is ever removed.
   - Assert **eviction is FIFO and fails safe**: an evicted key's next request
     is allowed (counter reset), never wrongly blocked.
   - Assert normal traffic volumes **never evict**, so the cap cannot silently
     become a de-facto limit on legitimate users.
   - Then the reclamation half: entry count returns to ~0 within two windows of
     traffic stopping, and the process holds no timer preventing exit.
4b. **The polling client, which this plan newly exposes to 429s:** five
   consecutive limiter 429s to a running video job leave it running and it
   recovers on the sixth; a **persistent generic 5xx still terminates** via the
   existing five-error path. Both, because the fix is only correct if it
   distinguishes them.
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

**Ordering (David, 2026-08-04).** Item 4 — the unenforced autoscale instance cap
— **goes first**, ahead of the user-visible bugs, per §7's decision: with 25 of
31 route files having no other rate limiting, the fleet-wide bound is what makes
this middleware mean anything, and it is currently unbounded. Then items 1-3 (the
user-visible ones, in that order), then 5 and 6. Item 6 is last but is the only
one that **worsens with time** — `rate_limit_counters` gains rows every day —
so it should not be allowed to sit indefinitely.

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
   so only the current generation may publish, **and rejection cleanup**
   (round-16 finding — I specified this for item 3 and omitted it here, in the
   same document): a stored promise that rejects once during a transient
   database failure and is never cleared makes every config reader await that
   rejection until restart, so every getter falls back to its default —
   including `isLiveMode()` silently selecting **test mode** on a live
   deployment. Clearing must not clobber a newer generation's replacement.
   Acceptance: a failed load followed by a successful retry, matching item 3's.
3. **`getStripeSync()` is not mode-scoped or rejection-safe.** `stripeClient.ts:102-107`.
   **The full remedy is recorded here deliberately** (round-15 finding: an
   earlier version of this entry compressed it to "single-flight it," and a
   later bugfix following that description could add one global promise and
   still ship three of the four defects):
   - *Concurrent construction.* No single-flight, so concurrent misses each run
     `buildStripeSync()` — extra `StripeSync` instances **and** extra pg pools
     (`:96`, `max: 2`), which also breaks item 4's arithmetic.
   - *Superseded publication.* A `stripe_live_mode` flip mid-flight lets an
     old-mode build publish **after** `invalidateStripeSync()`. The flight must
     be **generation- and mode-scoped**, and a completion whose generation is no
     longer current must be discarded rather than stored.
   - *Mixed-mode credentials.* `buildStripeSync()` re-reads the mode
     independently for the secret key and the webhook secret rather than using
     the mode captured at `getStripeSync()` entry — so a flip landing between
     those reads yields a live key with a test webhook secret, or the reverse.
     The captured mode must be threaded through **all** credential resolution.
     This one exists today independent of any single-flight.
   - *Rejection poisoning.* A stored promise that rejected and is never cleared
     fails every later webhook until restart. A rejected flight must be cleared.
   - *Pool leakage on disposal* (round-16 finding — discarding a superseded
     completion prevents stale *publication* but does not dispose of what it
     built). In installed `stripe-replit-sync@1.0.0` the `StripeSync`
     constructor creates a `PostgresClient`, whose constructor creates a
     `pg.Pool`. So every superseded completion **and** every instance dropped by
     the existing `invalidateStripeSync()` leaks two connections. Repeated mode
     flips therefore leak steadily and invalidate item 4's arithmetic. Both
     paths need lifecycle-safe draining (`postgresClient.pool.end()`), which
     means "discard" is the wrong verb throughout this item — it is *dispose*.
   - **Acceptance matrix:** a delayed mid-flight mode flip; a construction
     failure followed by a successful retry; and **repeated flips returning the
     live pool count to one**. All three, or the fix is not done.
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
6. **`rate_limit_counters` has no production cleanup at all.**
   `purgeExpiredRateLimitCounters()` (`sharedRateLimiter.ts:83-85`) is one
   unbounded `DELETE` and nothing calls it. An earlier version of this entry
   offered "or delete it" as an equally acceptable outcome — **that was wrong**
   (round-15 finding): `checkSharedRateLimit` (`:44-68`) inserts a persistent row
   for every new endpoint/IP/user/email key, so deleting the helper would leave
   the table growing without limit and merely remove the evidence. The required
   outcome is **real retention**: wire up deletion with a bounded statement
   **and** a bounded whole-run budget with rescheduling, and test that expired
   rows from a high-cardinality backlog are eventually removed without one run
   monopolizing the pool.

   Note this is a **pre-existing** gap that this plan does not touch — the
   reduced design writes no rows — but it is the one queue item that gets worse
   with time rather than staying static.

Items 1-3 are user-visible or correctness bugs and should go first. Items 4-6 are
latent.

## 7. Decisions and open questions

**1. DECIDED (David, 2026-08-04): ship this plan as written, and reprioritize
the queue.** Round 16 established that six of thirty-one route files carry a
limiter and the other twenty-five have none — so for most of the API this
middleware is not a backstop, it is the first rate limiting those routes will
ever have had. David's call was that this does not change the plan, but it does
change two things around it:

- **This is worth more than "clear a CodeQL alert"** and should be described
  that way rather than as compliance work.
- **§6 item 4 — the unenforced autoscale instance cap — is promoted to the head
  of the queue.** Per-instance counting matters considerably more when nothing
  fleet-correct sits underneath it, and that cap is the one change that turns
  §2's unbounded fleet-wide allowance into a quantifiable `cap × 12,000`. It is
  no longer fifth behind three user-visible bugs; see §6's ordering note.

The rejected alternative, recorded so it isn't re-proposed: adding per-route
limiters to the uncovered twenty-five *before* shipping this. That is a much
larger piece of work and it is the fleet-correct DB-backed path that consumed
rounds 4-14. Coverage is a separate roadmap item, not a precondition.

**2. Does `/api/admin/*` sit behind this ceiling?** It does by default, since the
limiter mounts at `/api`. `current-roadmap.md:280-288` records this as a pending
decision, so this plan flags it rather than settling it silently — the sharp edge
is gone, since with a code-constant ceiling there is no admin endpoint whose
throttling could lock an operator out of fixing the throttle. Admin routes behind
12,000/min per IP is unremarkable, so **the recommendation is to leave them
covered** and close the roadmap item.
