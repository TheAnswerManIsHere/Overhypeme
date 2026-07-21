# PR216 — Async-Jobs Worker Lanes (fast/render/bulk) — TEST_RUN

Engineering/automated checklist for the Replit safety net. This doc is
transient — delete it once the checklist has passed; the UAT sibling is the
durable half.

## Scope

Splits the single async-jobs worker into three independent lanes (`fast`,
`render`, `bulk`), each with its own timer, closure-local re-entrancy guard,
claim-query queue filter, and concurrency bound. Pure process-local scheduling
change — **no schema change, no migration, no data touch**. Existing pending
`async_jobs` rows are claimed by their queue's assigned lane after restart.

Files touched:
- `artifacts/api-server/src/lib/asyncJobs.ts` (core)
- `artifacts/api-server/src/lib/factSendBackJob.ts`, `projectionRepairJob.ts` → `{ lane: "fast" }`
- `artifacts/api-server/src/lib/imagePromptJobs.ts` → both queues `{ lane: "render" }`
- `artifacts/api-server/src/lib/email.ts` (stale poll-interval comment only)
- `artifacts/api-server/src/__tests__/asyncJobs.test.ts` (4 new tests)

## Commands (`artifacts/api-server`)

Replit owns the DB connection — apply migrations/push as usual for the suite,
then run:

```
# typecheck (tsc -b + cycle check + no-console gate)
pnpm run typecheck

# the worker's own suite
node --import tsx/esm --test src/__tests__/asyncJobs.test.ts

# adjacent handlers whose registration now passes { lane }
node --import tsx/esm --test \
  src/__tests__/factSendBackJob.test.ts \
  src/__tests__/imagePromptJobs.test.ts \
  src/__tests__/pulidJobs.test.ts

# full suite sanity
pnpm test
```

## Expected results

- `typecheck` — clean (no TS errors; cycle check reports only the 1 known
  allow-listed cycle; no-console OK).
- `asyncJobs.test.ts` — **8 pass, 0 fail** (4 pre-existing + 4 new):
  - assigns lanes (default bulk), replaces on re-register, clears on reset
  - claims only the lane's queues, in nextAttemptAt/id order; empty lane claims nothing
  - honors per-call maxConcurrency
  - runs lanes independently — a blocked bulk lane never suppresses the fast lane
- adjacent handlers — **23 pass, 0 fail**.
- full suite — no new failures attributable to this PR.

## Behavioral checks (running server)

1. **Startup classification log** — on boot, exactly one
   `[asyncJobs] worker lanes started` record listing all registered queues under
   their lane (`fast`: `fact_send_back`, `projection_repair`; `render`:
   `image_prompt_generation`, `image_generation`; `bulk`: `enrichment`,
   `fact_enrichment_backfill`, `fact_pexels`, `fact_visual_concepts`, `email`,
   `review_render_prepare`). Every queue appears exactly once. A queue that
   silently missed a lane annotation would show up under `bulk` here.
2. **Lane attribution in logs** — any worker log line carries `[asyncJobs:<lane>]`
   (or a structured `lane` field). No `[asyncJobs:undefined]` anywhere.
3. **Fast lane under load** — with slow `bulk`/`render` jobs in flight, enqueue a
   `fact_send_back` row (or click "Send back to review"): it flips
   `pending → processing → done` within ~1–2 fast ticks (interval 2s), not behind
   the slow batch.
4. **No stuck rows / double-runs** — periodic recovery + retention purge still run
   (from the bulk runner only); confirm no duplicate `[asyncJobs:*] retention
   purge` or recovery sweeps from three lanes.

## SQL / DB checks

None required — **no schema change**. Optional sanity: confirm `async_jobs` rows
still transition normally and `async_jobs_pending_idx` is used by the lane-filtered
claim (`EXPLAIN` of a `status='pending' AND queue = ANY(...) AND next_attempt_at <= now()`
select should hit the partial index).

## Gotchas / notes

- The new `asyncJobsTick` 3rd arg is an **options object** (`{ queues?,
  maxConcurrency?, lane? }`), all optional — a bare `asyncJobsTick(db)` is
  byte-identical to old behavior. That's why the 4 existing tests are unchanged.
- Env overrides (all optional): `ASYNC_JOBS_FAST_INTERVAL_MS`,
  `ASYNC_JOBS_FAST_MAX_CONCURRENCY`, `ASYNC_JOBS_RENDER_INTERVAL_MS`,
  `ASYNC_JOBS_RENDER_MAX_CONCURRENCY`; **bulk keeps the legacy names**
  `ASYNC_JOBS_WORKER_INTERVAL_MS` / `ASYNC_JOBS_MAX_CONCURRENCY` (now scoped to
  bulk only). Intervals are floored at 500ms; invalid values fall back with a
  warning.
- `runAsyncJobsWorker()` no longer takes a positional `intervalMs`. Only the bare
  production call in `index.ts` existed; nothing else passed one.
- Combined worker concurrency is now 2+3+3 = 8 handlers against a default 10-conn
  pool — watch pool acquisition/wait latency under simultaneous lane + HTTP load.

## Deliberately NOT shipped

- Raising the DB pool `max` (separate infra call; 8/10 is workable).
- Admin-config-driven per-lane concurrency; per-queue priority within a lane.
- Moving `email` / `review_render_prepare` out of `bulk`.
- Changing the per-tick `.limit(10)` claim batch size.
