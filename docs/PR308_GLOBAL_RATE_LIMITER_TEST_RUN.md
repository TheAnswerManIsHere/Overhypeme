# PR308 — Global rate-limit backstop for CodeQL js/missing-rate-limiting · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Replit owns the DB connection — no DATABASE_URL / test-DB env
is set here.

Pre-merge gates (install, typecheck, codegen drift) are assumed green; spot-check
only if something below fails.

Sibling: [`PR308_GLOBAL_RATE_LIMITER_UAT.md`](./PR308_GLOBAL_RATE_LIMITER_UAT.md)
(David's click-through — the durable half of the pair).

**No migration in this PR.** No new table, no schema change — the store is
in-process memory, not the database. There is nothing to confirm in
`admin_config` or any table.

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes. This PR
  added no migration, so nothing new to reconcile — this is a spot-check that
  another PR landing first didn't break the chain.
- `pnpm --filter @workspace/db check-snapshots` — expected: passes, all entries
  exempt or snapshotted. **No new `SNAPSHOT_EXEMPT_TAGS` entry** — this PR adds
  none.
- `node scripts/check-docs-accuracy.mjs` — expected: clean
- Other allow-list entries this PR added: **none** — no `check-no-console.mjs`
  or `check-cycles.mjs` allowlist entries were touched.

## Targeted tests (run always)

```
bash artifacts/api-server/scripts/run-test.sh \
  src/__tests__/globalRateLimit.integration.test.ts \
  src/__tests__/rateLimit.test.ts \
  src/__tests__/csrf.integration.test.ts
```

Expected: **0 fail**. Known environmental failures: **none** for this set.

Also run the frontend poller tests (not routed through `run-test.sh` — these
aren't DB-backed and have no equivalent wrapper):

```
pnpm --filter @workspace/overhype-me exec vitest run \
  src/components/meme-builder/wizard/__tests__/pollRetryClassification.test.ts \
  src/components/meme-builder/wizard/step2-video/__tests__/GodModeLoadingTakeover.spec.tsx \
  src/components/meme-builder/wizard/step2-video/__tests__/Step2Video.spec.tsx
```

Expected: **0 fail**.

Proof tests to note by name — these encode invariants, not example values, and
are the ones worth reading if anything fails:

- `never exceeds the configured cap` / `drains previous before current, so
  eviction takes the genuinely oldest keys` (`globalRateLimitStore` peak-
  cardinality tests) — the store's whole reason for existing over the
  package's stock `MemoryStore` is a bounded peak under a key-cardinality
  flood. Mutation-tested during review: draining `current` first, capping
  per-map instead of combined, and removing eviction entirely each
  independently fail these.
- `resets an evicted key's counter (fails safe, never a wrongful 429)` — the
  store's core safety property. An eviction must never cause a caller to be
  blocked who wouldn't otherwise have been.
- `survives five consecutive limiter 429s and recovers on the sixth poll` /
  `still terminates after five consecutive non-429 failures` /
  `does NOT treat a 503 carrying Retry-After as retryable` (`GodModeLoadingTakeover`)
  — this is the boundary that protects a live, already-paid-for video
  generation from being killed by the limiter this PR introduces. All three
  cases matter: retryable-forever-on-429, still-terminates-on-real-failure,
  and status-alone-decides (not header presence).
- `exempts case- and trailing-slash-variant spellings identically` /
  `does not exempt a wrong-method request to an exempt path` — Express's
  routing is neither strict nor case-sensitive; a narrower exemption check
  would let `/API/HEALTHZ` or `POST /api/healthz` slip past the meter or, in
  the other direction, meter a legitimate uptime-monitor spelling.
- `meters a rejected-origin preflight — cors() falls through instead of
  answering` — deliberate: exempting `OPTIONS` would be a one-word bypass for
  an attacker to dodge the limiter entirely.

## Full sharded suite — shared infra touched: **yes**

`app.ts` was restructured into a `createApp()` factory and the global limiter
is mounted ahead of most existing middleware (cors, cookie parsing, CSRF,
auth) — every route in the app now passes through new code before reaching
its handler.

```
pnpm --filter @workspace/api-server test
```

Stop the `artifacts/api-server: API Server` workflow first to free test-DB
connections, or the `pretest` chain (push-force → migrate → codegen) stalls.

**Known pre-existing failures, unrelated to this PR** — verified locally by
`git stash`-ing this entire diff and re-running the identical sharded suite
against unmodified `main`; the same suites fail there too:

- `DB CHECK — facts_active_requires_concept` (3 subtests) — the
  `facts_active_requires_concept` CHECK constraint is absent from the test
  database in this container; reproduces byte-identical on `main`.
- `acquireLease`, `acquireLeaseWithWait`, `withLeaseFence`, `releaseLease`,
  `sweepExpiredGrace — convergence, not enforcement`, `recomputeMembership` —
  all fail identically on unmodified `main` in the same sharded run. Two of
  the six pass cleanly when run standalone (`bash
  artifacts/api-server/scripts/run-test.sh
  src/__tests__/membershipLease.test.ts
  src/__tests__/membershipGraceSweep.test.ts`), pointing at sharded-run DB
  contention rather than a defect anywhere in this diff.

If Replit's environment shows a **different** failure set than this list, that
is a real finding worth reporting — this list is what reproduced in the
sandbox, not a guarantee Replit's environment behaves identically.

**Watch specifically for a global-limiter false-positive symptom**: any test
in the sharded run failing with a `429` status it didn't expect. The new
limiter's default ceiling (12,000 req/min per IP) is far above the sharded
suite's request volume from any single test-runner IP, and the new
integration test file already exercises a 200-request burst against the
default ceiling with zero 429s — but the sharded suite runs many files
concurrently from the same machine, which the local sandbox may not fully
replicate.

## Manual behavior checks (run always)

1. **`GET /api/healthz` still works, from both a fresh request and a
   burst.** Hit it a few dozen times in quick succession — it must never
   return 429. It's mounted twice on purpose (early, ahead of the limiter,
   and via the router); confirm the response body is identical either way:
   `{"status":"ok"}`.

2. **Trip the limiter for real, from one IP.** The default ceiling is
   12,000/min — impractical to hit by hand. Instead, confirm the *shape* is
   correct at low volume: any `/api/*` route (e.g. repeatedly `GET
   /api/config`) returns normal 200s under ordinary manual clicking, carries
   `RateLimit-Limit` / `RateLimit-Remaining` response headers, and does
   **not** carry legacy `X-RateLimit-*` headers.

3. **A live video or PuLID image generation survives ordinary polling.**
   Start a real video or image generation and let it run to completion.
   Confirm the loading takeover never shows a failure screen mid-generation
   under normal (non-adversarial) traffic — this is the regression surface
   the poller retry-classification fix protects, and it's worth one real
   end-to-end run beyond the unit-level 429-simulation tests above.

4. **`Cache-Control: no-store` on a 429**, if one can be observed (e.g. via
   browser devtools) — confirms an intermediate proxy won't cache a stale
   block and keep serving it after the window rotates.

5. **Log volume stays sane under ordinary traffic.** No specific action
   needed — just note whether the API server's logs show a `[rateLimit]
   global rate limit exceeded` line more than roughly once per second even
   during a heavier-than-usual traffic moment. It's throttled to at most one
   such line per second per process by design; more than that would indicate
   the throttle itself is broken.

## What's deliberately NOT shipped

- **No fleet-wide rate limiting.** This is a per-instance ceiling
  (`MemoryStore`'s `localKeys = true`); on autoscale with no configured
  instance cap, the effective allowance is `instances × 12,000/min`. The
  existing narrow, DB-backed limiters remain the fleet-correct layer for the
  6 of 31 route files they cover.
- **No coverage expansion for the six pre-existing bugs the plan-review loop
  surfaced** (`adminConfig` stampede, `getStripeSync` pool-leak, the
  unenforced autoscale instance cap, `IP_HASH_SALT` production fallback, the
  unbounded `rate_limit_counters` table) — queued for separate `/bugfix` PRs.
- **No local CodeQL re-scan in this checklist** — that's CI's CodeQL job, not
  something Replit's environment can meaningfully re-verify differently.

## Delete me

Transient — delete once the checklist has been run. The `_UAT.md` sibling is
the durable half.
