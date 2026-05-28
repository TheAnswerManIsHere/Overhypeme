# Fact Enrichment Extension (Phase 2A Bridge) — Automated test run

This is the engineering-side checklist for the Phase 2A bridge work shipped on
`claude/visual-taxonomy-prompt-arch-cb8up`. It exercises five pieces of
infrastructure that landed together:

1. **OpenAI direct-client migration** (`OPENAI_API_KEY` direct; the Replit
   connector vars are an env-driven fallback for rollback).
2. **Shared schema additions** — `culturalReferences[]`, `visualPromptPreview`,
   strict "wire" mirrors for OpenAI Structured Outputs.
3. **Prompt-strategy module** (`promptStrategy/` — types, guardrails with the
   supporting-text policy, `STRATEGY_MAP` with 11 stubbed archetype entries,
   visual-preview generator).
4. **Generalized async-jobs queue** — `email_outbox` renamed to `async_jobs`,
   one polling worker, registered handlers (`email` + `enrichment` +
   `preview`). Migration 0063.
5. **Phase 2A feature wiring** — submit-review enqueues "enrichment";
   `/admin/reviews/:id/{enrich,preview}` endpoints; `/admin/facts/:id/preview`
   for backfilled facts; hard approval gate (server + UI).

The User Acceptance Test is in [`PHASE_2A_UAT.md`](./PHASE_2A_UAT.md) — that's
for David to walk through in a browser.

---

## TL;DR

```bash
# 0. Test DB is up (session-start hook).
export DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test"

# 1. Apply the new migration (0063 — email_outbox → async_jobs).
pnpm --filter @workspace/db run migrate

# 2. Validate the migration snapshot chain (chain now has 50 snapshots).
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck (libs + api-server + frontend).
pnpm run typecheck

# 4. Server tests for the touched surface.
cd artifacts/api-server && \
  DATABASE_URL="$DATABASE_URL" TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test \
    src/__tests__/factEnrichment.test.ts \
    src/__tests__/routes.reviews.test.ts \
    src/__tests__/routes.admin.auth.test.ts \
    src/__tests__/routes.share.test.ts \
    src/__tests__/routes.localAuth.test.ts \
    src/__tests__/routes.users.test.ts \
    src/__tests__/webhookHandlers.integration.test.ts \
    src/__tests__/adminEmailQueue.delete.test.ts

# 5. Frontend tests.
cd ../overhype-me && pnpm exec vitest run
```

Expected: migration applies, snapshot chain valid (50 snapshots), typecheck
green, **factEnrichment 15 / routes.reviews 24 / routes.admin.auth 121 /
routes.share / routes.localAuth / routes.users / webhookHandlers /
adminEmailQueue.delete** all pass with 0 failures, frontend **494** tests pass.

If everything above is green you can stop. Sections below break each step out.

---

## A — Setup gate

### A1. Direct OpenAI client

`getOpenAIClient()` now prefers `OPENAI_API_KEY` (direct → `api.openai.com`).
The Replit-connector vars (`AI_INTEGRATIONS_OPENAI_API_KEY` +
`AI_INTEGRATIONS_OPENAI_BASE_URL`) remain a fallback so the migration is
reversible by env. With `OPENAI_API_KEY` set:

```bash
node -e "import('@workspace/integrations-openai-ai-server').then(m => { const c = m.getOpenAIClient(); console.log('baseURL:', c.baseURL ?? 'default api.openai.com'); })"
```

Pass criterion: prints either `default api.openai.com` (no baseURL — direct path)
or the proxy URL (fallback path), based on which env var is set.

### A2. Migration applies cleanly

```bash
pnpm --filter @workspace/db run migrate
```

Pass criterion: `Applying 0063_async_jobs_generalize` runs without SQL errors.
Verify the rename + payload backfill preserved any existing email rows:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT count(*) FROM async_jobs WHERE queue='email';"
```

### A3. Schema chain valid

```bash
pnpm --filter @workspace/db run check-snapshots
```

Pass criterion: `Snapshot chain is valid (50 snapshots, all prevId links correct).`

### A4. New table shape

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c "\d async_jobs"
```

Pass criteria: columns include `id, queue, payload jsonb NOT NULL, external_id,
result jsonb, dedupe_key, status, attempts, max_attempts, next_attempt_at,
last_error, created_at, updated_at`. Indexes include
`async_jobs_pending_idx (queue, next_attempt_at) WHERE status='pending'`,
`async_jobs_status_created_idx (queue, status, created_at DESC)`,
`async_jobs_dedupe_idx UNIQUE (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing')`.

### A5. Status vocabulary normalized

Legacy email rows had `sending|delivered|abandoned`; the migration normalizes
to the generic `pending|processing|done|failed`. Quick check:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT DISTINCT status FROM async_jobs;"
```

Pass criterion: only `pending`, `processing`, `done`, `failed` appear (or
nothing if the table is empty). No `sending`/`delivered`/`abandoned`.

### A6. Visual-preview config seeded

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT key FROM admin_config WHERE key LIKE 'fact_visual_preview_%' ORDER BY key;"
```

Pass criterion: `fact_visual_preview_system` present.

---

## B — Server tests

Run from `artifacts/api-server`:

```bash
DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
node --import tsx/esm --test \
  src/__tests__/factEnrichment.test.ts \
  src/__tests__/routes.reviews.test.ts \
  src/__tests__/routes.admin.auth.test.ts \
  src/__tests__/routes.share.test.ts \
  src/__tests__/routes.localAuth.test.ts \
  src/__tests__/routes.users.test.ts \
  src/__tests__/webhookHandlers.integration.test.ts \
  src/__tests__/adminEmailQueue.delete.test.ts
```

Pass criterion: all suites pass, 0 fail.

### B1. factEnrichment (15) — taxonomy validation + orchestration + persistence

The `VALID` fixture now includes `culturalReferences: []` (load-bearing for the
back-compat default). Orchestration tests inject a `callModel` so they don't
hit the live OpenAI API — the live call now uses Structured Outputs but the
tests stay shape-compatible.

### B2. routes.admin.auth (121, +2)

The `ADMIN_AUTH_ROUTES` registry gained `POST /admin/facts/:id/preview` (new).
The completeness check still passes; if it fails, the registry and
`adminRouter` have drifted.

### B3. routes.reviews + share + localAuth + users + webhookHandlers

These all import the email-row table for cleanup or assertions; updated to use
`asyncJobsTable` with `queue='email'` + jsonb-payload access. They exercise the
end-to-end flow that emails are still enqueued via the renamed table.

### B4. adminEmailQueue.delete

DELETE `/admin/email-queue?status=…` covers the normalized status vocabulary
(`done`/`failed`/`pending`).

> **Removed:** `emailOutbox.test.ts` — the worker mechanics moved into the
> generic `asyncJobsTick`. A focused `asyncJobs.test.ts` is a worthwhile
> follow-up.

---

## C — Manual API smoke (curl)

The new and changed endpoints, in order.

### C1. Submit a review → "enrichment" job enqueued

```bash
curl -i -s -X POST -H "Cookie: <user-session>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Sharks have a David Week."}' \
  http://localhost:<api-port>/api/facts/submit-review
```

Pass criteria:
- `201 { success: true, reviewId }`.
- `pending_reviews` row has `enrichment_status = 'pending'`.
- `async_jobs` row exists with `queue='email'` (the admin notify) and one with
  `queue='enrichment'` (the classification job), the latter with
  `dedupe_key='enrichment:<reviewId>'` and `payload={"reviewId":<id>}`.

With `OPENAI_API_KEY` configured, the worker picks the enrichment row up on
the next tick (≤30s) and writes the blob; if not configured, the row marks
`failed` and the admin UI falls back to the manual-fill path.

### C2. List the queue

```bash
curl -s -H "Cookie: <admin-session>" \
  "http://localhost:<api-port>/api/admin/email-queue" | jq '.rows[0]'
```

Pass criterion: response is the flattened-payload shape the UI expects (`to`,
`subject`, `text`, `html`, `kind`, plus `status` etc.) — no raw `payload jsonb`
leaking to the client.

### C3. Re-run classification

```bash
curl -i -s -X POST -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/reviews/<reviewId>/enrich
```

Pass criterion: `200 { success:true, enrichmentStatus:"pending" }`. A new
`enrichment` job appears in `async_jobs`.

### C4. Regenerate preview only

```bash
curl -i -s -X POST -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/reviews/<reviewId>/preview
```

Pass criteria:
- `200 { success:true, previewStatus:"pending" }`.
- Stored `enrichment.previewStatus` flips to `pending`; `visualPromptPreview`
  is left intact until the worker overwrites it on success.
- 400 with explanatory copy if stored enrichment is missing/invalid.

### C5. Hard approval gate

```bash
# Approve without enrichment OR without preview should 400.
curl -i -s -X POST -H "Cookie: <admin-session>" \
  -H "Content-Type: application/json" -d '{}' \
  http://localhost:<api-port>/api/admin/reviews/<reviewId>/approve
```

Pass criterion: `400` with body
`{ error: "A valid enrichment is required before approval. ..." }`
**or** (if stored enrichment is valid but no preview)
`{ error: "A visual prompt preview is required before approval. ..." }`.

A subsequent approve with the full edited blob in the body (including a
non-empty `visualPromptPreview`) succeeds with `200` and the fact is inserted.

### C6. On-demand fact preview

```bash
curl -i -s -X POST -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/facts/<factId>/preview
```

Pass criteria:
- `200 { success:true, previewStatus:"pending" }` when the fact has enrichment.
- `400` with explanatory copy when the fact has no enrichment (admin should
  run backfill first).
- After the worker runs, `facts.enrichment.visualPromptPreview` is populated.

---

## D — async-jobs worker smoke

### D1. Worker runs and drains

Start the dev server; check the logs every ~30s for the tick. Insert a
synthetic enrichment job:

```sql
INSERT INTO async_jobs (queue, payload, dedupe_key)
VALUES ('enrichment', '{"reviewId":<some-real-pending-review-id>}', 'enrichment:test:1');
```

Pass criterion: within ~30s the row transitions `pending → processing → done`
(or `failed` if OpenAI isn't configured). The pending_review's
`enrichment_status` updates accordingly.

### D2. Dedupe

Insert the same row twice (same `dedupe_key`); the second insert no-ops via
the partial unique index. Confirm via the dedupe-conflict log entry:

> `[asyncJobs] enqueue dedupe — pending/processing row exists`

### D3. Retry + abandon

Without `OPENAI_API_KEY` set (so enrichment fails immediately), enqueue a
preview job and watch the row attempts climb. After `max_attempts` (default 5,
per-queue overrideable via `async_job_<queue>_max_attempts`) the row reaches
`failed`. The target's `previewStatus` is also `"failed"`.

### D4. Stuck-row recovery

Manually leave a row `processing` (e.g. update by hand) older than 5 minutes,
restart the server, watch the boot log:

> `[asyncJobs] startup recovery …`

Pass criterion: the row transitions back to `pending` and is picked up on the
next tick.

### D5. Retention purge

Per-queue retention via admin_config (`async_job_<queue>_retention_days`,
default 30) — done/failed rows older than the cutoff are deleted on each tick.
The email handler retains rows whose payload `kind` starts with
`admin_abandoned_email_alert` (the addended `retainDuringPurge` hook).

---

## E — What's deliberately not in this PR

- **No new server-side tests** for the new validators (cultural refs / visual
  preview) or the generic worker — covered by typecheck + the existing
  end-to-end flows. A focused `asyncJobs.test.ts` + cultural-ref/preview unit
  tests are a worthwhile follow-up.
- **Strategy-map content** — David authors the per-archetype strategy text
  (TODO markers seeded in `lib/promptStrategy/strategyMap.ts`). Previews are
  intentionally thin until content lands.
- **Fal i2i / i2v polling migration** onto `async_jobs` — the `external_id`
  column is reserved; a future PR moves the blocking `fal.subscribe` + the
  in-memory `Map<jobId, JobState>` onto the same durable queue.
- **Backfill-enrichment is still in-process** (sequential admin-triggered
  loop). The on-demand fact preview *is* on the queue.

---

## F — Environment

Real classification + preview requires:

```
OPENAI_API_KEY          # direct OpenAI key — preferred
# or, for rollback fallback:
AI_INTEGRATIONS_OPENAI_API_KEY
AI_INTEGRATIONS_OPENAI_BASE_URL
```

Without either, every OpenAI call throws and enrichment/preview marks `failed`
gracefully. Submission and email delivery are unaffected.
