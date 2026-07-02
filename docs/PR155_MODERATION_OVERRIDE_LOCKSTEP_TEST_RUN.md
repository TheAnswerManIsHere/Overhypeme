# PR155 — Moderation override tracking (lockstep with Edit Fact) — Replit TEST RUN

Engineering/automated checklist for Replit. Human click-through:
`PR155_MODERATION_OVERRIDE_LOCKSTEP_UAT.md`.

## What this PR changes (context for the checks)

The moderation ReviewModal now edits the **staging fact** through the exact
same machinery as the Edit Fact screen: tracked fields via
`PUT/DELETE /admin/facts/:stagingFactId/enrichment-overrides` (instant,
per-field, audited), the visual-strategy override via the localStorage-backed
draft committed to `PATCH /admin/facts/:stagingFactId/enrichment`. The four
legacy whole-blob paths that wiped the override map are retired:

1. `PATCH /admin/reviews/:id/staging-enrichment` → **410**
   `STAGING_ENRICHMENT_RETIRED` (route kept registered, in order).
2. Approval ignores a legacy client `enrichment` body (warn log
   `ignoredLegacyEnrichmentBody: true`) and never rewrites enrichment columns.
3. `PATCH /admin/reviews/:id` ignores a legacy `enrichment` draft field
   (warn log `ignoredLegacyEnrichmentDraft: true`); note/reason still save.
4. `buildReviewScenarioGrid` / `loadReviewRenderContext` no longer take an
   `enrichmentOverride` — staleness always reads `facts.enrichment`.

**No DB migrations. No schema/enum changes. No new endpoints.**

## Commands

From the repo root:

```
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/overhype-me exec tsc -b
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/overhype-me test
```

Expected: both typechecks clean; api-server **392 tests, 0 fail**
(93 suites); frontend **655 tests, 0 fail** (57 files). (Counts are as of
this PR's HEAD — a later rebase may add tests; the number that matters is
**0 fail**.)

## Test files that carry this PR's contract

| File | What it pins |
| --- | --- |
| `artifacts/api-server/src/__tests__/reviewRenderScenarios.routes.test.ts` — "moderation enrichment edits via fact override endpoints" | Override PUT on the staging fact persists all three layers (effective updated, baseline preserved, override recorded with `overriddenFrom`) and flips a prior render tile **stale**; the legacy seed also pins the no-`enrichmentAiDerived` fallback; non-admin 403; retired route returns **410 + `STAGING_ENRICHMENT_RETIRED`** |
| `artifacts/api-server/src/__tests__/routes.reviews.test.ts` — approve-for-production describe | Approval preserves `enrichmentAiDerived` + `enrichmentOverrides` + the overridden effective; a legacy body `enrichment` is ignored (stored blob ships; review-row snapshot matches the stored blob) |
| `artifacts/api-server/src/__tests__/routes.reviews.test.ts` — "PATCH /admin/reviews/:id (draft autosave)" | note/reason save; a legacy `enrichment` field is ignored; the staging fact is untouched |
| `artifacts/api-server/src/__tests__/routes.enrichmentOverrides.test.ts` — "override endpoints on inactive (staging) facts" | PUT + GET-resolved work on `isActive: false` facts (the property moderation depends on) and editing does NOT activate the fact |
| `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx` | The anti-smuggle overlay (moderation commit pins `suggestedHashtags` to the server value while the VSO edit goes through; Facts-page surface commits hashtags as-is); `enabled=false` → zero fetches / null state; enabled flip and factId switch load cleanly |
| `artifacts/overhype-me/src/components/admin/EnrichmentEditor.dualMode.test.tsx` | Review mode + override decoration together: summary bar, needs-review count, Revert/Keep, final-hashtags editor; tracked select → `onOverride`; VSO toggle → `onChange` only |

## Manual API spot-checks (optional, against the dev server)

- `PATCH /api/admin/reviews/<id>/staging-enrichment` with any body as admin →
  `410` with `code: "STAGING_ENRICHMENT_RETIRED"`.
- `PUT /api/admin/facts/<stagingFactId>/enrichment-overrides` with
  `{"path":"/visualComplexity","value":"high"}` → 200; then confirm on the
  fact row that `enrichment.visualComplexity = 'high'`,
  `enrichment_ai_derived` still holds the AI value, and
  `enrichment_overrides` has the `/visualComplexity` entry.
- Approve a production_review with a bogus `enrichment` in the body → 200,
  and the server log shows the `ignoredLegacyEnrichmentBody: true` warn.

## DB expectations

No migrations to apply. After a moderation override edit + approval, the
live fact row should have **all three layers populated** (`enrichment`,
`enrichment_ai_derived`, `enrichment_overrides`) and
`enrichment_override_history` rows for the edits — the same shape the Edit
Fact screen produces.

## Deliberately NOT shipped

- The retired `staging-enrichment` route still exists (returns 410) — it is
  kept for one release so stale clients fail with a clear code, then can be
  deleted.
- `pending_reviews.enrichment` is still written at approval — as an **audit
  snapshot only** (commented as such in code). Nothing reads it back as
  editable state.
- No hashtag-flow changes: moderator final hashtags still ride only in the
  approve request; `suggestedHashtags` stays AI metadata.

## Gotchas

- The frontend suite logs a jsdom canvas warning ("Not implemented:
  HTMLCanvasElement's getContext") — pre-existing, harmless.
- Two structured **warn** logs are expected when legacy clients hit the
  ignored paths (`ignoredLegacyEnrichmentBody`, `ignoredLegacyEnrichmentDraft`)
  — they are signals for finding stale clients, not errors.
