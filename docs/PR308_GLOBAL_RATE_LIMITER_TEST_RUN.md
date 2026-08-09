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

**No test suites in this checklist.** This PR's integration and unit tests
(`globalRateLimitStore` peak-cardinality/eviction tests, `rateLimit.test.ts`,
`csrf.integration.test.ts`, the frontend poller-retry-classification and
`GodModeLoadingTakeover` specs) already ran and passed in CI on this exact
merged code — including the full sharded api-server suite, despite this PR
restructuring `app.ts` into a `createApp()` factory and moving the global
limiter ahead of most existing middleware. Re-running any of that here would
verify the environment, not the code, and adds no new signal. Everything
below is what CI genuinely cannot see: the live app under real traffic.

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

## Live checks (read-only; run always)

1. **`GET /api/healthz` still works, from both a fresh request and a
   burst.** Hit it a few dozen times in quick succession — it must never
   return 429. It's mounted twice on purpose (early, ahead of the limiter,
   and via the router); confirm the response body is identical either way:
   `{"status":"ok"}`.

2. **The limiter's response shape is correct at low volume.** The default
   ceiling (12,000/min) is impractical to trip by hand, so this checks shape,
   not the ceiling itself: any `/api/*` route (e.g. repeatedly `GET
   /api/config`) returns normal 200s under ordinary manual clicking, carries
   `RateLimit-Limit` / `RateLimit-Remaining` response headers, and does
   **not** carry legacy `X-RateLimit-*` headers.

3. **`Cache-Control: no-store` on a 429**, if one can be observed (e.g. via
   browser devtools) — confirms an intermediate proxy won't cache a stale
   block and keep serving it after the window rotates.

4. **Log volume stays sane under ordinary traffic.** No specific action
   needed — just note whether the API server's logs show a `[rateLimit]
   global rate limit exceeded` line more than roughly once per second even
   during a heavier-than-usual traffic moment. It's throttled to at most one
   such line per second per process by design; more than that would indicate
   the throttle itself is broken.

**Not run here: a live video/PuLID generation surviving ordinary polling.**
Starting one is a genuine live write — it creates generation/job records and
stored media and can incur an external-generation charge — with no restore
path through this checklist. The poller retry-classification boundary this
would exercise is covered by `GodModeLoadingTakeover`'s unit tests (named
below); the live end-to-end version is ordinary product usage and belongs in
the UAT instead.

Proof tests guarding this PR's budgets (run in CI, listed for awareness — not
run here):

- `never exceeds the configured cap` / `drains previous before current, so
  eviction takes the genuinely oldest keys` (`globalRateLimitStore` peak-
  cardinality tests) — the store's whole reason for existing over the
  package's stock `MemoryStore` is a bounded peak under a key-cardinality
  flood.
- `resets an evicted key's counter (fails safe, never a wrongful 429)` — the
  store's core safety property. An eviction must never cause a caller to be
  blocked who wouldn't otherwise have been.
- `survives five consecutive limiter 429s and recovers on the sixth poll` /
  `still terminates after five consecutive non-429 failures` /
  `does NOT treat a 503 carrying Retry-After as retryable` (`GodModeLoadingTakeover`)
  — the boundary that protects a live, already-paid-for video generation from
  being killed by the limiter this PR introduces.
- `exempts case- and trailing-slash-variant spellings identically` /
  `does not exempt a wrong-method request to an exempt path` — Express's
  routing is neither strict nor case-sensitive; a narrower exemption check
  would let `/API/HEALTHZ` or `POST /api/healthz` slip past the meter or, in
  the other direction, meter a legitimate uptime-monitor spelling.
- `meters a rejected-origin preflight — cors() falls through instead of
  answering` — deliberate: exempting `OPTIONS` would be a one-word bypass for
  an attacker to dodge the limiter entirely.

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
