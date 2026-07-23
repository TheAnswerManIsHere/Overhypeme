# Phase 2 — Closing the fact lifecycle: activation guard + ingestion funnel

> Plan-review artifact. **Not approved for implementation** until David approves
> in words. Phase 1 (PR #234) made the Visual Concept *required within the
> moderation flow*; Phase 2 makes that requirement — and moderation itself —
> **impossible to bypass**, on both ends of the fact lifecycle.

## Problem

A fact can currently become **active/visible with no Visual Concept and no
enrichment at all**, because the moderation pipeline is *opt-in*, not enforced:

1. **The storage default is "live."** `facts.is_active` defaults to `true`
   (`lib/db/src/schema/facts.ts:34`), so any insert that doesn't explicitly say
   otherwise produces a live fact. Only the moderation staging path opts out
   (`moderationStaging.ts:61`, `isActive: false`).
2. **Multiple ingestion paths skip moderation entirely** and land active,
   enrichment-null facts: admin direct-create (`POST /facts`), three bulk-import
   endpoints, and variant creation. None touch a review, a `workflowStage`, or
   the concept gate.

The symptom: the "every visible fact passed the Visual Concept gate" invariant
Phase 1 established is only true for user-submitted facts. Admin/bulk/variant
facts violate it silently — active, conceptless, unrenderable-as-a-good-meme.

## Product Intent

David's two verbatim principles:

- **One exit:** "in order for the fact to be released into production, it must
  have a Visual Concept so that the image and video engines have something to
  work with when we make memes. Without the ability to make good memes, the fact
  can't be made available to view."
- **One entrance:** "there should only be two ways that a fact gets into the
  system. The first is the manual path where a user submits a fact. The second
  is a bulk import. In both those cases, the ingestion of the fact should put it
  on stage 1 of the moderation flow where it needs to be triaged, then enriched,
  then activated. If we ever have a future way of ingesting a fact (API for
  example) then it should also just be filling the front of that production
  pipeline."

**Outcome:** the fact lifecycle becomes a closed system — every fact enters at
Stage 1 (`triage_pending`), and the *only* way to `is_active: true` is completing
moderation with a non-empty Visual Concept, enforced both in the application and
at the database.

**Must NOT change:**
- The manual user-submission path — it already routes correctly to Stage 1 and
  is cost-gated (no fact/enrichment/spend until provisional approval). Leave its
  behavior intact.
- The refresh/send-back flow — it refreshes *already-active* facts and never
  touches `is_active`; it stays as-is.
- Existing live facts stay live (grandfathered — see below); this is not a purge.
- The render-time plan/compiler remains the prompt source of truth; the Visual
  Concept remains the authoritative scene.

**Settled decisions (David, this session):**
1. Bulk import routes to Stage 1 and runs the full pipeline — it becomes a way to
   *load the moderation queue*, not to publish. (Confirmed, consequence accepted.)
2. Admin direct-create (`POST /facts`) is **removed** — it was bootstrapping
   scaffolding; David wants a user-generated-content site to avoid copyright
   surface.
3. Variants are "normal facts that happen to have a parent" — routed **into
   moderation**, carrying their parent linkage.
4. Dev fixtures may do whatever dev needs (but must satisfy the DB constraint —
   see Testing).
5. DB backstop **included** (David deferred the call; recommended and accepted).
6. Existing active-but-conceptless facts are **grandfathered** and **backfilled**
   with a visible sentinel concept `{NAME} stands there confidently.` so they're
   obviously placeholders (David will replace them shortly).
7. All in one plan (this one).

## Repo Context Inspected

Two structured recon passes (activation paths + design details) covered:

- Schema: `lib/db/src/schema/facts.ts` (`is_active` default, enrichment columns),
  `lib/db/src/schema/reviews.ts` (`pendingReviewsTable`, `reviewWorkflowStageEnum`).
- Enrichment materialization: `artifacts/api-server/src/lib/factEnrichment.ts`
  (`materializeEnrichment`, `materializeFromBaseline`), Visual Concept shape
  `lib/api-zod/src/visualStrategyOverride.ts`.
- Moderation: `lib/api-zod/src/moderationWorkflow.ts` (stage machine),
  `artifacts/api-server/src/lib/moderationStaging.ts` (`ensureStagingFact`,
  `resolveReviewCycleEnrichment`, `resolveSavedCoreSceneForReview`),
  `firstTimeStagingPrep.ts`, `sendBackToReview.ts`.
- Activation + gates: `routes/reviews.ts` (`submit-review`, `provisional-approve`,
  `approveForProduction` with `CONCEPT_MISSING`, candidate/override PATCH routes
  with `visual_concept_required`).
- Ingestion: `routes/facts.ts` (`POST /facts`), `routes/import.ts`,
  `routes/admin.ts` (import/import-csv, variants), `routes/reviews.ts`
  (`submit-review`).
- Codegen contract: `lib/api-spec/openapi.yaml`, generated `@workspace/api-zod`
  and `@workspace/api-client-react`, `artifacts/overhype-me/src/hooks/use-mutations.ts`.
- Seed/scripts: `lib/seed.ts`, `scripts/src/seed.ts`, `scripts/src/reseed-facts.ts`.
- Docs: `docs/ai-context/moderation-workflow.md`, `visual-pipeline.md`,
  `decisions.md`, `docs/engineering/migrations-and-backfills.md`.

## Current Behavior

- **`is_active` default `true`** — inserts are live unless they opt out.
- **Manual submit** (`POST /facts/submit-review`) → creates a `pendingReviews`
  row at `workflowStage: "triage_pending"`, `enrichment: null`. No fact row yet
  (cost gate). Correct.
- **Activation** happens at exactly one place: `approveForProduction`
  (`reviews.ts:741-748`) flips a pre-existing inactive staging fact to
  `isActive: true` and sets `parentId`. It is concept-gated (`reviews.ts:687`,
  `CONCEPT_MISSING`), hashtags-gated, and render-gated.
- **`parentId`** is carried on the *staging fact* (`facts.parent_id`), set at
  provisional-approve from the request body → `ensureStagingFact` →
  `approveForProduction`. `pendingReviews` has **no parent column**.
- **Bypass paths** (all insert `isActive: true`, enrichment null, no review):
  `POST /facts` (dead code — no live caller, no test; codegen'd into two client
  packages); `POST /admin/import/facts` (dedup + hashtags + embeddings);
  `POST /admin/facts/import` + `import-csv` (no dedup/hashtags/embeddings);
  `POST /admin/facts/:id/variants` (sets only `parentId`, copies nothing).
- **The Visual Concept lives inside the `enrichment` JSONB** at
  `enrichment -> 'visualPromptStrategyOverride' ->> 'coreSceneOverride'`. There is
  **no dedicated column** for it.
- **One insert relies on the default:** `scripts/src/seed.ts:80-89` (dev seed)
  inserts without `isActive`.

## Source-of-Truth Analysis

- **Active enrichment truth:** `facts.enrichment` (materialized effective blob).
  The Visual Concept is a sub-object of it; **no mirror column** — so the DB
  constraint must read the JSON path, not a column. We do **not** introduce a
  duplicate concept column (that would create a second source of truth to keep in
  sync with `materializeEnrichment`).
- **Activation truth:** `facts.is_active`. Today set from many places; Phase 2
  funnels every *activation* through one helper so there is a single writer of
  `is_active = true`.
- **Entry-point truth:** the moderation stage machine (`moderationWorkflow.ts`).
  Every ingestion path must produce a Stage-1 review, never a fact row directly.
- **Parent linkage truth:** currently `facts.parent_id`, populated only at/after
  provisional-approve. Phase 2 adds `pending_reviews.parent_fact_id` as the
  *carrier* from submission → staging; `facts.parent_id` remains the final truth
  (the new column feeds it, never competes with it).

## Proposed Design

Three coordinated layers. The unifying idea: **facts are born inactive; the only
door out is a single concept-checked activation helper; the only door in is a
Stage-1 review.**

### A. Activation guard (the exit)

1. **Invert the storage default:** `facts.is_active` → `.notNull().default(false)`.
   Facts are born inactive; activation is now an explicit, opt-in act. Make
   `scripts/src/seed.ts` set `isActive` explicitly (it's the one path relying on
   the old default).
2. **Single activation chokepoint:** a shared helper
   `activateFact(tx, { factId, parentId, expectedText })` in
   `lib/factActivation.ts` (new). It performs the guarded update currently inline
   at `reviews.ts:741-748`: it re-reads the row's effective concept, refuses
   (throws a typed `ConceptMissingError`) if `coreSceneOverride` is blank/absent,
   then flips `is_active = true` under the same compare-and-set predicates
   (`is_active = false`, `text = expectedText`). `approveForProduction` calls it
   instead of updating inline. **This is the only code that sets `is_active =
   true`.** (The existing app-level `CONCEPT_MISSING` gate stays as the early,
   friendly 409; the helper is the last-line assertion.)
3. **DB backstop — CHECK constraint** on `facts`:
   ```sql
   ALTER TABLE facts ADD CONSTRAINT facts_active_requires_concept
     CHECK (
       is_active = false
       OR (enrichment #>> '{visualPromptStrategyOverride,coreSceneOverride}') ~ '\S'
     );
   ```
   `~ '\S'` matches "contains a non-whitespace char" — mirroring the app's
   `.trim()` non-empty semantics (a whitespace-only scene fails, exactly like the
   app gate). Added **after** the backfill (below), so it can be added **VALID**
   (fully enforced, no existing violators) rather than the weaker `NOT VALID`.

### B. Ingestion funnel (the entrance)

The reusable primitive: the `submit-review` row-build (`reviews.ts:191-202`) —
"create a `triage_pending` review." Extract it into a shared
`createTriageReview(tx, { submittedText, submittedById, hashtags, parentFactId? })`
helper in `lib/moderationStaging.ts` (or a sibling). Manual submit, bulk import,
and variants all call it. `enrichment`/`canonicalText`/`hashtag upsert`/`embeddings`
stay deferred to the pipeline (as manual submit already does) — nothing derives
them at ingest.

1. **Manual submit — unchanged**, but refactored to call `createTriageReview`
   (behavior identical; proven by its existing tests).
2. **Remove `POST /facts`:** delete the route (`routes/facts.ts:422-490`), the
   `/facts` `post:` entry in `openapi.yaml`, regenerate `@workspace/api-zod` +
   `@workspace/api-client-react` (per the codegen discipline in CLAUDE.md — update
   `patch-generated.mjs` line-list if an export drops, run codegen, confirm clean
   diff), and delete the dead `useCreateFact`/`createFact` wiring in
   `use-mutations.ts`. No live caller, no test — clean.
3. **Reroute the three bulk-import endpoints:** instead of inserting active facts,
   each row becomes a `createTriageReview` call (admin as `submittedById`).
   - **Preserve exact-text dedup** (currently only on `POST /admin/import/facts`)
     — extend it to all three so bulk import can't flood triage with duplicates;
     dedup against both existing facts *and* existing unresolved reviews.
   - **Drop** at-ingest `canonicalText`/`splitTokenIndex`/`hasPronouns`, hashtag
     upsert, and embeddings — the review→staging→approval pipeline re-derives each
     at its proper stage (`ensureStagingFact`, approval). Store raw hashtags on
     the review.
   - **Reconcile normalizers:** bulk used `normalizeFactTemplateForStorage`;
     submit uses `normalizeFactTemplateForPendingReview`. Route all ingest through
     the pending-review normalizer so bulk rows normalize identically to
     user-submitted ones (confirm equivalence in a test; if they differ
     materially, that's a finding to escalate).
   - **Relax the per-user unresolved-review cap** for admin bulk import (the cap
     is an anti-spam guard for end users; an admin loading the queue is exempt).
   - **Response shape + UI:** endpoints now return `{ queued, skipped, failed }`
     ("queued for moderation") not `{ created }`. Update the admin import UI
     (`facts.tsx` `handleImport`) copy to "Queued N facts for triage" and adjust
     the consumed shape.
4. **Reroute variant creation:** add a nullable **`pending_reviews.parent_fact_id`**
   column (FK → `facts.id`). Variant creation (`POST /admin/facts/:id/variants`)
   becomes `createTriageReview(tx, { …, parentFactId: rootId })` — it creates a
   Stage-1 review carrying the parent, not an active fact. Thread `parent_fact_id`:
   review → `provisional-approve` (default the staging parent from the review's
   `parent_fact_id` when the body doesn't override) → `ensureStagingFact` →
   `approveForProduction` (unchanged; already reads `stagingFact.parentId`). The
   variant thus earns its **own** triage/enrichment/concept, with the parent
   linkage surviving to activation. Update `facts.tsx` `addVariant` to reflect the
   new "queued for review" outcome (it no longer gets an active `variant` back).

### C. Grandfather backfill (existing data)

A migration/backfill that stamps the sentinel Visual Concept into every currently
**active** fact whose effective `coreSceneOverride` is blank/absent — so that
after it runs, **no active fact violates the new constraint** and the CHECK can be
added VALID.

- Sentinel: `coreSceneOverride: "{NAME} stands there confidently."` — a valid,
  renderable, obviously-generic scene; greppable so David can find and replace
  them. (It carries the `{NAME}` token, consistent with authored concepts.)
- For facts **with** an enrichment blob but no scene: set
  `enrichment.visualPromptStrategyOverride.coreSceneOverride` to the sentinel
  (materialize the VSO layer if `visualPromptStrategyOverride` is absent),
  re-materializing via the same `materializeEnrichment` path so all derived
  columns stay canonical.
- For facts with **null enrichment** (bulk-imported/admin-created): materialize a
  **minimal valid enrichment** carrying only the sentinel VSO. (These facts have
  no taxonomy either; the sentinel makes them constraint-valid and renderable-ish
  until David redoes them. Flag in the migration doc that these remain
  taxonomy-poor — expected pre-launch.)
- **Grandfather:** never set `is_active = false` on an existing fact. Live stays
  live.

## Data Model and Migration Impact

Three schema/data changes, sequenced in one migration series:

1. **`facts.is_active` default `true` → `false`** (schema change; affects future
   inserts only — no existing row changes).
2. **New column `pending_reviews.parent_fact_id` uuid NULL, FK → facts.id**
   (`ON DELETE SET NULL`). Additive, nullable — no backfill needed (existing
   reviews have no parent).
3. **Backfill** the sentinel concept into active-conceptless facts (Section C).
4. **`facts_active_requires_concept` CHECK constraint**, added **VALID after** the
   backfill.

**Ordering (must hold):** default-flip + column-add → backfill → add CHECK VALID.
If the CHECK is added before the backfill it rejects the grandfathered rows and
the migration fails.

**Idempotency / observability / rollback** (per
`docs/engineering/migrations-and-backfills.md`):
- Backfill is idempotent: it only touches facts where `is_active = true` AND the
  effective `coreSceneOverride` is blank/absent; re-running is a no-op (those rows
  now have the sentinel). Guard by matching blank scene, not "equals sentinel," so
  a re-run after a partial failure completes cleanly.
- Emit counts: candidates scanned, backfilled (with-enrichment vs null-enrichment
  split), already-had-concept (skipped), failed.
- Rollback: the CHECK can be dropped; the column can be dropped; the default can
  be restored. The sentinel backfill is *forward-only* data (harmless if left —
  it's a valid concept), but the migration doc will note the grep to find/undo
  sentinels if ever needed.

**Row-state matrix** (backfill):

| Row state | Action |
|---|---|
| active + real concept | skip (no-op) |
| active + blank/absent concept, enrichment present | set sentinel in VSO, re-materialize |
| active + null enrichment | materialize minimal enrichment w/ sentinel VSO |
| inactive (any) | skip — constraint permits inactive-without-concept |
| already sentinel (re-run) | skip (blank-scene predicate no longer matches) |

## Runtime Behavior

- **Every new fact is inactive at birth.** The only transition to active is
  `activateFact`, reachable only via `approveForProduction` after the full
  pipeline + non-empty concept.
- **Bulk import** now enqueues Stage-1 reviews. Admin sees "queued N for triage";
  facts appear only after moderation. Duplicates (vs facts or open reviews) are
  skipped and reported.
- **Variants** enter Stage 1 with their parent recorded; they get their own
  triage/enrichment/concept; on approval the activated fact carries `parent_id`.
- **A raw SQL / future code path** that tries to set `is_active = true` on a
  conceptless fact is rejected by the DB constraint — the true backstop.
- **Edge cases:** whitespace-only concept → rejected by both app gate and
  constraint (`~ '\S'`). A fact sent back to review stays active (refresh path
  untouched). A variant whose parent is later deleted → `parent_fact_id` nulls
  (FK `SET NULL`), review still valid.

## Admin/User UX Impact

- **Admin import UI** (`facts.tsx`): success copy changes from "imported N facts"
  to "Queued N facts for triage; M skipped as duplicates" — sets the expectation
  that imported facts are now moderation work, not live content. Standard
  loading/error/partial states already exist; extend the result summary to the
  `{ queued, skipped, failed }` shape.
- **Variant button** (`facts.tsx` `addVariant`): outcome becomes "Variant queued
  for review" instead of appearing immediately in the fact list. Copy + local
  state update accordingly (no `variant` row returned).
- **No end-user-facing change** — submission is unchanged; users never saw the
  admin/bulk/variant paths.
- Async status: bulk import is synchronous per-request today (returns counts); it
  stays synchronous, just producing reviews. The Stage-1 triage queue is the
  existing per-item status surface.

## Security, Permissions, and Validation

- Route protection unchanged: import stays `requireApiKey`/`requireAdmin`,
  variants `requireAdmin`, submit `requireAuth`.
- Removing `POST /facts` removes an admin write surface (net security reduction of
  attack surface).
- The DB CHECK is defense-in-depth against any route/SQL that bypasses the app
  gate.
- Validation: bulk rows go through the same pending-review normalizer + zod as
  user submissions; the per-user cap is bypassed only for the admin bulk path
  (documented, admin-authed).
- Audit: activation remains the audited transition; no new PII.

## Testing Plan

Runners: backend `bash artifacts/api-server/scripts/run-test.sh [--setup]
src/__tests__/<file>`; frontend `pnpm --filter @workspace/overhype-me exec vitest
run <file>`; typechecks `pnpm run typecheck:libs`,
`pnpm --filter @workspace/api-server run typecheck`,
`pnpm --filter @workspace/overhype-me run typecheck`.

**The DB CHECK constraint has a test-fixture blast radius:** every test that
inserts an *active* fact without a concept will now violate it. Mitigation: a
shared test helper `insertActiveFactWithConcept(...)` (sentinel concept) and a
mechanical sweep of active-fact fixtures. Inactive-fact fixtures are unaffected.

New/updated tests proving the **invariants** (with negative cases):
1. **Constraint:** a raw insert/update setting `is_active = true` with blank/absent
   concept is rejected by the DB; with a concept it succeeds; whitespace-only is
   rejected (`~ '\S'`). Inactive-without-concept is allowed.
2. **`activateFact` helper:** activates with a concept; throws `ConceptMissingError`
   without one; honors the compare-and-set (won't double-activate, won't activate
   on text drift).
3. **Default flip:** a bare `insert(factsTable)` lands inactive.
4. **Ingestion funnel:** `POST /facts` returns 404 (removed); each bulk endpoint
   creates `triage_pending` reviews (not facts), dedups exact-text against facts
   AND open reviews, and reuses the submit normalizer; variant creation creates a
   review with `parent_fact_id` set.
5. **Parent threading:** a variant taken through provisional-approve → approve
   yields an active fact with the correct `parent_id`.
6. **Backfill:** the row-state matrix — with-enrichment, null-enrichment,
   already-concept (skip), inactive (skip), re-run idempotent; counts correct.
7. **Regression:** manual submit unchanged (existing tests green); refresh/
   send-back untouched (existing tests green).

Manual QA (Replit TEST_RUN + David UAT, authored PR-first per CLAUDE.md): import a
CSV → see reviews in triage, not live facts; add a variant → see it in triage with
parent; try to approve any without a concept → blocked; confirm existing live
facts now show the sentinel concept.

## Implementation Steps

Ordered, each independently green-able:

1. **Guard core (no behavior change yet):** add `activateFact` + `ConceptMissingError`;
   route `approveForProduction` through it. Tests 2. (Tree stays green; behavior
   identical.)
2. **Default flip + seed fix:** flip `is_active` default; make `scripts/src/seed.ts`
   explicit. Test 3.
3. **Backfill migration:** sentinel concept into active-conceptless facts; counts;
   idempotency. Test 6.
4. **CHECK constraint (VALID):** add after backfill. Test 1 + the fixture sweep +
   `insertActiveFactWithConcept` helper.
5. **`createTriageReview` extraction:** refactor manual submit onto it (behavior
   identical; existing tests green).
6. **Bulk import reroute:** all three endpoints → `createTriageReview`; dedup;
   normalizer reconcile; cap bypass; response shape + admin UI copy. Test 4.
7. **Variant reroute:** add `pending_reviews.parent_fact_id`; variant → review;
   thread parent through provisional-approve → activation; admin UI copy. Tests 4-5.
8. **Remove `POST /facts`:** route + openapi + regen + dead wiring. Test 4 (404).
9. **Docs:** update `moderation-workflow.md` (ingestion funnel), `visual-pipeline.md`
   (activation guard), `decisions.md` (supersede/close the Phase-2 fast-follow note),
   regenerate any field-doc references. TEST_RUN + UAT (PR-numbered).

## Risks and Mitigations

- **Test-fixture sweep is large.** Mitigation: shared active-fact-with-concept
  helper; do the sweep as its own step (4) so failures are localized, not smeared
  across later steps.
- **Normalizer divergence** (`…ForStorage` vs `…ForPendingReview`) could change how
  bulk rows canonicalize. Mitigation: an explicit equivalence test; if they differ
  materially, escalate to David rather than silently changing import normalization.
- **Codegen churn** removing `POST /facts` (the `patch-generated.mjs` line-list
  gotcha from CLAUDE.md). Mitigation: follow the codegen-immediately discipline;
  confirm `git diff --exit-code` on generated files.
- **Migration ordering** (constraint-before-backfill fails). Mitigation: encoded
  order in the migration series + the row-state matrix + idempotent re-run.
- **Null-enrichment facts remain taxonomy-poor** after the sentinel backfill.
  Accepted pre-launch (David redoes all facts); documented, not silently hidden.
- **Bulk import UX shift** (queue vs publish) could surprise an admin mid-launch.
  Mitigation: explicit UI copy + UAT step.

## Questions for David

None outstanding — all forks resolved in the pre-plan conversation (scope,
admin-create removal, variant handling, DB backstop, grandfather+sentinel, one
plan). Any new product fork Codex surfaces during review will be escalated, not
absorbed.

## External-Claim Verification

Not applicable. The plan makes no external API / SDK / model / pricing /
rate-limit claims. It relies only on standard PostgreSQL semantics —
`ALTER TABLE … ADD CONSTRAINT … CHECK`, the `#>>` JSONB path operator, and the
POSIX `~` regex match — all stable, long-standing core features (Postgres ≥ 12,
this repo runs 16). No current-docs verification needed.

## Definition of Done

- [ ] A fact cannot become `is_active: true` without a non-empty Visual Concept —
      enforced by `activateFact` AND the DB CHECK constraint (proven by a raw-SQL
      negative test).
- [ ] Every ingestion path produces a Stage-1 review: bulk import (×3) and variant
      creation create `triage_pending` reviews, not facts; `POST /facts` is gone.
- [ ] Variants carry their parent through moderation to the activated fact.
- [ ] Existing live facts stay live and now carry the sentinel concept; the CHECK
      is VALID with zero violators.
- [ ] Manual submission and refresh/send-back behavior unchanged (existing tests
      green).
- [ ] Full backend sharded suite + frontend suite green; all typechecks clean.
- [ ] Admin can exercise it: import a CSV and see facts land in triage (not live);
      approve one through to active; observe the block on a conceptless approval.
- [ ] TEST_RUN + UAT docs shipped on the implementation PR.
