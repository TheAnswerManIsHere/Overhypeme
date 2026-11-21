# Taxonomy and Enrichment

> **Out of date below this banner, until the batched documentation pass.**
> Increment 2.1a of Issue #1018 removed Taxonomy Health and its machinery: the
> page and its routes, the processing signature and engine revision ("Mark
> major update"), projection repair, the character fill, the old taxonomy
> backfill, the manual-override system (layers, history writer, the override
> merge on write, the editor and its badges and filters), the version-history
> panel and the hashtag edit. The taxonomy is now read-only stored AI output:
> a run writes the classifier's own result through `taxonomyColumns`
> (`artifacts/api-server/src/lib/factEnrichment.ts`), and the Facts editor
> shows it with only "Re-run" (`FactTaxonomyPanel.tsx`). The override,
> signature and version columns stay in the schema, unread, until increment
> 2.1c drops them; increment 2.1b adds run history. Trust the code and
> `docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md` (2A–2C) over the sections below.

> Enrichment = the AI **classification** layer for a fact. This doc is the
> source-of-truth boundary map. Key modules: `lib/api-zod/src/taxonomy.ts`
> (schema + version constants), `lib/api-zod/src/enrichmentOverrides.ts` (the
> resolver), `artifacts/api-server/src/lib/factEnrichment.ts`,
> `enrichmentVersioning.ts`, `enrichmentJobs.ts` (Taxonomy Health's
> modules went in increment 2.1a).

## What enrichment is responsible for

Durable, structured **classification metadata** describing *how the joke works*:
`primaryArchetype` (the 11-value joke mechanism), `subtype`, `modifiers`,
`overhypeFit`, `adultSuitability`, `visualLiteralness`, `visualComplexity`,
`culturalReferences`, `semanticEntities` (capitalization-aware referents),
`suggestedHashtags`, `taxonomyConfidence`, and admin notes. Produced via OpenAI
Structured Outputs, validated against the taxonomy schema.

**The fact character list** (`characters`, Issue #968) is part of enrichment
too, but has its own producer: a dedicated, versioned call
(`CHARACTER_LIST_PROMPT_VERSION`, `factCharacters.ts`) made inside
`enrichFact` after classification, with its own response schema — the main
classifier's contract and `CLASSIFICATION_PROMPT_VERSION` don't move for it.
`charactersExtraction` is stamped **only** when that call's output validated
(an empty list included); a default, an old blob, a failed call and a promote
of an old baseline never stamp it, so "extracted" is never confused with
"defaulted to empty". A failed call keeps a prior extracted list and marker
(the wording is locked, so it is still the fact's) and otherwise leaves the
fact *missing a character list* — the Taxonomy Health card of that name, whose
"Fill character lists" action (`fact_character_fill`) runs the call alone
over live facts, first-time facts at the Gags or Test Renders step, and open
refresh candidates, writing only the list and its marker under a row lock.
A moderator correction is the `/characters` override; it survives the sticky
re-enrich (which re-reads overrides under its row lock), a refresh promote,
and both bulk backfills (which keep `/characters` while resetting the rest as
before). It is render-affecting (the planner reads it), but not part of the
Visual Idea hash (the Visual Idea writer never reads it).

## What enrichment is NOT responsible for

**Enrichment is NOT an image prompt.** The module header says so explicitly:
*"durable classification metadata, NOT an image prompt."* There is **no
render-time visual-preview phase inside enrichment.** The render-time
**visual plan + Nano Banana compiler** are the single source of truth for what
the image model receives — see [`visual-pipeline.md`](./visual-pipeline.md). Do
not blur these layers.

## Every fact stands alone

**Each fact owns its own metadata, and nothing links one fact to another.** A
fact's enrichment and taxonomy, gags, AI images and memes are its own, and
enrichment classifies a fact on its own wording only. A near-duplicate wording
is either rejected at triage as a duplicate or accepted as a fact of its own
([`moderation-workflow.md`](./moderation-workflow.md)). The link between facts
that once existed was retired on 2026-11-15; why, and the shape to use if
alternate wordings are ever wanted again, are in
[`decisions.md`](./decisions.md#2026-11-15--variants-are-retired-every-fact-stands-alone-and-the-existing-ones-are-deleted) and [`docs/retired/README.md`](../retired/README.md).
**Do not reintroduce a link between facts.**

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
`REFRESH_ALREADY_IN_PROGRESS`, `NOT_ACTIVE`.

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
  signature — an engine change would otherwise flip corpus-wide staleness. (Engine
  choice is a code change, [decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows).)
  `currentProcessingSignatureFromConfig()` (api-server) reads it via
  `getConfigIntRaw`, the plain `value` read kept as this marker's named entry
  point (it once bypassed Debug mode's overlay, removed in launch Phase 4:
  [`docs/retired/debug-mode.md`](../retired/debug-mode.md)).
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
  `factsWithInFlightRefresh` in
  `adminTaxonomyHealth.ts`) — the evaluator loads **all active facts** into JS
  memory, so a bulk action's candidate set can be corpus-sized (thousands after
  a "Mark major update" bump); chunk `inArray(...)` queries. See the matching
  [known-failure-patterns.md](./known-failure-patterns.md#unbounded-id-list-into-a-db-guard-query)
  entry.

## Files to inspect before enrichment work

- `lib/db/src/schema/facts.ts`, `lib/db/src/schema/factEnrichmentVersions.ts`,
  `lib/db/src/schema/engineRevisionBumps.ts`
- `lib/api-zod/src/enrichmentOverrides.ts`, `lib/api-zod/src/taxonomy.ts`,
  `lib/api-zod/src/processingSignature.ts` (the stored shape only)
- `artifacts/api-server/src/lib/factEnrichment.ts`,
  `enrichmentOverrideLayers.ts`, `enrichmentVersioning.ts`,
  `sendBackToReview.ts`, `enrichmentJobs.ts`, `factEnrichmentBackfillJob.ts`,
  `factSendBackJob.ts`, `factEnrichmentConfig.ts`, `processingSignature.ts`
- Tests: `enrichmentOverridesResolver.test.ts`,
  `enrichmentVersioning.refresh.test.ts`, `taxonomyHealth.evaluate.test.ts`,
  `factEnrichmentRepair.test.ts`, `projectionRepair.test.ts`,
  `routes.sendBackToReview.test.ts`, `factSendBackJob.test.ts`,
  `routes.adminTaxonomyHealth.bulkSendBack.test.ts`,
  `adminTaxonomyHealth.guardQueryChunking.test.ts`
