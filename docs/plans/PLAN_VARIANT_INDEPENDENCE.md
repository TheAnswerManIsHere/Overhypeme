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
(queries all active facts with no `parentId` filter at all).

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
  **Pre-existing, out of scope (Codex round 10, P1) — a real concurrency gap,
  not fixed here:** `isNull(pexelsImages)` makes `backfill-images`/
  `backfill-pexels` idempotent across sequential re-runs (a completed fact is
  excluded next time), but NOT safe against two overlapping invocations —
  both fire-and-forget `void runFactImagePipeline(...)` per fact with no
  dedup key or durable per-fact status, unlike the existing
  `enqueueFactPexels`/`FACT_PEXELS_QUEUE` infrastructure
  (`factPexelsJobs.ts`) that already solves exactly this for other call
  sites. Two overlapping bulk-triggers can both select the same
  not-yet-updated row and duplicate OpenAI/Pexels API calls for it. This gap
  predates this fix and affects roots today; widening the pool to variants
  doesn't change the *likelihood* of a double-trigger, only the blast radius
  if one happens. Rearchitecting these two routes onto the durable queue (and
  building an equivalent for `backfill-ai-memes`, which has the same
  fire-and-forget shape) is real, separate scope — a technical-debt item for
  David to prioritize on its own, not folded into this PR. The Testing Plan
  below is corrected to claim only sequential-re-run idempotency, not
  concurrent-invocation safety.
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

None. No schema change. No backfill: this changes *behavior going forward*,
not stored data. Existing variant rows with `pexelsImages: null` /
`aiMemeImages: null` simply become eligible for the same generation paths a
root already uses — nothing to migrate, nothing destructive.

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
  job later exhausted retries (Codex round 15, P1 — see Implementation Step
  2):** the TEST_RUN doc's stop condition is `eligibleRemaining: 0` AND
  `failed: 0` on the same response AND no terminally-`failed`
  `fact_send_back` jobs — not `eligibleRemaining: 0` alone.

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
  `eligibleRemaining` alone can't be the stop signal. Then assert a
  follow-up `bulk-send-back` call (enqueue succeeding this time) selects
  and successfully queues that same fact — proving the documented
  check-`failed`-and-retry step actually recovers it. Separately, assert a
  `fact_send_back` job that exhausts its retries lands in terminal `failed`
  status in the async-jobs table with no candidate row created for that
  fact, and that the fact still evaluates `staleForReprocess` — i.e. it's
  neither "done" nor "in review," so it can only be caught by checking job
  status, not by the response body or the in-flight-review check alone.
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
  directly, since it has no such check today. **Correction (Codex round 10,
  P1): this is NOT concurrent-invocation safety** — two overlapping
  bulk-triggers can still duplicate work per fact (pre-existing gap, out of
  scope, documented above). Do not test or claim overlapping-invocation
  idempotency; that's a separate rearchitect.
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
   `staleForReprocess` with nothing tracking it as pending. Operator
   guidance, three conditions must ALL hold before the reprocess is
   actually done: (1) a `bulk-send-back` (`all_stale`) response with
   `eligibleRemaining: 0` **and** `failed: 0`; (2) no `fact_send_back`
   queue jobs in terminal `failed` status (check the async-jobs table/admin
   view) — if any exist, re-run `bulk-send-back` targeting those fact ids
   (`scope: "selected"`) since the underlying fact is still stale and
   uncaptured, so the picker will select it again; (3) round 14's
   in-flight-review resolution + re-run. Document all three as the actual
   stop condition in the TEST_RUN doc — "`eligibleRemaining` hits 0" alone
   is necessary but not sufficient.
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

**One outstanding (Codex round 11, P2 — my "none outstanding" claim was
wrong; this genuinely needs your answer, not an in-repo assumption):**

1. `scripts/backfill-pexels-images.mjs` (site 12) is not referenced anywhere
   else in this repo, but that only tells me it's unused *in-repo* — I can't
   see whether you or anyone else runs it manually/operationally outside
   what's visible here. **Do you use this script?** If no → delete it (the
   plan's default). If yes → it gets the same `parentId`-filter fix as its
   siblings instead of deletion, and stays.

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
