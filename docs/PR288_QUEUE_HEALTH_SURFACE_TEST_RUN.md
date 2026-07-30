# PR288 — Phase 1 async-queue hardening: worker liveness + Queue Health surface · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Replit owns the DB connection — no DATABASE_URL / test-DB env
is set here.

Pre-merge gates (install, typecheck, codegen drift) are assumed green; spot-check
only if something below fails.

Sibling: [`PR288_QUEUE_HEALTH_SURFACE_UAT.md`](./PR288_QUEUE_HEALTH_SURFACE_UAT.md)
(David's click-through — the durable half of the pair).

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`)
- `pnpm --filter @workspace/db check-snapshots` — expected: passes, all entries
  exempt or snapshotted. **New `SNAPSHOT_EXEMPT_TAGS` entry this PR added:**
  `"0094_worker_lane_heartbeats"` — hand-authored idempotent DDL following
  0093's shape. If this gate fails, verify *that entry exists* rather than
  diagnosing an unexplained failure.
- `node scripts/check-docs-accuracy.mjs` — expected: clean
- Other allow-list entries this PR added: **one, and it is a test fixture rather
  than a build allow-list** — `ADMIN_AUTH_ROUTES` in
  `artifacts/api-server/src/__tests__/routes.admin.auth.test.ts` gained
  `get /admin/queue-health` and `get /admin/queue-health/jobs`. The
  completeness assertion in that file fails if a new `/admin/*` route is
  registered without being declared there, so a failure means a route/table
  mismatch, not a broken gate.

## Targeted tests (run always)

```
bash artifacts/api-server/scripts/run-test.sh \
  src/__tests__/workerHeartbeats.test.ts \
  src/__tests__/queueHealth.test.ts \
  src/__tests__/asyncJobs.test.ts \
  src/__tests__/routes.admin.auth.test.ts \
  src/__tests__/routes.health.test.ts
```

Expected: **0 fail**. Known environmental failures: **none** — these ran clean
locally four consecutive times with the three queue files in flight together.

**Run this set at least twice.** Not superstition: the three queue files share
the `worker_lane_heartbeats` table, and cross-file contamination there was a
real bug during development (one file's cleanup wiped another's rows). A single
green run would not have caught it; two would.

Proof tests to note by name — these encode invariants, not example values, and
are the ones worth reading if anything fails:

- `publishes in_flight_count before awaiting handlers, so a wedged tick is
  visible` — asserts the count is observable **while a handler is still
  blocked**. If this regresses, Phase 2's wedged-lane alert becomes unable to
  fire in the only case it exists for.
- `stamps last_scheduled_at even when the re-entrancy guard skips the tick` —
  a lane whose timer fires while its previous tick still runs is healthy-but-slow
  and must not read as dead.
- `reports a lane healthy when ONE instance is stale but another is scheduling
  it` — the case that distinguishes the fleet-wide quantifier from "any stale
  heartbeat". A test of only the fully-dead case passes against both the correct
  and the incorrect implementation.
- `runs lanes independently — a blocked bulk lane never suppresses the fast lane`
  — **pre-existing**, guards PR #216/#256's isolation invariant. It went flaky
  during this work and was fixed with an injectable `heartbeats` seam, not by
  loosening the assertion. If it fails here, that is a real regression.
- `keeps the reclaim cutoff clear of the slowest real handler` — pre-existing
  from PR #283.

Frontend: no Vitest tests were added for the page in this PR (see *What's
deliberately NOT shipped*).

## Full sharded suite — shared infra touched: **yes**

`lib/db/src/schema/` gained a table and `lib/db/src/index.ts` changed the pool
`max`, so the DB layer every test connects through is in scope.

```
pnpm --filter @workspace/api-server test
```

Stop the `artifacts/api-server: API Server` workflow first to free test-DB
connections, or the `pretest` chain (push-force → migrate → codegen) stalls.

**Watch specifically for connection-exhaustion symptoms** (`too many clients`,
pool acquire timeouts). The pool `max` went from unset — pg's default of 10 — to
an explicit 20 per process, which is the intended fix, but the sharded runner
starts several processes at once and is the most likely place for a fleet-level
arithmetic mistake to surface. If you see them, that is a real finding worth
reporting rather than a flake; `DB_POOL_MAX` can be set lower as an immediate
mitigation.

## Manual DB / behavior checks (run always)

1. **Migration 0094 applied.** Confirm the table exists and its shape:
   - `worker_lane_heartbeats` with primary key `(instance_id, lane)`
   - `instance_id` `varchar(64)` NOT NULL, `lane` `varchar(32)` NOT NULL
   - `worker_protocol_version` `integer` NOT NULL
   - `last_scheduled_at` `timestamptz` NOT NULL default `now()`
   - `last_tick_completed_at` `timestamptz` **nullable** (a tick that has never
     completed must be distinguishable from one that completed at epoch)
   - `in_flight_count` `integer` NOT NULL default 0
   - index `worker_lane_heartbeats_last_scheduled_idx` on `last_scheduled_at`

2. **Re-running migration 0094 is a no-op.** `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, and the config seed is
   `INSERT … ON CONFLICT (key) DO NOTHING`. Nothing reads or rewrites an
   existing row, so there is no backfill and nothing to roll back.

3. **The TTL config row seeded with its bounds.** Confirm `admin_config` has
   `instance_heartbeat_ttl_minutes` = `15`, `data_type` `integer`,
   `min_value` `1`, `max_value` `1440`. **The bounds are the point** —
   `PATCH /admin/config/:key` only enforces a range when the row supplies one,
   so a seed without them would accept a negative TTL and quietly disable
   pruning.

4. **Heartbeat rows appear for all five lanes, from a live worker.** After the
   API server has been up for ~30s, `worker_lane_heartbeats` should hold one row
   per `(instance_id, lane)` for `fast`, `render`, `bulk`, `pexels`,
   `ai_meme_backfill`, all with `worker_protocol_version = 1` and a
   `last_scheduled_at` inside the last minute. **This is the check that proves
   the feature works at all** — the table existing proves only the migration ran.

5. **`GET /health/queues` returns 200 on a healthy worker**, with a body
   containing only `ok`, `ts`, `laneCount`, `stalledLaneCount`. Confirm it leaks
   **no** queue names, payloads, error text or instance ids — it is
   unauthenticated by design, so that absence is a requirement, not an omission.

6. **`GET /health/queues` returns 503 when a lane genuinely stalls.** The
   cheapest way to observe this: stop the API server workflow, wait past the
   stale threshold (60s — `max(3 × interval, 60s)`, and every lane's interval is
   ≤ 5s so all five floor at 60s), then request the endpoint from another
   process. Expected 503 with `stalledLaneCount: 5`. Restarting the server
   should return it to 200 within a tick.

7. **`GET /admin/queue-health` against real data** (authenticated as admin).
   Expect every registered queue to appear **even with zero rows** — a queue
   absent from the response would read as "fine" when the truth may be that it
   has never run. Confirm the response contains **no** `activeAlerts` /
   `unacknowledgedAlerts` key at all: alerting arrives in Phase 2, and an empty
   array here would read as "no alerts" rather than "not built yet".

8. **`GET /admin/queue-health/jobs` caps its page size.** Request
   `?limit=100000` and confirm the response's `limit` is `100`.

9. **Derived statuses against real rows, if any exist.** If production has a
   `fact_ai_meme_backfill` row that finished with
   `result = {"skipped": true, "reason": "not_active"}`, confirm the aggregate
   reports it under `skipped` **and** the per-item row reports
   `displayStatus: "skipped"` with `skipReason: "not_active"`. If it has a
   `failed` `fact_ai_meme_backfill` row, confirm `abandonedNoRetry` counts it and
   the row shows `displayStatus: "abandoned_no_retry"`. Both altitudes must
   agree — a derived status right in one and wrong in the other is the failure
   mode this was written against. **If no such rows exist, say so rather than
   inventing one** — the unit tests already cover the logic; this check is only
   about real data.

## What's deliberately NOT shipped

- **No alerting.** No `job_alerts`, no webhook, no dispatcher, no banner. Phase 2.
- **No alert fields on the aggregate response** — not even an empty array.
- **No lease tokens, no fenced finalize, no graceful shutdown drain.** Phase 3.
  The unfenced finalize is still there; PR #283's 30-minute reclaim cutoff is
  still the only mitigation.
- **No enqueue/transactional changes.** Phase 4.
- **No frontend Vitest tests for the page.** The page's logic is fetch +
  render-state selection; its states are specified in the UAT and verified by
  click-through. Worth revisiting if the page grows conditional logic.
- **No `pnpm run build` verification** — deferred to CI, flagged in the PR body.

## Delete me

Transient — delete once the checklist has been run. The `_UAT.md` sibling is
the durable half.
