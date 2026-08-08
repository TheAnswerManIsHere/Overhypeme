# Architecture Map

> A map to orient before modifying code. Paths are concrete and verified against
> the repo; where a boundary is fuzzy it's marked **Needs verification**. Inspect
> the actual files before relying on any summary here.

## Stack overview

- **Monorepo:** pnpm workspaces + TypeScript. Packages under `artifacts/*`,
  `lib/*`, `lib/integrations/*`, `cloudflare/*`, `scripts`.
- **API server:** Express 5, Zod validation (`artifacts/api-server`).
- **Frontend:** React 19 + Vite, TanStack Query (`artifacts/overhype-me`).
- **Database:** PostgreSQL + `pgvector`, Drizzle ORM (`lib/db`).
- **API codegen:** OpenAPI 3.1 + Orval → generated React Query hooks
  (`lib/api-client-react`) and Zod schemas (`lib/api-zod`).
- **Auth:** Replit OIDC + Google/Apple OAuth + local email/password (bcryptjs).
- **Build:** esbuild (backend), Vite (frontend), `tsc` (typecheck).

## Repository layout

```
artifacts/
  api-server/        Express API, domain logic in src/lib/*, routes in src/routes/*, tests in src/__tests__/*
                     (generative engine catalogue lives here: src/lib/engines/ — catalogue.ts, reconcile.ts, one file per engine)
  overhype-me/       React+Vite frontend (pages/, components/, admin under pages/admin & components/admin)
lib/
  db/                Drizzle schema (src/schema/*) + migrations
  api-spec/          OpenAPI spec + codegen (pnpm --filter @workspace/api-spec run codegen)
  api-client-react/  generated React Query client
  api-zod/           generated Zod schemas + shared vocab (moderationWorkflow, taxonomy, renderScenarios, visualPromptStrategies)
  integrations*/     OpenAI / Anthropic / fal.ai / redact integration wrappers
  replit-auth-web/   Replit auth helper
cloudflare/og-router/  Cloudflare Worker (OG image routing); deploy: pnpm worker:deploy
scripts/             operational one-off scripts (e.g. resubmit facts for review)
.agents/memory/      engineering "memory" notes — read these before deep work in a subsystem
docs/                this documentation
```

## Frontend surfaces

- **Public** (`artifacts/overhype-me/src/pages/`): `Home.tsx` (cold vs warm
  visitor), `SubmitFact.tsx`, `TopFacts.tsx` (leaderboard), `Search.tsx`,
  `Hashtags.tsx`, `Profile.tsx`, `ActivityFeed.tsx`, fact detail + comments,
  merch (`WearIt.tsx`). The meme/video builders live under
  `artifacts/overhype-me/src/components/` (not `pages/`): `components/meme-builder/`,
  `MemeStudio.tsx`, `MemeBuilder.tsx`, `VideoBuilder.tsx`, `MemeMagicVideo.tsx`.
- **Admin** (`src/pages/admin/`, wrapped in `components/admin/AdminLayout.tsx`):
  Dashboard, Facts, Users, Moderation, Comments, Billing, Refunds & Disputes,
  Affiliate, Video Styles, Engines, Taxonomy Health, Email Queue, Features,
  Configuration, AI Settings. Shared: `EnrichmentEditor.tsx` (+ `fieldDocs/`),
  `useTaxonomyHealthActions.ts` (async-status reference).
- Prefer the generated React Query hooks (`lib/api-client-react`) for API calls.
  Note this is **not** universal: many surfaces (admin prompt-preview/moderation
  hooks, the meme/video builder flows) intentionally use hand-written `fetch`.
  Match the local surface — don't do unrelated client refactors to "fix" this.

## Backend services and routes

Routes in `artifacts/api-server/src/routes/*`; domain logic in
`artifacts/api-server/src/lib/*`. Notable areas:

- `routes/facts.ts`, `routes/reviews.ts` — submission + moderation lifecycle.
- `routes/ai.ts` — tokenize-fact, suggest-hashtags, check-duplicate.
- `routes/admin.ts` + `routes/admin*.ts` (e.g. `adminImagePrompt.ts`,
  `adminEngines.ts`) — admin surfaces, all guarded by `requireAdmin`.
- `routes/stripe.ts` + webhook handlers — billing/checkout.
- `routes/affiliate.ts` — Zazzle click tracking.
- Domain libs (`artifacts/api-server/src/lib/`): `imagePrompt/`,
  `factImagePipeline.ts`, `factEnrichment*.ts`, `enrichmentVersioning.ts`,
  `taxonomyHealth/`, `factTokenizer.ts`, `videoPipelineRunner.ts`, `engines/`,
  `moderation/` (safety scanners), `stripe*`, `budgetGate.ts`. (The token
  *renderer*, `render-fact.ts`, is a **frontend** file —
  `artifacts/overhype-me/src/lib/render-fact.ts` — not an api-server lib.)

### Health and route-stats endpoints

Diagnostics, not product surfaces — the [Overhype.me Manual](../manual/README.md)
deliberately excludes them and points here instead.

- **`GET /api/healthz`** (`artifacts/api-server/src/routes/health.ts`) — a bare
  liveness check returning `{ status: "ok" }`, validated against the
  `HealthCheckResponse` schema.
- **`GET /api/health`** — the richer endpoint intended for external uptime
  monitors. One read of the newest `stripe_processed_events` row, ordered by
  `processed_at` (**no index on that column** — a plain `event_id` primary key
  is the table's only index today, so this is a scan/sort that gets more
  expensive as webhook history grows), so the uptime check doubles as a
  **webhook-staleness signal** (`lastStripeEvent` carries the event id,
  processed timestamp, and its age in minutes). It **never fails on the
  optional metadata**: a DB error is reported in-band as `lastStripeEventError`
  and the response is still a 200, because the question the monitor is asking
  is whether the API server is up.
- **`GET /api/route-stats`** (`artifacts/api-server/src/routes/routeStats.ts`)
  — the top `n` visited route keys (`n` defaults to 3, capped at 10) from
  `route_stats`. On a query failure it logs and returns an empty list rather
  than erroring.
- **`POST /api/route-stats`** — accepts either `{ route }` (a single visit) or
  `{ counts }` (a session flush of accumulated counts). Both are validated
  against a fixed allowlist of route keys, but the two shapes fail
  differently: an unknown key in `{ route }` is **rejected** with `400
  { error: "Unknown route key" }`, while an unknown key in `{ counts }` is
  **silently dropped** from that batch (per-key deltas must also be positive
  and ≤ 100,000, or that key is dropped too). A valid `{ route }` is answered
  **204**; a `{ counts }` post is answered with how many keys were accepted.
  Counters are upserted into `route_stats` and each accepted delta is also
  appended to `route_stat_events`. Persistence is **best-effort** — a write
  failure is swallowed so counting can never surface as a user-visible error.
  This endpoint is one of the `ORIGIN_EXEMPT_PATHS` (see
  [`security-model.md`](./security-model.md)).

## Database and Drizzle conventions

- Schema per concern in `lib/db/src/schema/*.ts` (e.g. `facts`, `reviews`
  → `pending_reviews`, `engines`, `asyncJobs` → `async_jobs`,
  `factEnrichmentVersions`, `memberships`, `auth`).
- `pgvector` `vector(384)` embedding on `facts.embedding`.
- **Migration tooling caveat:** `drizzle-kit generate` currently fails on a
  malformed snapshot; new migrations use a `SNAPSHOT_EXEMPT_TAGS` workaround plus
  hand-written idempotent `ADD COLUMN IF NOT EXISTS`. See
  [`../engineering/migrations-and-backfills.md`](../engineering/migrations-and-backfills.md).
- Apply schema locally with `pnpm --filter @workspace/db push-force` then
  `pnpm --filter @workspace/db run migrate`.

## Async jobs and queues

- Single durable table **`async_jobs`** (`lib/db/src/schema/asyncJobs.ts`), a
  `queue` discriminator + JSON payload + `dedupeKey` + retry bookkeeping; status
  `pending → processing → done | failed`.
- **Five independent scheduling lanes** (`asyncJobs.ts`, PR #216; `pexels` /
  `ai_meme_backfill` added for the variant-independence bulk-backfill queues)
  — `fast` / `render` / `bulk` / `pexels` / `ai_meme_backfill` — each with its
  own poll timer, closure-local re-entrancy guard, claim-query queue filter,
  and concurrency bound, so a busy lane can never block another's progress:
  - `fast` — `fact_send_back`, `projection_repair` (pure-DB admin actions).
  - `render` — `image_prompt_generation`, `image_generation` (single-item,
    moderator-watched renders).
  - `bulk` (default for any queue that doesn't set `{ lane }`) — `enrichment`,
    `fact_enrichment_backfill`, `fact_visual_concepts`, `email`,
    `review_render_scenarios_prepare`.
  - `pexels` — `fact_pexels`, `maxConcurrency: 1` (preserves the old direct-call
    route's Pexels rate-limit pacing now that the queue is the only path).
  - `ai_meme_backfill` — `fact_ai_meme_backfill`, `maxConcurrency: 1` (paid
    OpenAI/fal.ai calls, processed strictly one fact at a time).
  A queue's lane is set via `registerJobHandler(queue, handler, { lane })`; see
  [`decisions.md`](./decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes).
  (`fal_video` is defined but marked a **future** queue — the video pipeline does
  not yet run through `async_jobs`; check `asyncJobs.ts` for the live list.)
- **Poll intervals are per-lane defaults, all env-overridable.** `fast` 2s;
  `render`, `bulk`, `pexels`, `ai_meme_backfill` 5s each
  (`DEFAULT_*_INTERVAL_MS`, `asyncJobs.ts`), each overridable via
  `ASYNC_JOBS_FAST_INTERVAL_MS` / `_RENDER_` / `_WORKER_` / `_PEXELS_` /
  `_AI_MEME_BACKFILL_INTERVAL_MS`. Env override is the **only** way to change
  them — the old `intervalMs` argument is gone.
- **Lane is orthogonal to retry and dedupe; ordering is per-lane, not
  global.** `{ lane }` selects *scheduling* only — retries and dedupe behave
  identically in every lane. **Claim ordering is the exception to state
  carefully:** the claim query's `ORDER BY nextAttemptAt, id` is unchanged by
  lane, but it runs *inside a queue-filtered query* driven by that lane's own
  runner and timer, so it orders rows **within** a lane only. There is no
  global FIFO across lanes — a newer `fast` row is routinely claimed ahead of
  an older `bulk` one, which is the entire point of the split. Retry budget is
  an **enqueue-time** option on the queue, which is
  why `fact_ai_meme_backfill` enqueues with **`maxAttempts: 1`**
  (`aiMemeBackfillJobs.ts`) and is therefore **never retried automatically**.
  The reason is that a retry could not help, not that it would cost twice:
  the handler opens with a **replay guard** keyed on `facts.aiMemeBackfillStatus`,
  and a failing attempt stamps that column `"failed"` before returning — so a
  second attempt exits at the `existing === "failed"` branch **without calling
  `generate` at all**. Extra attempts would burn the budget and delay
  abandonment while doing nothing. The guard refuses rather than resumes
  because there is nothing to resume from: `generateAiMemeBackgrounds` uploads
  each slot's image as it goes but writes `facts.aiMemeImages` **once, after
  the whole slot loop** (`aiMemePipeline.ts`), so a late-slot failure leaves
  the fact with no record of the earlier successes even though their paid
  OpenAI/fal.ai calls and uploads already happened. Note `maxAttempts: 1` also
  means `onAbandon` fires on the very first failure.
- **Handler concurrency is not pool occupancy — don't equate them.** Per-lane
  `maxConcurrency` defaults are `fast` 2, `render` 3, `bulk` 3 (both from
  `ASYNC_JOBS_MAX_CONCURRENCY`), `pexels` 1, `ai_meme_backfill` 1 — worst
  case **10** concurrent handlers. `lib/db/src/index.ts` now sets the pool
  `max` explicitly to **20** (`POOL_MAX_DEFAULT`, overridable by
  `DB_POOL_MAX`), derived from measured production capacity rather than
  picked — deliberately double the lanes' worst case. **It was unset until
  the async-queue hardening work (PR #288)**, which meant pg's default of 10
  against a worst-case demand of exactly 10.
  Even so, do not read handler count as connection count in either
  direction: `maxConcurrency` bounds concurrent *handler promises*, not
  checked-out clients. `asyncJobsTick` **commits and releases the claim
  transaction before** `mapWithConcurrency` invokes any handler, and each
  outcome opens only a short finalize transaction. **But occupancy is not
  confined to those two boundaries** — handlers do their own DB work while
  running (`factSendBackHandler` → `sendFactBackToReview` holds a transaction
  across several reads and writes; the enrichment and image handlers query
  too), so a handler *can* occupy a connection during its promise. What it
  reliably does **not** do is hold one while awaiting an external provider,
  which for the provider-bound lanes is most of a job's wall-clock. Occupancy
  is therefore workload-dependent and bursty rather than pinned at the handler
  count — which is why the old 10-vs-10 framing overstated the problem even
  before the ceiling was raised. Every lane bound is env-overridable
  (`ASYNC_JOBS_FAST_MAX_CONCURRENCY` etc.), so a raised lane still adds
  claim/finalize contention; the headroom cost of that has never been
  measured and this doc does not assert one.
- **Stranded-row recovery is delayed by design (PR #283).** Claim commits
  `processing` *before* the handler runs, so a crash — **or a rejection in the
  finalize transaction after the handler returned** — leaves the row committed
  as `processing`. `recoverStuckProcessing` requeues such rows to `pending`,
  but **only** those whose `updatedAt` (stamped at claim) is older than
  `RECOVER_STUCK_CUTOFF_MIN = 30` minutes, swept every `RECOVER_INTERVAL_MS`
  (60s) by the **`bulk` runner only** (table-wide, so one owner is correct)
  plus one sweep at boot. 30 minutes is a **floor, not a bound**: the age
  comparison is strict, the sweep runs at most once a minute, and maintenance
  happens only *after* the `bulk` lane's own tick finishes (overlapping timer
  callbacks return early on the re-entrancy guard), so a long-running bulk
  handler pushes recovery further out. That cost is deliberate: this
  deployment is
  `deploymentTarget = "autoscale"` with the worker started in **every**
  instance, so too aggressive a cutoff reclaims a *different live instance's*
  in-flight row and both runs execute — for `email`, a duplicate send to a
  real person. The cutoff is load-bearing only because finalize matches on row
  id with **no fencing token**; the real fix (lease tokens + fenced finalize)
  is Phase 3a in
  [`deferred-work.md`](../engineering/deferred-work.md#code-level-tech-debt).
  The boot path passes the cutoff explicitly so it can never silently use a
  shorter one.
- Per-fact status mirrors on `facts` (`enrichmentStatus`, `pexelsStatus`,
  `visualConceptStatus`: `pending | ok | failed`).
- **Enqueue is not completion** — never report a job "done" at enqueue time; poll
  its terminal state. UI must show per-item + aggregate status (see
  [`known-failure-patterns.md`](./known-failure-patterns.md)).
- **`HandlerResult` failures are terminal or retryable, additively (PR #224).**
  The historical `{ ok: false, error }` shape still means "retryable" (backoff,
  retry up to `maxAttempts`) with zero change to existing handlers. A handler
  may opt in to `{ ok: false, error, retryable: false, code }` — built via the
  `terminalFailure(code, message)` helper — for a **deterministic** failure
  (re-running the same frozen inputs can't change the outcome): the worker
  marks the row `failed` after the first attempt instead of retrying, and does
  **not** fire `onAbandon` (that hook's contract is "retries exhausted," which a
  first-attempt terminal isn't). The image-prompt handler is the first
  consumer — see
  [`visual-pipeline.md`](./visual-pipeline.md#terminal-vs-retryable-render-failures).

### Worker liveness heartbeats + the Queue Health surface (Phase 1, PR #288)

- **`worker_lane_heartbeats`** (`lib/db/src/schema/workerLaneHeartbeats.ts`),
  keyed `(instance_id, lane)` — `instance_id` is a process-start
  `randomUUID()`, **not** a deployment identifier, so every autoscaled
  instance gets its own row per lane instead of the fleet collapsing onto one
  row (which would let a wedged worker hide behind a healthy peer).
  `worker_protocol_version` is a capability marker (`1` today) for a future
  Phase 3 lease-fence check, not a release identifier. The write moments are
  each load-bearing:
  - `last_scheduled_at` stamps on **every** timer fire, including the
    re-entrancy early-return, so a lane whose timer fires while its previous
    tick is still running reads as healthy-but-slow, not dead. The write is
    `GREATEST(stored, incoming)`, not an unconditional overwrite — two racing
    ticks under pool contention can commit out of order, and an unconditional
    write would let the *older* one's timestamp land last and move the
    column backward past the stale threshold.
  - `in_flight_count` publishes as soon as the claim transaction commits,
    **before** any handler is awaited — a completion-only write would leave a
    wedged tick's count at zero and the (Phase 2) wedged-lane condition could
    never fire in the one case it exists for. It then **decrements per-job**,
    right after each claimed job settles (not only once at the end of the
    whole batch) — so during a tick where jobs finish at different times, the
    count reflects the remaining long tail rather than the original claimed
    batch size.
  - `last_tick_completed_at` stamps only on completion, clearing the count
    there so a lost decrement self-corrects on the next tick instead of
    leaving a healthy lane looking permanently wedged.
  - Departed instances (an autoscale scale-down) are pruned on a purge
    cadence — this bounds the table's growth as instances churn, **and it
    is liveness-critical, not merely retention**: the prune cutoff must
    never be narrower than `laneHealth`'s own live-cutoff predicate (below),
    because a row deleted before the query's cutoff would have excluded it
    is indistinguishable from that row never having existed — the query can
    only correctly evaluate a row that's still there when it runs. See the
    widened-cutoff coupling below for why both are wired to the identical
    formula.
- **Per-lane "stalled" is `max(3× the lane's poll interval, 60s)`** of no
  `last_scheduled_at` movement — at every current lane's **default** interval
  (2s or 5s), the 60s floor is what actually governs, so a stall means
  roughly 12–30 missed ticks, not three; the "three missed intervals" framing
  only holds once a lane's interval is at least ~20s. Every lane's interval
  is independently environment-configurable (`ASYNC_JOBS_*_INTERVAL_MS`),
  with no aggregate constraint tying it to the 60s floor, so an operator
  raising an interval past ~20s genuinely shifts which term governs — this
  isn't just a default-vs-hypothetical distinction. **Two independently-configurable
  knobs feed the same liveness check and must stay coupled at every
  consumer, not just the primary read path**: the heartbeat TTL
  (`admin_config`) and each lane's own stale threshold. A TTL shorter than a
  lane's threshold would, if left unwidened, exclude the row from the
  query before the per-lane threshold check ever ran; the live-instance
  query cutoff is `max(configured TTL, the widest stale threshold across
  all lanes)`. Review caught that the periodic `pruneDepartedInstances()`
  delete sweep (which runs on its own schedule, independent of any query)
  needed the **identical** widened cutoff, and this is **liveness-critical,
  not optional retention**: if the row physically no longer exists when
  the query runs, the query's own correctly-widened predicate has nothing
  left to evaluate — a prematurely-deleted row and a wrongly-excluded row
  produce the identical wrong outcome (`lastScheduledAt: null` →
  `stalled: true`), so the query's predicate being logically correct in
  isolation does not make the verdict correct unless the row it needs is
  still there. **Both consumers are now wired to the same formula**
  (`asyncJobs.ts:936-938` computes `widenedTtlMinutes =
  max(configuredTtlMinutes, widestStaleThresholdMs() / 60_000)` and passes
  it into `pruneDepartedInstances`, matching `laneHealth`'s own
  `liveCutoff`) — since both cutoffs are always the same timestamp at
  evaluation time, prune can never delete a row before the query's own
  cutoff would already have excluded it, which is what keeps the `stalled`
  verdict correct. Losing this coupling (e.g. a future change that
  widens the query cutoff without widening prune's) would silently
  reintroduce false stalls, not just shrink a retention window — treat the
  two cutoffs as one invariant, not two independent tuning knobs.
- **Three read surfaces**, all derived by query — no `async_jobs` or
  heartbeat state is written by a reader (the two admin-authenticated
  endpoints do write `rate_limit_counters` on every request, via the same
  `checkSharedRateLimit()` every rate-limited admin route uses — unrelated
  to queue/lane state):
  - `GET /api/admin/queue-health` — aggregate altitude. Per queue: the four raw
    status tallies, two derived states (below), oldest-pending age, 24h
    throughput. Per lane: live instance count, heartbeat ages, in-flight
    count, fleet-wide stalled verdict. The two related queries run inside one
    `repeatable read` transaction so a job finalizing mid-read can't produce
    an internally impossible snapshot (e.g. `failed: 0` alongside
    `abandonedNoRetry: 1`).
  - `GET /api/admin/queue-health/jobs` — per-item altitude, paginated, capped
    at 100.
  - `GET /api/health/queues` — **unauthenticated** liveness probe (mounted
    under `/api`, not bare `/health/queues` — the app mounts routes there via
    `app.use("/api", router)` in `app.ts`). On total API-process death this
    route is as unreachable as any other (`/api/health`, `/api/healthz`) — an
    external monitor just sees the same connection failure either way, so
    that isn't what's distinctive about it. The aggregate endpoint above
    already reports the same fleet-wide `stalled` verdict per lane — as JSON
    data, always behind a 200 (`/admin/queue-health` never sets a non-200
    status for a stalled lane, only for a request-level failure). What the
    probe uniquely adds is turning that verdict into the **HTTP status code
    itself**: a meaningful non-200 while the **process itself is alive**, so
    a monitor doesn't have to parse a body to detect the problem — it returns
    503 when every worker has stopped scheduling a lane fleet-wide, **and**
    fails closed with the same 503 shape if evaluating lane health itself
    throws (e.g. the DB query fails) — a genuinely unhealthy-looking response
    rather than the looks-fine-while-broken shape this endpoint exists to
    prevent. Returns only `{ok, ts, laneCount, stalledLaneCount}` — no queue
    names, payloads, or error text, on either path — and a routine
    autoscale scale-down (one instance quietly going away) never trips it,
    since only a fleet-wide stall or an evaluation failure does.
- **Two derived display states**, because raw `async_jobs.status` collapses
  distinctions the async-UI contract ([`async-ui-status.md`](./async-ui-status.md))
  requires as first-class:
  - `skipped` — a handler-level skip finishes as `done` with
    `result.skipped`; the reason is sanitized against the existing
    `TAXONOMY_HEALTH_SKIP_REASON_VALUES` enum rather than echoing arbitrary
    handler text to an admin surface.
  - `abandoned_no_retry` — a row is `failed` with **either** `attempts <
    effectiveMax` (only reachable via `terminalFailure()`, since the
    exhaustion path can only mark a row `failed` once `attempts >=
    effectiveMax`) **or** `effectiveMax <= 1` (a single-attempt queue has no
    retry budget regardless of *why* the one attempt failed — via
    `terminalFailure()`, or via the ordinary exhaustion path on attempt 1,
    which is not necessarily deterministic: `fact_ai_meme_backfill` enqueues
    at `maxAttempts: 1` but its handler returns the ordinary retryable
    `{ ok: false, error }` shape on a transient paid-API failure, not
    `terminalFailure()`) — i.e. "the worker won't retry this," a different
    operator story from "retries exhausted." See
    [`decisions.md`](./decisions.md#2026-07-30--queue-health-classification-persists-the-retry-ceiling-at-finalization-instead-of-re-deriving-it-live)
    for why this reads the row's own **persisted** `maxAttempts`, not a live
    re-resolve of `admin_config`, and why a legacy `0`-sentinel row is
    deliberately classified conservatively (plain `failed`) rather than risk
    the same misclassification on data that can't be resolved safely.
- **The connection pool's `max` is now an explicit constant, 20**, not pg's
  implicit default of 10 (`lib/db/src/index.ts`). 20 is **offline-derived,
  not runtime-computed** — the code hardcodes `POOL_MAX_DEFAULT = 20` and
  reads no `max_instances` value; nothing shrinks or grows it automatically
  as the fleet scales. The comment above that constant records the
  one-time arithmetic that produced it: production measured `max_connections`
  450, 7 superuser-reserved, ~13 in use on a live app (direct connection, not
  pooled) → `budget = 450 − 7 − 5 (migration/console/admin burst) − 40
  (headroom) = 398`, `max = min(20, floor(398 / max_instances))` evaluated
  by hand at the observed fleet size, not by the running process. 20 doubles
  the five lanes' **default** worst-case simultaneous demand (fast 2 +
  render 3 + bulk 3 + pexels 1 + ai_meme_backfill 1 = 10) and holds for any
  autoscale ceiling up to 19 instances at those defaults; past 19 instances
  (or with `DB_POOL_MAX` unset and a larger fleet), the constant does **not**
  adjust itself — an operator must manually re-run the `floor(398 / N)`
  arithmetic for the new ceiling and set `DB_POOL_MAX` explicitly. Each
  lane's concurrency is independently
  environment-configurable (`ASYNC_JOBS_FAST_MAX_CONCURRENCY`,
  `_RENDER_`, `_PEXELS_`, `_AI_MEME_BACKFILL_MAX_CONCURRENCY`, and the
  `bulk`-lane/legacy fallback `ASYNC_JOBS_MAX_CONCURRENCY`) with **no
  aggregate cap** tying them together — raising any of these past its
  default moves the real worst-case demand above 10, so `DB_POOL_MAX` needs
  reconsidering whenever lane concurrency changes, not only when the
  autoscale ceiling does. This closes the "no default spare connection" gap
  the five-lane expansion (PR #256, adding `pexels`/`ai_meme_backfill` on top
  of PR #216's original fast/render/bulk split) had left as follow-up work,
  at default concurrency settings.

## Storage / CDN

- Images persist to **Google Cloud Storage** via the Replit sidecar today. (The
  stated long-term intent is Cloudflare R2 — **not yet done**; treat GCS as
  current truth.)
- **Cloudflare Worker** at `cloudflare/og-router/` handles OG image routing;
  edit in code and `pnpm worker:deploy` (never ask for dashboard changes). A
  Google-infra `GAESA` cookie breaks X/Twitter OG cards and is fixed at the
  Worker layer — see `docs/cloudflare-gaesa-og-fix.md`.

## AI / vendor integration points

- **OpenAI** — tokenization, enrichment classification (Structured Outputs),
  embeddings (`text-embedding-3-small`, 384-dim), and the visual planner.
  **Never route OpenAI through a Replit proxy** — direct `OPENAI_API_KEY` only
  (`.agents/memory/openai-no-replit-proxy.md`).
- **fal.ai** — image + video generation (Nano Banana family, PuLID identity,
  Kling video, etc.) and safety scanning.
- **Stripe** — billing/subscriptions/webhooks.
- **Resend** — transactional email. **hCaptcha** — submission captcha.
- **Sentry** — error reporting (telemetry spans three tabs; see `docs/SENTRY.md`).
- Generative models are configured **code-first** in
  `artifacts/api-server/src/lib/engines/` (`catalogue.ts`, `reconcile.ts`, one file
  per engine) and reconciled into the `engines` table at boot; admin owns
  `isActive`/`isDefault`/pricing.

## Admin and moderation surfaces

- Admin gate: single `is_admin` (via DB flag, `ADMIN_USER_IDS` env, or bootstrap
  email); `requireAdmin` on every admin route. No multi-role model.
- Two **separate** moderation systems: content-quality review
  (`pending_reviews` + workflow stages — see
  [`moderation-workflow.md`](./moderation-workflow.md)) and legal/safety
  moderation (`quarantined_memes`/`ncmec_reports`, `lib/moderation/`). The
  latter now has a real NCMEC CyberTipline reporting implementation
  underway (schema + ISPWS HTTP client shipped in PR #293, phases 1–2 of
  8 — see [`current-roadmap.md`](./current-roadmap.md#in-progress-slices));
  `submitNcmecReport()` remains a stub (DB row + admin email, no live filing)
  until the worker and reconciler land in later phases. **No dedicated
  `/admin/safety` surface exists yet** — the seeded NCMEC keys are visible
  and editable today only through the generic `/admin/config` cards (the
  five filing-capable ones reject writes with a 403 per phase 1's
  reserved-key guard; `ncmec_safety_alert_email` and the two retry keys stay
  plain editable cards). No manual chapter yet either, since there's no
  purpose-built UI to document.

## Test structure

- API DB-backed tests: `artifacts/api-server/src/__tests__/*.test.ts`, run via the
  isolated runners (never raw `node --test`). See
  [`../engineering/testing-guide.md`](../engineering/testing-guide.md) and
  `docs/TESTING.md` (canonical).
- Frontend: Vitest under `artifacts/overhype-me`.
- **GitHub CI is the authoritative gate** (`Build` + `Test` required on PRs to
  `main`).

## Where to inspect before common tasks

| Task | Read first |
| --- | --- |
| Visual pipeline / prompts / renders | [`visual-pipeline.md`](./visual-pipeline.md), `imagePrompt/`, `.agents/memory/image-prompt-preview-parity.md` |
| Moderation flow | [`moderation-workflow.md`](./moderation-workflow.md), `lib/api-zod/src/moderationWorkflow.ts`, `routes/reviews.ts` |
| Enrichment / taxonomy | [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md), `factEnrichment*.ts`, `enrichmentVersioning.ts`, `taxonomyHealth/` |
| Tokenizer / grammar | [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md), `factTokenizer.ts`, `templateGrammar.ts`, `render-fact.ts` |
| Schema / migration / backfill | [`../engineering/migrations-and-backfills.md`](../engineering/migrations-and-backfills.md), `lib/db/src/schema/*` |
| Billing | `routes/stripe.ts`, `stripe*`, `lib/db/src/schema/memberships.ts` |
| Async jobs | `lib/db/src/schema/asyncJobs.ts`, the `*Jobs.ts` handlers |
