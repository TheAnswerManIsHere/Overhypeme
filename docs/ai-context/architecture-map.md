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
  case **10** concurrent handlers — and `lib/db/src/index.ts` constructs its
  `Pool` **without a `max`**, so the ceiling is node-postgres's own default,
  also **10**. That numeric coincidence is real (nobody picked either number
  to match the other) but it does **not** mean a saturated worker leaves zero
  connections for HTTP traffic. `maxConcurrency` bounds concurrent *handler
  promises*, not checked-out clients: `asyncJobsTick` **commits and releases
  the claim transaction before** `mapWithConcurrency` invokes any handler, a
  handler awaiting an external provider holds no connection at all, and each
  outcome opens only a short finalize transaction. Pool occupancy is
  therefore bursty at claim/finalize boundaries rather than pinned at the
  handler count. Every bound is env-overridable
  (`ASYNC_JOBS_FAST_MAX_CONCURRENCY` etc.), so raising one still raises
  claim/finalize contention against an unchanged pool — the reason raising
  the pool limit is tracked as follow-up work
  ([`current-roadmap.md`](./current-roadmap.md)) — but the headroom cost has
  not been measured, and this doc does not assert one.
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
  moderation (`quarantined_memes`/`ncmec_reports`, `lib/moderation/`).

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
