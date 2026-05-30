# Admin Research Reference button — Test Run

Engineering-side checklist for the work shipped on
`claude/admin-reference-research-button-cb8up`. Covers:

1. **Schema** — new `ReferenceResearchResult` types + business validator
   in `@workspace/api-zod`; optional research metadata fields appended to
   `culturalReferenceSchema` (no migration — JSONB).
2. **DB** — new `reference_research_cache` table (migration 0067).
3. **Service** — `lib/referenceResearch/` with OpenAI Responses API
   wrapper using the `web_search_preview` tool, cache layer, orchestrator.
4. **Admin config** — `reference_research_system` system prompt seed.
5. **Route** — `POST /admin/references/research` (admin-only).
6. **Frontend** — per-row "Research Reference" button + result panel in
   the existing `CulturalReferencesEditor`. Auto-applies when conditions
   met; otherwise shows Apply / Replace / Dismiss buttons.
7. **Tests** — 9 validator cases + 11 service cases + 4 route-auth cases
   (24 new across 3 files).

UAT for David: [`REFERENCE_RESEARCH_UAT.md`](./REFERENCE_RESEARCH_UAT.md).

---

## TL;DR

Run, against your own database connection:

```bash
# 1. Apply the new migration (0067).
pnpm --filter @workspace/db run migrate

# 2. Snapshot chain check.
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck (libs + api-server + frontend).
pnpm -w typecheck

# 4. Targeted unit + auth tests.
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/referenceResearch.validate.test.ts \
  artifacts/api-server/src/__tests__/referenceResearch.service.test.ts \
  artifacts/api-server/src/__tests__/routes.adminReferenceResearch.auth.test.ts \
  artifacts/api-server/src/__tests__/factEnrichment.test.ts \
  artifacts/api-server/src/__tests__/imagePromptGeneration.validate.test.ts \
  artifacts/api-server/src/__tests__/asyncJobs.test.ts
# Expected: 80/80 pass.
```

After migrations apply, confirm the new table exists:

```sql
\d reference_research_cache
```

Should show columns:
`cache_key VARCHAR(128) PK, input JSONB, result JSONB, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ`,
plus index `IDX_reference_research_cache_created_at`.

---

## 1. Schema (`lib/api-zod/src/referenceResearch.ts`)

Verify exports:
- `REFERENCE_RESEARCH_CONFIDENCE_VALUES` (3 values).
- `REFERENCE_RESEARCH_SOURCE_TYPE_VALUES` (7 values).
- `ReferenceResearchInput`, `ReferenceResearchSource`,
  `ReferenceResearchResult` types.
- `referenceResearchResultWireSchema` (strict — for OpenAI Structured
  Outputs).
- `validateReferenceResearchResult(raw, expectations)` and
  `computeCanAutoApplyToEmptyFields(wire, referenceType)`.

`culturalReferenceSchema` in `taxonomy.ts` gains six optional research
fields: `researchConfidence`, `researchSources`, `researchNotes`,
`ambiguityWarnings`, `researchedAt`, `researchedBy`. Existing enrichment
blobs validate unchanged.

Validator test counts:
```
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/referenceResearch.validate.test.ts
# Expected: 14 tests pass (9 validateReferenceResearchResult + 5 computeCanAutoApplyToEmptyFields).
```

Business rules:
- non-empty `explanation`
- non-empty `visualImplication`
- `visualImplication` must contain concrete visual guidance (regex on
  visual-domain verbs/nouns; rejects pure definitions like "Apple is a
  technology company")
- `confidence: "high"` on a public reference type (brand / pop-culture /
  meme / media / place / brand-or-cultural) requires ≥1 source
- forbidden directives — never recommend rendering real logos, brand
  marks, full fact text, or hashtags (two-part check on render verb +
  forbidden noun, so "Render the real Apple logo" is caught)

## 2. Service (`lib/referenceResearch/`)

Files:
- `index.ts` — `researchCulturalReference(input, opts?)` (live) +
  `researchCulturalReferenceWithModel(input, callModel, opts?)` (test).
- `openaiResponses.ts` — `callReferenceResearchModel` wrapper around
  `openai.responses.create` with `tools: [{ type: "web_search_preview" }]`
  and Structured Outputs JSON schema.
- `cache.ts` — sha256-keyed read/write on `reference_research_cache`.

Service test counts:
```
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/referenceResearch.service.test.ts
# Expected: 10 tests pass.
```

Cases covered:
- live call writes through to cache + stamps `researchedAt` /
  `researchedBy` / `canAutoApplyToEmptyFields`
- second call returns `fromCache: true` and skips the model
- `forceRefresh: true` bypasses cache and overwrites the row
- cache key differs by `factText` (per-fact research)
- cache key matches for identical input
- input validation: missing `factText`, missing both
  `sourcePhrase`/`canonicalReference`
- model returning non-JSON throws `phase: "validation"` error
- model returning a wire-shape that fails business rules throws
  `phase: "validation"`
- ambiguity warnings set `canAutoApplyToEmptyFields: false`

## 3. Route (`routes/adminReferenceResearch.ts`)

`POST /admin/references/research` with `requireAdmin`.

Request body:
```ts
{
  factText: string;
  sourcePhrase: string;
  referenceType: string;
  canonicalReference: string;
  existingExplanation?: string;
  existingVisualImplication?: string;
  adminNotes?: string;
  forceRefresh?: boolean;
}
```

Response:
```ts
{ result: ReferenceResearchResult; fromCache: boolean; cacheKey: string }
```

Error responses:
- `400` on missing required input
- `502 research_provider_unavailable` on OpenAI failure
- `502 research_validation_failed` on schema or business-rule violation
- `500 internal_error` on unexpected exceptions

Auth test counts:
```
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/routes.adminReferenceResearch.auth.test.ts
# Expected: 4 tests pass.
```

## 4. Boot wiring

`lib/seed.ts` now calls `seedReferenceResearchConfig()` after the Phase 2
image-prompt config seeds. Confirm via:

```sql
SELECT key, data_type FROM admin_config WHERE key = 'reference_research_system';
```

Should return a single row with `data_type = 'text'`.

No new async-job queue or boot-time handler registration — the research
flow is synchronous (admin clicks button, route responds with the
result).

## 5. Frontend (`components/admin/EnrichmentEditor.tsx`)

New `ResearchReferencePanel` mounted inside each Cultural / Insider
Reference row. Receives `factText` (threaded from `moderation.tsx` →
`EnrichmentEditor` → `CulturalReferencesEditor`).

States:
- **idle** — button + helper text when disabled (missing fact text /
  source phrase / canonical reference / reference type)
- **researching** — spinner
- **result** — confidence chip, optional `from cache` tag, ambiguity
  warnings (amber), proposed explanation, proposed visualImplication,
  sources details, research notes details, Apply / Replace / Dismiss
- **applied** — emerald success row when auto-applied
- **error** — red box with the failure detail

Auto-apply triggers when:
- `result.canAutoApplyToEmptyFields === true`
- both `explanation` and `visualImplication` are empty (post-trim)
- `result.confidence !== "low"`

Replace requires `confirm()` dialog confirmation.

## 6. What's NOT in this PR

- No frontend vitest tests for `ResearchReferencePanel` (the panel is
  fairly self-contained and the backend service has full unit coverage;
  follow-up if a regression is spotted).
- No retention sweep on `reference_research_cache` — `expires_at` column
  exists but is always `NULL` for v1. A TTL sweep is a one-line follow-up
  if cost grows.
- No rate-limit beyond the existing admin auth gate. Add a per-admin
  limiter if spend gets noisy.
- No bulk "research all flagged references" admin action.
- No live OpenAI smoke test in CI against the new system prompt — verified
  manually via the UAT scenarios.
