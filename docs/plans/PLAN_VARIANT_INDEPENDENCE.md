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
must be an active root, `HAS_ACTIVE_VARIANTS` blocking root deletion/moderation
mid-cycle).

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

## Current Behavior

**Confirmed bugs (metadata inheritance / root-only generation) — 9 sites:**

| # | Site | Current behavior |
|---|---|---|
| 1 | `routes/facts.ts:233-243` (`GET /facts/:id`) | Fills in the root's images for whichever kind (`pexelsImages`/`aiMemeImages`) the variant lacks |
| 2 | `routes/facts.ts:587-590` (`GET /facts/:factId/pexels-images`) | **Unconditionally replaces** a variant's own stock images with the root's — a variant can never surface its own |
| 3 | `lib/enrichmentJobs.ts:140-206, 354-386` | Classifies a variant with the root's text as context (`status: "variant"`, `parentText`); `parentId` + parent text are baked into the staleness fingerprint |
| 4 | `lib/factTextEditProtection.ts` (`loadDirectVariantDependencies`, `VariantDependency`) | Blocks a root text edit while any direct variant has an unresolved review or active enrichment job — exists only to protect #3 |
| 5 | `lib/confirmedFactTextEdit.ts:200-204` | Clears every child variant's `lastProcessedSignature` on a confirmed root edit, marking them `stale_for_reprocess` — exists only to protect #3 |
| 6 | `routes/admin.ts:1012` (`confirmedFactTextEdit` PATCH dispatch, `protected_committed` case) | Only a ROOT's confirmed edit triggers `embedFactAsync` + `runFactImagePipeline`; a variant's edit triggers neither |
| 7 | `routes/admin.ts:1990` (`POST /admin/facts/:id/refresh-images`) | Explicit 400: "Images are only stored on root facts, not variants." |
| 8 | `routes/admin.ts:1999-2013, 2015-2034, 2077-2091` (`backfill-images`, `backfill-pexels`, `backfill-ai-memes`) | All three filter `isNull(factsTable.parentId)` — variants silently never processed |
| 9 | `routes/memes.ts:1324-1332`, `routes/pulidJobs.ts:217-233` | Explicit 400: "AI meme generation only supported on root facts" — a legendary user cannot generate an AI visual for a variant today |

**Legitimate, unchanged (verified structural or display, not inheritance):**
`facts.ts:110,156,361`, `admin.ts:736,860,866,901,912,1550,1580`, `memes.ts:468`,
`factActivation.ts:123,127,177`, `resubmitForModeration.ts:98-106`,
`sendBackToReview.ts:107`, `adminTaxonomyHealth.ts:179-184`,
`moderationStaging.ts:119`, `enrichmentVersioning.ts` (already the *correct*
pattern — its field-preservation invariant treats `parentId`, `pexelsImages`,
`aiMemeImages` as variant-owned).

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
  and from the staleness fingerprint. `status` becomes purely informational
  (or can stay `"variant"` vs `"new_fact"` as a data point the classifier
  doesn't need external text for) — the classifier call for a variant looks
  identical in shape to a root's, just always solo-text.
- `factTextEditProtection.ts`: remove `loadDirectVariantDependencies`,
  `VariantDependency`, and the root-edit-blocks-on-in-flight-variant check
  entirely. A root re-word no longer needs to look at its variants at all.
- `confirmedFactTextEdit.ts:200-204`: remove the child-signature-clearing
  block. A root re-word touches only the root row.
- `admin.ts:1012`: change the `protected_committed` dispatch to trigger
  `embedFactAsync` + `runFactImagePipeline` for **the fact being edited**,
  regardless of `parentId` (root or variant) — per David's decision 1. Drop
  the `outcome.fact.parentId === null` gate.

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
  three queries' `where` clauses (per David's decision 2) — `backfill-images`
  becomes "all active facts missing `pexelsImages`" (root or variant), same
  pattern for `backfill-pexels` and `backfill-ai-memes`.
- `memes.ts:1324-1332`, `pulidJobs.ts:217-233`: remove the `parentId !== null`
  rejection. AI meme / PuLID generation operates on any fact the caller is
  authorized to generate for (existing tier/ownership checks are untouched —
  this only removes the root-only fact-shape restriction, not any auth check).

**No frontend gating currently mirrors these backend restrictions** (verified:
the meme-builder wizard, admin Facts Editor, and enrichment UI don't
conditionally hide these actions for variants — they just get 400s today).
So this is a backend-only change; no dead-UI risk, and no new UI needs to ship
for the restriction to lift (ship-the-UI-surface's "don't ship dead controls"
concern doesn't apply in reverse here — we're removing a silent block, not
adding a control).

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

## Admin/User UX Impact

- **Existing variants may go from "has (root's) photos" to "has none" in the
  picker/detail view**, until an admin runs the (now variant-inclusive) bulk
  backfill or someone explicitly generates images for them. This is a visible,
  expected consequence of removing the fallback — flag in the TEST_RUN/UAT
  docs so David isn't surprised seeing it in QA. Pre-launch, no real user
  impact.
- No new UI ships (per Proposed Design — no frontend gating existed to
  remove/add).
- Admin's confirmed-edit flow for a variant now kicks off a background embed +
  image pipeline, same as a root edit already does — no new UI state needed
  (the root path's existing "processing" signal, if any, already covers this
  shape of async work).

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
  component. Re-wording a root does NOT change a variant's
  `lastProcessedSignature` or trigger any job for it (negative case).
- `factTextEditProtection`/`confirmedFactTextEdit`: a root text edit succeeds
  immediately even with an in-flight variant review/job (previously blocked) —
  `loadDirectVariantDependencies` and its call sites are gone; grep-level test
  or lint that the symbol no longer exists.
- `admin.ts:1012`: confirming a variant's text edit triggers `embedFactAsync`
  + `runFactImagePipeline` for the variant's own id; confirming a root's edit
  still triggers them for the root, unaffected.
- `facts.ts:233`/`587`: a variant with its own `pexelsImages` shows its own; a
  variant with none shows none — never the root's, in both the detail summary
  and the picker endpoint. Root behavior unchanged.
- `refresh-images`: succeeds for a variant id (no more 400); still succeeds for
  a root.
- Bulk backfill (all three): a variant missing images is included in the
  queued/processed set; a root missing images still is too. Idempotency
  (already-has-images facts skipped) holds for both.
- AI meme/PuLID generation: a legendary user can generate for a variant fact
  id; existing tier/auth rejections for non-legendary or wrong-owner requests
  are unchanged (negative cases still fire).
- Full suite: `pnpm test` (api-server), `pnpm run check:codegen-drift` if any
  shared type/export surface moves, `pnpm run check:docs`.

## Implementation Steps

1. Enrichment independence: strip parent context from `enrichmentJobs.ts`
   (both the initial classify and the recheck-after-classify paths) and its
   staleness fingerprint.
2. Remove the now-pointless dependency machinery: `loadDirectVariantDependencies`/
   `VariantDependency` from `factTextEditProtection.ts`, the blocking check in
   its caller, and the signature-clearing block in `confirmedFactTextEdit.ts`.
   Update/remove tests that assert the old blocking/clearing behavior
   (`factTextEditProtection.test.ts`, `confirmedFactTextEdit.test.ts` — check
   for asserted 409s referencing `DEPENDENT_VARIANT_IN_PROGRESS` and
   `blockingVariants`/`affectedVariantCount` response fields that no longer
   apply).
3. `admin.ts:1012`: drop the root-only gate on the confirmed-edit embed/image
   trigger.
4. Stock/AI image display: remove the parent-fallback in `facts.ts:233-243`
   and the parent-substitution in `facts.ts:587-590`.
5. Image/AI generation: remove the `parentId !== null` guard in
   `admin.ts:1990`, `memes.ts:1324-1332`, `pulidJobs.ts:217-233`; remove
   `isNull(factsTable.parentId)` from the three bulk-backfill queries in
   `admin.ts`.
6. Update/add tests per the Testing Plan (root + variant fixture for every
   changed site).
7. Update the decision-log entry (`docs/ai-context/decisions.md`) to mark this
   fix as **done**, not just planned — the entry currently reads as a
   forward-looking "sites to fix"; close the loop once merged.
8. TEST_RUN + UAT docs (per the standing PR ritual), calling out the
   "variants may show no images until backfilled" visible change.

## Risks and Mitigations

- **The repo-wide enumeration was already wrong twice during doc review**
  (Codex caught two missed sites in a row). Mitigation: step 1 of
  implementation re-runs the same `parentId`/`isNull(factsTable.parentId)`
  grep sweep immediately before touching code, not just trusting this plan's
  table — if anything shifted since the docs PR merged, catch it here.
- Removing `loadDirectVariantDependencies` touches tests that assert the old
  blocking behavior — must update, not just delete, so we don't lose coverage
  of whatever *does* still need to hold (e.g., root deletion still can't
  proceed with active variants — a different, still-valid guard).
- Bulk-backfill jobs now processing variants too increases their fact count
  (and therefore external API cost/duration) — expected per David's decision,
  not a regression, but worth a one-line note in TEST_RUN so Replit isn't
  surprised by a longer-running job during QA.

## Questions for David

None outstanding — the three genuine judgment calls (variant re-word parity,
bulk-backfill scope, curation-spot scope) were resolved this session.

## Definition of Done

- Repo-wide sweep re-confirmed at implementation time; all 9 listed sites
  fixed; no other `parentId`-gated images/enrichment/AI-generation site
  remains (verified by grep, not assumed).
- A variant can: get its own stock/AI images (via explicit generation, admin
  refresh, or now-inclusive bulk backfill), get its own enrichment classified
  from its own text only, and have its own confirmed text edit trigger its own
  embed + image pipeline — all independent of its root.
- A root re-word never touches, blocks on, or invalidates any variant.
- Structural invariants (no variants-of-variants, active-root-parent
  enforcement, root-deletion-blocked-by-active-variants) all still hold —
  verified by the existing tests for those, unmodified in behavior.
- Full test suite green; `check:docs`/`check:codegen-drift` clean.
- The decision-log entry is updated to reflect this is shipped.
- David can exercise it: create a variant, generate its own AI meme, confirm
  it shows the variant's own image (not the root's) everywhere.
