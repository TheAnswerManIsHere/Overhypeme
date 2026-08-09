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

## Variants are independent facts

**A variant is a fully independent fact.** `facts.parent_id` records that a
variant expresses **the same concept** as its root (the primary example of that
concept) in slightly different words — and it exists for exactly two purposes:
**recording that kinship**, and letting the UI **show or hide** variants. It is
**not** an inheritance link.

David, verbatim (2026-07-24): *"the only thing that we should be doing with
variants is tracking them as having a parent-child relationship to the master
fact… other than being able to show or hide variants I don't want them to be
dependent upon their parents for any metadata. A variant can have its own memes,
can have its own visual taxonomy, can have its own enrichment, can have its own
visual concept."*

So, for **every** metadata layer:

- A variant owns its **own** enrichment/taxonomy, Visual Concept, stock
  (`pexelsImages`) and AI (`aiMemeImages`) images, memes, and videos.
- A variant **never displays, borrows, or falls back to** its root's metadata.
  If a variant has no stock images of its own, it has none — the picker must not
  substitute the root's.
- **A variant can GENERATE its own images, not just display them (PR #256).**
  `admin.ts`'s `refresh-images`/`backfill-images`/`backfill-pexels`/
  `backfill-ai-memes`, and, user-facing, AI meme/PuLID generation (`memes.ts`,
  `pulidJobs.ts`) all now operate on any active fact, root or variant — the
  root-only 400s ("AI meme generation only supported on root facts") are
  removed. The three bulk-backfill routes also converted from blocking/
  direct-call to a durable async queue (`fact_pexels` / `fact_ai_meme_backfill`
  lanes — see [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues)).
  **Still treat any new `isNull(factsTable.parentId)` / `parentId !== null`
  guard on an images/enrichment/AI-generation path as suspect** — the exact
  list of root-only sites was under-enumerated twice during PR #256's review
  before a repo-wide sweep found them all; the same blind spot can recur if a
  future feature adds a new generation path and copies an old root-only
  pattern instead of checking this doc first.
- **Enrichment classifies a variant on its own text only** — the root's wording
  is not passed as classifier context. Consequence (intended): **re-wording a
  root does not invalidate or re-enrich its variants.** Their enrichment depends
  on their own text, nothing else. This retires the dependency machinery that
  existed only to protect the old model: `factTextEditProtection.ts`'s
  `loadDirectVariantDependencies` (blocks a root text edit while a variant is
  mid-cycle) and `confirmedFactTextEdit.ts`'s child-signature clearing on a
  confirmed root edit — both go away with it, not just go unused.
- The only legitimate cross-references are **structural, not metadata**: the
  `parent_id` link itself, show/hide grouping, lifecycle guards that reference
  kinship (`HAS_ACTIVE_VARIANTS`, "a variant's parent must be an active root"),
  and excluding self/parent/siblings from "related facts".

**When you find code that makes a variant read its parent's metadata, that is a
bug, not a feature** — fix it toward independence rather than mirroring it into
new code paths. (`enrichmentVersioning.ts`'s field-preservation invariant
already treats `parentId`, `pexelsImages`, and `aiMemeImages` as variant-owned;
that is the correct pattern.)

## Source-of-truth boundaries

- **Active fact truth:** the `facts.*` columns. The public feed and runtime read
  `facts.enrichment` (the effective blob). "Option B": `facts.*` is the SOLE
  active truth.
- **Variant truth:** a variant's own `facts.*` row — never its parent's (see
  *Variants are independent facts* above).
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
index). The stale-fact **"send back to review"** primitive
(`sendBackToReview` in `sendBackToReview.ts`) is shared by three callers —
the Facts-editor endpoint, the Taxonomy Health single-row action, and the bulk
send-back job (PR4, below) — none of which call each other: in one transaction
it creates a `candidate` seeded from the fact's active enrichment (including the
Visual Concept / visual override layer — a refresh does **not** require
rebuilding it from scratch), opens a **new `pending_reviews` cycle at
`prep_pending`** (the original approval review is never mutated), flips only
`facts.enrichment_status = "pending"` (the fact stays `isActive` and the public
feed keeps reading `facts.enrichment`), and enqueues the candidate enrichment
job. That job classifies into the version row and advances the review to
**Step 2 (`concept_review`)** — never `facts.*`. **Promote** archives the prior
active as a `superseded` row, rematerializes the candidate into `facts.*`
(including the signature — see above), and marks it `promoted`; **reject**
retains the candidate as `rejected` history (never hard-deleted). Guards:
`REFRESH_ALREADY_IN_PROGRESS`, `NOT_ACTIVE`. (A prior `HAS_ACTIVE_VARIANTS`
guard here — "refreshing a root could invalidate its variants' classification"
— was removed once variants stopped classifying from the root's text; see
*Variants are independent facts* above. `factActivation.ts` has its own,
unrelated `HAS_ACTIVE_VARIANTS` code for reparenting, which still stands.)

**A refresh is initiation, not completion.** Sending a fact back only starts
the cycle — it still has to clear **both** human gates (Visual Concept at Step
2, Test Renders at Step 3; see [`moderation-workflow.md`](./moderation-workflow.md))
before it can promote. Nothing in this subsystem, including the bulk action
below, auto-promotes a refreshed fact.

### Bulk send-back (PR4, #205)

`POST /admin/taxonomy-health/actions/bulk-send-back` fans the same primitive
out across many stale facts via the `fact_send_back` async-jobs queue
(`factSendBackJob.ts`), reusing the `backfill-enrichment` bulk-action pattern.
Two scopes: `all_stale` (server picks up to a **50-per-request cap**,
`BULK_SEND_BACK_BATCH_LIMIT`, from the corpus-wide stale set) and `selected`
(an explicit admin-chosen id list). `all_stale` **silently excludes** ineligible
facts (already in review) to keep the response bounded regardless of corpus
size — `selected` gives each chosen fact an explicit, reasoned skip outcome
instead, since the admin picked it deliberately.

`all_stale` also excludes any fact whose most recent `fact_send_back` jobs
have repeatedly failed — `factsWithRepeatedSendBackFailures`'s default
`streak` of **3** — so a persistently-broken fact can't eat a bulk run's
capacity forever (`repeatedFailureCount` in the response). `selected`
deliberately is NOT gated by this: a manual retry after investigating
`lastError` on the terminal rows is the only path that clears the streak.

A guard rejection (`NOT_ACTIVE` / already in review) is a
**terminal skip, not a retry** — that's what makes re-running a batch
idempotent. `REFRESH_ALREADY_IN_PROGRESS` gets extra handling: the primitive
commits the candidate/review, then enqueues candidate enrichment in a
**separate step after commit** — if that enqueue ever fails, the handler
defensively re-enqueues it before retiring as a clean skip, so a bulk retry
can't mask a stranded refresh (see the guard-query and job-skip-visibility
notes below).

## Processing signatures

**Live since PR3 (#168).** `lastProcessedSignature` on `facts` (and `signature`
on the version row) records the engine/prompt/code revision an enrichment was
generated under, so a fact processed under old assumptions reads as stale.

- `ProcessingSignature` (`lib/api-zod/src/processingSignature.ts`, pure, no DB)
  = `{ engineRevision, taxonomyVersion, classificationVersion,
  imagePromptGenerationVersion, visualStrategyVersion }`. The four `*Version`
  fields are the same code-version constants used elsewhere;
  `currentProcessingSignature(engineRevision)` composes them.
  `computeProcessingSignatureStaleness(stored, current)` returns `{ stale,
  reason }` with `reason` = `never_processed` (absent/invalid) |
  `engine_revision` (manual marker moved) | `code_version` (any code constant
  moved).
- `engineRevision` is a **manual admin int**, not derived from anything — it
  only moves via the admin "Mark major update" action (atomic, advisory-locked
  bump + `engine_revision_bumps` audit row) for engine/LLM swaps that no code
  constant captures. Engine/model IDs are deliberately **excluded** from the
  signature — a config toggle would otherwise flip corpus-wide staleness.
  `currentProcessingSignatureFromConfig()` (api-server) reads it via
  `getConfigIntRaw` (bypasses the admin debug overlay — staleness must reflect
  a real, audited bump, never a debug value).
- **Stamping rules** (who gets a fresh signature, and when):
  - A refresh **candidate** captures the signature immediately **before** the
    classify call and writes it onto the `fact_enrichment_versions.signature`
    column at classify time; **promote** copies that value through to
    `facts.last_processed_signature` (permissive — the candidate's classify-time
    signature, not a fresh one at promote time).
  - A **first-time approval** (`first_time_staging` mode) stamps
    `facts.last_processed_signature` fresh at production-approve — a newly
    approved fact is never stale-for-reprocess on day one.
  - **Direct live re-enrich never stamps.** It's refresh-first by design: the
    only way an already-live fact's signature moves is send-back → promote.
  - **Legacy facts** (approved before PR3) carry a `null` signature forever
    until refreshed — the intended "never processed under the versioned
    pipeline" signal, not a bug.

## Staleness tracking — two orthogonal dimensions

- **`stale_enrichment_version`** — the older, narrower lens: per fact,
  `enrichment.classificationPromptVersion` is stamped at classify time; when it
  differs from the current `CLASSIFICATION_PROMPT_VERSION` constant
  (`lib/api-zod/src/taxonomy.ts` — check the constant itself for the live
  value rather than trusting a hardcoded version number in prose, which has
  already gone stale here once) the fact is flagged stale.
  `VISUAL_STRATEGY_VERSION` (`lib/api-zod/src/visualPromptStrategies.ts`) is
  surfaced for visibility but not separately gated on.
- **`stale_for_reprocess`** (PR3) — the `ProcessingSignature`-based lens
  described above. Computed **only for valid, enriched facts** (missing/invalid
  enrichment gets its own error-severity card instead) and only when the
  evaluator is given `currentSignature` — `info` severity, so it never flips a
  fact's overall status to "needs attention" on its own (the dedicated card is
  the surface; folding it into the overall rollup would swamp real signals,
  since on a legacy corpus nearly every valid fact starts out
  stale-for-reprocess).
- **They overlap heavily but are not the same thing.** A legacy fact is
  typically both (never processed under any version constant, versioned or
  signed). The remediation differs: `stale_enrichment_version` can be cleared
  by a **direct bulk re-enrich** (writes `facts.*` straight, no stamp);
  `stale_for_reprocess` can **only** be cleared by send-back → promote (a
  direct re-enrich never stamps a signature). The bulk "Re-enrich stale facts"
  action therefore **excludes** any fact that's also `stale_for_reprocess` —
  see `pickEnrichmentTargets` in `adminTaxonomyHealth.ts`.

## Taxonomy Health dashboard

`evaluateFactTaxonomyHealth` (`taxonomyHealth/index.ts`) is a **pure function**
(no DB/LLM/IO) that emits typed issues + recommended actions. It checks: missing/
invalid enrichment, **low confidence** (`taxonomyConfidence < 0.75`),
questionable/reject fit, adult `requires_review`, cultural refs needing research,
semantic entities needing review, capitalization hints, **stale version**,
**stale for reprocess** (PR3, valid-enriched facts only — see above), and
**projection mismatch** (stored `primaryArchetype/subtype/overhypeFit/
adultSuitability` columns vs what `buildFactEnrichmentColumns()` derives).

Three remediation actions, with safety semantics:

- **Re-enrich** — re-runs the classifier. **Costs model calls**; skips
  admin-edited rows (see below); excludes anything also `stale_for_reprocess`.
- **Repair projections** — `projectionRepair.ts` rewrites only the four derived
  columns from the stored JSON; **never touches the JSONB blob**. Safe/instant,
  fine in bulk.
- **Send back to review** — the only remediation offered for
  `stale_for_reprocess` rows (single-row or bulk, PR4 above). Refresh-first:
  initiates a moderated refresh cycle rather than writing `facts.*` directly.

This panel is also the **reference implementation for async status** — copy its
per-item + aggregate polling pattern (see
[`async-ui-status.md`](./async-ui-status.md)). PR4 strengthened that reference
implementation: a **handler-level** skip (a race-condition guard caught inside
a job, as opposed to a picker pre-skip) now surfaces through `job-status` as
sanitized `{skipped, reason}` metadata so it renders "Skipped", never a bare
"Done" — any future job handler that can complete with a skip result should
follow the same pattern, not just picker-level exclusion.

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
- Writing `facts.*` from a candidate classification path — candidates write the
  version row only, until promote.
- Assuming a direct/bulk re-enrich clears `stale_for_reprocess` — it never
  stamps a signature; only send-back → promote does.
- Passing an unbounded fact-id array into a DB guard query (e.g.
  `factsWithInFlightRefresh`/`factsWithActiveVariants` in
  `adminTaxonomyHealth.ts`) — the evaluator loads **all active facts** into JS
  memory, so a bulk action's candidate set can be corpus-sized (thousands after
  a "Mark major update" bump); chunk `inArray(...)` queries. See the matching
  [known-failure-patterns.md](./known-failure-patterns.md#unbounded-id-list-into-a-db-guard-query)
  entry.

## Files to inspect before enrichment work

- `lib/db/src/schema/facts.ts`, `lib/db/src/schema/factEnrichmentVersions.ts`,
  `lib/db/src/schema/engineRevisionBumps.ts`
- `lib/api-zod/src/enrichmentOverrides.ts`, `lib/api-zod/src/taxonomy.ts`,
  `lib/api-zod/src/taxonomyHealth.ts`, `lib/api-zod/src/processingSignature.ts`
- `artifacts/api-server/src/lib/factEnrichment.ts`,
  `enrichmentOverrideLayers.ts`, `enrichmentVersioning.ts`,
  `sendBackToReview.ts`, `enrichmentJobs.ts`, `factEnrichmentBackfillJob.ts`,
  `factSendBackJob.ts`, `factEnrichmentConfig.ts`, `processingSignature.ts`
- `artifacts/api-server/src/lib/taxonomyHealth/{index.ts,projectionRepair.ts}`
- `artifacts/api-server/src/routes/adminTaxonomyHealth.ts`
- Tests: `enrichmentOverridesResolver.test.ts`,
  `enrichmentVersioning.refresh.test.ts`, `taxonomyHealth.evaluate.test.ts`,
  `factEnrichmentRepair.test.ts`, `projectionRepair.test.ts`,
  `routes.sendBackToReview.test.ts`, `factSendBackJob.test.ts`,
  `routes.adminTaxonomyHealth.bulkSendBack.test.ts`,
  `adminTaxonomyHealth.guardQueryChunking.test.ts`
