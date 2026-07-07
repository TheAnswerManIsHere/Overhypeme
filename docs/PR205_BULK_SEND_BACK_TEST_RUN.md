# PR205 — Stale-Fact Refresh PR4 (Bulk Send-Back) · TEST_RUN

> **Audience:** Replit (the automated technical safety net). Exact commands +
> expected outcomes. Delete this file once you've run it and confirmed green —
> it's transient by design; the UAT doc is the durable half of this pair.
>
> **No schema/migration this PR.** Nothing here touches `DATABASE_URL` setup —
> Replit owns its own DB connection. This checklist is pure test-suite +
> typecheck verification.

## What changed

- `lib/api-zod/src/taxonomyHealth.ts` — new `send_back_to_review` action value;
  new skip reasons `already_in_review` / `has_active_variants` / `not_active`;
  `TaxonomyHealthActionResponse` gains optional `totalStale` /
  `eligibleRemaining` / `batchLimit`; `JobStatusEntry` gains optional
  `skipped` / `skipReason`.
- `artifacts/api-server/src/lib/factSendBackJob.ts` (new) — the
  `fact_send_back` async-job handler + strand-recovery logic.
- `artifacts/api-server/src/routes/adminTaxonomyHealth.ts` — `job-status` now
  surfaces sanitized skip metadata; new `pickSendBackTargets` +
  `POST /admin/taxonomy-health/actions/bulk-send-back`.
- `artifacts/api-server/src/lib/sendBackToReview.ts` — doc-comment fix only
  (corrected stage vocabulary); no behavior change.
- `artifacts/api-server/src/index.ts` — registers the new job handler.
- `artifacts/overhype-me/src/components/admin/useTaxonomyHealthActions.ts` —
  job-based skip rendering (skipped vs. done); carries the new response
  fields.
- `artifacts/overhype-me/src/pages/admin/taxonomy-health.tsx` — bulk button +
  row checkboxes on the Stale-for-reprocess card; the single-row send-back is
  now routed through the same async hook as bulk (previously a separate
  synchronous path).

## 1 — Install, typecheck, migrate (no-op)

```bash
pnpm install
pnpm -r run typecheck
```

Expect: clean across all 13 workspace packages (no `as TaxonomyHealthAction`
escapes, no unused-import errors from the removed synchronous send-back
state).

```bash
pnpm --filter @workspace/db run migrate
```

Expect: no new migration to apply — this PR ships no schema change. If your
last-applied migration is already `0080_engine_revision` (or later), you're
current.

## 2 — Backend test suite

```bash
pnpm --filter @workspace/api-server test
```

Expect: **all 4 shards green, 0 failures.** New coverage in this PR:

- `src/__tests__/factSendBackJob.test.ts` — the `fact_send_back` handler:
  success path; `NOT_ACTIVE` / `HAS_ACTIVE_VARIANTS` guard → terminal skip
  (never retried); missing `factId` / fact-not-found → `ok:false` (retried);
  `REFRESH_ALREADY_IN_PROGRESS` strand-recovery (re-enqueues the candidate
  enrichment job before skipping), including the **missing-`existing`
  fallback lookup** and the **can't-resolve-anything** case (must NOT falsely
  retire as a clean skip).
- `src/__tests__/routes.adminTaxonomyHealth.bulkSendBack.test.ts` — zod
  validation (missing/invalid scope, empty `selected` factIds → 400);
  `all_stale` never enqueues an in-flight or active-variant fact and emits
  **no** skip outcome for them (silent exclusion); response carries
  `totalStale`/`eligibleRemaining`/`batchLimit`, `batchLimit === 50`,
  `jobs.length <= 50`; `selected` scope classification — dedupe, inactive →
  `not_active`, nonexistent → `not_applicable`, non-stale (current signature)
  → `not_applicable`, already-in-flight → `already_in_review` (idempotent, no
  double-queue), active-variant root → `has_active_variants`, an eligible fact
  enqueues with `dedupeKey: fact_send_back:<id>`; job-status skip-metadata
  parsing (`skipped:true, reason` on a `done` job with a known reason; neither
  field for an unknown reason or a normal result).
- `src/__tests__/routes.adminTaxonomyHealth.auth.test.ts` — extended matrix
  entry for `POST /admin/taxonomy-health/actions/bulk-send-back` (401/403).

Also re-verify no regression in the existing stale-fact refresh suites:
`routes.sendBackToReview.test.ts`, `routes.adminTaxonomyHealth.actions.test.ts`,
`enrichmentVersioning.refresh.test.ts`.

## 3 — Frontend test suite

```bash
pnpm --filter overhype-me exec vitest run
```

Expect: **all files green.** New coverage:

- `src/components/admin/useTaxonomyHealthActions.test.ts` — a `done` job
  carrying `skipped:true` renders row state `"skipped"` (not `"done"`) and
  synthesizes a reasoned `ActionOutcome`; `counts()` moves such a job from
  `done` into `skipped`; scope precedence (the most-recent operation touching
  a fact wins its display, e.g. a bulk-queued fact then individually
  re-clicked); `onChanged` (the summary/list refetch) fires exactly once per
  terminal operation.
- `src/pages/admin/taxonomy-health.bulkSendBack.test.tsx` — the bulk controls
  only render on the Stale-for-reprocess card; "Send next 50 stale" confirms
  before POSTing `{scope:"all_stale"}` (and does nothing if declined); "Send
  selected" is disabled with nothing checked and posts exactly the checked
  `factIds`; the unified single-row button posts through
  `/api/admin/taxonomy-health/actions/bulk-send-back` (NOT the old direct
  Facts-editor endpoint).
- `src/pages/admin/taxonomy-health.rows.test.tsx` — pre-existing PR3 coverage,
  re-verify it still passes unchanged (proves the row-action refactor didn't
  regress the stale-for-reprocess row's Re-enrich suppression or in-review
  state).

## 4 — What's deliberately not shipped / out of scope

- No auto-promotion of any refreshed fact — every send-back still needs a
  human to clear both `concept_review` and `production_review`.
- No admin-config-driven batch limit — `BULK_SEND_BACK_BATCH_LIMIT = 50` is a
  code constant this PR; moving it to `admin_config` for live tuning is
  explicitly deferred.
- No dry-run/preview endpoint for an exact eligible count before the confirm
  dialog — the confirm copy says "up to 50 eligible" rather than an exact
  number, which is correct behavior, not a gap.
- The Facts-editor's direct per-fact send-back
  (`POST /admin/facts/:id/send-back-to-review`, with `clearOverrides`) is
  unchanged — only the Taxonomy Health row action moved to the async path.
