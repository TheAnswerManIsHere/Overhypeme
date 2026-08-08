# Deferred Engineering Work

The single, durable home for engineering, security-hygiene, and maintenance
work we have **consciously chosen not to do yet** — dependency bumps we've
parked, deprecations we're carrying, cleanup we've postponed, toolchain debt.

This doc exists so that deferred work is **visible and revisited on a
schedule**, not lost in a chat or an inline `// TODO`. It is equally a record
that a deferral was a *deliberate, reasoned decision* — an item here with a
revisit condition that hasn't fired yet is **correctly parked, not debt we're
ignoring**. We don't chase an idealized codebase; we defer on purpose and act
when the trigger says to.

**Scope: engineering only.** Deferred *product/feature* work lives in
[`current-roadmap.md`](../ai-context/current-roadmap.md#explicitly-deferred-work)
— not here. If an item is "a feature we haven't built," it belongs in the
roadmap; if it's "maintenance/security/cleanup on code we've already shipped,"
it belongs here.

## How this doc works

**Every entry carries four things** — keep them, or the list rots into a
graveyard or a guilt-trip:

1. **What** — the deferred change, in one line.
2. **Why deferred now** — the honest "not worth it yet." This is the
   anti-perfectionism guardrail: it's permission to wait.
3. **Cost of waiting** — what we're accepting, and whether it grows.
4. **Revisit trigger** — a *condition*, never "someday." A dated event, a
   dependency shipping a fix, a recurrence count, a launch gate, or a
   named ritual (weekly maintenance / quarterly security review).

**Items get on the list** from: PRs we park (like a broken Dependabot bump),
major-version bumps we hold, Codex review findings we consciously defer,
deferred `/bugfix` items that are really tech debt, and deprecations spotted
in CI or lockfiles.

**Items come off the list** when done, or when we consciously mark them
*won't-do* (with the reason). Don't delete silently — a removed entry should
be traceable to "shipped" or "decided against."

**Triage cadence — no new ritual.** The weekly
[`/maintenance`](../../.claude/skills/maintenance/SKILL.md) pass re-reads this
doc and re-checks each revisit trigger; anything that has fired gets surfaced
to David. The quarterly `/security-review` consults the **Security & patching**
section. That keeps the backlog proactive without inventing overhead.

---

## Security & patching

Proactive security and patching deferrals — bumps held for a reason, hardening
we've sequenced for later.

- **sharp / esbuild bumps parked (PR #243).** See
  [Dependencies & toolchain](#dependencies--toolchain) below — the sharp 0.35
  hold has a security dimension (we're declining a patch-eligible bump), so the
  quarterly security review should re-check whether a CVE has landed on the
  0.34.x line we're staying on.

- **`rate_limit_counters` has no production cleanup — PII- and session-token-retention gap, not just table growth.** See the
  [Code-level tech debt](#code-level-tech-debt) entry below for the full
  detail: every row `checkSharedRateLimit` writes carries the raw IP, user
  id, and sometimes a normalized recipient email, with no purge ever wired
  up — and for both `createRateLimiter`- and `createFactSubmitRateLimiter`-
  backed routes (including fact submission in `reviews.ts`), "user id" is
  the actual session token. Left in Code-level tech debt (grouped with the sibling
  `adminConfig`/`getStripeSync` entries from the same review), but flagged
  here so the quarterly `/security-review` — which otherwise only reads this
  section — doesn't miss it.

- **The autoscale connection budget is unenforced and slightly wrong (found on PR #299's review, deferred by PR #308).**
  - **What.** `.replit` selects `deploymentTarget = "autoscale"` with no
    maximum instance count, so `lib/db/src/index.ts:45-67`'s "safe up to 19
    instances" comment cannot actually fail if violated. It also omits the
    `StripeSync` pool's `max: 2` from the per-instance total, making the real
    per-instance total 22 (not 19) and the honest ceiling
    `floor(398 / 22) = 18`, not the assumed 19.
  - **Why deferred now.** Pre-existing on `main`; same provenance as the
    `adminConfig`/`getStripeSync`/`rate_limit_counters` entries in
    [Code-level tech debt](#code-level-tech-debt) below — all five surfaced on
    the same 16-round review of the plan that became PR #308. Prioritized
    **first** among these five by David's 2026-08-04 ordering decision — with
    most of this API's route files having had no other rate limiting before
    PR #308's global backstop, an unbounded per-instance ceiling multiplied by
    an unbounded instance count is the one item that determines whether that
    backstop means anything fleet-wide.
  - **Cost of waiting.** The global rate-limiter's advertised per-IP ceiling
    (12,000/min) is a **per-instance** number with no fleet-wide bound — see
    the 2026-08-04 `decisions.md` entry's "accepted trade-off" note. The DB
    connection budget is also silently thinner than the code comment claims.
  - **Revisit trigger.** Either a deployment-level instance cap is configured,
    or a boot-validated instance-count input is added to derive `DB_POOL_MAX`
    correctly (including the `StripeSync` pool's connections). Should land
    before scaling autoscale usage materially.

- **`IP_HASH_SALT` can silently fall back in production (found on PR #299's review, deferred by PR #308).**
  - **What.** `hashIp` falls back to a repository-known string when the salt
    env var is missing or under 16 characters, logged only as a WARN. PR
    #308's own rate limiter doesn't hash IPs, but `transientRenderLog.ts`'s
    existing usage still does, so this fallback remains live.
  - **Why deferred now.** Pre-existing on `main`; same provenance as the
    autoscale entry above.
  - **Cost of waiting.** In production with a missing/weak salt, IP hashes in
    `transientRenderLog` would use a value anyone with repo access can derive
    — defeating the point of hashing — with only a WARN log as the signal.
  - **Revisit trigger.** Next security-focused pass, or the quarterly security
    review. Fix is a boot assertion on the canonical production predicate
    (`REPLIT_DEPLOYMENT === "1" || NODE_ENV === "production"`), tested on
    **both** branches of that `||`.

**Security follow-ups from the C5/C9 review.** Lower-risk hardening the
security review consciously deferred. Full context lives in
[`security-model.md`](../ai-context/security-model.md#deliberately-out-of-scope--deferred);
re-gather it when the work is scheduled.

- **CSP: Report-Only → enforcing.**
  - **Why deferred.** Flipping to enforcing before UAT confirms zero violations
    risks breaking real page loads.
  - **Cost of waiting.** CSP is observe-only until flipped — it reports but
    doesn't block.
  - **Revisit trigger.** UAT confirms zero CSP violations in Report-Only.

- **HSTS `includeSubDomains` / `preload`.**
  - **Why deferred.** Asserting these before every `*.overhype.me` subdomain is
    HTTPS-only would strand any non-HTTPS subdomain.
  - **Cost of waiting.** Slightly weaker transport guarantee at the subdomain
    edge.
  - **Revisit trigger.** All `*.overhype.me` subdomains are HTTPS.

- **`ADMIN_API_KEY` scoping + `confirm`/`limit` gates on the API-key backfill launchers.**
  - **Why deferred.** The backfill-launcher gates depend on the `ADMIN_API_KEY`
    scoping decision, which isn't made yet.
  - **Cost of waiting.** Backfill launchers lack a belt-and-suspenders
    confirm/limit guard (they are admin-gated already).
  - **Revisit trigger.** The `ADMIN_API_KEY` scoping decision is made — then
    wire the gates.

- **Admin field-length validation tidying.**
  - **Why deferred.** Cleanup, not a live risk; validation exists, this is
    tightening bounds.
  - **Cost of waiting.** Minimal.
  - **Revisit trigger.** Next time we touch admin input validation, or a
    quarterly security pass judges it due.

- **Git-history purge of the removed prod dump.**
  - **Why deferred / won't-do-leaning.** Destructive history rewrite; **secret
    rotation is the real mitigation** and is the primary control. The purge is
    cosmetic cleanup on top of that.
  - **Cost of waiting.** None once rotation is confirmed — the dump's secrets
    are dead.
  - **Revisit trigger.** Only if rotation is ever found incomplete; otherwise
    leave as won't-do.

## Dependencies & toolchain

- **sharp 0.34.5 → 0.35.0 (and esbuild 0.27.3 → 0.28.1) — parked from PR #243.**
  - **What.** A Dependabot `npm_and_yarn` group bump raising sharp to 0.35.0
    and esbuild to 0.28.1.
  - **Why deferred now.** sharp 0.35 is a 0.x "minor" but effectively a
    **major** (its release notes list ~8 `Breaking:` items). It breaks `tsc`
    with `TS7016` across all our sharp consumers — sharp repackaged its
    `exports` map and its `.d.ts` no longer resolves under our
    `moduleResolution: "bundler"`. It also raises the Node floor to
    **≥ 20.9.0**. sharp is core to the **visual pipeline** (high-risk per the
    tier table), so it deserves a deliberate upgrade with UAT, not a drive-by
    group bump. Our code does **not** call any of the removed sharp APIs
    (`failOnError`, `format.jp2k`, `paletteBitDepth`), so the break is
    packaging/typings, not API usage.
  - **Cost of waiting.** Real, not zero — sharp 0.34.5 **does** carry a known
    CVE: it inherits vulnerabilities from its bundled libvips (four CVEs incl.
    [GHSA-f88m-g3jw-g9cj](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj),
    High), fixed by the libvips 8.18.3 bump that ships with sharp ≥0.35.0.
    sharp is a **direct** dependency (`artifacts/api-server/package.json`),
    confirmed via a Dependabot alert triage on 2026-07-24 (see
    [`decisions.md`](../ai-context/decisions.md#2026-07-24--dependabot-alert-triage-found-the-safe-patch-bumps-parked-in-pr-243-were-actually-9-disclosed-cves-including-a-sql-injection-in-the-production-orm)
    and [`known-failure-patterns.md`](../ai-context/known-failure-patterns.md#security-relevant-dependency-claims-written-from-assumption-not-verification)
    — this line originally, and wrongly, claimed "no known CVE"). Grows if a
    further advisory lands on the 0.34.x line, or if we need a 0.35-only
    feature.
  - **Update (2026-07-24).** The typings-resolution bug is already fixed —
    sharp v0.35.1 (2026-06-11) shipped "Ensure type definitions are published
    for both ESM and CJS" ([#4537](https://github.com/lovell/sharp/issues/4537),
    per the [v0.35.1 changelog](https://sharp.pixelplumbing.com/changelog/v0.35.1/)).
    That leg of the original trigger has fired — noted here so it isn't
    re-discovered as a fresh trigger — but it isn't sufficient on its own: the
    breaking-change surface and the Node ≥ 20.9.0 floor are still real, so this
    stays parked pending a deliberate visual-pipeline upgrade. If/when we pick
    this up, target **0.35.1+**, not raw 0.35.0.
  - **Revisit trigger.** ~~A security advisory hits 0.34.x~~ — **already
    fired** (see Cost of waiting above: the libvips-inherited CVEs are a
    known, accepted risk while this stays parked, not an open trigger
    anymore). The only remaining gate: we schedule a visual-pipeline
    dependency upgrade with UAT (Opus-tier).
  - **Update (2026-07-24, continued).** The other three bumps bundled in #243
    (drizzle-orm 0.45.2, vite 7.3.6, postcss 8.5.12) turned out **not** to be
    generic hygiene — a Dependabot triage of the repo's open alerts found they
    fix four disclosed High-severity CVEs, including a **SQL injection in
    drizzle-orm** (our direct production ORM). Split out into **PR #246**
    rather than waiting on sharp or the next Dependabot cycle.
    **Status: PR #246 merged (squash commit `27277ff`).** drizzle-orm/vite/
    postcss/fast-uri are fully resolved on `main`. **esbuild is only
    *partially* resolved** — #246 patched `artifacts/api-server`'s own
    **direct** esbuild devDependency (0.28.1, closing the alert anchored to
    that manifest), but `esbuild@0.27.3` (the CVE-affected version) is still
    resolved on `main` for three transitive consumers: `tsx`, `@orval/core`,
    and `wrangler` (confirmed via `pnpm-lock.yaml`). The underlying CVE
    ([GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr))
    is specifically about esbuild's **dev-server** feature — `tsx`/`@orval/core`
    don't invoke it (pure transpile/codegen use), `wrangler dev` plausibly
    could, so that's the one instance worth more scrutiny, not just noting.
    None of these three has its own package.json declaring esbuild directly
    in this repo (all pull it in as *their own* transitive dependency), so
    there's no direct-specifier fix available the way there was for
    api-server — bumping would mean waiting on `tsx`/`@orval/core`/`wrangler`
    to bump their own esbuild pin, or a workspace override (same mechanism as
    the `fast-uri` fix in #246 — see
    [`pnpm-override-scope-and-application.md`](../../.agents/memory/pnpm-override-scope-and-application.md)
    for the gotchas that surfaces). See #246 for the full CVE list and
    verification of what **is** resolved.
  - **Revisit trigger (esbuild specifically).** `tsx`, `@orval/core`, or
    `wrangler` ship a release pinning esbuild ≥0.28.1, **or** we force it via
    a workspace override and verify no breakage — whichever comes first.

- **~40 lower-severity Dependabot alerts — not yet individually triaged. OPEN QUESTION, not closed.**
  - **What.** Of the repo's 54 open Dependabot alerts as of 2026-07-24, 9 CVEs
    across 5 packages were triaged and fixed (PR #246, see above). The
    remaining ~40 (mostly Moderate/Low) are still untriaged individually —
    lodash, ws, undici, picomatch, brace-expansion, path-to-regexp, js-yaml,
    linkify-it, qs, uuid, markdown-it, and others, mostly transitive
    ReDoS/DoS-class findings in build tooling rather than a production
    request path.
  - **Why deferred now.** The 9 confirmed, high-value CVEs (incl. a SQL
    injection in the production ORM) were prioritized first. Real severity of
    the remaining ~40 is unqualified — none has been individually checked
    against our actual exposure the way the 9 were.
  - **Cost of waiting.** Unknown until triaged — that's the open question, not
    a settled "low" like the other entries here.
  - **Revisit trigger.** Not a one-time fired condition — this is a **standing
    open question for David**: whether to triage individually (thorough, slow)
    or accept them as one grouped backlog entry with a sweep-based approach
    (`pnpm update` + re-check, opportunistic). Surface as an open decision item
    every `/maintenance` pass until David decides; once decided, replace this
    entry with the actual outcome (either N individually-triaged entries, or
    one grouped entry with its own trigger).

- **recharts v2 → v3.**
  - **What.** recharts is pinned at `^2.15.x` in `artifacts/overhype-me` and
    `artifacts/mockup-sandbox`. recharts 1.x/2.x are end-of-life ("no longer
    active — bump to v3," per the v3 migration guide flagged in the lockfile).
  - **Why deferred now.** v3 is a major with a migration guide; charts work
    today; not worth a migration mid-flight.
  - **Cost of waiting.** No further bugfixes or security patches on the v2 line.
  - **Revisit trigger.** Next time we do meaningful charts work, or a security
    advisory on recharts v2, or the weekly maintenance sweep judges it overdue.

## Code-level tech debt

- **Async-queue enqueue-side status write isn't transactional with `enqueueJob` (PR #256).**
  - **What.** `factPexelsJobs.ts`'s `enqueueFactPexels` and
    `aiMemeBackfillJobs.ts`'s `enqueueFactAiMemeBackfill` each write the
    fact's status field to `"pending"` (or a handler writes a terminal value)
    as a separate statement from the `enqueueJob` insert/dedupe call — the two
    aren't composed inside one transaction. Two related races follow: (1) a
    late enqueue landing between a handler's terminal-marker write and its
    `async_jobs` row's finalization can reset the marker back to `"pending"`
    and then dedupe onto the still-`processing` row, which never repairs it;
    (2) `factPexelsJobs.ts`'s 1s post-success pacing sleep widens that same
    window further. In both cases the underlying `pexelsImages`/`aiMemeImages`
    data is unaffected — only the status marker can go stale.
  - **Why deferred now.** Closing this needs `enqueueJob`'s dedupe-conflict
    recovery to compose inside a caller-managed transaction, which it doesn't
    support today — a real fix is a small piece of `asyncJobs.ts` transaction
    hardening, not a one-line change in either queue file.
  - **Cost of waiting.** A rare concurrent-enqueue race can leave a fact's
    Pexels/AI-meme status display stuck at "pending" after the underlying job
    actually completed. No data loss; a moderator/admin can force a re-enqueue
    to clear it.
  - **Revisit trigger.** Next time `asyncJobs.ts`'s enqueue/dedupe machinery is
    touched for another reason, or this race is observed in production status
    data (not just theoretically), fold in transactional composition then.

- **Async-jobs reclaim finalize has no fencing token (PR #283).**
  - **What.** `processClaimedJob` finalizes a job by row id alone. Stuck-row
    recovery (`RECOVER_STUCK_CUTOFF_MIN`) reclaims a row once it's been
    `processing` past the cutoff, but nothing stops the *original* holder from
    still being alive and finishing after the reclaim — both runs execute and
    whichever finalizes last silently overwrites the other. PR #283 raised the
    cutoff (10 → 30 min) as an interim mitigation that narrows the race window;
    it does not close it.
  - **Why deferred now.** The real fix — lease tokens stamped at claim time and
    checked at finalize, so a stale run's finalize is a no-op instead of an
    overwrite — is Phase 3a of the async-queue hardening plan (surfaced during
    the review on PR #282) and is sequenced after the Phase 1 health-surface
    work that makes this race observable in production.
  - **Cost of waiting.** A genuinely concurrent reclaim (autoscale boot racing
    a slow in-flight handler) still causes silent double-execution — a
    duplicate send on the `email` queue, or a corrupted status marker on
    `fact_ai_meme_backfill` — just less often now that the window is narrower.
  - **Revisit trigger.** When Phase 3a (lease tokens + fenced finalize) lands,
    this entry closes and `RECOVER_STUCK_CUTOFF_MIN` stops being load-bearing.

- **`TODO(PR3-signature)` — `artifacts/api-server/src/lib/sendBackToReview.ts:151`.**
  - **What.** Rows are re-queued with `signature: null` because per-row
    processing signatures aren't stamped at send-back time; the comment defers
    stamping "at classify time once signatures land."
  - **Why deferred now.** Depends on signature work sequenced elsewhere; a null
    signature is handled correctly today.
  - **Cost of waiting.** Low.
  - **Revisit trigger.** When classify-time signature stamping lands — wire this
    in the same pass.

- **Stripe↔local membership reconciliation — the repair path for an event that
  never arrives (PR #287).**
  - **What.** Every Stripe event we *receive* is authoritative, fenced and
    idempotent, and duplicates and out-of-order deliveries are handled. What is
    missing is the job that discovers a discrepancy nothing told us about — a
    webhook Stripe never successfully delivers across its whole retry window.
    That user's entitlement stays whatever it was until the next event for the
    same subscription or payment happens to arrive.
  - **Why it bites in one direction only.** Access wrongly *lost* is repairable
    by hand — an admin grant restores it. Access wrongly *kept* is not: admin
    grant/revoke act on admin grants, so nothing on the admin surface can mark a
    stale Stripe subscription cancelled, or a purchase refunded or
    dispute-lost. That direction is the one that costs money.
  - **Why deferred now.** It was built and then pulled from PR #287 to narrow
    the PR (David, 2026-07-30). The machinery it needs — run lease with
    heartbeat, staged apply that re-verifies at apply time, the bounded
    downgrade guard, and a durable run record at both altitudes — is
    substantially more than the grace sweep that stayed, and it accounted for a
    large share of that PR's review findings.
  - **The known hard part, unsolved.** It cannot enumerate from local rows
    alone. A first purchase whose checkout webhook never landed has *no* local
    row to scan, so a subscription-row-driven sweep examines zero sources and
    never finds the paying customer who was never granted access. Closing that
    means enumerating from Stripe, which has no natural "list everything that
    might be ours" query — a design question, not an implementation one.
  - **Cost of waiting.** Real but bounded: it requires a webhook to fail for its
    entire retry window. Stated as an accepted limitation in
    `PR287_PAYMENTS_ENTITLEMENT_MODEL_UAT.md` and in `membershipSchedules.ts`'s
    header, so it is a known gap rather than a silent one.
  - **Revisit trigger.** The first time a real membership is observed out of
    step with Stripe with no explaining event — or before scaling paid signups
    materially, whichever comes first.
  - **Sequencing.** Blocked on PR #287 merging.

> The other inline marker, `TODO(version-rollback)` in
> `enrichmentVersioning.ts`, is **product** work (an unbuilt feature) and is
> tracked in the roadmap's deferred list, not here.

- **`adminConfig.loadAll()` has a cache stampede and a stale-fill race (found on PR #299's review, deferred by PR #308).**
  - **What.** `adminConfig.ts:32-39` checks `_cache`, awaits the query, then
    assigns, with no in-flight promise today — concurrent callers on an empty
    or just-expired cache each issue their own query (the stampede). Worse,
    `bustConfigCache()` can clear the cache while an older read is in flight;
    that read then repopulates it with pre-write rows for another ~60 seconds,
    which affects the immediate `stripe_live_mode` cache-bust/invalidate path
    at `routes/admin.ts:2881-2897`. **Forward-looking guardrail, not a current
    symptom:** today's code has no stored in-flight promise at all, so there's
    nothing to leak on a failed query — but any single-flight fix for the
    stampede must not introduce an unlogged failure mode of its own: a stored
    promise that rejects during a transient DB failure must be cleared, not
    cached, or every later config reader would await that same rejection until
    restart — every getter falling back to its default, including
    `isLiveMode()` silently selecting **test mode** on a live deployment.
  - **Why deferred now.** Pre-existing on `main`, not caused by PR #308's
    rate-limiter work — surfaced as a side finding during the 16-round review
    of the plan that became #308, deliberately kept rather than lost with the
    code it was found in, and queued for its own `/bugfix` PR per David's
    2026-08-04 decision.
  - **Cost of waiting.** Redundant concurrent config queries under load today.
    No rejection-poisoning risk exists yet (there's no single-flight to poison)
    — that's a pitfall to avoid *when* single-flight is added, not a present
    defect.
  - **Revisit trigger.** Next `/bugfix` pass through this area, or if
    stampede-driven query load is actually observed. Fix needs a single-flight
    with a **generation counter** (so only the current generation may publish)
    and rejection cleanup built in from the start (a rejected in-flight
    promise must be cleared, not cached) — not added later as a patch.

- **`getStripeSync()` is not mode-scoped or rejection-safe (found on PR #299's review, deferred by PR #308).**
  - **What.** `stripeClient.ts:120-126` (`getStripeSync()` itself; the cached
    module-level vars and `buildStripeSync()` start at `:103-107`), three
    current defects plus one forward-looking guardrail: (1) no single-flight,
    so concurrent misses each run `buildStripeSync()`, creating extra
    `StripeSync` instances **and** extra `pg.Pool`s; (2) a `stripe_live_mode`
    flip mid-flight lets an old-mode build publish *after*
    `invalidateStripeSync()` — the flight must be generation- **and**
    mode-scoped, discarding a completion whose generation is no longer
    current; (3) `buildStripeSync()` re-reads the mode independently for the
    secret key and the webhook secret rather than using the mode captured at
    entry, so a flip landing between those reads can yield a live key paired
    with a test webhook secret or the reverse. **Forward-looking guardrail:**
    today's code has no stored in-flight promise either — `stripeSync = await
    buildStripeSync()` simply throws to the caller on failure, leaving the
    prior cached value in place — but any single-flight fix must clear a
    rejected promise rather than cache it, or every later webhook would fail
    until restart. A superseded or invalidated `StripeSync` also **leaks its
    underlying `pg.Pool`** — the installed `stripe-replit-sync@1.0.0`'s
    constructor creates a `PostgresClient`, whose constructor creates a
    `pg.Pool` — so repeated mode flips leak connections steadily; "discard" is
    the wrong verb throughout, the fix must *dispose*
    (`postgresClient.pool.end()`).
  - **Why deferred now.** Pre-existing on `main`; same review/deferral
    provenance as the `adminConfig` entry above.
  - **Cost of waiting.** Extra Postgres connections and pool churn on every
    concurrent Stripe-sync miss or live/test mode flip, worsening the
    [autoscale connection-budget problem](#security--patching) (now filed
    under Security & patching, above this section). No known production
    incident yet; the mixed-mode-credentials case (3) is the most severe if
    it fires — a live secret key paired with a test webhook secret.
  - **Revisit trigger.** Next `/bugfix` pass through Stripe sync, or the
    [autoscale connection-budget entry](#security--patching) being fixed
    first (its arithmetic assumes this leak doesn't exist). Acceptance needs
    three cases proven together: a
    delayed mid-flight mode flip, a construction failure followed by a
    successful retry, and repeated flips returning the live pool count to one.

- **`rate_limit_counters` has no production cleanup at all (found on PR #299's review, deferred by PR #308).**
  - **What.** `purgeExpiredRateLimitCounters()` (`sharedRateLimiter.ts:83-85`)
    is one unbounded `DELETE` and nothing calls it, while
    `checkSharedRateLimit` (`:44-68`) inserts a persistent row for every new
    endpoint/IP/user/email key combination. The table grows without limit.
  - **Why deferred now.** Pre-existing on `main` — PR #308's rate limiter uses
    its own bounded in-memory store and writes no rows to this table at all,
    so it doesn't touch this gap. Ordered **last** of these five by David's
    2026-08-04 decision, but flagged as the one that **worsens with time**
    rather than staying static, so it shouldn't sit indefinitely.
  - **Cost of waiting.** Not just table growth: `key_raw`
    (`sharedRateLimiter.ts`'s `normalizeRateLimitKey()`) stores the raw IP,
    user id, and — for endpoints scoped by `recipientEmail` — a normalized
    email address, per row, for every endpoint/IP/user/email key combination
    ever seen. **For both `createRateLimiter`- and `createFactSubmitRateLimiter`-
    backed routes, the "user id" is `getSessionId(req)`** (both factories call
    the same `rateLimitScope()` in `rateLimit.ts` — `createFactSubmitRateLimiter`
    passes `scope.userId` into its own `checkSharedRateLimit` call for the
    `fact_submit` endpoint, mounted on fact submission in `reviews.ts`) — this
    repo's 32-byte hex session cookie/Bearer token, not an opaque account id —
    so those rows, across both factories, retain live/recent **session
    tokens**, a materially higher-severity secret than an identifier. With no cleanup,
    this is an **unbounded PII-and-session-token retention backlog**, not
    merely inert counters — a privacy/security cost, not only a
    query-latency one. This reframes the item: the quarterly
    `/security-review` should track it too, not just a maintenance pass, and
    a design that only addresses index/query cost (e.g. archiving instead of
    deleting) would leave the retention problem unsolved — worse, archiving
    would extend the retention window on live session tokens.
  - **Revisit trigger.** A scheduled maintenance pass, the quarterly security
    review, or observed table-size growth becoming a real query-latency
    concern — whichever fires first. Fix needs real retention (deletion, not
    archiving, given the PII content): a bounded per-run delete statement
    plus a bounded whole-run budget with rescheduling (not a single
    unbounded `DELETE`), verified against a
    high-cardinality backlog so no single run monopolizes the pool.

- **No CI guard against dangling `docs/plans/*` citations from code (found on PR #319's `/document` harvest review).**
  - **What.** [`plan-doc-path-never-cite-from-code.md`](../../.agents/memory/plan-doc-path-never-cite-from-code.md)
    documents the rule — plan-review branches are never merged, so a code
    comment or docstring citing a `docs/plans/*` path is dangling from
    the moment it's written — and records **two** confirmed occurrences (PR
    #256, PR #308) despite the rule already existing after the first one.
    `scripts/check-docs-accuracy.mjs` only link/path-checks the shared docs
    set (`docs/ai-context/`, the manual, etc.); it does not scan implementation
    code comments or `.agents/memory/` for this specific pattern, so a third
    occurrence can still merge green.
  - **Why deferred now.** This repo's own rule is that a recurring failure
    pattern becomes a deterministic CI guard, not a reviewer-memory ask — this
    item is the queued acknowledgment of that rule firing, not a decision to
    skip it. Not implemented in the PR that raised it (#319) because that PR
    is a docs-only `/document` harvest; adding a new guard script + build.yml
    wiring is a code change outside that ceremony's boundary (see
    `docs/ai-context/documentation-workflow.md`'s "Docs-only" boundary).
  - **Cost of waiting.** A third dangling-citation instance stays possible
    and undetected by CI until this ships — the exact gap that let occurrence
    #2 slip through despite the rule already being documented from #1.
  - **Scope note (Codex review, PR #319, second pass).** The guard must NOT
    scan `docs/*_TEST_RUN.md`/similar historical docs — a repo-wide search
    already finds a real, legitimate citation surviving there
    (`docs/PR256_VARIANT_INDEPENDENCE_TEST_RUN.md` cites a `docs/plans/*`
    file for the async-queue-hardening plan, long since gone from `main`, as
    a "not built in this PR" note). A guard scoped only to implementation
    code comments (`artifacts/*/src/` **and** `lib/*/src/` — this repo ships
    real implementation source under both roots, e.g. `lib/db/src` and
    `lib/api-zod/src`, either of which could carry the same dangling
    citation and merge green under an `artifacts/`-only guard) and
    `.agents/memory/` catches the actual failure mode (a docstring pointing
    readers at a plan that won't exist on `main`)
    without breaking on transient docs that are allowed to reference a
    plan-review PR they're paired with. Whitelisting after the fact, rather
    than scoping correctly from the start, would recreate exactly the kind
    of guard-vs-legitimate-content conflict this repo's other content guards
    already had to learn to avoid.
  - **Revisit trigger.** Next dev-infra/tooling pass, or the next time this
    exact mistake recurs a third time. Fix is a small regex/grep-based check
    (relative `docs/plans/*` path references appearing outside that directory
    itself), scoped to implementation code and `.agents/memory/` only, not
    `docs/` generally, added to `check-docs-accuracy.mjs` or a sibling
    script, wired into the Build job like the other content guards.
    **Second scope note (Codex review, PR #319, third pass):** a literal
    regex over `.agents/memory/` would also fail on the canonical
    rule-defining docs themselves —
    [`plan-doc-path-never-cite-from-code.md`](../../.agents/memory/plan-doc-path-never-cite-from-code.md)
    cites `docs/plans/PLAN_*.md`-shaped examples as the teaching content the
    rule is *about*, and
    [`codeql-missing-rate-limiting-csrf-false-positive.md`](../../.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md)
    links a `docs/plans/*` GitHub blob URL (a legitimate historical
    citation, deliberately not a relative path — see that doc's own note on
    why).
    **Retracted (Codex review, PR #319, fourth pass):** an earlier revision
    of this note proposed "only flag a *relative* path, not a full URL" as a
    cleaner alternative to an explicit file exemption — that does NOT work.
    `plan-doc-path-never-cite-from-code.md`'s own teaching examples
    (`docs/plans/PLAN_ASYNC_QUEUE_HARDENING*.md`,
    `docs/plans/PLAN_CODEQL_RATE_LIMITER*.md`, both verified as literal text
    in that file) are themselves bare relative paths used as historical
    prose, not URLs and not asterisk-glob placeholders — a relative-path-only
    regex would still flag them. The guard genuinely needs an **explicit
    file-level exemption** for `plan-doc-path-never-cite-from-code.md`
    specifically (its whole purpose is to name the dangling-path pattern in
    prose); the relative-vs-URL distinction only correctly resolves the
    *other* memory doc's citation, not this one. **The exemption list also
    needs `MEMORY.md`** (Codex review, PR #319, fifth pass): its own one-line
    index summary of the "never cite a `docs/plans/*` path from code" lesson
    (`MEMORY.md:23`) repeats the same bare `docs/plans/PLAN_*.md` teaching
    text, a third file the guard would need to know about before it can ship.

- **`app.ts`'s `ORIGIN_EXEMPT_PATHS` can desync from `isDevAdminLoginEnabled()` in a shared process (found on PR #319's `/document` harvest review).**
  - **What.** `app.ts:23-43`: `ORIGIN_EXEMPT_PATHS` is a module-level `Set`,
    conditionally gaining `/api/auth/dev-admin-login` only inside an
    `if (isDevAdminLoginEnabled())` block that runs **once at import time**.
    `createApp()` (`:107` onward) separately re-checks
    `isDevAdminLoginEnabled()` **fresh on every call** to decide whether to
    mount the permissive dev-admin CORS middleware — but the origin-check
    middleware it also registers calls `isOriginExempt()`, which reads the
    same frozen-at-import `Set`. In a shared-process caller (a test file, a
    preview helper) that imports `app.ts` before `ENABLE_DEV_ADMIN_LOGIN` is
    set and calls `createApp()` after, the permissive CORS gets mounted
    (fresh check passes) but the exemption never gets added (stale check) —
    a cross-origin dev-admin-login POST gets permissive CORS headers and is
    then rejected by the origin-check middleware anyway.
  - **Why deferred now.** Same species of import-time-env-capture bug as the
    eager-singleton fix PR #308 shipped
    ([`app-ts-eager-singleton-test-isolation.md`](../../.agents/memory/app-ts-eager-singleton-test-isolation.md)),
    but that fix targeted the app-instance singleton specifically and did not
    touch this `Set` — found by a later Codex review round on the `/document`
    harvest documenting that fix, not by PR #308 itself. Not implemented here
    because this is a docs-only harvest PR.
  - **Cost of waiting.** Narrow blast radius: only fires for a caller that
    imports `app.ts` before flipping `ENABLE_DEV_ADMIN_LOGIN`, which is
    already a non-production-only backdoor (fail-closed by design). No known
    production or CI incident.
  - **Revisit trigger.** Next `/bugfix` pass through `app.ts`, or if a
    dev-admin-login-in-tests symptom is actually observed. Fix is either
    moving `ORIGIN_EXEMPT_PATHS`'s conditional entry into `createApp()`
    itself (so it's re-evaluated per call, matching the CORS-mount check), or
    documenting the asymmetry as an intentional exception if there's a reason
    the exemption specifically must stay import-time-frozen.

---

## Product deferrals live elsewhere

Deferred features and product-direction bets are **not** in this doc. See
[`current-roadmap.md` → Explicitly deferred work](../ai-context/current-roadmap.md#explicitly-deferred-work).
