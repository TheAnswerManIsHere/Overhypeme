# Variant Independence — Code Fix

## Problem

`facts.parent_id` was documented (PR #251, `docs/ai-context/taxonomy-and-enrichment.md`)
as kinship + show/hide only — never metadata inheritance. The code still violates
that in multiple places: a variant cannot generate its own images, its stock
photos silently fall back to its root's, its enrichment is classified using the
root's text as context, and machinery exists solely to protect that last
behavior. David, verbatim: *"the only thing that we should be doing with
variants is tracking them as having a parent-child relationship to the master
fact… I don't want them to be dependent upon their parents for any metadata. A
variant can have its own memes, can have its own visual taxonomy, can have its
own enrichment, can have its own visual concept."*

## Product Intent

A variant is a fully independent fact for every metadata purpose. It owns its
own enrichment/taxonomy, Visual Concept, stock (`pexelsImages`) and AI
(`aiMemeImages`) images, memes, and videos — generated and displayed
independently of its root. The **only** legitimate root↔variant
cross-references are structural: the `parent_id` link itself, show/hide
grouping, and lifecycle invariants (no variants-of-variants, a variant's parent
must be an active root, `factActivation.ts`'s `HAS_ACTIVE_VARIANTS` blocking
root **reparenting** mid-cycle — **not** to be confused with
`sendBackToReview.ts`'s same-named but unrelated `HAS_ACTIVE_VARIANTS`,
which site 13 removes. **Correction (Codex round 9, P1): deleting a root does
NOT block on active variants** — `DELETE /admin/facts/:id` (both soft and
hard) atomically cascades via `cascadeDeactivateActiveChildren` instead of
rejecting; that cascade is the actual structural invariant here, not a
block, and this plan doesn't touch it).

**What must NOT change:**
- Structural invariants: no variants-of-variants (`admin.ts:1550`), can't
  delete a root via the variant-delete endpoint (`admin.ts:1580`), reparenting
  guards, active-root-parent enforcement (`factActivation.ts`), orphaned-parent
  FK guard (`resubmitForModeration.ts`).
- Display/grouping choices that are genuinely "show or hide," not inheritance:
  default root-only public listing (toggled by `includeVariants=true`,
  `facts.ts:110`), admin Facts Editor's root-grouped view with variant-text
  search fallthrough (`admin.ts:736`), a fact's meme gallery pooling its
  variants' memes alongside its own (`memes.ts:468`).
- **Explicitly out of scope (David, this session):** two root-only
  content-curation choices unrelated to the metadata bug — the homepage hero
  billboard pool (`facts.ts:156`) and the "pad with top-Wilson facts" filler on
  related-facts (`facts.ts:361`). Left exactly as they are; not a metadata
  question, a separate curation decision if David ever wants to revisit it.

**Settled with David this session:**
1. A variant's own confirmed text edit now triggers its own embed + stock-photo
   re-seed (parity with what a root re-word already gets) — today it triggers
   nothing.
2. The three admin bulk-backfill jobs (images, Pexels, AI memes) will process
   variants too, not just roots.

## Repo Context Inspected

Full repo-wide sweep for `parentId`/`isNull(factsTable.parentId)` across
`artifacts/api-server/src` (29 files matched `parentId`; every hit individually
classified below). Read: `docs/ai-context/taxonomy-and-enrichment.md` (the
canonical rule, PR #251), `docs/ai-context/decisions.md` (the decision entry +
enumerated sites), `docs/ai-context/agent-working-rules.md`.

**Correction (Codex round 5): the original sweep's scope was too narrow.**
Limiting the grep to `artifacts/api-server/src` is exactly why site 12
(`scripts/backfill-pexels-images.mjs`, at the repo root, outside `artifacts/`
entirely, using raw SQL rather than the Drizzle query builder so it doesn't
even match `factsTable.parentId`) was missed for four rounds straight. The
repo-wide sweep re-run at implementation time (per the Definition of Done)
must cover the whole repo — `scripts/`, `artifacts/*/scripts/`, and any raw
SQL (`parent_id IS NULL`), not just `factsTable.parentId`/`isNull(...)`
call sites under `artifacts/api-server/src`.

## Current Behavior

**Confirmed bugs (metadata inheritance / root-only generation) — 13 sites:**

| # | Site | Current behavior |
|---|---|---|
| 1 | `routes/facts.ts:233-243` (`GET /facts/:id`) | Fills in the root's images for whichever kind (`pexelsImages`/`aiMemeImages`) the variant lacks |
| 2 | `routes/facts.ts:587-590` (`GET /facts/:factId/pexels-images`) | **Unconditionally replaces** a variant's own stock images with the root's — a variant can never surface its own |
| 3 | `lib/enrichmentJobs.ts:140-206, 354-386` | Classifies a variant with the root's text as context (`status: "variant"`, `parentText`); `parentId` + parent text are baked into the staleness fingerprint |
| 4 | `lib/factTextEditProtection.ts` (`loadDirectVariantDependencies`, `VariantDependency`) | Blocks a root text edit while any direct variant has an unresolved review or active enrichment job — exists only to protect #3 |
| 5 | `lib/confirmedFactTextEdit.ts:200-204` | Clears every child variant's `lastProcessedSignature` on a confirmed root edit, marking them `stale_for_reprocess` — exists only to protect #3 |
| 6 | `routes/admin.ts:1012` (`confirmedFactTextEdit` PATCH dispatch, `protected_committed` case) | Only a ROOT's confirmed edit triggers `embedFactAsync` + `runFactImagePipeline`; a variant's edit triggers neither |
| 7 | `routes/admin.ts:1990` (`POST /admin/facts/:id/refresh-images`) | Explicit 400: "Images are only stored on root facts, not variants." |
| 8 | `routes/admin.ts:1999-2013, 2015-2034, 2077-2091` (`backfill-images`, `backfill-pexels`, `backfill-ai-memes`) | All three filter `isNull(factsTable.parentId)` — variants silently never processed. **`backfill-images` (1999-2013) uniquely has no other filter at all** — unlike its two siblings, it re-triggers the pipeline for every root fact regardless of `isActive` or existing `pexelsImages`, every call; the other two already check `isNull(pexelsImages)`/`isNull(aiMemeImages)` |
| 9 | `routes/memes.ts:1324-1332`, `routes/pulidJobs.ts:217-233` | Explicit 400: "AI meme generation only supported on root facts" — a legendary user cannot generate an AI visual for a variant today |
| 10 | `artifacts/overhype-me/src/pages/admin/facts.tsx:1481-1482` (Codex round 1) | Wraps the entire "Pexels Image Pipeline (root facts only)" admin panel in `selectedFact.parentId === null` — a variant has no UI surface to run/see `refresh-images` |
| 11 | `artifacts/api-server/scripts/backfill-pexels.ts:38` (Codex round 1) | Standalone CLI script (separate from the `admin.ts` HTTP route of the same name) also filters `isNull(factsTable.parentId)` |
| 12 | `scripts/backfill-pexels-images.mjs:112-113` (Codex round 5) | A THIRD, undocumented-elsewhere standalone script (repo root, raw SQL, its own hand-rolled OpenAI-keyword + Pexels logic — duplicates `pexelsClient.ts`'s pipeline rather than reusing it) filters `parent_id IS NULL AND is_active = true` in both its normal and `--all` modes |
| 13 | `lib/sendBackToReview.ts:102-114` (Codex round 7) | `sendFactBackToReview` rejects a root with any active variant (`HAS_ACTIVE_VARIANTS`) — its own comment says why: *"Variants are classified WITH their parent's text as context; refreshing a root out from under active variants could silently invalidate them."* That justification IS the bug this plan fixes. Left in place, it structurally blocks the v6→v7 prompt-version reprocessing (via `POST /admin/taxonomy-health/actions/bulk-send-back`, and the single-fact send-back path) for exactly the population — roots with active variants — this whole fix is about |

**Checked, already correct — no fix needed:** `artifacts/api-server/scripts/backfill-ai-memes.ts`
(queries all active facts with no `parentId` filter at all); **`artifacts/api-server/scripts/backfill-fact-pexels.ts`
(Codex round 23)** — a fourth, previously-missed bulk-Pexels-backfill
implementation (enqueues onto `FACT_PEXELS_QUEUE` per active fact, no
`parentId` filter) — also already correct on this question, though it
shares the concurrency-pacing gap fixed under site 8's durable-queue work.

**Legitimate, unchanged (verified structural or display, not inheritance):**
`facts.ts:110,156,361`, `admin.ts:736,860,866,901,912,1550,1580`, `memes.ts:468`,
`factActivation.ts:123,127,177`, `resubmitForModeration.ts:98-106`,
`sendBackToReview.ts:107`, `adminTaxonomyHealth.ts:179-184`,
`moderationStaging.ts:119`, `enrichmentVersioning.ts` (already the *correct*
pattern — its field-preservation invariant treats `parentId`, `pexelsImages`,
`aiMemeImages` as variant-owned), `facts.tsx:690` (fetch child variants — only
meaningful when viewing a root), `facts.tsx:1412` (the "Variants (N)" section —
a variant can't have its own variants).

## Source-of-Truth Analysis

| Concept | Source of truth after this change |
|---|---|
| A variant's enrichment/taxonomy | Its own `facts.enrichment`, classified from its own text only |
| A variant's stock/AI images | Its own `facts.pexelsImages`/`aiMemeImages` — never the root's, never a fallback |
| Whether a root re-word affects a variant | Never — a variant's staleness/enrichment depends only on its own text |
| Whether a variant can generate images | Yes, via the same endpoints/pipelines a root uses, minus the root-only guard |
| Root↔variant relationship | `facts.parent_id` — kinship + show/hide + lifecycle invariants only |

No new or duplicate source of truth is introduced; this removes an incorrect
implicit one (the root as a variant's de facto metadata source).

## Proposed Design

**A. Enrichment (sites 3, 4, 5) — stop passing parent context, retire the
   machinery built to protect it.**
- `enrichmentJobs.ts`: drop `parentText`/`parentId` from the classifier call
  and from the staleness fingerprint.
  **Correction (Codex round 4): `status` cannot stay as "purely informational"
  — it is NOT informational today.** `factEnrichment.ts`'s
  `buildEnrichmentUserMessage` (lines 96-119) renders `input.status` directly
  into the classifier prompt as an explicit `"Fact status:\nvariant"` /
  `"...new_fact"` line, plus a separate `"Optional parent fact text:"` line —
  both are live signals the model sees, so a root and a variant with
  byte-identical text would still get different prompts (and could get
  different taxonomy) purely because `parentId` is non-null. That directly
  violates "classified from its own text only." Remove the `status` and
  `parentText` fields from `EnrichInput` entirely (not just stop passing
  `parentText`), and delete the `"Fact status"`/`"Optional parent fact text"`
  prompt lines and the "If this is a variant, classify it independently"
  note from `buildEnrichmentUserMessage` — the classifier input becomes
  byte-for-byte identical in shape for a root and a variant, differing only
  in `factText`. Every `enrichFact`/`EnrichInput` call site stops
  passing `status` (the field no longer exists): the two dynamic computations
  in `enrichmentJobs.ts` (~206, ~384), the hardcoded `status: "new_fact"`
  call sites in `enrichmentJobs.ts:108` and `factEnrichmentBackfillJob.ts:68`
  (both already always pass `"new_fact"`, so behaviorally unaffected — just
  drop the now-nonexistent field), and **`admin.ts:2145-2148` (Codex round 6
  — a caller my "complete list" missed): `POST /admin/facts/backfill-enrichment`
  calls `enrichFact({ factText, status: fact.parentId ? "variant" : "new_fact" })`**,
  the same root/variant prompt distinction being retired everywhere else —
  drop the `status` field and its now-unused `parentId` read here too. Update
  the fixtures in `factEnrichment.test.ts` and `factEnrichmentRepair.test.ts`
  that construct `EnrichInput` with a `status` field.
- **Version the prompt change and specify the reprocessing path (Codex round
  6, P1) — this is not optional cleanup, it's how already-classified facts
  stop carrying parent-influenced metadata.** Removing `status`/`parentText`
  changes what the classifier actually sees, which by this repo's own
  established convention (`lib/api-zod/src/taxonomy.ts:279-291` — see the v4/
  v6 history comments) means bumping `CLASSIFICATION_PROMPT_VERSION` from
  `"v6"` to `"v7"` with a one-line history comment describing the change.
  Without the bump, every fact already classified under the old prompt
  (roots AND variants — the prompt changed for everyone, not just variants)
  keeps reporting as "current" to Taxonomy Health forever, and a
  parent-influenced variant classification would never surface for
  re-processing. **No new reprocessing mechanism needs to be built** — the
  version bump makes `evaluateFactTaxonomyHealth` (which already compares
  `enrichment.classificationPromptVersion` against the live constant) flag
  every fact as stale. Update the hardcoded assertion in
  `redundantMechanism.test.ts:269` (`assert.equal(CLASSIFICATION_PROMPT_VERSION,
  "v6")`) to `"v7"`.
  **Correction (Codex rounds 7-9): the reprocessing path is `stale_only`
  NEVER — see site 13 / section E below.** `stale_only`/`missing_or_stale`
  exclude any fact with `staleForReprocess` set, and both an already-processed
  fact AND a never-processed one land on `staleForReprocess` (a missing
  signature evaluates as `"never_processed"`, itself a form of staleness) —
  so every single v6→v7-affected fact routes through `bulk-send-back`, which
  today hard-blocks any root with an active variant. Both halves are
  required together: the version bump (so staleness is detected at all) and
  removing `sendFactBackToReview`'s `HAS_ACTIVE_VARIANTS` guard (so
  send-back can actually reach the roots this fix is about).
- `factTextEditProtection.ts`: remove `loadDirectVariantDependencies`,
  `VariantDependency`, and the root-edit-blocks-on-in-flight-variant check
  entirely. A root re-word no longer needs to look at its variants at all.
- `confirmedFactTextEdit.ts:200-204`: remove the child-signature-clearing
  block. A root re-word touches only the root row.
- `admin.ts:1012`: change the `protected_committed` dispatch to trigger
  `embedFactAsync` + `runFactImagePipeline` for **the fact being edited**,
  regardless of `parentId` (root or variant) — per David's decision 1. Drop
  the `outcome.fact.parentId === null` gate.
- **The shared API contract and admin UI surface built around this behavior
  must be removed too (Codex round 3) — not just backend logic and tests.**
  Retiring `loadDirectVariantDependencies`/the signature-clearing makes these
  dead, but they're a real contract admins currently see, so removal is an
  implementation step, not incidental cleanup:
  - `lib/api-zod/src/factTextEdit.ts`: remove the `DEPENDENT_VARIANT_IN_PROGRESS`
    error code, the `BlockingVariant` type, and the `affectedVariantCount`/
    `blockingVariants` response fields — the save response for a root edit no
    longer has a "some variants got marked stale" outcome to report.
  - `artifacts/overhype-me/src/components/admin/patchFactDraft.ts`: remove the
    `dependent_variant_in_progress` result kind and its handling.
  - `artifacts/overhype-me/src/components/admin/ApprovedFactTextEditModal.tsx:44-49`:
    remove the "N variant(s) were classified against the old wording and will
    be marked stale for reprocess" / "will be marked stale for reprocess"
    consequence copy — a root re-word no longer has this consequence to warn
    about.
  - `artifacts/overhype-me/src/pages/admin/facts.tsx:591,612`: remove the
    "Saved. N variant(s) marked stale for review" success-path message and the
    "Can't re-word this parent: N variant(s) mid-review… Resolve or finish
    those first" blocking-error message — both describe behavior this fix
    deletes.
  - **`ApprovedFactTextEditImpact.isRoot` (`lib/api-zod/src/factTextEdit.ts:68`)
    becomes dead too (Codex round 12) — its only live consumer is the exact
    `impact.isRoot && impact.affectedVariantCount > 0` branch in
    `ApprovedFactTextEditModal.tsx:44` being removed above.** Remove the
    `isRoot` field from the interface, and its two computation sites in
    `confirmedFactTextEdit.ts:88,170` (`const isRoot = fact.parentId === null`)
    — both already sit inside the dependent-variant logic sites 4/5 are
    deleting, so this isn't new surgery, just not leaving the field behind
    once its producers and consumer are both gone. Update
    `ApprovedFactTextEditModal.test.tsx:18`'s fixture accordingly.
  - Update `factTextEditProtection.test.ts`, `confirmedFactTextEdit.test.ts`,
    `ApprovedFactTextEditModal.test.tsx`, `patchFactDraft.test.ts` to match
    (already named in Implementation Steps' test list — this makes explicit
    *why*: the contract they assert is gone, not just the backend function).
  - `lib/api-zod` codegen: per this repo's standing gotcha
    (`patch-generated.mjs` rewrites `lib/api-zod/src/index.ts` from a
    hardcoded line list), if any export name changes, update
    `apiZodIndexLines` and re-run codegen immediately, confirming
    `git diff --exit-code lib/api-zod/src/index.ts` is clean — before writing
    any consumer change.

**B. Stock/AI image display (sites 1, 2) — read only the fact's own row.**
- `facts.ts:233-243`: delete the parent-fallback gap-fill. A variant with no
  images has none; the summary reflects that honestly.
- `facts.ts:587-590`: delete the parent-substitution branch. The picker always
  reads the requested fact's own `pexelsImages`.

**C. Image/AI generation (sites 7, 8, 9) — drop the root-only guard, keep
   everything else.**
- `admin.ts:1990`: remove the `parentId !== null` rejection. `refresh-images`
  operates on whichever fact id it's given, root or variant.
- `admin.ts` bulk jobs (site 8): remove `isNull(factsTable.parentId)` from all
  three queries' `where` clauses (per David's decision 2).
  **`backfill-images` (Codex round 2) needs more than that:** as written today
  it has no `pexelsImages`/`isActive` predicate at all, so dropping only the
  `parentId` filter would turn it into "re-run the pipeline for literally
  every fact, active or not, already-imaged or not" — the opposite of the
  idempotent behavior this plan's own Testing Plan requires, and materially
  more background work once variants are in the pool. Add
  `isNull(factsTable.pexelsImages)` to its `where` clause (matching the
  idempotency pattern `backfill-pexels` already has) at the same time the
  `parentId` filter is removed. `backfill-pexels` and `backfill-ai-memes`
  already have their own idempotency predicate (`isNull(pexelsImages)` /
  `isNull(aiMemeImages)` unless `force`); removing only `parentId` from those
  two is sufficient. **Pre-existing, out of scope:** none of the three routes
  filter on `isActive` today (they already sweep inactive/staging root facts,
  unrelated to variants) — that gap is not introduced by this fix and is left
  as-is.
  **Reversed (Codex round 18, P1) — this is required scope, not a deferrable
  judgment call.** Rounds 10 and 16 documented a real concurrency/
  observability gap here and I scoped it out as pre-existing technical
  debt; round 17 pushed back a third time and I still treated it as a
  discretionary call for David (Question 2). **That was wrong: `AGENTS.md`
  already has a standing, cross-agent, non-negotiable rule for exactly
  this** — "Async work must show status at two altitudes (per-item +
  aggregate)" (`AGENTS.md:126-127`), detailed in
  [`docs/ai-context/async-ui-status.md`](docs/ai-context/async-ui-status.md)
  ("Whenever you build or touch anything asynchronous... the surface that
  triggers it must report status at two altitudes"). This plan doesn't just
  brush past these three routes — it deliberately touches and *widens*
  their core selection query to include variants, which is exactly the
  "touch" the rule gates. This was never a fresh product trade-off for
  David to weigh; it's compliance with an already-settled repo rule I
  mischaracterized as optional. Removed from Questions for David; folded in
  as required scope below and in Implementation Steps.

  **What "touched" means the fix must cover — reusing existing
  infrastructure, not inventing a new status channel (per the doc's own
  "prefer existing polling helpers" rule):**
  - `backfill-images` and `backfill-pexels`: stop calling
    `void runFactImagePipeline(...)` fire-and-forget; route each selected
    fact through the existing `enqueueFactPexels`/`FACT_PEXELS_QUEUE`
    infrastructure (`factPexelsJobs.ts`) instead — it already gives durable
    per-fact job rows with a dedupe key, which is also what closes the
    round-10 concurrency gap as a side effect (two overlapping bulk
    triggers now dedupe onto the same job instead of double-calling
    Pexels/OpenAI). The route returns the enqueued job ids immediately
    (`202`, matching `backfill-pexels`'s existing status code) instead of
    waiting on completion.
    **Correction (Codex round 19, P2): the queue isn't a drop-in
    replacement for an inactive fact.** Verified `factPexelsJobs.ts:92-98`:
    `runFactPexelsJob`'s cost guard checks `isStagingImagePrepActive`,
    which returns `false` for a fact with no unresolved staging review AND
    `isActive === false` — and on `false` the handler returns a
    *successful* no-op that explicitly leaves `pexelsStatus` untouched
    (stuck at the `"pending"` `enqueueFactPexels` already set it to,
    forever — never `"ok"`, never `"failed"`). Since these two bulk routes
    have no `isActive` predicate (a pre-existing, out-of-scope gap
    documented above), an inactive fact they select would enqueue
    "successfully," silently do nothing, and remain perpetually
    `pexelsImages: null` — reappearing as eligible on every future run,
    while the new durable-status UI shows it stuck at "pending" forever
    instead of a clear terminal state. Fix: before enqueueing, check
    `fact.isActive` (already selected alongside `id`/`text` in these
    queries) and skip inactive facts with an explicit outcome (reusing the
    `not_active` skip-reason vocabulary already established for
    `bulk-send-back`) rather than handing them to a queue whose cost guard
    will silently swallow them. This doesn't add an `isActive` predicate to
    the selection query itself (still out of scope, per the note above) —
    it just makes the existing gap terminate visibly instead of stalling
    invisibly once routed through a queue that behaves differently for
    inactive facts than the old direct pipeline call did.
  - **`backfill-ai-memes` — a new durable `fact_ai_meme_backfill` queue
    (converged design, rounds 20-23).** No equivalent durable queue exists
    yet for AI-meme generation (`generateAiMemeBackgrounds`/
    `aiMemePipeline.ts` are called directly, fire-and-forget, from both
    `admin.ts` and `memes.ts`). Add the queue (`registerJobHandler`,
    dedupe key per fact) wrapping `generateAiMemeBackgrounds` — diverging
    from `factPexelsJobs.ts`'s shape in several ways, each forced by a
    real property of the wrapped function or the queue framework:

    1. **Schema:** add `facts.ai_meme_backfill_status` (`varchar(16)`,
       nullable, no DB-level enum — mirrors `pexels_status` exactly,
       `lib/db/migrations/0075_facts_pexels_status.sql`), values
       `pending | processing | ok | failed | skipped`, null on every
       existing fact and on facts whose AI-meme generation goes through
       the live, non-queued paths (`memes.ts`). Ship it as a real,
       runnable migration, not just a SQL string: add the next journal
       entry (`{"idx": 93, "version": "7", "when": 1782600000000, "tag":
       "0093_facts_ai_meme_backfill_status", "breakpoints": true}`,
       following 0092's shape) to `lib/db/migrations/meta/_journal.json`
       — `lib/db/src/migrate.ts` only applies journaled migrations — and
       add the tag to `SNAPSHOT_EXEMPT_TAGS` in
       `lib/db/scripts/check-migration-snapshots.ts` (a hand-authored
       DDL-lite migration with no drizzle-kit snapshot, exactly like
       `0075_facts_pexels_status`, already exempted there).
    2. **Retry safety — `maxAttempts: 1` + `suppressErrors: false`:**
       `aiMemePipeline.ts:842-935` wraps the entire per-slot loop (up to 9
       paid image calls) in one `try`, writing `facts.aiMemeImages` only
       once, after every slot succeeds (`:922-926`) — a failure on a late
       slot loses everything from earlier successful slots, so automatic
       retry would regenerate (and re-pay for) them every attempt.
       Enqueue with `maxAttempts: 1` (matches today's zero-retry
       behavior). The handler must call `generateAiMemeBackgrounds` with
       `suppressErrors: false`, not the `true` other call sites use —
       `suppressErrors: true` catches internal errors and returns
       normally (no throw), which would make the handler believe a
       fully-failed run succeeded. Per-slot idempotency (checkpointing
       after each image) stays out of scope — a separate, larger
       `aiMemePipeline.ts` change.
    3. **Crash-recovery safety — a fact-level in-progress marker, written
       in careful order:** `recoverStuckProcessing` (`asyncJobs.ts:583-591`)
       resets a job stuck in `processing` back to `pending` **without
       incrementing `attempts`**, bypassing `maxAttempts` entirely — a
       worker crash mid-run would otherwise replay the whole thing on
       recovery. Handler order: on entry, if
       `ai_meme_backfill_status === "processing"`, this is a
       crash-recovery replay — set `failed` and abort without calling the
       pipeline. Else, re-check `isActive` execution-time (point 5). Only
       past both checks does the handler set `processing`, **immediately
       before** calling the pipeline (not any earlier — setting it before
       the `isActive` recheck would leave the marker stuck at
       `processing` on the inactive-skip path). The enqueue side must
       write the status BEFORE calling `enqueueJob`, not after —
       `enqueueJob` commits the `async_jobs` row (immediately claimable)
       as part of its own insert, so a write placed after it can race a
       worker that already claimed and set `processing`, clobbering it
       back to `pending`. `enqueueFactAiMemeBackfill`'s order: conditional
       write first (`UPDATE facts SET ai_meme_backfill_status = 'pending'
       WHERE id = ? AND ai_meme_backfill_status IS DISTINCT FROM
       'processing'` — a no-op if a prior invocation is genuinely
       mid-flight, preserving the guard), then `enqueueJob`.
    4. **Concurrency safety — a dedicated serialized lane:**
       `admin.ts:2097-2102` deliberately `await`s facts one at a time
       ("Process sequentially so we don't hammer OpenAI rate limits"). An
       unlabeled queue registration defaults to the shared `bulk` lane
       (`asyncJobs.ts:345-353,815-819`) at `maxConcurrency: 3`, silently
       removing that safeguard. Register a new dedicated
       `"ai_meme_backfill"` lane in `asyncJobs.ts`'s `laneConfigs` with
       `maxConcurrency: 1` (env-overridable, matching the existing
       `fast`/`render`/`bulk` pattern).
    5. **Inactive facts, checked twice, both ending in a real terminal
       state:** check `isActive` before enqueueing (route-level, explicit
       `not_active` skip, no enqueue at all) — but with the lane
       serialized, a job can sit queued long enough for an admin to
       deactivate the fact before its handler runs, so the handler also
       re-reads `isActive` execution-time, immediately before setting
       `processing` (point 3's ordering) — on failure, set the terminal
       `skipped` value and return a `not_active` skip result surfaced as
       skipped, not done. Matches `factPexelsJobs.ts`'s own
       `isStagingImagePrepActive` guard, which runs execution-time for
       the same reason.
    6. **Startup registration:** every existing queue is registered
       explicitly in `artifacts/api-server/src/index.ts:419-430`
       (`registerEmailHandler()`, `registerFactPexelsJobHandler()`, etc.)
       before `runAsyncJobsWorker()` starts — defining a handler doesn't
       add it to the `HANDLERS` registry `asyncJobsTick` reads from. Add
       `registerFactAiMemeBackfillHandler()` to that block.

    Route `backfill-ai-memes`'s selected facts through
    `enqueueFactAiMemeBackfill`.
  - **`FACT_PEXELS_QUEUE` needs its own dedicated `"pexels"` lane too
    (`maxConcurrency: 1`), not the shared `bulk` lane.** `admin.ts:2039-2065`'s
    current `backfill-pexels` deliberately processes facts one at a time
    with a 1-second delay to respect Pexels' rate limit, and each fact's
    pipeline already fires 3 parallel Pexels searches — routing
    `backfill-images`/`backfill-pexels` onto `FACT_PEXELS_QUEUE`'s
    existing shared `bulk` lane (`maxConcurrency: 3`) would silently drop
    that pacing. Move `FACT_PEXELS_QUEUE` to the new dedicated lane,
    matching the AI-meme fix. This also affects `firstTimeStagingPrep.ts`'s
    existing single-fact staging-prep enqueue (the queue's only other
    consumer) — acceptable, since that flow is per-fact, human-review-paced,
    and already documented as best-effort/non-blocking
    (`factPexelsJobs.ts`: "never blocks the gate"). **Repo-sweep addition:**
    `artifacts/api-server/src/scripts/backfill-fact-pexels.ts` is a
    fourth, previously-missed bulk-Pexels-backfill implementation — already
    enqueues onto `FACT_PEXELS_QUEUE` with no `parentId` filter (already
    correct on the variant-independence question, like
    `backfill-ai-memes.ts`, and gets the same pacing fix as a side effect).
    Added to the Current Behavior sweep table as a checked-correct site.
  - **A new frontend surface is required, not an addition to an existing
    one.** A repo-wide search finds no frontend caller for any of the
    three bulk routes today — the Facts Editor's `facts.tsx:728-748`
    action calls only the single-fact `/admin/facts/:id/refresh-images`
    endpoint; these three routes are curl/CLI-only, itself a violation of
    `AGENTS.md`'s "ship the surface with the behavior (no dead UI, no
    invisible backend)" principle. Add genuinely new admin controls
    (bulk-trigger buttons for the three actions — e.g. a "Bulk
    Operations" section in the Facts Editor or an adjacent admin page)
    plus per-item/aggregate polling status, both following
    `useTaxonomyHealthActions.ts` as the reference pattern.
  - This does **not** require solving generic bulk-observability for every
    admin action in the repo — scoped strictly to the three routes this
    plan is already touching.
  - **Canonical architecture doc:** `docs/ai-context/architecture-map.md:88-102`
    documents exactly three scheduling lanes (`fast`/`render`/`bulk`) and
    lists `fact_pexels` under `bulk` — both wrong once `ai_meme_backfill`
    and `pexels` exist as dedicated lanes. Update that doc's lane list and
    queue membership, and the matching comments in `asyncJobs.ts`.
  - The Testing Plan below is corrected accordingly: "included in the
    queued/processed set" now means durable per-fact terminal state is
    assertable directly (queried from the new job rows), not just inferred
    by re-querying `pexelsImages`/`aiMemeImages` after an arbitrary wait.
- **`artifacts/api-server/scripts/backfill-pexels.ts:38` (Codex round 1) —
  the standalone CLI script (`pnpm --filter @workspace/api-server run
  backfill:pexels`), separate from the `admin.ts` HTTP route of the same
  name, also filters `isNull(factsTable.parentId)`.** Remove it, same fix as
  the HTTP route. Checked the sibling `backfill-ai-memes.ts` script: it
  already queries all active facts with no `parentId` filter — already
  correct, no change needed there.
  **Root-only copy left behind (Codex round 12) — update alongside the
  query, not just the filter:** the script's header docstring
  (`backfill-pexels.ts:1-2`) and two `console.log` lines (`:33,44`) all
  describe/log "root facts"; the `admin.ts` HTTP route has the same gap in
  its route comment (`admin.ts:2016`) and a log line (`:2030`). An operator
  reading either would be told only roots were processed when variants are
  now included too. Update all of them to drop the root-only framing.
  **Also rename the misleading variable names (Codex round 13):**
  `admin.ts:2001` (`backfill-images`) and `admin.ts:2081` (`backfill-ai-memes`)
  both name their query result `rootFacts` — live code, not just a comment,
  falsely describing a now-mixed root/variant collection. Rename both (e.g.
  `facts`/`targetFacts`); `backfill-pexels`'s `nullFacts` (`admin.ts:2021`)
  is already neutral and doesn't need changing.
- **`scripts/backfill-pexels-images.mjs:112-113` (Codex round 5) — retire it,
  don't fix it in place.** This is a THIRD implementation of the same
  operation (repo-root, raw SQL, its own hand-rolled OpenAI keyword-extraction
  + Pexels-search logic), not found referenced anywhere else in the repo (no
  `package.json` script, no doc). It already duplicates
  `artifacts/api-server/scripts/backfill-pexels.ts` and the `admin.ts` HTTP
  route — maintaining a third parallel copy of this logic (which can silently
  drift from the real pipeline in `pexelsClient.ts`) is worse than deleting
  it. Delete the file. **Flagging for David:** if this script is actually used
  operationally outside what's visible in-repo, say so and it gets the same
  `parentId`-filter fix as its siblings instead of deletion.
- `memes.ts:1324-1332`, `pulidJobs.ts:217-233`: remove the `parentId !== null`
  rejection. AI meme / PuLID generation operates on any fact the caller is
  authorized to generate for (existing tier/ownership checks are untouched —
  this only removes the root-only fact-shape restriction, not any auth check).

**D. Frontend — remove the matching admin gate (site 10, Codex round 1: my
   original "no frontend gating exists" claim was wrong).**
- `artifacts/overhype-me/src/pages/admin/facts.tsx:1481-1482` wraps the
  entire "Pexels Image Pipeline" panel in `selectedFact.parentId === null` —
  an admin selecting a variant in the Facts Editor has no surface to run or
  even see `refresh-images` status for it. Remove the gate; update the
  root-only comment/copy (the panel currently labels itself "(root facts
  only)"). Once `refresh-images` accepts variants (site 7), the UI must show
  the same panel for a selected variant.
- Verified two **legitimate** root-only gates in the same file, not bugs:
  `facts.tsx:690` (fetch child variants — only meaningful when viewing a
  root) and `facts.tsx:1412` (the "Variants (N)" section — a variant can't
  have its own variants, per the no-variants-of-variants invariant). Both
  left unchanged.

**E. Unblock reprocessing for roots with active variants (site 13, Codex
   rounds 7-9) — correcting round 6's reprocessing-path claim.** Round 6 said
   the existing `stale_only` bulk re-enrich action was sufficient to
   reprocess pre-v7 facts. **That was wrong for every affected fact, not just
   already-processed ones (round 9 correction — round 7 only fixed half the
   claim):** `currentProcessingSignature()` bakes in
   `CLASSIFICATION_PROMPT_VERSION`, and `computeProcessingSignatureStaleness`
   treats a MISSING signature as stale too (`"never_processed"`) — so both an
   already-processed fact AND a never-processed one land on
   `staleForReprocess`, and `pickEnrichmentTargets()` *deliberately* excludes
   `staleForReprocess` facts from `stale_only`/`missing_or_stale`
   (direct re-enrich never stamps a fresh signature, so including them would
   leave `stale_for_reprocess` stuck forever — correct existing behavior, not
   a bug). `stale_only` is not involved in this fix at all — the actual path
   for every v6→v7-affected fact is `bulk-send-back`
   (`POST /admin/taxonomy-health/actions/bulk-send-back`) — but
   `sendFactBackToReview` (`lib/sendBackToReview.ts:102-114`) rejects any
   root with an active variant, and its own comment says exactly why: *"Variants
   are classified WITH their parent's text as context; refreshing a root out
   from under active variants could silently invalidate them."* That's the
   inheritance bug this plan eliminates everywhere else — once variants
   never depend on a root's text, refreshing the root can't invalidate them,
   so this guard has no remaining justification. Remove it:
   - `lib/sendBackToReview.ts:102-114`: delete the active-variant check and
     the `HAS_ACTIVE_VARIANTS` branch of `SendBackToReviewError`.
   - `routes/adminTaxonomyHealth.ts`: remove the `factsWithActiveVariants()`
     pre-skip (lines ~170-174, ~838) and its `HAS_ACTIVE_VARIANTS` skip-outcome
     branch (~880) in `pickSendBackTargets` — the bulk picker no longer needs
     to pre-filter for a guard that no longer exists.
   - `lib/factSendBackJob.ts:38-39`: remove the `HAS_ACTIVE_VARIANTS` case
     from `sendBackGuardToSkip` (dead once the error code can't be thrown).
   - Update tests asserting the old behavior: `routes.sendBackToReview.test.ts`,
     `routes.admin.test.ts` (two 409 assertions), `enrichmentVersioning.refresh.test.ts`,
     `factSendBackJob.test.ts`, `adminTaxonomyHealth.guardQueryChunking.test.ts`.
   - **Every other contract/surface exposing this guard (Codex round 8, P2 —
     my round-7 list only covered the backend, not the full reachable
     surface):**
     - `lib/api-zod/src/taxonomyHealth.ts:365`: remove the `"has_active_variants"`
       member from the bulk-send-back skip-reason union.
     - `artifacts/overhype-me/src/components/admin/useTaxonomyHealthActions.ts:39`:
       remove the `has_active_variants` message-map entry.
     - `artifacts/overhype-me/src/pages/admin/taxonomy-health.tsx:162`: remove
       the `has_active_variants` → "Skipped — has active variants" case.
     - `artifacts/overhype-me/src/pages/admin/taxonomy-health.tsx:371`
       (Codex round 11) — the bulk-send-back confirmation dialog's copy
       ("...Facts already in review or blocked by active variants are left
       out of this batch...") describes a rejection that no longer happens.
       Drop the "or blocked by active variants" clause.
     - `artifacts/overhype-me/src/components/admin/sendBackToReview.ts:18`:
       remove `"HAS_ACTIVE_VARIANTS"` from the client's
       `SendBackToReviewCode` union; update `sendBackToReview.test.ts`.
     - `artifacts/api-server/src/__tests__/routes.adminTaxonomyHealth.bulkSendBack.test.ts`:
       update assertions covering this skip reason.
     - `admin.ts:1441`'s comment enumerating the three guard codes: drop
       `HAS_ACTIVE_VARIANTS`.
     - **Canonical docs, corrected — not just code:**
       `docs/ai-context/taxonomy-and-enrichment.md:70-73,142,164` and
       `docs/ai-context/decisions.md:39-42` (both from PR #251, written by
       me) currently list `sendFactBackToReview`'s `HAS_ACTIVE_VARIANTS` as a
       **legitimate structural guard** alongside `NOT_ACTIVE`/
       `REFRESH_ALREADY_IN_PROGRESS`. That characterization was wrong — it
       was this exact metadata-inheritance bug wearing a "structural"
       label. Correct both docs to state plainly that this guard was
       removed as part of the code fix, and that `factActivation.ts`'s
       differently-motivated `HAS_ACTIVE_VARIANTS` (reparenting) remains the
       only surviving guard by that name.
     - **Also correct `docs/ai-context/taxonomy-and-enrichment.md:213-216`
       (Codex round 12) — a separate, pre-existing staleness in the same
       doc, unrelated to the `HAS_ACTIVE_VARIANTS` mischaracterization
       above.** It hardcodes `CLASSIFICATION_PROMPT_VERSION` as `"v5"` in
       prose — already wrong *today* (the live constant is `"v6"` before
       this fix even lands) and would become wrong again at `"v7"` after
       step 2. Either update the value to `"v7"` or rewrite the sentence to
       not hardcode a volatile version number at all (point at the source
       file instead), so this doesn't go stale a third time.
     - Accept only when a repo-wide search for `HAS_ACTIVE_VARIANTS`/
       `has_active_variants` leaves exactly the unrelated
       `factActivation.ts` structural path.
   - **Do NOT touch `factActivation.ts:151,197`'s separate `HAS_ACTIVE_VARIANTS`
     code** — that one blocks reparenting a fact that itself has active
     children (the no-variants-of-variants structural invariant), an entirely
     different concern already listed in "What must NOT change." Same error
     code name, unrelated guard, unrelated fix.
   - **Not a code fix, an operational note:** `bulk-send-back` is capped at
     `BULK_SEND_BACK_BATCH_LIMIT = 50` per request — expected, pre-existing
     behavior, not a bug. An admin runs it repeatedly (`eligibleRemaining`
     tells them when to stop), same as any other prompt-version-bump
     reprocess. With site 13 fixed, this now actually reaches every stale
     fact, root-with-variants included.

## Data Model and Migration Impact

**One schema change (Codex round 22, P1 — corrects the "None" claim below,
which contradicted step 6a's own `aiMemeBackfillStatus` field):** add
`facts.ai_meme_backfill_status`, mirroring the existing `pexels_status`
precedent exactly (`lib/db/migrations/0075_facts_pexels_status.sql`,
`lib/db/src/schema/facts.ts:59`) — `varchar(16)`, nullable, no DB-level enum
constraint (validated in the app/Zod layer, same as `pexelsStatus`), added
via an idempotent hand-authored migration
(`ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "ai_meme_backfill_status" varchar(16);`).
Null on every existing fact (never ran through this queue) and on any fact
whose AI-meme generation still goes through the direct, non-queued paths
(`memes.ts`'s live user-triggered generation) — this field tracks only the
new bulk-backfill queue's lifecycle, the same scoping `pexels_status`
already has relative to `runFactImagePipeline`'s other callers. No backfill
of existing rows needed; the column starts fully null and gets populated
going forward as the queue processes facts. Otherwise, no other schema
change. No backfill of `facts.pexelsImages`/`aiMemeImages` themselves: this
changes *behavior going forward*, not stored data — existing variant rows
with `pexelsImages: null`/`aiMemeImages: null` simply become eligible for
the same generation paths a root already uses.

## Runtime Behavior

- Editing a variant's text (once confirmed) now re-embeds it and re-seeds its
  own stock photos — previously silent no-op.
- Editing a root's text no longer touches, blocks on, or invalidates any
  variant. Variants keep whatever enrichment/images they already had.
- An admin can `refresh-images` a variant directly; the three bulk-backfill
  jobs now sweep variants too.
- A legendary user can generate an AI meme/PuLID visual for a variant fact.
- `GET /facts/:id` and the stock-photo picker show a variant's own images —
  which, for existing variants that were never independently populated, may
  now show **no images** where they previously (incorrectly) showed the
  root's. This is intended per the decision — see UX note below.
- **The `CLASSIFICATION_PROMPT_VERSION` bump (v6→v7) marks every existing
  fact — root and variant — as `staleForReprocess` in Taxonomy Health**
  (Codex round 9 correction: not `stale_only` — see the Testing Plan), since
  the classifier prompt changed for everyone (not just variants). This is
  expected and matches how prior prompt changes (v4, v6) were handled; it's
  a one-time bulk-reprocess trigger, not a bug.

## Admin/User UX Impact

- **Existing variants may go from "has (root's) photos" to "has none" in the
  picker/detail view**, until an admin runs the (now variant-inclusive) bulk
  backfill or someone explicitly generates images for them. This is a visible,
  expected consequence of removing the fallback — flag in the TEST_RUN/UAT
  docs so David isn't surprised seeing it in QA. Pre-launch, no real user
  impact.
- One existing admin UI gate is removed: the Facts Editor's "Pexels Image
  Pipeline" panel becomes visible/usable when a variant is selected, not just
  a root (site 10). Copy changes from "(root facts only)" to reflect that.
- Admin's confirmed-edit flow for a variant now kicks off a background embed +
  image pipeline, same as a root edit already does — no new UI state needed
  (the root path's existing "processing" signal, if any, already covers this
  shape of async work).
- **Taxonomy Health will show every fact as `staleForReprocess` immediately
  after deploy** (the prompt-version bump above). **Correction (Codex round
  8): this is ONE path, not two** — a null-signature fact is
  `staleForReprocess` too (`never_processed`), not `stale_only`, so
  reprocessing goes entirely through
  `POST /admin/taxonomy-health/actions/bulk-send-back`, capped at
  50/request — run it repeatedly until `eligibleRemaining` is 0.
  `backfill-enrichment`'s `stale_only`/`missing_only` modes are unaffected by
  this fix — they only ever catch the pre-existing, unrelated
  invalid-enrichment and missing-enrichment cases respectively (Codex round
  11 correction — see the Testing Plan for why `stale_only` specifically
  never reaches `missing_enrichment`). Both bulk-send-back and
  backfill-enrichment protect admin-edited rows by default. Site 13 (removing
  `sendFactBackToReview`'s `HAS_ACTIVE_VARIANTS` guard) is what makes
  `bulk-send-back` actually reach roots with active variants — without it,
  that population is permanently stuck. Call this reprocess out prominently
  in the TEST_RUN/UAT docs — it's the single largest visible consequence of
  this fix and needs a
  deliberate post-deploy action, not a surprise. **`eligibleRemaining: 0` is
  not the finish line if any fact has an in-flight review candidate (Codex
  round 14, P1 — see Implementation Step 2 for the full mechanism):**
  promoting or rejecting such a review after that point can leave the fact
  stale again if the candidate predates the v7 deploy, so the TEST_RUN doc
  must instruct a second `bulk-send-back` pass once any pending reviews
  resolve. **Nor is it the finish line if a target failed to enqueue or its
  job later exhausted retries (Codex rounds 15-17, P1 — see Implementation
  Step 2):** the TEST_RUN doc's stop condition is not any single response
  field — it's looping `bulk-send-back` (`all_stale`) until one call
  returns `queued: 0`, `failed: 0`, **and** `eligibleRemaining: 0`
  together, then doing one more loop after any pending reviews from
  condition (1) resolve. A separate async-jobs-table inspection (tried in
  rounds 15-16) isn't needed and isn't campaign-scoped — the loop-until-
  clean condition is driven entirely by current staleness/active state.

## Security, Permissions, and Validation

No auth/tier changes. `admin.ts` routes stay `requireAdmin`/
`requireAdminOrApiKey`; `memes.ts`/`pulidJobs.ts` keep every existing
auth/tier/ownership/rate-limit check — only the `parentId !== null` fact-shape
rejection is removed, nothing that gates on *who* is asking.

## Testing Plan

General invariant, not just the reported example — for every changed site,
prove it with **both** a root and a variant fixture:

- Enrichment: classifying a variant never fetches or references its parent's
  text; the staleness fingerprint contains no `parentId`/parent-text
  component. **`buildEnrichmentUserMessage` produces byte-identical output for
  a root and a variant given the same `factText` (Codex round 4)** — assert
  this directly (same input text, `parentId` null vs non-null, identical
  prompt string) rather than only checking the fingerprint. Re-wording a root does NOT change a variant's
  `lastProcessedSignature` or trigger any job for it (negative case).
- **Prompt versioning (Codex round 6, P1):** `CLASSIFICATION_PROMPT_VERSION`
  is `"v7"`. `admin.ts:2145-2148` (`backfill-enrichment`) no longer computes
  or passes `status`.
  **Correction (Codex round 8, P1): my round-7 "no signature → `stale_only`"
  assertion was itself wrong.** `computeProcessingSignatureStaleness`
  returns `{ stale: true, reason: "never_processed" }` for an absent
  signature — that's `staleForReprocess`, not `stale_only`, so
  `pickEnrichmentTargets` excludes null-signature facts from `stale_only`
  too, same as already-processed ones — **every fact that had VALID v6
  enrichment before the bump, signature or not, routes through
  `bulk-send-back`, not `backfill-enrichment`.**
  **Further correction (Codex round 11, P2): `stale_only` does NOT catch
  `missing_enrichment` facts as I claimed above** —
  `evaluateFactTaxonomyHealth` returns early for both missing enrichment
  (`fact.enrichment == null`) and invalid enrichment, *before*
  `staleForReprocess` is ever computed (it stays `false`, the default). So:
  `missing_enrichment` facts are selected by `missing_only`/`missing_or_stale`
  (a pre-existing path, entirely unrelated to the v6→v7 bump — a fact with no
  enrichment never carried parent-influenced metadata to begin with); a fact
  with genuinely `invalid_enrichment` (fails schema validation) IS still
  selected by `stale_only` (its `staleForReprocess` defaults `false` since
  the function returned before computing it), also a pre-existing,
  unrelated case. Neither of these two populations is what this plan's
  reprocessing concern is about. Assert a null-signature `"v6"`-enrichment
  fixture (valid, just old-version) evaluates as `staleForReprocess` and IS
  selected by `bulk-send-back`'s picker, not `stale_only`; separately assert
  a missing-enrichment fixture is selected by `missing_only` and an
  invalid-enrichment fixture by `stale_only`, both unaffected by this fix.
- **Reprocessing reaches root-with-active-variants facts (Codex round 7, P1):**
  give a fact `"v6"` enrichment PLUS a `"v6"`-stamped processing signature
  under a live `"v7"` — assert it evaluates as `staleForReprocess`. Give
  that fact an active variant, call `sendFactBackToReview`/`bulk-send-back` —
  it must succeed (no `HAS_ACTIVE_VARIANTS` rejection), proving the
  documented operator action can actually refresh a root with active
  variants, not enqueue zero jobs. `factActivation.ts`'s separate
  `HAS_ACTIVE_VARIANTS` reparenting guard is unaffected — its own tests still
  pass unchanged.
- **`eligibleRemaining: 0` doesn't mean every fact is refreshed when a
  review is in flight (Codex round 14, P1):** give a fact `"v6"` enrichment
  plus a `"v6"`-stamped processing signature under a live `"v7"`, and an
  in-flight review candidate (`factEnrichmentVersionsTable` row,
  `status: "candidate"`, also classified pre-deploy). Assert
  `pickSendBackTargets` excludes it from the eligible set (so
  `eligibleRemaining` can reach 0 while it's still pending). Promote that
  candidate via `promoteCandidateEnrichmentVersion` — assert the fact's
  resulting `lastProcessedSignature` is the candidate's (pre-v7) signature,
  and that it now evaluates as `staleForReprocess` again. Assert a
  subsequent `bulk-send-back` call selects it — proving the documented
  two-pass operator flow (finish in-flight reviews, re-run) actually
  refreshes it, rather than `eligibleRemaining: 0` being mistaken for
  corpus-complete.
- **A failed send-back must not be masked by `eligibleRemaining: 0` (Codex
  round 15, P1):** force `enqueueJob` to throw for one target in an
  `all_stale` `bulk-send-back` call — assert the response reports that fact
  in `outcomes` with `status: "failed"` (and a nonzero `failed` count) while
  `eligibleRemaining` still reflects the batch as consumed, proving
  `eligibleRemaining` alone can't be the stop signal.
- **The stop condition is a loop-until-clean invariant, not any single
  response field (Codex rounds 15-17, P1 — replaces the per-fact
  async-jobs-table approach tried in rounds 15-16, which round 17 showed
  wasn't campaign-scoped and didn't cover in-flight jobs):** simulate a
  fact whose `enqueueJob` fails on the first `all_stale` call (still
  stale afterward, no job created) — assert the very next `all_stale` call
  re-selects it (proving the retry is automatic, not something the
  operator must separately detect via job history). Simulate a fact with a
  still-`pending`/`processing` `fact_send_back` job (job accepted, not yet
  run) — assert an `all_stale` call in that window still re-selects/
  re-attaches to it (`queued` stays nonzero, `enqueueJob`'s dedupe key
  returns `inserted: false`), proving a call can't report a false-clean
  `queued: 0` while work is genuinely still in flight. Then let that job
  resolve successfully (candidate created) — assert the *next* `all_stale`
  call excludes it (round 14's in-flight check takes over) and, with no
  other stale facts left, returns `queued: 0`, `failed: 0`, and
  `eligibleRemaining: 0` together — proving that specific combination,
  not `eligibleRemaining: 0` alone, is what "done" actually looks like.
  Separately, simulate a fact whose only `fact_send_back` job is long-past
  and terminally `failed`, with the fact NOW inactive (no longer part of
  the live cohort) — assert it does NOT block a clean `all_stale` response
  for the currently-stale-and-active population, proving the condition is
  scoped to current state and can't be blocked by irrelevant history the
  way a raw job-table query could.
- **The loop-until-clean condition doesn't hide a persistently-failing fact
  from the operator (Codex round 18, P1):** simulate a fact whose
  `fact_send_back` handler fails every attempt (a genuine, non-transient
  bug) across 3 consecutive `all_stale` calls — assert each call shows this
  fact fresh in `jobs` (`deduped: false`, a NEW job each time, proving
  `maxAttempts` gets reset every loop iteration rather than being honored
  across calls) while `summary.failed` stays 0 throughout (proving handler
  failures are invisible to that field, unlike synchronous enqueue
  failures).
- **The circuit breaker must actually stop server-side selection, not just
  guide the operator (Codex round 19, P1 — a test for the previous bullet's
  scenario, continued):** after that same fact's 3rd consecutive terminal
  failure, assert `factsWithRepeatedSendBackFailures` flags it and a 4th
  `all_stale` call does NOT select/enqueue it (no new `jobs` entry for that
  fact id) while OTHER still-stale facts in the same call continue to be
  selected and enqueued normally — proving the exclusion is per-fact, not a
  global halt. Assert `scope: "selected"` targeting that exact fact id
  STILL attempts it (the deliberate-retry escape hatch), and that a single
  later success for that fact (a `done` row within its most recent 3)
  clears the flag — the next `all_stale` call selects it again normally.
  Assert the new `repeated_failure` skip reason is wired through
  `lib/api-zod/src/taxonomyHealth.ts`,
  `useTaxonomyHealthActions.ts`, and `taxonomy-health.tsx` row state.
- `factTextEditProtection`/`confirmedFactTextEdit`: a root text edit succeeds
  immediately even with an in-flight variant review/job (previously blocked) —
  `loadDirectVariantDependencies` and its call sites are gone; grep-level test
  or lint that the symbol no longer exists.
- **Shared contract + admin UI (Codex round 3):** grep confirms
  `DEPENDENT_VARIANT_IN_PROGRESS`, `blockingVariants`, and
  `affectedVariantCount` no longer exist anywhere in the repo
  (`lib/api-zod`, `patchFactDraft.ts`, `ApprovedFactTextEditModal.tsx`,
  `facts.tsx`, and their tests). A root re-word's success/error UI no longer
  mentions variants at all.
- `admin.ts:1012`: confirming a variant's text edit triggers `embedFactAsync`
  + `runFactImagePipeline` for the variant's own id; confirming a root's edit
  still triggers them for the root, unaffected.
- `facts.ts:233`/`587`: a variant with its own `pexelsImages` shows its own; a
  variant with none shows none — never the root's, in both the detail summary
  and the picker endpoint. Root behavior unchanged.
- `refresh-images`: succeeds for a variant id (no more 400); still succeeds for
  a root.
- Bulk backfill (all three `admin.ts` routes, plus the standalone
  `backfill-pexels.ts` script): a variant missing images is included in the
  queued/processed set; a root missing images still is too.
  **Sequential-re-run idempotency** (already-has-images facts skipped on a
  second, non-overlapping call) holds for both — including `backfill-images`,
  which needs its new `isNull(pexelsImages)` predicate (site 8 fix) verified
  directly, since it has no such check today. **Correction, then reversed
  again (Codex round 10, then round 18, both P1): concurrent-invocation
  safety was first flagged as a gap, then required to be fixed anyway.**
  Originally: two overlapping bulk-triggers could both select the same
  not-yet-updated row and duplicate work (pre-existing, fire-and-forget with
  no dedup key). Now that these routes route through
  `enqueueFactPexels`/`FACT_PEXELS_QUEUE` and the new AI-meme queue (see
  Proposed Design), assert this directly: two overlapping `backfill-pexels`
  (or `-images`/`-ai-memes`) calls for the same fact dedupe onto the same
  job — no duplicate OpenAI/Pexels calls.
  **Corrected, then reversed (Codex rounds 16 and 18, both P1):** round 16
  caught that "included in the queued/processed set" overclaimed what was
  observable given the routes' original fire-and-forget shape (verified
  `admin.ts:1999-2104` — `backfill-images` returned only
  `{ success, triggered }`, `backfill-pexels` logged per-fact outcomes only
  to server logs, `backfill-ai-memes` returned only an initial `queued`
  count). Round 18 established that leaving this unfixed isn't actually an
  option — `AGENTS.md`'s standing async-status rule applies because this
  plan touches these routes' selection query, so the routes are being
  rearchitected onto durable queues (see the Proposed Design section
  above), not left as-is. **The claim is restored, now made true instead of
  corrected away:** assert each selected fact (root or variant) gets a
  durable job row via `enqueueFactPexels`/`FACT_PEXELS_QUEUE` (images/
  Pexels) or the new `fact_ai_meme_backfill` queue (AI memes), queryable to
  a terminal `done`/`failed` state — not just inferred by re-querying
  `pexelsImages`/`aiMemeImages` after an arbitrary wait. Assert the two
  overlapping bulk-trigger case from round 10 now dedupes onto the same job
  instead of double-calling the external APIs.
- **`scripts/backfill-pexels-images.mjs` (site 12) — conditional on David's
  answer to the Questions-for-David item (Codex round 13 correction: my
  claim here was unconditional, contradicting the plan's own default vs.
  override):** if unused → the file no longer exists in the repo. If David
  flags active use → the file still exists, its `parent_id IS NULL` filter
  is removed from both the default and `--all` query modes, and both now
  include variants.
- Admin Facts Editor: selecting a variant shows the Pexels Image Pipeline
  panel (previously hidden); the panel's status/actions work identically to
  a root's.
- AI meme/PuLID generation: a legendary user can generate for a variant fact
  id; existing tier/auth rejections for non-legendary or wrong-owner requests
  are unchanged (negative cases still fire).
- Full suite (Codex round 10 correction — the root `package.json` has no
  `test` script, so `pnpm test` cannot exercise the API suite; **round 11
  correction — this list was still missing the repo's required build/
  typecheck gates**): the standard sequence per `AGENTS.md`/
  `docs/TESTING.md` — `pnpm --filter @workspace/api-spec run codegen` →
  `pnpm run typecheck:libs` → `pnpm typecheck` → DB setup
  (`pnpm --filter @workspace/db push-force` then
  `pnpm --filter @workspace/db run migrate`) →
  `pnpm --filter @workspace/api-server test` for the backend;
  `pnpm --filter @workspace/overhype-me test` (Vitest) for the frontend
  changes in `facts.tsx`, `ApprovedFactTextEditModal.tsx`,
  `patchFactDraft.ts`, `sendBackToReview.ts`, `useTaxonomyHealthActions.ts`,
  `taxonomy-health.tsx`; `pnpm run build` (this fix removes members from
  `lib/api-zod` and touches multiple frontend consumers — Vitest alone
  doesn't typecheck/build the whole frontend); `pnpm run check:codegen-drift`
  **unconditionally, not "if"** — the shared `api-zod` export surface
  definitely changes (`DEPENDENT_VARIANT_IN_PROGRESS`, `BlockingVariant`,
  `affectedVariantCount`, `blockingVariants`, `has_active_variants`,
  `HAS_ACTIVE_VARIANTS` all removed); `pnpm run check:docs`. GitHub CI's
  required `Build` + `Test` checks are the authoritative gate regardless of
  what runs locally.

## Implementation Steps

1. Enrichment independence: strip parent context from `enrichmentJobs.ts`
   (both the initial classify and the recheck-after-classify paths) and its
   staleness fingerprint. **Remove the `status`/`parentText` fields from
   `EnrichInput` and the `"Fact status"`/`"Optional parent fact text"` prompt
   lines from `buildEnrichmentUserMessage` in `factEnrichment.ts:62-119`
   (Codex round 4)** — leaving `status` in the prompt keeps a root and a
   variant with identical text on different classifier inputs, which is the
   exact bug this plan exists to fix. Update every `enrichFact` call site
   (`enrichmentJobs.ts:108,206,384`, `factEnrichmentBackfillJob.ts:68`,
   `admin.ts:2145-2148` — Codex round 6) to stop passing `status`, and the
   `EnrichInput` fixtures in `factEnrichment.test.ts`/
   `factEnrichmentRepair.test.ts`.
2. **Version the prompt change (Codex round 6, P1):** bump
   `CLASSIFICATION_PROMPT_VERSION` from `"v6"` to `"v7"` in
   `lib/api-zod/src/taxonomy.ts:291`, with a one-line history comment
   (matching the existing v4/v6 comments) describing the status/parentText
   removal. Update the hardcoded `"v6"` assertion in
   `redundantMechanism.test.ts:269`. **Reprocessing (corrected Codex round
   9, P1 — this step previously pointed at the wrong action): every
   v6→v7-affected fact, with or without a prior processing signature,
   evaluates as `staleForReprocess`, not `stale_only` —
   `pickEnrichmentTargets` deliberately excludes `staleForReprocess` facts
   from `backfill-enrichment`'s `stale_only`/`missing_or_stale` modes. The
   only path that reaches this population is
   `POST /admin/taxonomy-health/actions/bulk-send-back`** (step 8 below
   makes it actually reach roots with active variants too). No new
   reprocessing mechanism needs to be built — `bulk-send-back` already
   protects admin-edited rows by default; note running it repeatedly
   post-deploy (until `eligibleRemaining` is 0) in the Testing Plan +
   TEST_RUN doc. `backfill-enrichment`'s `stale_only` mode is unrelated to
   this fix — do not reference it as a reprocessing step for this change.
   **`eligibleRemaining: 0` does not prove every affected fact is done
   (Codex round 14, P1):** `pickSendBackTargets` excludes facts with an
   in-flight review candidate (`factsWithInFlightRefresh` — a `candidate`
   row in `factEnrichmentVersionsTable`) from the eligible set, and
   `promoteCandidateEnrichmentVersion` writes that candidate's classify-time
   signature — not a fresh one — onto the fact when the review is later
   approved (`enrichmentVersioning.ts:250-252`, "permissive staleness: if
   the world moved on mid-review, the fact stays stale"). If that candidate
   was classified before the v7 deploy, promoting (or leaving unresolved and
   rejecting) it after `eligibleRemaining` hits 0 leaves that fact
   `staleForReprocess` again — outside the pass an operator just declared
   complete. This is not a code gap, it's an operational step the plan was
   missing: once `eligibleRemaining` reaches 0, check for facts still
   showing an in-progress review; after each such review resolves
   (promoted or rejected), re-run `bulk-send-back` once more — Taxonomy
   Health correctly re-flags any fact that reverted to stale, so a second
   pass catches it. Document this as a required operator step, not an
   optional follow-up, in the TEST_RUN doc.
   **`eligibleRemaining: 0` also survives enqueue and job failures (Codex
   round 15, P1) — a second, independent way the stop condition can lie.**
   `pickSendBackTargets` computes `eligibleRemaining` as
   `eligibleStaleIds.length - toEnqueue.length` — a count of what was
   *selected*, before any enqueue is attempted
   (`adminTaxonomyHealth.ts:515-550`). If `enqueueJob` throws for a
   selected fact, that fact is recorded in `outcomes` with
   `status: "failed"` and counted in the route's `failed` tally, but it
   still counts against `eligibleRemaining` as if handled — a response can
   read `eligibleRemaining: 0, failed: 3` and an operator watching only
   `eligibleRemaining` would stop with those 3 facts never queued.
   Separately, a job that *does* enqueue successfully can still exhaust its
   retries and land in terminal `status: "failed"` in the async-jobs table
   (`asyncJobs.ts:443-459`, `abandoned = newAttempts >= effectiveMax`) —
   this happens after the HTTP response already returned, so no response
   ever surfaces it, and because `sendFactBackToReview` never ran to
   completion, no candidate row exists — the fact is invisible to round
   14's in-flight-review check too. Both failure modes leave the fact
   `staleForReprocess` with nothing tracking it as pending.
   **Rounds 16-17, P1 — the per-fact "async-jobs table" check I built to
   catch this was itself broken twice, so it's replaced entirely.** Round
   16 caught that a bare "no failed `fact_send_back` rows" check is
   table-wide, not campaign-scoped (terminal rows persist up to 30 days —
   `purgeTerminalJobs`, `asyncJobs.ts:603-643` — so a superseded or
   unrelated historical failure blocks forever). My "fix," a per-fact
   latest-attempt-wins query, still had two more holes round 17 caught: (a)
   it only excludes `failed`, so a fact whose latest attempt is still
   `pending`/`processing` passes it even though the job hasn't resolved
   yet and could still fail; (b) grouping by `factId` alone still isn't
   campaign-scoped — a fact whose latest-ever attempt failed long ago, with
   no later retry, stays flagged forever even if it's since gone inactive
   or is no longer `staleForReprocess` by any other path, and the
   documented `scope: "selected"` recovery can't even re-enqueue such a
   fact (`pickSendBackTargets`'s `selected` path requires
   `staleIdSet.has(id)`). **Dropping the separate job-table inspection
   entirely — the actual correct stop condition needs no query beyond
   `bulk-send-back` itself:** repeatedly call `bulk-send-back`
   (`scope: "all_stale"`) until a SINGLE response returns `queued: 0`
   **and** `failed: 0` **and** `eligibleRemaining: 0` together — i.e. a
   call that finds nothing eligible to select, attempts nothing new, and
   fails at nothing. This is self-correcting by construction, driven
   entirely by current state rather than job history: a still-stale fact
   with a pending/processing job is NOT yet excluded from `eligibleStaleIds`
   (only an in-flight *candidate*, not a pending job, is excluded — see
   round 14), so it keeps getting re-selected on every call, and
   `enqueueJob`'s dedupe key (`fact_send_back:${factId}`) just re-attaches
   to the still-running job — `queued` stays nonzero for that fact on every
   call until the job actually resolves, keeping the loop "dirty" the
   entire time it's genuinely in flight. Once it resolves: success creates
   a candidate, which round 14's in-flight-review exclusion then takes over
   tracking; failure leaves the fact stale-and-not-in-flight, so the next
   call re-attempts it fresh (dedupe only blocks non-terminal rows) and
   `failed`/`queued` stays nonzero until it genuinely stops failing. A
   long-past, unrelated, or now-irrelevant historical failure has zero
   effect on this condition, since nothing here queries job history at
   all — only current staleness/active state, exactly what the picker
   itself uses. Operator guidance, two conditions must hold before the
   reprocess is actually done: (1) a `bulk-send-back` (`all_stale`) call
   that returns `queued: 0`, `failed: 0`, **and** `eligibleRemaining: 0`
   together, obtained by looping the call and re-checking, not by reading
   one response in isolation; (2) round 14's in-flight-review resolution +
   one more re-run afterward (a resolved review can revert a fact to
   `staleForReprocess`, which condition (1)'s next loop iteration would
   then naturally pick up — but only if the operator actually loops again
   after resolving pending reviews, not just once at the start). Document
   both as the actual stop condition, and the loop-until-clean mechanic
   itself, in the TEST_RUN doc — "`eligibleRemaining` hits 0" on one
   response, alone, is never sufficient.
   **Correction (Codex round 18, P1): the loop-until-clean mechanic itself
   silently defeats `maxAttempts`-bounded retry and hides persistent
   failures from the operator.** Verified: once a `fact_send_back` job
   exhausts `maxAttempts` and goes terminally `failed`, it drops out of
   `enqueueJob`'s dedupe index (non-terminal rows only), so the NEXT
   `all_stale` call doesn't retry that job — it inserts a brand-new job
   with a FRESH attempt budget. A persistently-failing fact (a genuine bug,
   not a transient blip) therefore gets an unbounded number of full
   `maxAttempts` cycles, one per operator loop iteration, forever — and
   `summary.failed` only counts *synchronous* `enqueueJob` exceptions
   (`adminTaxonomyHealth.ts:515-550`), not asynchronous handler failures,
   so this repeated-failure pattern never surfaces as `failed` in any
   response — it just looks like `queued` going up again on every call,
   indistinguishable from ordinary transient retry. The loop-until-clean
   condition still correctly refuses to go "clean" while this is
   happening (so it won't falsely declare done), but it gives the operator
   no bounded, visible signal that a specific fact needs human
   investigation rather than more looping.
   **Correction (Codex round 19, P1): an "operator procedure" circuit
   breaker doesn't actually work — nothing stops the SERVER from
   re-selecting the fact.** A human tracking "3 strikes, stop looping for
   this one" doesn't change what `pickSendBackTargets` selects: the very
   next `all_stale` call (needed to keep progressing the rest of the
   corpus) still finds this fact `staleForReprocess` and not in-flight, and
   enqueues a 4th fresh job regardless of what the operator privately
   decided. The only way to actually stop it is server-side. **Fix: a new,
   bounded exclusion query in `pickSendBackTargets`, same shape as
   `factsWithInFlightRefresh`/`factsWithActiveVariants`:**
   `factsWithRepeatedSendBackFailures(factIds, streak = 3)` — for each
   fact, look at only its `streak` most recent `fact_send_back` jobs
   (ordered by `createdAt DESC`, `LIMIT streak`); flag it only if there are
   at least `streak` rows and **all** of them are terminally `failed`. This
   stays bounded by construction (never looks past the most recent 3 rows,
   regardless of how much history exists) and self-clears the moment a
   single success lands anywhere in that window — unlike the campaign-wide
   "any failed row ever" check dropped in round 17, a fact that fails twice
   then succeeds is never flagged. Wire it into `eligibleStaleIds` in
   `pickSendBackTargets` (`all_stale` silently excludes it, matching the
   existing convention for `inFlight`/`withVariants`; `selected` scope
   still allows it through — a deliberate single-fact retry after an admin
   has investigated and fixed the cause — with its own outcome, `queued`
   or another guard, unaffected by this exclusion) so `all_stale` stops
   creating a 4th job while the rest of the corpus keeps progressing
   normally. Add a new `TaxonomyHealthSkipReason` member (e.g.
   `repeated_failure`) to `lib/api-zod/src/taxonomyHealth.ts`, surfaced via
   `useTaxonomyHealthActions.ts`/`taxonomy-health.tsx` row state — per
   `pickSendBackTargets`'s own design ("ineligible rows already show their
   own state"), so a flagged fact is discoverable in the Taxonomy Health
   list even though `all_stale` stops surfacing it as a skip outcome.
   Document the 3-streak threshold and the `scope: "selected"` manual-retry
   path (after investigating `lastError` on the terminal rows) in the
   TEST_RUN doc alongside the loop-until-clean stop condition.
3. Remove the now-pointless dependency machinery: `loadDirectVariantDependencies`/
   `VariantDependency` from `factTextEditProtection.ts`, the blocking check in
   its caller, and the signature-clearing block in `confirmedFactTextEdit.ts`.
   **Remove the shared contract and admin UI built on top of it (Codex round
   3 — this is implementation work, not incidental test cleanup):**
   `DEPENDENT_VARIANT_IN_PROGRESS`/`BlockingVariant`/`affectedVariantCount`/
   `blockingVariants`/**`isRoot`** (Codex round 12 — dead once its only
   consumer, the modal branch below, is gone) from
   `lib/api-zod/src/factTextEdit.ts` (re-run codegen per the standing
   `api-zod` export-drift gotcha if the export surface moves), the
   `dependent_variant_in_progress` result kind in `patchFactDraft.ts`, the
   stale-for-reprocess consequence copy in
   `ApprovedFactTextEditModal.tsx:44-49`, the two variant-count messages in
   `facts.tsx:591,612`, and `isRoot`'s two computation sites in
   `confirmedFactTextEdit.ts:88,170`. Update/remove tests that assert the old
   blocking/clearing behavior (`factTextEditProtection.test.ts`,
   `confirmedFactTextEdit.test.ts`, `ApprovedFactTextEditModal.test.tsx`,
   `patchFactDraft.test.ts`).
4. `admin.ts:1012`: drop the root-only gate on the confirmed-edit embed/image
   trigger.
5. Stock/AI image display: remove the parent-fallback in `facts.ts:233-243`
   and the parent-substitution in `facts.ts:587-590`.
6. Image/AI generation: remove the `parentId !== null` guard in
   `admin.ts:1990`, `memes.ts:1324-1332`, `pulidJobs.ts:217-233`; remove
   `isNull(factsTable.parentId)` from the three bulk-backfill queries in
   `admin.ts` and from `artifacts/api-server/scripts/backfill-pexels.ts:38`.
   For `backfill-images` specifically, also add
   `isNull(factsTable.pexelsImages)` to its `where` clause (it has no
   idempotency predicate today) so it doesn't regress into re-triggering the
   pipeline for every fact. Delete `scripts/backfill-pexels-images.mjs`
   (site 12) — a third, undocumented, duplicate implementation of the same
   backfill, unless David flags active use of it (see Proposed Design C),
   in which case fix its `parent_id IS NULL` filter instead. **Update the
   root-only copy left behind (Codex round 12):**
   `backfill-pexels.ts`'s header docstring (`:1-2`) and two `console.log`
   lines (`:33,44`), plus `admin.ts`'s `backfill-pexels` route comment
   (`:2016`) and log line (`:2030`) — all still describe/log "root facts"
   after the query itself is widened. **Rename the misleading variable
   names too (Codex round 13):** `admin.ts:2001`/`:2081`'s `rootFacts`
   collections (`backfill-images`/`backfill-ai-memes`) to a neutral name;
   `backfill-pexels`'s `nullFacts` is already fine.
6a. **Durable per-fact/aggregate status for the three bulk-backfill routes
   (Codex round 18, P1 — required by `AGENTS.md`'s standing async-status
   rule since step 6 touches these routes, not optional scope). Converged
   design after rounds 18-23:**
   - `backfill-images`/`backfill-pexels`: replace the fire-and-forget
     `void runFactImagePipeline(...)` calls with enqueues onto the existing
     `enqueueFactPexels`/`FACT_PEXELS_QUEUE` (`factPexelsJobs.ts`) — durable
     job rows, a dedupe key per fact (closing round 10's concurrency gap as
     a side effect), return the enqueued job ids in the `202` response
     instead of only an initial count. Check `fact.isActive` before
     enqueueing; record an explicit `not_active` skip outcome instead of
     handing an inactive fact to a queue whose cost guard silently no-ops
     for it (round 19).
   - **Move `FACT_PEXELS_QUEUE` to a new dedicated `"pexels"` lane
     (`maxConcurrency: 1`, env-overridable) instead of the shared `bulk`
     lane (Codex round 23, P1):** `admin.ts`'s current `backfill-pexels`
     deliberately processes facts one at a time with a 1-second delay to
     respect Pexels rate limits; the shared `bulk` lane's
     `maxConcurrency: 3` would silently drop that pacing once routed
     through the queue. Also fixes the same latent gap in
     `artifacts/api-server/src/scripts/backfill-fact-pexels.ts` (a
     pre-existing, previously-missed 4th bulk-Pexels-backfill script,
     already `parentId`-clean — added to the Current Behavior sweep as a
     checked-correct site) and applies harmlessly to
     `firstTimeStagingPrep.ts`'s existing single-fact enqueue (per-fact,
     human-review-paced, already best-effort/non-blocking).
   - `backfill-ai-memes`: add a new `fact_ai_meme_backfill` queue with:
     - Migration: `facts.ai_meme_backfill_status` (`varchar(16)`, nullable,
       idempotent `ADD COLUMN IF NOT EXISTS`, mirroring `pexels_status`) —
       **plus the journal entry (`_journal.json` idx 93) and
       `SNAPSHOT_EXEMPT_TAGS` entry (Codex round 23, P1)**; a SQL file
       alone is silently never applied by `lib/db/src/migrate.ts`.
     - `registerJobHandler` with a dedupe key per fact, `maxAttempts: 1`
       (`generateAiMemeBackgrounds` only persists `aiMemeImages` after
       every slot succeeds — automatic retry would regenerate/re-pay for
       already-succeeded slots), and `suppressErrors: false` on the
       `generateAiMemeBackgrounds` call (not the `true` other call sites
       use — the handler needs the throw to reach its own `catch` so a
       failure is actually recorded, not silently swallowed as success).
     - **`registerFactAiMemeBackfillHandler()` added to
       `artifacts/api-server/src/index.ts`'s existing registration block
       (Codex round 23, P1)** — a handler that's defined but never
       registered at startup leaves every enqueued job pending forever;
       every other queue is registered there explicitly.
     - Register on a new dedicated `"ai_meme_backfill"` lane
       (`maxConcurrency: 1`, env-overridable, matching the
       `fast`/`render`/`bulk` pattern) — the default unlabeled `bulk` lane
       runs 3 concurrent jobs, silently removing the existing
       sequential-processing safeguard (`admin.ts:2097-2102`).
     - Handler guard order (crash-recovery-safe, race-safe): on entry, if
       `ai_meme_backfill_status === "processing"`, this is a
       crash-recovery replay (`recoverStuckProcessing` resets a stuck job
       back to `pending` without incrementing `attempts`, bypassing
       `maxAttempts` entirely) — set `failed` and abort without calling the
       pipeline. Else, re-check `isActive` execution-time (an enqueue-time
       check alone misses a queue-wait deactivation race now that the lane
       is serialized) — on failure, set the terminal `skipped` value and
       return a `not_active` skip result. Only past both checks does the
       handler set `processing`, **immediately before** calling the
       pipeline (not any earlier — setting it before the `isActive`
       recheck would leave the marker stuck at `processing` on the
       inactive-skip path).
     - **Enqueue-side write, atomically ordered before the job becomes
       claimable (Codex round 23, P1 — corrects round 22's still-racy
       order):** `enqueueFactAiMemeBackfill` writes the fact's status
       FIRST (conditionally — `UPDATE ... SET ai_meme_backfill_status =
       'pending' WHERE id = ? AND ai_meme_backfill_status IS DISTINCT
       FROM 'processing'`), THEN calls `enqueueJob`. Writing after
       `enqueueJob` (round 22's order) leaves a window where a worker
       claims the row and sets `processing` before the enqueuer's own
       write runs, letting that write clobber it back to `pending` (or
       even overwrite a fast handler's terminal state). Ordering the
       write first closes the window entirely, since the job can't be
       claimed before it exists in `async_jobs`.
     - Check `isActive` before enqueueing too (route-level, explicit
       `not_active` skip outcome, no enqueue at all) — the execution-time
       recheck above is the narrow race-window backstop, not a substitute.
     Route this route's selected facts through the new queue.
   - **New frontend surface required — not additive to an existing panel
     (Codex round 23, P1):** no frontend caller exists today for any of the
     three bulk routes (the Facts Editor's `refresh-images` action is
     single-fact only) — this is itself a "no dead UI, no invisible
     backend" violation independent of the async-status rule. Add bulk-
     trigger controls for the three actions (e.g. a "Bulk Operations"
     section in the Facts Editor or an adjacent admin page) plus
     per-item/aggregate polling status, both following
     `useTaxonomyHealthActions.ts` as the reference pattern.
   - **Update the canonical lane documentation (Codex round 23, P2):**
     `docs/ai-context/architecture-map.md`'s "Three independent scheduling
     lanes" section and the matching `asyncJobs.ts` comments now describe
     five lanes (`fast`/`render`/`bulk`/`pexels`/`ai_meme_backfill`) with
     `fact_pexels` moved off `bulk` — update both, not as a follow-up.
   - Update/add tests: durable job row created per selected fact (root and
     variant); two overlapping bulk-trigger calls for the same fact dedupe
     onto one job, no duplicate external API calls; per-fact/aggregate
     status queryable to a terminal state. **(Codex round 19, P2):** an
     inactive fact selected by `backfill-images`/`backfill-pexels` gets an
     explicit `not_active` skip outcome, is never enqueued onto
     `FACT_PEXELS_QUEUE`, and — if it somehow were enqueued — assert the
     queue's own cost-guard no-op behavior (`pexelsStatus` stuck at
     `pending`) is exactly why the route-level skip is required, not
     optional cleanup.

     **`fact_ai_meme_backfill` (Codex rounds 20-22 — converged test list):**
     - A job whose handler throws is NOT retried: assert exactly one
       `generateAiMemeBackgrounds` call (with `suppressErrors: false`) for
       a forced-failure fixture, and the fact ends `failed`.
     - 4 facts enqueued are processed with at most 1 concurrently in
       flight at any instant (a controllable test double on
       `generateAiMemeBackgrounds` that blocks until released, asserting
       the second queued job doesn't start until the first finishes).
     - Crash-recovery replay: enqueue a job, let the handler set
       `ai_meme_backfill_status = "processing"` and call
       `generateAndStoreImage` at least once, then simulate a crash — leave
       the `async_jobs` row in `processing` past the recovery cutoff and
       call `recoverStuckProcessing` directly rather than waiting on the
       real timer. Re-run the worker tick — assert the handler sees
       `ai_meme_backfill_status === "processing"`, aborts without calling
       `generateAndStoreImage` again, and the fact ends `failed` — the
       paid call from the first attempt is never repeated.
     - Execution-time inactive skip: enqueue an active fact, deactivate it
       before the worker tick runs (simulating a queue-wait race), run the
       tick — assert zero calls to `generateAndStoreImage`/
       `generateAiMemeBackgrounds`, and both per-item and aggregate status
       report `skipped`/`not_active`, never `done`, and never left at
       `processing`.
     - Route-level inactive skip: an inactive fact selected by
       `backfill-ai-memes` gets an explicit `not_active` skip outcome and
       is never enqueued at all.
     - Dedupe preserves an in-flight `processing` marker: start a job (its
       handler sets `ai_meme_backfill_status = "processing"` and is
       mid-pipeline-call), then trigger a second, overlapping
       `backfill-ai-memes` call selecting the same fact — assert
       `enqueueJob` returns `inserted: false` (deduped onto the existing
       job) and `ai_meme_backfill_status` is still `processing`, NOT reset
       to `pending`. Then simulate a crash/recovery on that job (per the
       crash-recovery test above) — assert `generateAndStoreImage` is
       still called only once total, proving the dedupe path can't
       silently disarm the crash-recovery guard.
     - Migration: the `ai_meme_backfill_status` column exists after
       running migrations, defaults to `NULL` on existing rows, and the
       `ADD COLUMN IF NOT EXISTS` migration is safe to run twice.
     - **(Codex round 23, P1) Migration is actually wired in:** the new
       journal entry is present in `_journal.json` and `pnpm --filter
       @workspace/db check-snapshots` passes (the new tag is in
       `SNAPSHOT_EXEMPT_TAGS`); running `migrate` from a pre-change schema
       snapshot actually applies the column (not just "the SQL file
       exists").
     - **(Codex round 23, P1) Startup registration:** after normal server
       bootstrap, `fact_ai_meme_backfill` appears in the async-jobs
       registry (`getRegisteredQueues()` or equivalent), and an enqueued
       job actually reaches a terminal state — not left `pending` forever
       because nothing claims it.
     - **(Codex round 23, P1) Enqueue-write ordering under a real race:**
       pause between `enqueueJob`'s insert and the worker's claim (or
       inject a delay) so a worker claims and sets `processing` before
       any subsequent write could run — assert the fact's status is never
       clobbered back to `pending` and a crash-recovery replay still
       correctly aborts.
     - **(Codex round 23, P1) `FACT_PEXELS_QUEUE` pacing:** a bulk
       `backfill-pexels` selecting multiple facts processes them with at
       most 1 concurrently in flight (same blocking-test-double pattern
       as the AI-meme concurrency test), and the existing
       `firstTimeStagingPrep.ts` single-fact enqueue still functions
       correctly on the new `"pexels"` lane.
     - **(Codex round 23, P1) Frontend bulk controls:** clicking each of
       the three bulk actions in the new admin UI enqueues the expected
       jobs and the per-item/aggregate display reaches terminal
       done/failed/skipped states for every item, not just an initial
       count.
7. Frontend: remove the `selectedFact.parentId === null` gate around the
   Pexels Image Pipeline panel in `facts.tsx:1481-1482`; update its "(root
   facts only)" copy.
8. **Unblock send-back reprocessing for roots with active variants (site 13,
   Codex rounds 7-8):** remove the active-variant check in
   `lib/sendBackToReview.ts:102-114` and the `HAS_ACTIVE_VARIANTS` branch of
   `SendBackToReviewError`; remove `adminTaxonomyHealth.ts`'s now-unnecessary
   `factsWithActiveVariants()` pre-skip and its `HAS_ACTIVE_VARIANTS`
   skip-outcome branch in `pickSendBackTargets`; remove the
   `HAS_ACTIVE_VARIANTS` case from `factSendBackJob.ts`'s
   `sendBackGuardToSkip`. **Remove every other surface exposing this guard
   (round 8, P2):** the `"has_active_variants"` skip-reason member in
   `lib/api-zod/src/taxonomyHealth.ts:365`, the message-map entry in
   `useTaxonomyHealthActions.ts:39`, the switch case in
   `taxonomy-health.tsx:162`, the bulk confirmation dialog copy in
   `taxonomy-health.tsx:371` (round 11 — "or blocked by active variants"),
   the `SendBackToReviewCode` union member in the frontend's
   `sendBackToReview.ts:18`, and `admin.ts:1441`'s comment. Update
   `routes.sendBackToReview.test.ts`, `routes.admin.test.ts`,
   `enrichmentVersioning.refresh.test.ts`, `factSendBackJob.test.ts`,
   `adminTaxonomyHealth.guardQueryChunking.test.ts`,
   `routes.adminTaxonomyHealth.bulkSendBack.test.ts`, and the frontend's
   `sendBackToReview.test.ts`. Correct `docs/ai-context/taxonomy-and-enrichment.md`
   and `docs/ai-context/decisions.md` (both from PR #251) — they currently
   mischaracterize this guard as legitimate/structural; state it was removed
   as this bug's 13th site. **Also fix `taxonomy-and-enrichment.md:213-216`
   (Codex round 12)** — a separate, pre-existing error in the same file:
   it hardcodes `CLASSIFICATION_PROMPT_VERSION` as `"v5"` in prose, already
   wrong before this fix (live constant is `"v6"`) and would go stale again
   at `"v7"`; update to `"v7"` or stop hardcoding the value. Leave
   `factActivation.ts`'s separate `HAS_ACTIVE_VARIANTS` reparenting guard
   untouched.
8a. **Bounded repeated-failure circuit breaker for `bulk-send-back` (Codex
   round 19, P1 — a server-side mechanism, not just an operator habit):**
   add `factsWithRepeatedSendBackFailures(factIds, streak = 3)` to
   `adminTaxonomyHealth.ts` (same shape as `factsWithInFlightRefresh`) —
   flags a fact only when its 3 most recent `fact_send_back` jobs are all
   terminally `failed`. Wire into `pickSendBackTargets`'s `eligibleStaleIds`
   computation: excluded silently in `all_stale` scope (matching the
   existing `inFlight`/`withVariants` convention), still reachable via
   `scope: "selected"` as a deliberate manual retry. Add a
   `repeated_failure` member to `TaxonomyHealthSkipReason`
   (`lib/api-zod/src/taxonomyHealth.ts`) with message-map/row-state entries
   in `useTaxonomyHealthActions.ts` and `taxonomy-health.tsx`, so a flagged
   fact is discoverable per the existing "ineligible rows show their own
   state" design instead of silently vanishing from `all_stale` forever.
9. Update/add tests per the Testing Plan (root + variant fixture for every
   changed site).
10. Update the decision-log entry (`docs/ai-context/decisions.md`) to mark this
    fix as **done**, not just planned — the entry currently reads as a
    forward-looking "sites to fix"; close the loop once merged.
11. TEST_RUN + UAT docs (per the standing PR ritual), calling out the
    "variants may show no images until backfilled" visible change, and the
    post-deploy reprocess (`bulk-send-back`, run repeatedly until
    `eligibleRemaining` is 0 — covers every v6→v7-affected fact, `stale_only`
    is not involved).

## Risks and Mitigations

- **The repo-wide enumeration was already wrong twice during doc review**
  (Codex caught two missed sites in a row). Mitigation: step 1 of
  implementation re-runs the same `parentId`/`isNull(factsTable.parentId)`
  grep sweep immediately before touching code, not just trusting this plan's
  table — if anything shifted since the docs PR merged, catch it here.
- Removing `loadDirectVariantDependencies` touches tests that assert the old
  blocking behavior — must update, not just delete, so we don't lose coverage
  of whatever *does* still need to hold. **Corrected example (Codex round 10,
  P2 — my original example here named a guard that doesn't exist):** root
  deletion does NOT block on active variants — `DELETE /admin/facts/:id`
  (soft and hard) atomically cascades via `cascadeDeactivateActiveChildren`
  instead, and that cascade is the still-valid, unmodified behavior to keep
  covered, not a block.
- Bulk-backfill jobs now processing variants too increases their fact count
  (and therefore external API cost/duration) — expected per David's decision,
  not a regression, but worth a one-line note in TEST_RUN so Replit isn't
  surprised by a longer-running job during QA.

## Questions for David

**One outstanding:**

1. **(Codex round 11, P2 — my "none outstanding" claim was wrong; this
   genuinely needs your answer, not an in-repo assumption)**
   `scripts/backfill-pexels-images.mjs` (site 12) is not referenced anywhere
   else in this repo, but that only tells me it's unused *in-repo* — I can't
   see whether you or anyone else runs it manually/operationally outside
   what's visible here. **Do you use this script?** If no → delete it (the
   plan's default). If yes → it gets the same `parentId`-filter fix as its
   siblings instead of deletion, and stays.

**A second item that WAS here (Codex rounds 10/16/17), now resolved without
needing your input (Codex round 18):** whether to fold durable per-fact/
aggregate status into the three bulk-backfill routes turned out not to be a
product judgment call at all — `AGENTS.md` already has a standing,
cross-agent rule requiring exactly this whenever an async surface is
touched (`AGENTS.md:126-127`,
[`docs/ai-context/async-ui-status.md`](docs/ai-context/async-ui-status.md)),
and this plan touches these three routes directly. Folded in as required
scope (see Proposed Design and Implementation Steps) instead of asking you
to choose between "correct engineering" and "smaller PR."

The three other judgment calls from this session (variant re-word parity,
bulk-backfill scope, curation-spot scope) were resolved and are reflected
throughout the plan above.

## Definition of Done

- Repo-wide sweep re-confirmed at implementation time, **including outside
  `artifacts/`** (site 12 was found in the repo-root `scripts/` directory,
  not under `artifacts/api-server/src` where the original sweep was scoped —
  widen the re-sweep accordingly); all 13 listed sites fixed (including the
  frontend gate, both standalone/duplicate backfill scripts, and the
  send-back active-variant guard); no other `parentId`-gated images/
  enrichment/AI-generation site, and no other guard whose justification is
  parent-inheritance, remains anywhere in the repo (verified by grep, not
  assumed).
- A variant can: get its own stock/AI images (via explicit generation, admin
  refresh, or now-inclusive bulk backfill), get its own enrichment classified
  from its own text only, and have its own confirmed text edit trigger its own
  embed + image pipeline — all independent of its root.
- A root re-word never touches, blocks on, or invalidates any variant.
- The enrichment classifier prompt (`buildEnrichmentUserMessage`) is
  byte-identical in shape for a root and a variant given the same text — no
  `status`/parent-text signal remains that could make identical text classify
  differently based on `parentId`.
- No trace of `DEPENDENT_VARIANT_IN_PROGRESS`/`blockingVariants`/
  `affectedVariantCount` remains in **live** source (shared contract, admin
  UI, tests) — a root re-word's success/error messaging no longer mentions
  variants. **Scope note (Codex round 9, P2):** this check excludes
  historical `docs/PR<N>_*_TEST_RUN.md` snapshots (e.g.
  `docs/PR228_APPROVED_FACT_TEXT_LOCK_TEST_RUN.md:87,95`, which still
  references both terms) — per this repo's standing convention those docs
  are transient, point-in-time records of what a past PR tested, not live
  contracts kept in sync going forward (CLAUDE.md: "the TEST_RUN doc is
  transient — David deletes it once Replit has run it"). Not scheduled for
  edit or retirement as part of this fix.
- `CLASSIFICATION_PROMPT_VERSION` is `"v7"`; every fact classified under the
  old prompt is surfaced as `staleForReprocess` by Taxonomy Health (with or
  without a prior signature), and the `bulk-send-back` post-deploy reprocess
  is documented in TEST_RUN, not silently left for someone to discover.
- A root with an active variant can be sent back to review /
  bulk-reprocessed like any other fact — `sendFactBackToReview` no longer
  rejects it, proven by an actual root-with-active-variant fixture
  succeeding through `bulk-send-back`, not just a claim that it should work.
- A repo-wide search for `HAS_ACTIVE_VARIANTS`/`has_active_variants` finds
  it in exactly one place: `factActivation.ts`'s unrelated reparenting
  guard. The canonical docs no longer describe the send-back variant guard
  as legitimate.
- Structural invariants (no variants-of-variants, active-root-parent
  enforcement, `factActivation.ts`'s reparenting guard, and root deletion's
  atomic cascade-deactivate-children via `cascadeDeactivateActiveChildren` —
  not a block) all still hold — verified by the existing tests for those,
  unmodified in behavior.
- Full test suite green; `check:docs`/`check:codegen-drift` clean.
- The decision-log entry is updated to reflect this is shipped.
- David can exercise it: create a variant, generate its own AI meme, confirm
  it shows the variant's own image (not the root's) everywhere.
