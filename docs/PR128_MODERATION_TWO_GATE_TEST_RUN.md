# Two-gate fact moderation — engineering test run

**PR:** #128 · **Companion:** [`PR128_MODERATION_TWO_GATE_UAT.md`](./PR128_MODERATION_TWO_GATE_UAT.md)

This is the automated/technical checklist for the safety net. It covers the
cost-gated two-gate lifecycle, the durable `fact_pexels` image-prep queue, the
staging-fact prep-status hydration, and the codegen fix.

## Schema / migrations

Apply migrations against your database, then confirm:

- `facts.pexels_status` exists (`varchar(16)`, nullable) — migration
  `0075_facts_pexels_status.sql`. Source of truth: `lib/db/src/schema/facts.ts`.
- `pending_reviews` still has the `review_workflow_stage` enum + `staging_fact_id`
  + production-rejection columns from `0074_review_workflow_stage.sql` (added
  earlier in this branch).
- Migration journal includes idx 74 and 75; both are in `SNAPSHOT_EXEMPT_TAGS`
  in `lib/db/scripts/check-migration-snapshots.ts` (hand-authored DDL, no
  drizzle snapshot).

```bash
# from lib/db
pnpm run check-snapshots      # expect: all journal entries have snapshots or are exempt
```

`pexels_status` lifecycle: `pending` (set when the queue job is enqueued / on
provisional approve) → `ok` (photos persisted) → `failed` (ONLY after the queue
exhausts retries, via onAbandon). Null = never ran prep through the queue
(legacy rows; live-fact edits that fire-and-forget via `runFactImagePipeline`).

## Typecheck / static checks

```bash
bash scripts/typecheck.sh                                   # api-zod, db, api-server (tsc -b)
pnpm --filter @workspace/overhype-me run typecheck          # frontend (tsc -b)
pnpm --filter @workspace/api-server run check:cycles        # 1 known allow-listed cycle
pnpm --filter @workspace/api-server run check:no-console    # OK (2 allow-listed)
```

All expected clean. Note: `scripts/typecheck.sh` runs `api-spec` codegen, which
**rewrites** `lib/api-zod/src/index.ts` from the hardcoded list in
`lib/api-spec/patch-generated.mjs`. This PR adds the missing
`export * from "./moderationWorkflow";` line there — **verify it survives
codegen**:

```bash
pnpm --filter @workspace/api-spec run codegen
grep -c moderationWorkflow lib/api-zod/src/index.ts   # expect: 1
```

Without that line, codegen drops the `ReviewWorkflowStage` exports and the whole
api-server + frontend typecheck fails (`TS2305: has no exported member
'ReviewWorkflowStage'`). This was a latent bug from the earlier commits on the
branch.

## Tests

```bash
# from artifacts/api-server (Replit owns DATABASE_URL)
npx tsx --test src/__tests__/routes.reviews.test.ts
```

Expected: **50 pass, 0 fail.** Key cases added/extended in this PR:

- `POST /admin/reviews/:id/provisional-approve`
  - creates exactly one inactive staging fact, enters `prep_pending`, enqueues
    **one** `enrichment` job **and one** `fact_pexels` job; staging fact
    `pexels_status = "pending"`.
  - idempotent re-click: no second fact, no duplicate enrichment/pexels job.
- `GET /admin/reviews/:id`
  - `stagingFact` is `null` before provisional approval.
  - after provisional approval, `stagingFact` hydrates with
    `enrichmentStatus = "pending"`, `pexelsStatus = "pending"`, `isActive = false`.
  - `GET /admin/reviews?status=pending` list rows carry the same lightweight
    `stagingFact` prep slice.
- `fact_pexels` handler (`runFactPexelsJob` / `factPexelsJobHandler`):
  - **success** seeds images and leaves `workflow_stage` untouched (Pexels never
    gates).
  - **cost guard**: skips `deps.seed` when the linked review left `prep_pending`
    (returns ok no-op).
  - **retryable failure**: returns `{ok:false}` and leaves `pexels_status =
    "pending"` (still running) — NOT "failed".
  - **onAbandon**: marks `pexels_status = "failed"` without touching the stage.
- COST GATE (submission): `POST /facts/submit-review` enqueues **no** `enrichment`
  or `fact_pexels` jobs.

## Manual / queue smoke (optional, needs OpenAI + Pexels keys + worker running)

- Provisionally approve a review → confirm an `async_jobs` row with
  `queue = 'fact_pexels'`, `payload->>'factId'` = the staging fact id, dedupe key
  `fact_pexels:fact:<id>`.
- Let the worker drain it → `facts.pexels_images` populated,
  `facts.pexels_status = 'ok'`.
- Backfill: `npx tsx src/scripts/backfill-fact-pexels.ts --dry-run` lists active
  facts missing `pexels_images`; without `--dry-run` it enqueues `fact_pexels`
  jobs (deduped, safe to re-run). The running api-server worker drains them — the
  script only schedules.

## What's deliberately NOT shipped

- **No Pexels gate on production approval.** Best-effort by design; the frontend
  soft-warns (confirm step) when `pexels_status !== "ok"` but the backend never
  blocks. If product later wants a hard gate, it's an additive change to
  `approveForProduction` + the modal.
- **No localStorage autosave** of the production-review enrichment edits / admin
  note (committed on approve only). The two-gate rewrite dropped the draft-form
  wiring the single-gate modal had.
- **No per-stage list filter / backend stage filtering.** The list still filters
  by coarse `status`; stage is shown per row.
- **The legacy standalone `scripts/backfill-pexels-images.mjs`** is superseded by
  the durable-queue `backfill-fact-pexels.ts` and writes the old photo-ID shape —
  left in place but do not run it against current data.
