---
name: CodeQL doesn't recognize this repo's hand-rolled rate-limit/CSRF controls
description: js/missing-rate-limiting and js/missing-token-validation flag routes protected by checkSharedRateLimit or the double-submit CSRF cookie, because CodeQL's model only recognizes known npm packages.
---

# CodeQL flags custom rate-limiting/CSRF as "missing" even when it's present

CodeQL's default query suite includes `js/missing-rate-limiting` and
`js/missing-token-validation` (CSRF). Both appear to be built to recognize
**specific known npm packages** as satisfying the check (`express-rate-limit`,
`rate-limiter-flexible`, `csurf`, etc.) — not arbitrary custom code that
provides the same protection. This repo's actual controls are hand-rolled:

- **Rate limiting:** `checkSharedRateLimit` (`artifacts/api-server/src/lib/sharedRateLimiter.ts`),
  a DB-backed window counter. Some routes call it directly as the first
  statement in the handler; others go through `createRateLimiter`
  (`artifacts/api-server/src/lib/rateLimit.ts`), which wraps it as real
  Express middleware registered in the router chain (e.g. `ai.ts`'s
  `requireRateLimit`). Both shapes exist in this repo — the distinction
  doesn't matter to CodeQL either way (see below).
- **CSRF:** a double-submit `csrf_token` cookie + `x-csrf-token` header check,
  registered as global `app.use()` middleware in `app.ts` (see
  [`security-model.md`](../../docs/ai-context/security-model.md)).

CodeQL's `js/missing-rate-limiting` model doesn't key off "is this Express
middleware" — it keys off recognizing the *import* as one of a hardcoded list
of known packages (`express-rate-limit`, `express-brute`, `express-limiter`,
`rate-limiter-flexible`, `@fastify/rate-limit`). Confirmed empirically: a
route registered as genuine middleware via `createRateLimiter` still gets
flagged, because the underlying call is `checkSharedRateLimit`, not one of
those five packages. So neither shape — inline call or real middleware —
matches what CodeQL's query is looking for, and it flags routes protected by
either as vulnerable.

**Confirmed on PR #256:** adding `checkSharedRateLimit` to
`/admin/taxonomy-health/job-status` (matching the exact established pattern
already used unflagged elsewhere in `facts.ts`/`localAuth.ts` — those routes
just weren't in that PR's diff) did **not** clear the `js/missing-rate-limiting`
alert on that line; a fresh alert re-fired on the same line on the very next
push containing the fix. Separately, David spotted a `js/missing-token-validation`
("Missing CSRF middleware") alert on `app.ts`'s `cookieParser()` line —
verified via the GitHub Security tab to be **first detected 3 days before
PR #256 even existed**, i.e. pre-existing on `main`, not introduced by any
diff — and the CSRF protection sits a few lines below the flagged line in the
same file. Same class of false positive as the rate-limiting one, though not
independently confirmed by clearing it (David dismisses these manually; the
agent has no tool access to GitHub's code-scanning-alert dismissal API).

**Confirmed a second time on PR #288:** the same alert re-fired identically on
two new `/admin/queue-health*` routes after `checkSharedRateLimit` was applied
to them, on the next push containing the fix — same shape as PR #256, no new
information. Two independent confirmations is enough to stop treating this as
a one-off and start treating a fresh alert on an already-protected route as
the expected, not the surprising, outcome.

**Rule:** when a new CodeQL alert of either kind appears on a route/file that
already uses `checkSharedRateLimit` or sits behind the global CSRF middleware,
**investigate before "fixing"** — confirm the real control is present (check
this repo's established patterns above) rather than reflexively adding a
second, redundant, inconsistent control (e.g. `express-rate-limit` bolted onto
one route) just to satisfy the scanner's pattern-matcher. Once confirmed as a
false positive, it needs a human with repo-admin access to dismiss it in
GitHub's Security → Code scanning tab (mark "false positive") — no available
MCP/GitHub tool can do this from the agent side.

## Resolution: `js/missing-rate-limiting` (213 alerts) — mount the recognized package, don't fight the model

The rate-limiting half of this (not the CSRF half — that stayed a manual
per-alert dismissal) was resolved differently: rather than getting CodeQL to
recognize `checkSharedRateLimit`, or dismissing 213 alerts by hand, the fix
mounts `express-rate-limit` itself as a genuine, API-wide backstop. See
[`docs/plans/PLAN_CODEQL_RATE_LIMITER.md`](https://github.com/TheAnswerManIsHere/Overhypeme/blob/plan-review%2Fcodeql-rate-limiter/docs/plans/PLAN_CODEQL_RATE_LIMITER.md)
(a GitHub blob link, not a relative path — the file lives only on the
never-merged `plan-review/codeql-rate-limiter` branch, PR #299, converged
after 16 Codex review rounds, and is not present in this tree) for the full
design; the essentials:

- **Confirmed empirically, not assumed:** building a local CodeQL database
  against a copy of the repo with nothing but
  `app.use("/api", rateLimit({...}), router)` took the alert count from
  213 → 0. The query is pattern-sensitive on `rateLimit()` reaching
  `app.use()` directly — it models the *import and mount shape* of a small
  hardcoded package list, not the store implementation behind it. A custom
  `Store` (below) is invisible to the query; only the middleware shape
  matters.
- **The store is a bounded in-memory `Store`, not the existing DB-backed
  `checkSharedRateLimit`.** An earlier revision of this plan spent 14 Codex
  review rounds (rounds 4-14) trying to make a DB-backed `Store` safe on the
  hot path of every request, and each fix produced a new P1 on the same
  boundary (what happens when a DB call doesn't complete) — round 14's
  version was worse than the bug it replaced: hung queries would have wedged
  an in-process counter and returned 503 to every request indefinitely. David
  made the call to ship the package's proven in-memory shape instead:
  `BoundedMemoryStore` (`artifacts/api-server/src/lib/globalRateLimitStore.ts`)
  mirrors the package's own `MemoryStore` two-map rotation but adds a hard
  cap (`MAX_TRACKED_KEYS`, spanning both maps combined) with oldest-first
  eviction, closing an unbounded-peak-cardinality OOM path the stock store
  has. No I/O, no pool, no failure-policy question — a map insert with an
  eviction branch.
- **This is a coarse, per-instance backstop layered ON TOP of the existing
  narrow limiters, not a replacement for them.** `checkSharedRateLimit` /
  `createRateLimiter` are completely untouched. The new limiter uses
  `MemoryStore`'s own `localKeys = true` semantics (each autoscale instance
  counts independently), so it provides a per-instance abuse ceiling, not a
  bounded fleet-wide one — see the plan's "What per-instance counting means"
  section for the honest limitation statement, and §6 item 4 (the unenforced
  autoscale instance cap) for what would need to exist to make it fleet-wide.
- **At least 13 of this API's 31 route files had some rate/quota limiting
  before this change** (`facts.ts`, `reviews.ts`, `admin.ts`,
  `adminTaxonomyHealth.ts`, `ai.ts`, `localAuth.ts`, `share.ts`,
  `shareCopy.ts`, `videos.ts`, `storage.ts`, `memes.ts`, `pulidJobs.ts`,
  `videoJobs.ts`) — a round-16 finding that inverted the plan's original
  framing, and one this repo's own docs have now undercounted across **five
  separate Codex review rounds** on the same PR (#319's `/document`
  harvest): the plan's own text said 6/31; round one raised it to 9/31 via a
  grep scoped only to literal rate-limit symbol names inside route files (`rg
  'RATE_LIMIT|takeBucket|checkBucket|checkSharedRateLimit|createRateLimiter|createFactSubmitRateLimiter|requireRateLimit'
  artifacts/api-server/src/routes/*.ts`); round two caught protection
  delegated through a `lib/` helper (`storage.ts` → `checkUploadRateLimit` →
  `checkSharedRateLimit`; `memes.ts` → `createMemeRecord`'s DB-queried daily
  save cap) and misclassified `videos.ts` as an in-process bucket when it's
  actually a direct `videoJobsTable` query, raising it to 11/31; round three
  caught that `videos.ts`/`memes.ts`'s check-then-insert isn't atomic like
  `checkSharedRateLimit`'s single `INSERT ... ON CONFLICT`, so "DB-backed"
  there means DB-*observed*, not fleet-*correct* under a concurrent burst;
  round four caught a **different protection class entirely** — budget/quota
  gates, not rate-per-window limiters — that the grep-based methodology
  never had a chance of finding: `videos.ts` *also* 429s from `checkBudget()`
  (a per-user cost cap, independent of its `videoJobsTable` rate check), and
  `pulidJobs.ts` 429s from `isUserAtImageLimit()` (a per-user image-count
  cap), raising it to 12/31; round five caught that `videoJobs.ts` is a
  *separate* route file from `videos.ts` (mounted independently via
  `routes/index.ts`'s `router.use(videoJobsRouter)`) that also delegates to
  `startVideoJob()` → `checkBudget()`, a same-topic sibling the earlier
  passes never visited because it isn't named `videos.ts`, raising it to
  13/31. See the 2026-08-04 `decisions.md` entry's "accepted trade-off" note
  for the full, hedged breakdown. **No count in this note should be trusted
  as final** — five consecutive corrections is a track record, not a
  completed audit; a sixth review pass could plausibly find more.
  `render.ts` has separate Cloudflare-WAF edge-level protection, not
  application code, not counted in any of the above tallies.
  For the other ~18 (approximate, upper bound, likely to shrink further),
  this middleware isn't a
  backstop behind real protection; it's the first application-level rate
  limiting those routes have ever had.
- Because this mounts the API's first-ever *rate-limit* 429 path, it also
  created a **new class** of 429 for the video/pulid job pollers to handle —
  their *submission* endpoints already 429'd on budget/quota exhaustion
  (`checkBudget()`, `isUserAtImageLimit()`), but the pollers themselves
  (checking job status, not submitting) had never seen a 429 before this PR.
  Fixed in the same change (`artifacts/overhype-me/.../util/pollRetryClassification.ts`):
  a poll response is classified as retryable **only on status 429**, never on
  `Retry-After` presence alone (a persistent generic 503 can also carry that
  header), so a burst of rate-limiter 429s backs off instead of terminating a
  still-running job.

**Verify Codex plan-review PR #299's findings ledger** before assuming any of
the numbers above (100,000-key cap, 12,000/min default ceiling) are still
current — they're explicitly documented in the plan as placeholders pending
production instrumentation, not derived from measured traffic.

## Re-attribution: restructuring code can make CodeQL re-flag a dismissed alert as "new"

**Confirmed on PR #308's own implementation commit.** After the rate-limiter
feature landed, its follow-up commit refactored `app.ts` into a `createApp()`
factory (fixing an unrelated eager-singleton bug — see
[`app-ts-eager-singleton-test-isolation.md`](./app-ts-eager-singleton-test-isolation.md)).
That refactor touched no CSRF/CORS logic at all, but CodeQL's PR check fired
"2 new alerts including 1 high severity" on that commit anyway: `js/missing-
token-validation` on the `cookieParser()` line, and a "permissive CORS
configuration" alert on the dev-admin-login block's `cors({ origin: true, ...
})` call (the second one not previously seen in this repo's CodeQL history at
all, despite the code being untouched).

**Root cause:** `git diff origin/main -- artifacts/api-server/src/app.ts`
showed both flagged lines were **byte-identical** to `main` — only their line
numbers changed, because
wrapping the file body in a factory function reindented and shifted every
line below it. GitHub's PR-diff-based code-scanning UI appears to attribute
an alert to "new in this PR" partly by line position, so pre-existing,
previously-dismissed-or-known alerts can resurface as apparently-new findings
on a PR that only moved code, never changed its logic.

**Rule:** before treating a CodeQL alert as real on a PR that restructures,
reindents, or moves code (extracting a function, wrapping in a factory,
reordering top-level statements), diff the flagged file against `main` first.
Byte-identical flagged lines are a **necessary but not sufficient** check —
in Express, the *relative order* of middleware registration is often the
actual security behavior (e.g. CSRF/origin checks must run before the routes
they protect), and a restructuring PR could leave the flagged
`cookieParser()`/`cors(...)` line itself untouched while moving CSRF or
origin-check middleware to run *after* the routes instead of before — a real
regression that a line-content-only diff would miss entirely (Codex review
finding on PR #319's `/document` harvest of this note, 2026-08-04). So:
diff the flagged lines for byte-identity **and** separately confirm the
surrounding middleware registration order — which check runs before which
route/handler — is unchanged (e.g. `grep -n` each relevant `app.use(...)`
call and compare the sequence, not just individual line contents) before
calling it re-attribution. If either check fails, treat the alert as
potentially real and investigate the security substance from scratch. Once
confirmed as re-attribution by both checks, this still needs a human with
repo-admin access to dismiss in the Security tab; no available tool lets the
agent do it.
