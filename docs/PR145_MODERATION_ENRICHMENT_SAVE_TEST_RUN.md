# PR145 — Save Advanced-Options enrichment to the staging fact — Test Run (Replit)

Engineering / automated checklist. In-app click-through: `PR145_MODERATION_ENRICHMENT_SAVE_UAT.md`.

## What this PR does

Adds a **Save** for the Step-2 **Advanced Options** enrichment editor in moderation.
Before this, edits to the taxonomy enrichment / visual-strategy override lived only
in browser state and were flushed solely on approve — and the Step-2 test renders
read the **stored staging-fact** enrichment, so editing then re-running a tile
rendered against the *old* enrichment and the tile stayed stale forever.

The Save persists the whole edited blob to the staging fact (`facts.enrichment`),
the single source of truth the renders + approval gate read, via the same
`materializeFromBaseline` path `approve-for-production` uses.

## New backend route

`PATCH /admin/reviews/:id/staging-enrichment` (in `artifacts/api-server/src/routes/reviews.ts`)

- Admin-only (`requireAdmin`).
- Validates `body.enrichment` with `validateEnrichment` → 400 on invalid.
- Requires the review to be in `production_review` → 409 otherwise.
- Requires a staging fact → 409 if none / missing.
- Writes `materializeFromBaseline(enrichment).columns` + `enrichmentStatus: "ok"`
  to the staging fact, returns `{ success: true, enrichment }`.

This is the review-flow **plain whole-blob draft** save — deliberately *not* the
live-fact override-tracking model (`PATCH /admin/facts/:id/enrichment`), which
rejects tracked-field edits. A staging fact has no protected AI baseline / live
overrides to defend.

## Commands

```bash
# Apply migrations (none new in this PR) and run the affected suites.
pnpm --filter @workspace/api-server typecheck      # tsc -b + cycles + no-console
pnpm --filter @workspace/overhype-me typecheck     # tsc -b

# Backend route tests (the new ones live here):
#   src/__tests__/reviewRenderScenarios.routes.test.ts
# Expected: PATCH /admin/reviews/:id/staging-enrichment describe block green
#   - saves edited enrichment to the staging fact and flips prior renders stale
#   - rejects an invalid enrichment blob (400)
#   - refuses to save outside production_review (409)
#   - rejects non-admins (403)
#   - 404s for an unknown review
# Plus the existing GET/POST/approval-gate/idempotency tests still pass.
pnpm --filter @workspace/api-server test           # full sharded suite

# Frontend component test (new):
#   src/components/admin/FactVisualReviewGrid.test.tsx
#   - re-fetches the grid when reloadKey changes (surfaces post-save staleness)
pnpm --filter @workspace/overhype-me exec vitest run src/components/admin
```

Local results at authoring time:
- `reviewRenderScenarios.routes.test.ts`: **15 pass / 0 fail** (5 new).
- `routes.reviews.test.ts`: **51 pass / 0 fail** (no regression from the additive route).
- `src/components/admin` vitest: **26 pass / 0 fail** (1 new file).
- Both typechecks clean.

## DB / schema checks

- **No migration in this PR.** The route writes existing columns on `facts`
  (`enrichment`, the materialized projection columns, `enrichmentStatus`).
- Confirm a save updates the staging fact row: after `PATCH …/staging-enrichment`
  with a changed `visualComplexity`, the staging fact's `enrichment` JSON reflects
  the change and `enrichment_status = 'ok'`.
- Confirm staleness is derived, not stored: the prior render attempt row is
  unchanged; the grid's `stale` flag flips because the recomputed input hash no
  longer matches the attempt's `review_render_input_hash`.

## Gotchas

- The legacy `PATCH /admin/reviews/:id` draft autosave writes
  `pending_reviews.enrichment` — a **retired** column for the production-review
  flow. It is intentionally **not** the save target here; renders/approval read the
  staging fact. This PR does not touch that endpoint.
- After a successful save the frontend bumps a grid `reloadKey` so the scenario
  grid re-fetches (the poll loop is idle once tiles are terminal). The save does
  **not** auto-rerun renders — reruns stay explicit so FAL spend is intentional.

## Deliberately not shipped

- No auto-rerun on save (explicit rerun only).
- No change to the Facts-page enrichment save (override-tracking model) — unchanged.
- No new migration, no backfill.
