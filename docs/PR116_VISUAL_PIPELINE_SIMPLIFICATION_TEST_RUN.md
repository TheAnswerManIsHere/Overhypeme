# Visual-pipeline simplification (PR #116) — automated test run

Paired with **`docs/PR116_VISUAL_PIPELINE_SIMPLIFICATION_UAT.md`** (the
click-through acceptance test). Engineering safety net for Replit. **Replit owns
the database connection.** **No DB migration / no schema column change** — old
JSONB keys are stripped on next validate/save (soft cleanup; see below).

## TL;DR

```
# libs (repo root)
pnpm tsc -p lib/api-zod/tsconfig.json                                   # clean

# whole repo
pnpm typecheck                                                          # clean (no new import cycle)

# api-server (from artifacts/api-server) — DB suites need the env below
DATABASE_URL=postgres://… CRON_SECRET=test RENDER_PREFLIGHT_TIMEOUT_MS=300 \
  node --import tsx/esm --test \
    src/__tests__/routes.reviews.test.ts \
    src/__tests__/routes.adminFactsEnrichment.test.ts \
    src/__tests__/taxonomyHealth.evaluate.test.ts \
    src/__tests__/taxonomyHealth.filters.test.ts \
    src/__tests__/enrichmentVersionStatus.test.ts \
    src/__tests__/routes.adminTaxonomyHealth.actions.test.ts \
    src/__tests__/imagePromptPreview.test.ts            # all pass

# overhype-me (from artifacts/overhype-me)
pnpm tsc -p tsconfig.json --noEmit                                      # clean
npx vitest run src/__tests__/RuntimePromptPreview.test.tsx \
  src/__tests__/EnrichmentStalenessBadge.test.tsx \
  src/components/admin/useEnrichmentJobs.test.tsx                       # 15 pass
```

> `RENDER_PREFLIGHT_TIMEOUT_MS` is a **test-speed knob only** (production default
> 20s); not a rollout flag — the feature is on by default.

## What changed

Retire the redundant **enrichment-time `visualPromptPreview`** (a second,
fixed-assumption LLM artifact that never rendered yet gated approval) so the
render-time planner + `nanoBanana2` compiler (surfaced by `RuntimePromptPreview`)
is the single source of truth. Replace its approval gate with a **non-persistent
renderability preflight**. Remove the **"Stale Visual Plan"** concept from
Taxonomy Health.

### Backend
- `enrichmentJobs.ts` is **classify-only** (no Phase-2 preview job/queue/merge;
  `withPreservedOverride` retained). Removed `generateVisualPreview`,
  `factVisualPreviewConfig.ts`, the now-dead `promptStrategy/` dir, the
  `POST /admin/facts/:id/preview` + `POST /admin/reviews/:id/preview` endpoints,
  and `previewStatus` derivation/stamping. `seed.ts`/`imagePromptConfig.ts` drop
  the `fact_visual_preview_system` seed and add an idempotent
  `DELETE FROM admin_config WHERE key = 'fact_visual_preview_system'` (mirrors the
  retired `enable_image_prompt_v2`).

### Approval preflight (`lib/imagePrompt/renderPreflight.ts`)
- `assertFactPassesCanonicalRenderPreflight(factText, enrichment)` runs the REAL
  runtime path (`assembleImagePromptForPreview` → planner → compiler) once over a
  **neutral** subject `CANONICAL_RENDER_PREFLIGHT_SUBJECT = "Alex Jordan"` /
  `they/them` — not David. Persists nothing. Bounded by a 20s timeout (one retry
  on timeout only). Validates ONLY the canonical `human_identity_i2i` path.
- Typed result mapped in `reviews.ts` (`/approve` + `/approve-variant`), **before
  any state mutation**: `subjectFactCompatibility.rating === "poor"` → **400**
  (unrenderable, actionable); timeout/transient → **503** (retry); planner/
  compiler throw → **422** (logged). Failed checks never mutate the review.

### api-zod + Taxonomy Health
- Removed `visualPromptPreview`/`previewStatus` from the enrichment blob and their
  schemas/helpers (`visualPromptPreviewSchema`, `visualPreviewWireSchema`,
  `validateVisualPreview`, `hasUsableVisualPreview`, `PREVIEW_GENERATION_MODE`,
  `PREVIEW_STYLE`).
- Removed `stale_visual_preview` status, `stalePreview`/`previewStale` flags, the
  `staleVisualPreview` count, the filter mapping, and the preview half of
  version-staleness; kept `stale_enrichment_version`. Removed the
  `regenerate-previews` taxonomy-health endpoint.

### Frontend
- `EnrichmentEditor` drops `VisualPreviewPanel`, the preview-text warnings, and
  `onRegeneratePreview`/`previewBusy`; adds a read-only anchor naming the Runtime
  Compiled Prompt Preview as the only prompt surface (no "example prompt" copy).
  `useEnrichmentJobs` drops preview polling. `moderation.tsx`/`facts.tsx` drop
  client preview gating; approve relies on the server preflight (spinner + server
  error). Taxonomy-health UI drops the "Stale visual plan" card + "Regenerate
  Visual Plan" action.

## Approval-preflight test coverage (`routes.reviews.test.ts`, stubbed planner)
- Passes on a non-poor rating; **400** on `poor` (review **unchanged**); **503**
  on simulated timeout (unchanged); **422** on planner throw (unchanged); an
  **override-driven** case where the override reaches the planner input; and the
  rendered canonical subject is **"Alex Jordan"** (no `{NAME}` token, not David).
  Both `/approve` and `/approve-variant` covered.

## Soft cleanup (no migration)
Existing `enrichment.visualPromptPreview` / `previewStatus` keys may remain in
stored JSONB until a fact is next validated/saved; they are **ignored** by all
runtime, approval, and admin code after this PR. (`nanoBanana2.ts` is untouched —
owned by the open #115.)

## Reference grep (should be clean except doc comments / cleanup DELETE)
`visualPromptPreview`, `previewStatus`, `generateVisualPreview`,
`hasUsableVisualPreview`, `VisualPreviewPanel`, `exampleI2iPrompt`,
`exampleT2iPrompt`, `fact_visual_preview_system`, `stale_visual_preview`,
`/admin/facts/:id/preview`, `/admin/reviews/:id/preview`.
