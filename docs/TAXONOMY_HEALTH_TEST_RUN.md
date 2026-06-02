# Taxonomy Health — Engineering Test Run

Automated / technical checklist for the Taxonomy Health panel debug + enhance
work. In-app click-through for David:
[`TAXONOMY_HEALTH_UAT.md`](./TAXONOMY_HEALTH_UAT.md).

This change makes the panel **observable, accurate, and explainable**:

- Every action is routed through the shared **asyncJobs queue engine**
  (`artifacts/api-server/src/lib/asyncJobs.ts`) — the same engine emails and
  FAL image calls use — and the frontend now **observes** job state by concrete
  `async_jobs.id`, showing a spinner → ✓/✗/skipped/still-running indicator.
- Card counts and filtered lists are driven by **one shared predicate**
  (`matchesHealthFilter`), so a card's number can never disagree with its rows.
  Fixes "Healthy returned everything" and "Semantic entities counted 1, listed 8".
- Single-row Re-enrich **protects admin-edited enrichment** by default and
  reports it as a first-class `skipped` outcome.
- "Preview" UI copy renamed to **Visual Plan**.

---

## What changed (files)

- `lib/api-zod/src/taxonomyHealth.ts` — `matchesHealthFilter`,
  `SUMMARY_COUNT_TO_FILTER`, `TaxonomyHealthFilter`, and the action/job-status
  response contracts (`TaxonomyHealthActionResponse`, `QueuedJobDescriptor`,
  `ActionOutcome`, `JobStatusEntry`).
- `artifacts/api-server/src/lib/asyncJobs.ts` — `enqueueJob` now returns
  `{ jobId, queue, dedupeKey, status, inserted }`; dedupe detection hardened to
  match the Postgres unique-violation in the wrapped error's cause chain.
- `artifacts/api-server/src/routes/adminTaxonomyHealth.ts` — summary + list use
  `matchesHealthFilter`; actions return `{ mode, jobs, outcomes, summary }`;
  `selected_fact_ids` re-enrich honors the admin-edited guard; new
  `POST /admin/taxonomy-health/job-status`.
- `artifacts/overhype-me/src/components/admin/useTaxonomyHealthActions.ts` — the
  polling-actions hook (job-status by id, bounded; timeout → still_running).
- `artifacts/overhype-me/src/pages/admin/taxonomy-health.tsx` +
  `taxonomyHealthCards.ts` — per-row indicators, card explanation panel,
  last-action banner, warnings, renames.
- `artifacts/overhype-me/src/components/admin/EnrichmentEditor.tsx` — "Visual
  Interpretation Preview" → "Visual Plan", "Regenerate preview" → "Regenerate
  visual plan".

No schema/migration changes. The `previewStatus`, `preview` queue, and
`regenerate-previews` route names are intentionally unchanged (UI copy only).

---

## Typecheck

```bash
pnpm run typecheck:libs          # builds @workspace/api-zod (new exports)
pnpm --filter "./artifacts/api-server" run typecheck
pnpm --filter "./artifacts/overhype-me" run typecheck
```

Expected: all clean.

## Tests

Replit owns the DB connection — just apply migrations/schema as usual, then run.
The DB-backed tests insert their own facts under a per-run text prefix and clean
up after themselves.

```bash
cd artifacts/api-server
node --import tsx/esm --test \
  src/__tests__/taxonomyHealth.filters.test.ts \
  src/__tests__/taxonomyHealth.evaluate.test.ts \
  src/__tests__/routes.adminTaxonomyHealth.actions.test.ts \
  src/__tests__/routes.adminTaxonomyHealth.auth.test.ts \
  src/__tests__/projectionRepair.test.ts \
  src/__tests__/asyncJobs.test.ts
# Expected: 7 suites, all pass (52 tests at time of writing).
```

Key assertions:

- **`taxonomyHealth.filters.test.ts`** (pure, no DB):
  - `matchesHealthFilter(_, "healthy")` matches only `overallStatus === "healthy"`.
  - `semantic_entities_need_review` includes the info-level capitalization hint
    (and that fact is *also* Healthy — cards overlap).
  - **count == list for every card**: tallying via `SUMMARY_COUNT_TO_FILTER` +
    `matchesHealthFilter` equals filtering via `matchesHealthFilter`.
- **`routes.adminTaxonomyHealth.actions.test.ts`** (DB-backed):
  - Healthy filter returns healthy rows only (excludes missing/stale/mismatch).
  - Semantic filter includes the cap-hint fact.
  - Single-row Re-enrich on an admin-edited fact → `mode:"inline"`, one
    `skipped`/`admin_edited` outcome, `summary.skippedAdminEdited === 1`, no jobs.
  - With `forceOverwriteAdminEdited:true` → one queued job with a concrete
    numeric `jobId`; `job-status` returns it as `pending`/`processing`.
  - `job-status` with an unknown id → empty list (safe).
  - Regenerate Visual Plan → a `regenerate_visual_plan` job descriptor.
  - Repair projections (small set) → `mode:"inline"`, terminal `done` outcome.
- **`asyncJobs.test.ts`**:
  - `enqueueJob` returns a concrete id; a dedupe hit on a still-pending job
    returns the same id with `inserted:false`.
  - A prior **terminal** dedupe job does NOT block a fresh enqueue (new id,
    `inserted:true`) — so repeatable actions re-queue.

## Manual API smoke (optional, against a running server)

```bash
# Count == list for a card (pick any returned by /summary):
curl -s .../api/admin/taxonomy-health/summary
curl -s '.../api/admin/taxonomy-health/facts?status=healthy&limit=100' | jq '.total'
# total should equal summary.healthy.

# Poll a queued job by id (from an action response's jobs[].jobId):
curl -s -X POST .../api/admin/taxonomy-health/job-status \
  -H 'content-type: application/json' -d '{"jobs":[{"jobId":123}]}'
```

## Deliberately NOT shipped

- No force-overwrite toggle in the panel UI: single-row Re-enrich always
  protects admin-edited enrichment (backend still accepts
  `forceOverwriteAdminEdited` for future use). Edit admin-curated facts in the
  fact editor instead.
- Small projection repairs stay **inline** (instant, idempotent, no model call)
  rather than being forced through the 30s worker — they're surfaced with the
  same completion UI.
- No persisted health-snapshot table; counts are still computed per request.
- Internal identifiers (`previewStatus`, `preview` queue, `regenerate-previews`
  route) deliberately keep their names.
