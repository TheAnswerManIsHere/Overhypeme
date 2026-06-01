# Taxonomy Health Workbench — Test Run

Engineering-side checklist for the work shipped on
`claude/taxonomy-health-workbench-cb8up`. Covers:

1. **Shared types** in `@workspace/api-zod` — `TaxonomyHealthStatus`,
   `FactTaxonomyHealth`, `TaxonomyHealthSummaryCounts`, bulk-action mode
   enums, capitalization-sensitive term list.
2. **Health evaluator** — `evaluateFactTaxonomyHealth(input)` (pure
   function) + `isEnrichmentAdminEdited(enrichment)` (admin-edited signal
   used by bulk re-enrich).
3. **Projection repair helper** — `repairFactEnrichmentProjection(factId)`.
4. **Async-job queues** — new `projection_repair` and
   `fact_enrichment_backfill` handlers + boot wiring.
5. **Admin routes** — `/admin/taxonomy-health/summary`,
   `/admin/taxonomy-health/facts`, and three bulk actions.
6. **Frontend page** — `/admin/taxonomy-health` (summary cards, filters,
   table with row actions, bulk action buttons).
7. **Regression fixture suite** — 12 canonical fact texts with
   hand-authored expected enrichment shapes.

UAT for David: [`TAXONOMY_HEALTH_UAT.md`](./TAXONOMY_HEALTH_UAT.md).

---

## TL;DR

Run, against your own database connection:

```bash
# 1. No DB migrations in this PR — health is computed dynamically.
#    Drizzle schemas + journal are unchanged.
pnpm --filter @workspace/db check-snapshots

# 2. Repo-wide typecheck.
pnpm -w typecheck

# 3. Targeted unit + integration tests.
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/taxonomyHealth.evaluate.test.ts \
  artifacts/api-server/src/__tests__/projectionRepair.test.ts \
  artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.auth.test.ts \
  artifacts/api-server/src/__tests__/taxonomyRegressionFixtures.test.ts \
  artifacts/api-server/src/__tests__/factEnrichment.test.ts \
  artifacts/api-server/src/__tests__/referenceResearch.validate.test.ts \
  artifacts/api-server/src/__tests__/referenceResearch.service.test.ts
# Expected: 127 pass (78 new + 49 existing across these suites).
```

---

## 1. Health evaluator (`lib/taxonomyHealth/index.ts`)

Pure function — no DB, no LLM. Inputs: a row pulled from `facts` (text +
JSONB blob + promoted columns) plus the current version constants.
Output: a `FactTaxonomyHealth` object.

**Detection rules:**

| Rule | Status flag | Severity | Recommended action |
|---|---|---|---|
| `enrichment` is null or `{}` | `missing_enrichment` | error | `rerun_enrichment` |
| `validateEnrichment` fails | `invalid_enrichment` | error | `open_fact_editor` or `rerun_enrichment` |
| `taxonomyConfidence < 0.75` | `low_confidence` + `needs_admin_review` | warning | `open_fact_editor` |
| `overhypeFit === "questionable"` | `questionable_fit` + `needs_admin_review` | warning | `open_fact_editor` |
| `overhypeFit === "reject"` | `questionable_fit` + `needs_admin_review` | **error** | `open_fact_editor` |
| `adultSuitability === "requires_review"` | `needs_admin_review` | warning | `open_fact_editor` |
| Cultural ref has identity but missing visualImplication, or `requiresAdminReview`, or `researchConfidence === "low"`, or ambiguityWarnings | `incomplete_cultural_references` + `needs_admin_review` | warning/info | `research_cultural_reference` |
| Semantic entity with `requiresAdminReview`, low confidence, ambiguous kind, or sentence-initial ambiguous | `semantic_entities_need_review` + `needs_admin_review` | warning | `review_semantic_entity` |
| Fact text contains capitalization-sensitive term but no semantic entities | `semantic_entities_need_review` | **info** | `rerun_enrichment` |
| `visualPromptPreview` missing | `missing_visual_preview` | warning | `regenerate_visual_preview` |
| `visualPromptPreview.previewPromptVersion !== current` | `stale_visual_preview` | warning | `regenerate_visual_preview` |
| `classificationPromptVersion !== current` | `stale_enrichment_version` | warning | `rerun_enrichment` |
| `classificationPromptVersion` missing | `stale_enrichment_version` | info | `rerun_enrichment` |
| Promoted columns ≠ `buildFactEnrichmentColumns(enrichment)` | `projection_mismatch` | warning | `repair_projection_columns` |

**Evaluator tests:** 19 cases in `taxonomyHealth.evaluate.test.ts`. All
deterministic; no LLM, no DB.

**Admin-edited signal:** `isEnrichmentAdminEdited(enrichment)` returns
true iff `enrichedBy === "admin"` OR `adminReviewNotes` is non-empty
after trim. 3 cases covered in the same test file.

## 2. Projection repair helper (`lib/taxonomyHealth/projectionRepair.ts`)

`repairFactEnrichmentProjection(factId)`:

1. Loads the fact row.
2. If `enrichment` is null → `error: "missing_enrichment"`.
3. Runs `validateEnrichment`; on failure → `error: "invalid_enrichment: ..."`.
4. Derives expected columns via `buildFactEnrichmentColumns`.
5. If columns already match → returns `repaired: false` with no error.
6. Otherwise updates `primary_archetype` / `subtype` / `overhype_fit` /
   `adult_suitability`. Returns `repaired: true`.
7. Never alters the JSONB blob.

**Tests:** 5 cases — happy path, no-op when aligned,
`missing_enrichment`, `invalid_enrichment`, `fact_not_found`.

## 3. Async-job handlers

Two new queues:

- **`projection_repair`** — one job per fact id. Reuses the helper above.
- **`fact_enrichment_backfill`** — one job per fact id. Loads
  `facts.text`, optionally honors the admin-edited signal (skipped unless
  `forceOverwriteAdminEdited: true`), calls `enrichFact(...)`, writes
  back JSONB + promoted columns.

The existing `preview` queue handles fact-level preview regeneration via
`{targetType: "fact", targetId}` — no new code needed.

Both new handlers registered in `index.ts` boot.

## 4. Admin routes (`routes/adminTaxonomyHealth.ts`)

All `requireAdmin`. The reference-research bulk action is **not** in v1
(the per-row Research Reference button covers admin curation; bulk
fan-out invites cost surprises).

`GET /admin/taxonomy-health/summary` returns `TaxonomyHealthSummaryCounts`
across all approved facts.

`GET /admin/taxonomy-health/facts?status=…&search=…&limit=…&offset=…`
returns paginated rows. SQL pre-filters on promoted columns + search;
the status filter is applied in memory because it's derived from the
enrichment JSONB.

`POST /admin/taxonomy-health/actions/backfill-enrichment` enqueues
`fact_enrichment_backfill` jobs. Default mode `missing_only`. Modes:
`missing_only` / `stale_only` / `missing_or_stale` / `selected_fact_ids`.
`forceOverwriteAdminEdited` bypasses the admin-edited skip.

`POST /admin/taxonomy-health/actions/regenerate-previews` enqueues
`preview` jobs with `targetType: "fact"`.

`POST /admin/taxonomy-health/actions/repair-projections`:
- ≤25 facts → run synchronously, return `{mode: "sync", repaired,
  skipped, errors, outcomes}`.
- >25 facts → enqueue `projection_repair` jobs, return
  `{mode: "async", queued, failed}`.

**Auth tests:** 12 cases in `routes.adminTaxonomyHealth.auth.test.ts` —
401 unauth + 403 non-admin on every route, plus the admin happy path on
`/summary` and a 400 on invalid mode.

## 5. Frontend (`pages/admin/taxonomy-health.tsx`)

- Summary cards top-of-page (clickable filters).
- Filter chip-row reading the same status enum.
- Text search box (server-side `ilike` on `facts.text`).
- Bulk action buttons appear conditionally based on the active filter.
- Row actions: Repair / Re-enrich / Preview, shown only when relevant.
- Confirmation dialogs on re-enrich (for stale rows with existing
  enrichment) and the bulk replace flow.

Linked from the admin sidebar (new `Activity` icon, just under Engines).

## 6. Regression fixture suite (`taxonomyRegressionFixtures.test.ts`)

12 canonical fact texts taken verbatim from the spec, each paired with a
hand-authored expected `(primaryArchetype, subtype, semanticEntities?,
culturalReferences?)`. Tests assert:

- `(archetype, subtype)` belong together per `SUBTYPES_BY_ARCHETYPE`.
- A synthetic enrichment built from the fixture validates cleanly.
- The health evaluator marks it `healthy`.
- Semantic-entity `visualReferent` includes the expected keywords (and
  avoids the forbidden ones, e.g. "earth" must not be rendered as planet).
- Cultural-reference `visualImplication` covers must-include keywords and
  avoids must-avoid phrases (Shark Week: "sharks watching David, NOT
  David swimming with sharks").

**No live LLM** — purely structural; locks the SHAPES we want the
enrichment pipeline to produce. A live regression script can be added
later but isn't part of CI.

Fixture list:
1. Earth (capital) — planet
2. earth (lowercase) — ground
3. Magnifying glass at night
4. Shark Week / David Week
5. Victoria's Secret
6. PIN as last four digits of pi
7. Teachers raise hands
8. Baby drives mom home
9. Yardi demos
10. Water gets David
11. System logs itself in
12. Coffee beans confess

## 7. What's NOT in this PR

- No DB migration. Health is computed live from `facts.enrichment` +
  current version constants. A persisted `fact_taxonomy_health_snapshots`
  table is a follow-up if perf demands it.
- No live LLM regression script. Default tests are deterministic.
- No bulk reference-research action — the per-row button remains the
  curation path.
- No persistent `enrichedBy = "admin"` stamping outside what existing
  edit flows already do. The bulk re-enrich skips admin-edited rows;
  to opt in to "force overwrite" the admin checks the box.
- Filtering by combined statuses (AND across multiple filters). The
  status filter is single-select.
- Admin nav badge for unhealthy-count. The summary cards live on the page
  itself.
