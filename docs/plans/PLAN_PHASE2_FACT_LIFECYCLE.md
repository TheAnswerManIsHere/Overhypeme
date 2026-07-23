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
  **One exception** (David-decided): active facts with *no enrichment at all* (old
  bulk imports) are deactivated, since a fabricated concept can't make them
  render-valid — see §C.
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
- Seed/scripts: `artifacts/api-server/src/lib/seed.ts` (`seedIfEmpty()`),
  `scripts/src/seed.ts`, `scripts/src/reseed-facts.ts`.
- Docs: `docs/ai-context/moderation-workflow.md`, `visual-pipeline.md`,
  `decisions.md`, `docs/engineering/migrations-and-backfills.md`.

## Current Behavior

- **`is_active` default `true`** — inserts are live unless they opt out.
- **Manual submit** (`POST /facts/submit-review`) → creates a `pendingReviews`
  row at `workflowStage: "triage_pending"`, `enrichment: null`. No fact row yet
  (cost gate). Correct.
- **Activation** — the intended path is `approveForProduction`
  (`reviews.ts:741-748`), which flips a pre-existing inactive staging fact to
  `isActive: true` and sets `parentId`, concept-gated (`reviews.ts:687`,
  `CONCEPT_MISSING`), hashtags-gated, and render-gated. **But it is NOT the only
  false→true writer today:** `PATCH /admin/facts/:id` (`admin.ts`) also copies the
  body's `isActive` straight into `factsTable` (`nonTextUpdates`), so the admin
  "Active" toggle can flip a fact live outside moderation. Phase 2 closes that
  (**reject** its false→true; activation is moderation-only) — see Design A.2.
- **`parentId`** is carried on the *staging fact* (`facts.parent_id`), set at
  provisional-approve from the request body → `ensureStagingFact` →
  `approveForProduction`. `pendingReviews` has **no parent column**.
- **Bypass paths** — two shapes. **Inserts** (all `isActive: true`, enrichment
  null, no review): `POST /facts` (dead code — no live caller, no test; codegen'd
  into two client packages); `POST /admin/import/facts` (dedup + hashtags +
  embeddings); `POST /admin/facts/import` + `import-csv` (no
  dedup/hashtags/embeddings); `POST /admin/facts/:id/variants` (sets only
  `parentId`, copies nothing). **Flip:** `PATCH /admin/facts/:id` can set
  `is_active` false→true directly (the admin Active toggle) — see the activation
  bullet above. Phase 2 closes all of these (the admin flip is **rejected** —
  activation is moderation-only).
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
   Facts are born inactive; activation is now an explicit, opt-in act. Make **every
   seed/reseed script** that inserts active facts explicit *and* concept-valid —
   `scripts/src/seed.ts` (relies on the old default), `scripts/src/reseed-facts.ts`,
   and **`artifacts/api-server/src/lib/seed.ts`** (`seedIfEmpty()`, the production
   startup seed — explicitly inserts `isActive: true` with no concept; the earlier
   draft's `lib/seed.ts` path was wrong, Codex P3 round 4) — either seed a valid
   enrichment with a concept or insert inactive, or they'll violate the CHECK.
2. **Single `false → true` writer — `approveForProduction` (via `activateFact`) only.**
   A shared helper `activateFact(tx, { factId, parentId, expectedText })` in
   `lib/factActivation.ts` (new). It performs the guarded update currently inline
   at `reviews.ts:741-748`: it re-reads the row's effective concept, refuses
   (throws a typed `ConceptMissingError`) if `coreSceneOverride` is blank/absent,
   then flips `is_active = true` under the same compare-and-set predicates
   (`is_active = false`, `text = expectedText`). It is called **only** from
   `approveForProduction`, whose surrounding logic enforces the *rest* of the
   production gate (render-waiver checks, `pending_reviews` transition,
   production-approval recording, submitter notification). `activateFact` is the
   last-line assertion, **not** a standalone activation API — because on its own it
   would let any concept-bearing inactive row (e.g. a staging fact parked in
   `concept_review`) go live while skipping all of that.
   **Admin PATCH (Codex P1, rounds 3+5): reject false→true entirely.**
   `PATCH /admin/facts/:id` (`admin.ts`) today copies the body's `isActive` straight
   into `factsTable`. My round-3 fix (route it through `activateFact`) was
   **insufficient** — that still skips the production gate for a staging fact. So
   the admin PATCH may set `is_active = false` (deactivate is always safe) but a
   **false → true transition is rejected server-side** (`400 activation_requires_moderation`
   or similar); **activation is moderation-only.** *(Consequence flagged to David:
   an admin can no longer directly re-activate a deactivated fact; bringing one back
   goes through re-moderation. If a narrow "reactivate a previously-production-approved
   fact" shortcut is wanted, it's a small follow-up that verifies the prior approval
   and re-runs the production gate — out of scope here unless David wants it.)*
   **Whole-codebase writer audit.** The implementation includes an explicit audit
   of **every** path that writes `is_active` **or rewrites `facts.enrichment` on an
   active row** (not just inserts) to confirm the invariant holds — see the
   enrichment-rewrite audit in §A.4 below (Codex P2 round 5). `true → false`
   deactivations stay unrestricted. (The existing app-level `CONCEPT_MISSING` gate
   stays as the early, friendly 409.)
   **Parent revalidation at commit (Codex P2, round 2):** when `parentId` is set,
   `activateFact` re-reads it *in the same transaction* and requires it to be an
   **active root** (`is_active = true AND parent_id IS NULL`); if the parent was
   deactivated between variant enqueue/provisional-approve and final approval, it
   throws a typed `ParentNotActiveError` so approval is blocked and the moderator
   resolves it (re-parent or promote to root) — a variant must never activate
   under an inactive/orphaned root. This closes the TOCTOU gap where
   `approveForProduction` trusts a stale `stagingFact.parentId`.
3. **DB backstop — CHECK constraint** on `facts`:
   ```sql
   ALTER TABLE facts ADD CONSTRAINT facts_active_requires_concept
     CHECK (
       is_active = false
       OR COALESCE(
            jsonb_typeof(enrichment #> '{visualPromptStrategyOverride,coreSceneOverride}') = 'string'
              AND (enrichment #>> '{visualPromptStrategyOverride,coreSceneOverride}') ~ '\S',
            false
          )
     );
   ```
   **NULL-safety (Codex P1):** a CHECK passes on `UNKNOWN`, so a naive
   `(… #>> …) ~ '\S'` would *accept* an active row with `enrichment IS NULL` or an
   absent path (the regex side is NULL) — exactly the rows we must reject. The
   `COALESCE(…, false)` wrapper collapses every NULL case (null enrichment, absent
   path, non-string scalar) to `false`, so the CHECK fails and the row is rejected.
   The `jsonb_typeof(…) = 'string'` guard mirrors the app's *validated-string*
   gate (`#>>` would otherwise coerce a non-string JSON scalar to text and let,
   e.g., a number slip through). `~ '\S'` = "contains a non-whitespace char" = the
   app's `.trim()` non-empty semantics. Added **VALID after** the backfill (no
   existing violators) rather than the weaker `NOT VALID`.
4. **Concept-preservation audit — paths that REWRITE enrichment on an active row**
   (Codex P2 round 5). The activation invariant has a second face: a path that
   overwrites `facts.enrichment` on an already-active row can *drop the moderator
   Visual Concept*, which both violates the CHECK (once installed) and erases a
   human decision (AGENTS.md "human decisions preserved"). The known offender is
   **`POST /admin/facts/backfill-enrichment`** (`admin.ts`), which rewrites active
   rows with `buildFactEnrichmentColumns(enrichFact(...))` — fresh classifier
   output that carries **no** `visualPromptStrategyOverride`. After the CHECK it
   would fail every active-row update; before it, `?force=true` would silently
   strip the concept. Fix: route this (and any other active-row enrichment rewrite)
   through the **VSO-preserving** `materializeEnrichment` path — the same split the
   re-classification path already uses (`materializeFromBaseline` pulls the VSO out
   of the AI baseline and re-feeds it) — so the moderator concept survives, or
   disable the legacy route. A regression test asserts the VSO survives a forced
   re-enrich of an active fact. The whole-codebase audit in §A.2 covers **both**
   writer classes: `is_active` writers *and* active-row enrichment rewriters.

### B. Ingestion funnel (the entrance)

The reusable primitive: the `submit-review` row-build (`reviews.ts:191-202`) —
"create a `triage_pending` review." Extract it into a shared
`createTriageReview(tx, { submittedText, submittedById, hashtags, parentFactId?, matchingFactId?, matchingSimilarity?, reason? })`
helper in `lib/moderationStaging.ts` (or a sibling). Manual submit, bulk import,
and variants all call it. **The helper must carry every column manual submit
writes today** — `matchingFactId`, `matchingSimilarity`, and `reason` (the
duplicate/near-match context) in addition to the above (Codex P2, round 2) — so
refactoring manual submit through it is byte-identical; a regression test asserts
those fields survive. `submittedById` is **nullable** (see the API-key import case
below; refresh reviews already carry `submittedById = null`).
`enrichment`/`canonicalText`/`hashtag upsert`/`embeddings` stay deferred to the
pipeline (as manual submit already does) — nothing derives them at ingest.

1. **Manual submit — unchanged**, but refactored to call `createTriageReview`
   (behavior identical; proven by its existing tests).
2. **Remove `POST /facts`:** delete the route (`routes/facts.ts:422-490`), the
   `/facts` `post:` entry in `openapi.yaml`, regenerate `@workspace/api-zod` +
   `@workspace/api-client-react` (per the codegen discipline in CLAUDE.md — update
   `patch-generated.mjs` line-list if an export drops, run codegen, confirm clean
   diff), and delete the dead `useCreateFact`/`createFact` wiring in
   `use-mutations.ts`. No live caller, no test — clean.
3. **Reroute the three bulk-import endpoints:** instead of inserting active facts,
   each row becomes a `createTriageReview` call. **Submitter (Codex P2, round 2):**
   the two session-admin endpoints (`/admin/facts/import`, `/import-csv`,
   `requireAdmin`) use `req.user.id`; the machine endpoint
   `POST /admin/import/facts` is `requireApiKey` and has **no `req.user`**, so its
   reviews are **system imports with `submittedById = null`** (the same
   nullable-submitter shape refresh reviews already use — no user to notify, no
   activity-feed entry). We keep the API-key auth contract as-is (no migration to
   session auth). Triage queue/UX must tolerate a null submitter (it already does
   for refresh cycles).
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
- **Facts with null enrichment** (old bulk-imported/admin-created) — **DECIDED
  (David): deactivate.** A blob carrying only the sentinel VSO is **not** a valid
  `FactEnrichment` (schema requires `primaryArchetype`, `subtype`,
  `visualLiteralness`, hashtags, suitability, …), and generic meme rendering
  validates `facts.enrichment` first — so a VSO-only blob would *pass the CHECK yet
  still fail render* as `fact_enrichment_invalid`. Rather than fabricate a fake
  full enrichment to keep junk live (the exact anti-state Phase 2 removes), the
  backfill sets these unmoderated, never-enriched rows **`is_active = false`**.
  This is the **one** place the backfill touches `is_active` (the single exception
  to "grandfather all live facts"). We do **not** auto-create triage reviews for
  them — auto-enqueuing potentially-hundreds of unmoderated bulk-import rows would
  flood the moderator. They simply drop off the live site; David re-adds the ones
  worth keeping via the now-funneled bulk import (which lands them in triage the
  normal way — consistent with "I'll redo them shortly"). Facts that already have a
  valid enrichment (just missing the scene) are unaffected — the with-enrichment
  path above handles them.
- **Deactivating a root that has active children (Codex P1, round 2):** if a
  null-enrichment row being deactivated is a *root* (`parent_id IS NULL`) with
  **active children/variants**, deactivating only the root orphans them — the
  public `/facts` feed returns active roots (`is_active = true AND parent_id IS
  NULL`), while variant/detail code derives the canonical root from `parent_id`, so
  live children under an inactive root vanish from the main feed. Resolution:
  **cascade-deactivate** — the backfill also sets `is_active = false` on the root's
  active children, so the whole lineage drops out together and re-enters via
  re-import. (Those children came from the old moderation-bypassing variant path,
  so they're unmoderated too; cascade preserves identity/lineage rather than
  re-parenting. Deterministic, intent-consistent default — **flagged to David**;
  promote-a-child-to-root is the alternative if he prefers.) Covered by a dedicated
  row-state + test: `active null-enrichment root + active children`.
- **Grandfather:** never set `is_active = false` on an existing fact **except** the
  null-enrichment deactivation above and its child cascade. Facts with a valid
  enrichment stay live.

## Data Model and Migration Impact

Four schema/data changes, split across **two** migration phases with the
writer-closing code deployed **between** them (Codex P2 round 5) — because the
variant-reroute code needs the new column to *already exist*, while the
backfill+CHECK must *not* run until the old active-writers are gone. Framing it as
one batch breaks on a migration-before-code or rolling deploy (new code hits a
missing column, or old code creates a fresh violator between backfill scan and
`ADD CONSTRAINT`).

**Phase 1 — additive schema (safe before the new code):**
1. **`facts.is_active` default `true` → `false`** (affects future inserts only — no
   existing row changes; old writers set `isActive` explicitly so they're
   unaffected until rerouted).
2. **New column `pending_reviews.parent_fact_id` integer NULL, FK → facts.id**
   (`ON DELETE SET NULL`) — **`integer`** (Codex P1), matching `facts.id`
   (`serial`) and the existing `stagingFactId`/`approvedFactId`/`matchingFactId`
   integer FKs; a uuid FK to a serial PK is invalid. Drizzle:
   `parentFactId: integer("parent_fact_id").references(() => factsTable.id, { onDelete: "set null" })`.
   Additive, nullable — no backfill needed (existing reviews have no parent).

**→ Deploy the writer-closure code** (Ingestion funnel §B + admin-PATCH/enrichment
audit §A.2/§A.4 + variant reroute, which now has its column). After this, no code
path can create/flip an active conceptless row.

**Phase 2 — data + constraint (only after the writers are closed):**
3. **Backfill** (Section C): sentinel concept into active *with-enrichment*
   conceptless facts; **deactivate** active *null-enrichment* facts (+ child
   cascade).
4. **`facts_active_requires_concept` CHECK constraint**, added **VALID** (no
   violators remain — the backfill fixed the old ones and no writer can make new
   ones).

**Ordering (must hold):** Phase-1 schema → writer-closure code → Phase-2
backfill+CHECK. Two reasons the writer-closure must precede backfill+CHECK: (1) the
CHECK added before the backfill rejects grandfathered rows and fails; (2) a live
writer open during a rolling deploy inserts a fresh `is_active=true,
enrichment=NULL` violator between the backfill scan and `ADD CONSTRAINT` (Codex
round 3). See Implementation Steps for the full order.

**Idempotency / observability / rollback** (per
`docs/engineering/migrations-and-backfills.md`):
- Backfill is idempotent: it only touches facts where `is_active = true` AND the
  effective `coreSceneOverride` is blank/absent; re-running is a no-op (those rows
  now have the sentinel). Guard by matching blank scene, not "equals sentinel," so
  a re-run after a partial failure completes cleanly.
- Emit counts: candidates scanned, sentinel-backfilled (with-enrichment),
  deactivated (null-enrichment), already-had-concept (skipped), failed.
- Rollback: the CHECK can be dropped; the column can be dropped; the default can
  be restored. The sentinel backfill is *forward-only* data (harmless if left —
  it's a valid concept), but the migration doc will note the grep to find/undo
  sentinels if ever needed.

**Row-state matrix** (backfill):

| Row state | Action |
|---|---|
| active + real concept | skip (no-op) |
| active + blank/absent concept, enrichment present | set sentinel in VSO, re-materialize |
| active + null enrichment (leaf, or root with no active children) | **deactivate** (`is_active = false`) — the one exception to grandfathering; no auto-review (see §C) |
| active + null enrichment **root with active children** | **cascade-deactivate** root + its active children (see §C, Codex P1) |
| inactive (any) | skip — constraint permits inactive-without-concept |
| already sentinel (re-run) | skip (blank-scene predicate no longer matches) |
| already deactivated (re-run) | skip (`is_active = false` no longer matches the `is_active = true` predicate) |

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
   AND open reviews, and reuses the submit normalizer; the API-key import creates
   reviews with `submittedById = null` (system import); variant creation creates a
   review with `parent_fact_id` set.
5. **Parent threading:** a variant taken through provisional-approve → approve
   yields an active fact with the correct `parent_id`. **Parent revalidation:** if
   the carried parent is deactivated before final approval, `activateFact` throws
   `ParentNotActiveError` and no live variant is created under an inactive root.
6. **Backfill:** the row-state matrix — with-enrichment (sentinel), null-enrichment
   leaf (deactivate), **null-enrichment root with active children
   (cascade-deactivate — children go inactive, none orphaned)**, already-concept
   (skip), inactive (skip), re-run idempotent (incl. re-run over
   already-deactivated); counts correct.
7. **Regression:** manual submit **byte-identical** through `createTriageReview` —
   `matchingFactId`/`matchingSimilarity`/`reason` preserved on the review row
   (Codex round 2); refresh/send-back untouched (existing tests green).
8. **Admin PATCH activation guard (Codex round 3+5):** `PATCH /admin/facts/:id`
   with `isActive: true` is **rejected** (`400`, activation is moderation-only) —
   including on a *concept-bearing* inactive staging fact, which must NOT shortcut
   the production gate; `isActive: false` (deactivate) still works directly. A
   guard test asserts `activateFact`/`approveForProduction` is the sole false→true
   writer.
9. **Concept preservation on active-row re-enrich (Codex round 5):** a forced
   re-enrich of an active fact (`POST /admin/facts/backfill-enrichment?force=true`,
   and any other active-row enrichment rewrite) **preserves** the moderator
   `visualPromptStrategyOverride` — the concept survives; the row stays
   CHECK-valid; the human decision isn't erased.

Manual QA (Replit TEST_RUN + David UAT, authored PR-first per CLAUDE.md): import a
CSV → see reviews in triage, not live facts; add a variant → see it in triage with
parent; try to approve any without a concept → blocked; confirm existing live
facts now show the sentinel concept.

## Implementation Steps

Ordered, each independently green-able. **Ordering invariant (Codex rounds 3+5):
additive schema first → close every writer that can create/flip an active
conceptless fact (or strip its concept) → THEN backfill + VALID CHECK.** In a
rolling/migration-before-code deploy this ordering is load-bearing: the
variant-reroute code needs the new column to exist first, and a still-live writer
could insert a fresh violator between the backfill scan and `ADD CONSTRAINT`.

1. **Guard core (no behavior change yet):** add `activateFact` +
   `ConceptMissingError` + `ParentNotActiveError` (concept check now; parent
   revalidation wired but inert until variants carry a parent in step 4); keep it
   callable **only** from `approveForProduction`. Test 2. (Tree stays green.)
2. **Phase-1 additive schema + seed/reseed fix:** flip `is_active` default to
   `false`; add `pending_reviews.parent_fact_id` (integer FK); make
   `scripts/src/seed.ts`, `scripts/src/reseed-facts.ts`, and
   `artifacts/api-server/src/lib/seed.ts` (`seedIfEmpty()`) explicit +
   concept-valid (or inactive). Test 3. (Additive — safe before the new code.)
3. **Close the ingestion/activation/enrichment writers (all before the constraint):**
   - `createTriageReview` extraction; refactor manual submit onto it (identical).
   - Bulk import reroute (×3) → `createTriageReview`; dedup; normalizer reconcile;
     cap bypass; null system-submitter for the API-key path; response shape + admin
     UI copy. Test 4.
   - Variant reroute (uses the Phase-1 column): variant → review; thread parent →
     activation; admin UI copy. Tests 4-5.
   - Remove `POST /facts`: route + openapi + regen + dead wiring. Test 4 (404).
   - **Reject `PATCH /admin/facts/:id` `is_active` false→true** (activation is
     moderation-only; deactivate stays direct). Test 8.
   - **Preserve the VSO on active-row enrichment rewrites** (`backfill-enrichment`
     `?force` and any peer) via the VSO-preserving materialize path. Test 9.
   - Audit that no `is_active` false→true writer and no concept-stripping active-row
     enrichment writer remains.
4. **Phase-2 backfill migration:** sentinel concept into active *with-enrichment*
   conceptless facts; **deactivate** active *null-enrichment* facts,
   **cascade-deactivating** active children of a deactivated root; counts;
   idempotency (incl. re-run over already-deactivated). Test 6.
5. **Phase-2 CHECK constraint (VALID):** add last, after every writer is closed and
   the backfill is done — no source of a fresh violator remains. `ADD CONSTRAINT …
   CHECK` also takes an `ACCESS EXCLUSIVE` lock during validation as a backstop.
   Test 1 + the fixture sweep + `insertActiveFactWithConcept` helper.
6. **Docs:** update `moderation-workflow.md` (ingestion funnel), `visual-pipeline.md`
   (activation guard + single-writer + concept-preservation), `decisions.md`
   (supersede/close the Phase-2 fast-follow note), regenerate any field-doc
   references. TEST_RUN + UAT (PR-numbered).

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
- **Null-enrichment active facts are deactivated** (not sentinel-backfilled), incl.
  cascade to active children of a deactivated root. Accepted pre-launch (David
  redoes/re-imports them); counted and tested, not silently dropped.
- **Bulk import UX shift** (queue vs publish) could surprise an admin mid-launch.
  Mitigation: explicit UI copy + UAT step.

## Questions for David

**One capability change to confirm (flagged, not blocking):** the admin "Active"
toggle can no longer **activate** a fact — `PATCH /admin/facts/:id` false→true is
rejected, activation is moderation-only (Codex rounds 3+5; deactivation still
works). This is the faithful reading of "only moderation activates," but it does
remove an admin shortcut: to bring back a deactivated fact, an admin re-moderates
it. If you want a narrow "reactivate a previously-production-approved fact" button
that re-runs the production gate, say so and I'll add it (small follow-up).

The round-1 fork (active facts with no enrichment) was **David-decided: deactivate
them** (§C). The cascade-vs-promote choice for a deactivated root's children is a
flagged default (cascade — §C). Everything else was resolved in the pre-plan
conversation (scope, admin-create removal, variant handling, DB backstop,
grandfather+sentinel, one plan).

## External-Claim Verification

Not applicable. The plan makes no external API / SDK / model / pricing /
rate-limit claims. It relies only on standard PostgreSQL semantics —
`ALTER TABLE … ADD CONSTRAINT … CHECK`, the `#>>` JSONB path operator, and the
POSIX `~` regex match — all stable, long-standing core features (Postgres ≥ 12,
this repo runs 16). No current-docs verification needed.

## Definition of Done

- [ ] A fact cannot become `is_active: true` without a non-empty Visual Concept —
      enforced by `activateFact` AND the DB CHECK constraint (proven by a raw-SQL
      negative test). `approveForProduction`→`activateFact` is the **sole**
      false→true writer — the admin PATCH rejects activation, and no other
      `is_active` write nor active-row enrichment rewrite can bypass the concept
      (audited).
- [ ] Every ingestion path produces a Stage-1 review: bulk import (×3) and variant
      creation create `triage_pending` reviews, not facts; `POST /facts` is gone.
- [ ] Variants carry their parent through moderation to the activated fact, and a
      variant never activates under an inactive/orphaned root (`activateFact`
      revalidates the parent at commit).
- [ ] Existing live facts **with enrichment** stay live and carry the sentinel
      concept; existing active facts **with null enrichment are deactivated**
      (cascade-deactivating any active children), with counts emitted; the CHECK is
      VALID with zero violators.
- [ ] Manual submission and refresh/send-back behavior unchanged (existing tests
      green).
- [ ] Full backend sharded suite + frontend suite green; all typechecks clean.
- [ ] Admin can exercise it: import a CSV and see facts land in triage (not live);
      approve one through to active; observe the block on a conceptless approval.
- [ ] TEST_RUN + UAT docs shipped on the implementation PR.
