# Taxonomy and Enrichment

> Enrichment = the AI **classification** layer for a fact. This doc is the
> source-of-truth boundary map. Key modules: `lib/api-zod/src/taxonomy.ts`
> (schema + version constants), `lib/api-zod/src/enrichmentOverrides.ts` (the
> resolver), `artifacts/api-server/src/lib/factEnrichment.ts`,
> `enrichmentVersioning.ts`, `enrichmentJobs.ts`,
> `artifacts/api-server/src/lib/taxonomyHealth/`.

## What enrichment is responsible for

Durable, structured **classification metadata** describing *how the joke works*:
`primaryArchetype` (the 11-value joke mechanism), `subtype`, `modifiers`,
`overhypeFit`, `adultSuitability`, `visualLiteralness`, `visualComplexity`,
`culturalReferences`, `semanticEntities` (capitalization-aware referents),
`suggestedHashtags`, `taxonomyConfidence`, and admin notes. Produced via OpenAI
Structured Outputs, validated against the taxonomy schema.

## What enrichment is NOT responsible for

**Enrichment is NOT an image prompt.** The module header says so explicitly:
*"durable classification metadata, NOT an image prompt."* There is **no
render-time visual-preview phase inside enrichment.** The render-time
**visual plan + Nano Banana compiler** are the single source of truth for what
the image model receives — see [`visual-pipeline.md`](./visual-pipeline.md). Do
not blur these layers.

## Source-of-truth boundaries

- **Active fact truth:** the `facts.*` columns. The public feed and runtime read
  `facts.enrichment` (the effective blob). "Option B": `facts.*` is the SOLE
  active truth.
- **Archive/candidate:** `fact_enrichment_versions` is an append-only archive +
  in-flight candidate store — **not** active lineage.
- **Visual source of truth:** the Visual Concept + render-time plan/compiler, not
  enrichment.

## AI-derived values vs manual overrides

Three columns on `facts` (`lib/db/src/schema/facts.ts`):

- `enrichmentAiDerived` — **immutable pure-AI baseline.**
- `enrichmentOverrides` — **path-keyed manual overrides** (e.g.
  `{ "/primaryArchetype": ManualOverride }`), default `{}`.
- `enrichment` — the **materialized *effective* blob** that runtime reads
  (baseline + overrides).
- `enrichmentBaselineChanged` — denormalized flag: an override's captured AI
  baseline has drifted from the current AI value.

**Keep AI-derived and human overrides distinguishable — never collapse them.**
That separation is what lets re-enrichment refresh the AI baseline without
destroying human decisions, and what powers baseline-drift detection.

## Runtime merge behavior

The single merge function is **`resolveEnrichment()`**
(`lib/api-zod/src/enrichmentOverrides.ts`): start from the AI baseline, apply each
*valid* override on top (invalid stored values are recorded in `invalidPaths` and
the AI value is kept so the effective blob stays renderable), repair cross-field
archetype/subtype mismatches, and re-attach the moderator visual override. The
api-server write wrapper is `materializeEnrichment()` in `factEnrichment.ts` —
"THE single write-shape" — which also rebuilds the promoted projection columns.

Editing machinery (distinct concern) lives in `enrichmentOverrideLayers.ts`
(`applyOverrideUpsert/Reset`, subtype-compat, provenance). Note: setting a field
back to its AI value **deletes** the override (reset-when-equal-to-AI); an
override's captured `overriddenFrom` baseline is only refreshed on an explicit
`acknowledge`.

## Versioning model

`fact_enrichment_versions` statuses: **`candidate | promoted | superseded |
rejected`.** At most **one in-flight `candidate` per fact** (partial unique
index). The stale-fact **"send back to review"** flow
(`sendBackToReview.ts`): in one transaction it creates a `candidate` seeded from
the fact's active enrichment, opens a **new `pending_reviews` cycle at
`prep_pending`** (the original approval review is never mutated), flips only
`facts.enrichment_status = "pending"` (the fact stays `isActive` and the public
feed keeps reading `facts.enrichment`), and enqueues the candidate enrichment job.
Classification into a candidate writes the **version row, never `facts.*`**.
**Promote** archives the prior active as a `superseded` row, rematerializes the
candidate into `facts.*`, and marks it `promoted`; **reject** retains the
candidate as `rejected` history (never hard-deleted). Guards include
`REFRESH_ALREADY_IN_PROGRESS`, `NOT_ACTIVE`, `HAS_ACTIVE_VARIANTS`.

## Processing signatures

`lastProcessedSignature` on `facts` (and `signature` on the version row) are meant
to record the engine/prompt/code revision an enrichment was generated under, so a
fact processed under old assumptions reads as stale. **Current state: NOT
implemented — a TODO.** There are live `signature: null // TODO(PR3-signature)`
sites in `sendBackToReview.ts`, `enrichmentJobs.ts`, and `enrichmentVersioning.ts`,
and no `currentProcessingSignature()` function exists yet. The columns and the
copy-at-promote path exist; nothing computes a signature. **If you work here,
this is the gap to close — don't assume signatures are live.**

## Staleness tracking

- Version constants in `lib/api-zod/src/taxonomy.ts`: `TAXONOMY_VERSION`,
  `CLASSIFICATION_PROMPT_VERSION` (currently `"v5"`), `VISUAL_STRATEGY_VERSION`.
- Per fact, `enrichment.classificationPromptVersion` is stamped at classify time;
  when it differs from the current constant the fact is flagged **stale**.
- `VISUAL_STRATEGY_VERSION` is surfaced for visibility but **not gated on** today
  (not stored per fact).

## Taxonomy Health dashboard

`evaluateFactTaxonomyHealth` (`taxonomyHealth/index.ts`) is a **pure function**
(no DB/LLM/IO) that emits typed issues + recommended actions. It checks: missing/
invalid enrichment, **low confidence** (`taxonomyConfidence < 0.75`),
questionable/reject fit, adult `requires_review`, cultural refs needing research,
semantic entities needing review, capitalization hints, **stale version**, and
**projection mismatch** (stored `primaryArchetype/subtype/overhypeFit/
adultSuitability` columns vs what `buildFactEnrichmentColumns()` derives).

Two remediation actions, with safety semantics:

- **Re-enrich** — re-runs the classifier. **Costs model calls**; skips
  admin-edited rows (see below).
- **Repair projections** — `projectionRepair.ts` rewrites only the four derived
  columns from the stored JSON; **never touches the JSONB blob**. Safe/instant,
  fine in bulk.

This panel is also the **reference implementation for async status** — copy its
per-item + aggregate polling pattern.

## Re-enrichment safety

- **Direct/live re-enrich** (`runEnrichmentForFact`) is **sticky**: it preserves
  `enrichmentOverrides` and the moderator visual override and only refreshes the
  AI baseline. A transactional mid-classify recheck discards a stale result if a
  send-back committed during the LLM call.
- **Bulk re-enrich** (`factEnrichmentBackfillJob.ts`) **skips admin-edited rows**
  unless `forceOverwriteAdminEdited: true`. "Admin-edited" =
  `isEnrichmentAdminEdited()` (`enrichedBy === "admin"` or non-empty
  `adminReviewNotes`).

**Invariant: manual/human decisions must survive re-enrichment.** Any change here
must preserve that.

## Known failure modes

- Overwriting a human override during AI reprocessing — the #1 thing to prevent.
- Collapsing `enrichmentAiDerived` and `enrichment` into one column — destroys
  drift detection and override survival.
- Treating `fact_enrichment_versions` as active lineage — it's an archive;
  `facts.*` is active truth.
- Assuming processing signatures work — they're a TODO (see above).
- Writing `facts.*` from a candidate classification path — candidates write the
  version row only, until promote.

## Files to inspect before enrichment work

- `lib/db/src/schema/facts.ts`, `lib/db/src/schema/factEnrichmentVersions.ts`
- `lib/api-zod/src/enrichmentOverrides.ts`, `lib/api-zod/src/taxonomy.ts`,
  `lib/api-zod/src/taxonomyHealth.ts`
- `artifacts/api-server/src/lib/factEnrichment.ts`,
  `enrichmentOverrideLayers.ts`, `enrichmentVersioning.ts`,
  `sendBackToReview.ts`, `enrichmentJobs.ts`, `factEnrichmentBackfillJob.ts`,
  `factEnrichmentConfig.ts`
- `artifacts/api-server/src/lib/taxonomyHealth/{index.ts,projectionRepair.ts}`
- Tests: `enrichmentOverridesResolver.test.ts`,
  `enrichmentVersioning.refresh.test.ts`, `taxonomyHealth.evaluate.test.ts`,
  `factEnrichmentRepair.test.ts`, `projectionRepair.test.ts`
