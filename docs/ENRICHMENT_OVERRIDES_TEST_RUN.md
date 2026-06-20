# AI-derived vs. manual override tracking — automated test run

Paired with **`docs/ENRICHMENT_OVERRIDES_UAT.md`**. Engineering safety net for
Replit. **Replit owns the database connection** — apply migrations against your
own DB; don't copy any `DATABASE_URL` from here.

## TL;DR

```
# whole repo
pnpm typecheck                                                # clean (libs + artifacts)

# DB: apply the two new migrations, then confirm the columns/table exist
pnpm --filter @workspace/db migrate                           # applies 0071 + 0072

# api-server suites (from artifacts/api-server) — DB suites need the env
node --import tsx/esm --test src/__tests__/enrichmentOverridesResolver.test.ts      # 11 pass (pure)
node --import tsx/esm --test src/__tests__/routes.enrichmentOverrides.test.ts       # 12 pass (DB)
node --import tsx/esm --test src/__tests__/routes.adminFactsEnrichment.test.ts      # 18 pass (DB)
node --import tsx/esm --test src/__tests__/routes.admin.auth.test.ts                # 137 pass (drift-checked)
```

## Schema / migrations

Two new migrations (registered in `meta/_journal.json`, idempotent
`IF NOT EXISTS`):

- **`0071_facts_enrichment_overrides.sql`** — adds to `facts`:
  - `enrichment_ai_derived jsonb` (nullable) — the immutable, pure AI baseline.
  - `enrichment_overrides jsonb NOT NULL DEFAULT '{}'::jsonb` — path-keyed manual
    overrides.
  - `enrichment_baseline_changed boolean NOT NULL DEFAULT false` — denormalized
    "a standing override's AI baseline changed" flag (cheap list filtering).
  - Backfill: `enrichment_ai_derived = enrichment` for non-null rows.
  - Partial index `facts_has_overrides_idx ON (id) WHERE enrichment_overrides <> '{}'`.
- **`0072_enrichment_override_history.sql`** — new `enrichment_override_history`
  audit table (`fact_id, path, action, old_value, new_value, ai_generation_id,
  reason, performed_by, created_at`) + two indexes.

Confirm after migrating: `facts` has the three new columns; the partial index and
the `enrichment_override_history` table exist.

> **Backfill limitation (by design, NOT self-correcting):** pre-migration manual
> edits cannot be told apart from AI output, so the current `enrichment` is taken
> as the AI baseline. Those legacy edits are not recoverable as overrides; on the
> next re-enrich only new path-keyed overrides remain sticky.

## What changed

### Data-ownership boundary
```
enrichment_ai_derived = pure AI output (immutable; never absorbs human notes/visual override)
enrichment_overrides  = { "/path": ManualOverride } for the 11 allowlisted paths
visualPromptStrategyOverride = preserved as-is, nested in effective (not refactored)
facts.enrichment      = MATERIALIZED EFFECTIVE = applyOverrides(aiDerived, overrides)
                                                 + visualPromptStrategyOverride
```
`materializeEnrichment({ aiDerived, overrides, visualPromptStrategyOverride })`
(`lib/factEnrichment.ts`) is the single write-shape every site funnels through
(PUT/DELETE overrides, PATCH notes/visual, re-enrich, projection repair, review
approval, backfill), so preserved fields are never lost and projection columns
never drift.

### Override allowlist (11 paths)
Nine fully-decorated classification fields (`/primaryArchetype`, `/subtype`,
`/visualLiteralness`, `/visualComplexity`, `/overhypeFit`, `/adultSuitability`,
`/modifiers`, `/culturalReferences`, `/semanticEntities`) + two AI-authored notes
fields made **editable + sticky** via the same override layer (`/adminReviewNotes`,
`/adultSuitabilityNotes`). `suggestedHashtags` + `visualPromptStrategyOverride`
are out of scope and keep their existing paths.

### Resolver (`lib/api-zod/enrichmentOverrides.ts`)
`resolveEnrichment` assembles effective + the override summary
(`overriddenPaths / baselineChangedPaths / invalidPaths / crossFieldInvalid /
hasVisualStrategyOverride`); always returns a renderable effective (invalid stored
override → keep AI value + flag; cross-field mismatch → subtype repaired to the
archetype default). `normalizeForOverrideCompare` is the single canonical
comparison (sorted object keys, array order significant).

### Endpoints (`routes/admin.ts`)
- `GET /admin/facts/:id/enrichment-resolved` → `{ aiDerived, overrides, effective,
  overrideSummary, enrichmentStatus }`.
- `PUT /admin/facts/:id/enrichment-overrides` `{ path, value, reason?,
  acknowledgeCurrentAiBaseline? }` — **transaction + `FOR UPDATE` row lock**,
  merges against the latest stored overrides; reset-to-AI deletes the override;
  `overriddenFrom` only refreshed on explicit acknowledge; auto-links `/subtype`
  when `/primaryArchetype` changes; validates full effective before persisting;
  writes history.
- `DELETE /admin/facts/:id/enrichment-overrides[?path=…]` — reset one / all.
- `GET /admin/facts/:id/enrichment-overrides/history` — audit trail.
- `PATCH /admin/facts/:id/enrichment` — now owns only NON-tracked fields
  (visual override + hashtags); **rejects with 400** any payload that changes a
  tracked field.
- `GET /admin/facts` — new `?hasOverrides=true` / `?baselineChanged=true` filters
  + `hasEnrichmentOverrides` / `enrichmentBaselineChanged` row fields.
- Re-enrich (`enrichmentJobs.ts`) is **sticky**: regenerates the AI baseline,
  preserves overrides untouched (never refreshes `overriddenFrom`), rematerializes,
  and writes `baseline_reenriched` history only on a not-changed → changed
  transition.

### Frontend
- `components/admin/OverrideMark.tsx` — per-field decoration (nothing until a
  value diverges; "overridden" / "review — AI changed"; AI value, Revert, Keep
  override; section-level for large list fields; per-field save status).
- `EnrichmentEditor.tsx` — tracked fields route through PUT/DELETE (optimistic
  local update + reconcile); notes commit on blur; a compact "Overridden: …"
  summary (incl. Visual Strategy). Gated behind an optional `overrideContext` prop
  so the review/approval flow is unchanged.
- `pages/admin/facts.tsx` — fetches `enrichment-resolved`, wires the override
  callbacks, list-row "overridden" / "override needs review" pill, "Overridden"
  + "Needs review" list filters, and the explicit sticky re-enrich confirmation.

## Test coverage

- **`enrichmentOverridesResolver.test.ts`** (pure) — effective = override ?? AI;
  empty map == baseline; override wins / baseline untouched; baseline-change
  detection; invalid stored override kept renderable; cross-field subtype repair;
  visual override carried verbatim; key-order-insensitive / array-order-sensitive
  comparison; the 11-path allowlist; per-path validation.
- **`routes.enrichmentOverrides.test.ts`** (DB) — resolved shape; PUT creates +
  re-syncs projections + AI baseline untouched + history row; invalid path/value
  → 400; reset-to-AI deletes the override; auto-linked subtype (+ history);
  concurrency-safe merge (one path's write doesn't wipe another); `overriddenFrom`
  not refreshed except on acknowledge; DELETE one / all; sticky re-enrich
  (override wins, baseline regenerated, `baseline_reenriched` history,
  `enrichmentBaselineChanged` flag); human-field survival (visual override +
  sticky note across PUT + re-enrich); `?hasOverrides` filter.
- **`routes.adminFactsEnrichment.test.ts`** — PATCH that changes a tracked field
  → 400; PATCH leaving tracked fields unchanged → 200; existing visual-override /
  re-enrich-preservation tests still green.
- **`routes.admin.auth.test.ts`** — the 4 new routes added to the drift-checked
  auth list (401/403 coverage).

## Not changed
- Runtime consumers still read `facts.enrichment` (the materialized effective) —
  zero downstream change. `visualPromptStrategyOverride` keeps its own mechanism.
  `overriddenFromHash` is intentionally deferred (optional, not v1).
