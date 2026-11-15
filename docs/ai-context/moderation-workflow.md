# Moderation Workflow

> Staged, cost-gated review of user-submitted facts. Source of truth for the
> stages: `lib/api-zod/src/moderationWorkflow.ts`. Route logic:
> `artifacts/api-server/src/routes/reviews.ts`. Admin UI:
> `artifacts/overhype-me/src/pages/admin/moderation.tsx`.
>
> **Reconciliation note:** some older/spec notes call the AI-prep stages
> `enrichment_pending` / `enrichment_failed`. The **current repo enum uses
> `prep_pending` / `prep_failed`** (prep = enrichment + render prep). Use
> the repo names below.

## Why staged moderation exists

Enrichment and test renders **cost money** (model calls, image
generation). Staged moderation puts a **cheap human triage gate first**, so no
paid work runs on spam/duplicate/low-quality submissions. Paid prep only starts
after a human provisionally accepts a submission.

## Workflow stages

Submissions land in **`pending_reviews`** (never directly in `facts`) with a
coarse `review_status` (`pending | approved | rejected`) and a fine-grained
`review_workflow_stage`:

```
triage_pending ──reject──> triage_rejected
      │ provisionally accept
      ▼
prep_pending ──prep abandon──> prep_failed ──retry──> prep_pending
      │ prep ok (enqueues Visual-Idea candidates; NO renders yet)
      ▼
concept_review                                        ← Step 2: Gags gate
      │  approve the gags              ↑ back to gags
      │  (a saved gag + ideas OK → force-enqueue the default render batch)
      ▼
production_review                                     ← Step 3: Test Renders gate
      │ production approve
      ▼
production_approved   (fact is now live)

prep_pending · prep_failed · concept_review · production_review
      ──Withdraw: wording needs replacing──> production_rejected (first-time only)
```

**Rejection only happens at `triage_pending`.** Once a first-time submission
clears triage, there is no reject path — a failed prep, an unfinished Visual
Concept, or a render that isn't ready just leaves the candidate parked
(`prep_failed` / pending `concept_review` / pending `production_review`) until
an admin resolves the underlying issue (retry prep, fix the concept, fix the
render). It is the admin's job to get it unstuck, not to reject it. Two
exceptions: a **refresh cycle** (re-reviewing an already-live fact), and
**Withdraw: wording needs replacing** — see *Rejection paths* below.

Stages group in the UI as **Needs first pass → Prep → Gags →
Test Renders → Resolved**. The wizard shows three steps: **Triage → Gags →
Test Renders** (the Gags step was called Visual Concept until plan
`docs/plans/PLAN_THREE_GAGS.md`). Rejection reasons (`review_reason`): `duplicate | spam
| offensive | lame`.

**Three gates, not two.** Enrichment success now lands at `concept_review`
(Step 2), NOT `production_review`, and enqueues **no renders**. The moderator
must evaluate/approve the **Visual Concept** — the core description of how the
gag works visually — on every fact before any render spend. "Approve the visual
gag" advances `concept_review → production_review` via an atomic compare-and-set
and force-enqueues a fresh default render batch (no dedupe key). Renders only
ever fire in Step 3.

## The ingestion funnel — one entrance

Every way a fact enters the system funnels through one primitive,
`createTriageReview` (`artifacts/api-server/src/lib/moderationStaging.ts`): manual
user submission, admin/API-key bulk import, and the admin variant route (from an
existing fact's Facts-page editor) all insert a `pending_reviews` row starting at
`triage_pending` — none of them can create a fact directly. `facts.is_active`
defaults to `false`, so a fact is never born active or already enriched.

**Product-wise that is two sources, not three.** A fact is submitted either by a
user or by an admin import; the admin variant route is an authoring convenience
for the second, not a distinct kind of content. Variant status is a *link*
(`pending_reviews.parent_fact_id` → `facts.parent_id`), and within this funnel
it's applied in two places: that route sets it at creation, and Triage sets it
via `provisional-approve`'s `parentFactId` (the "Prep as Variant of #N" action
on a review carrying a `matchingFactId`, attached whenever the duplicate check
found any positive-confidence match — a lower bar than the threshold that
warns the submitter, so Triage sees candidates the submitter never saw
flagged). The latter is the near-duplicate
consolidation path — a reworded submission becomes an alternate phrasing of the
fact it echoes rather than a rejection or a second near-identical row. Either
way the fact runs the full pipeline; see
[*Variants are independent facts*](./taxonomy-and-enrichment.md#variants-are-independent-facts)
for what the link does and does not confer.

A third mechanism sits outside this funnel entirely: the admin Facts editor's
`parentId` field lets an admin directly PATCH an existing fact's parent,
re-parenting an already-published root under another root (or clearing a
variant back to root) without any review at all. It's gated by the same
active-root invariant `activateFact` enforces, not by the triage/prep
pipeline — nothing in this section's "funnel" claim covers it.

## The activation chokepoint — one exit

A fact can only become `is_active = true` through `activateFact`
(`artifacts/api-server/src/lib/factActivation.ts`), called from exactly one place
(`approveForProduction`). Inside the activating transaction it re-reads and
re-validates, atomically with the flip:

- the fact has an approved gag (`fact_gags`, migration 0139: a gag is
  approved when a moderator approves one of its test renders as its example),
  and
- a variant's parent is still an active root (`is_active = true AND parent_id IS
  NULL`), locked `FOR UPDATE` so a concurrent deactivate of that exact parent
  can't race the check.

A deferred constraint trigger, `facts_live_requires_approved_gag` (with its
twin on `fact_gags`, so removing or un-approving the last approved gag of a live
fact fails too), backstops this at the schema level — no writer, present or
future, can leave a live fact without an approved gag even by accident. It
replaced the `facts_active_requires_concept` CHECK when gags moved out of the
enrichment.

**The invariant holds for the fact's lifetime, not just at activation.** An
active variant's parent must stay an active root for as long as the variant is
live — so every write path that can flip a root `is_active = false` (the admin
PATCH deactivate and both DELETE paths) cascades the deactivation to that root's active children in the
same transaction (`cascadeDeactivateActiveChildren`), rather than leaving them
stranded under an inactive/missing parent.

## Deactivation is reversible, through moderation — never a direct toggle

The admin Facts editor's Active toggle can turn a fact **off** freely, but
**never directly back on** — a `false → true` PATCH is rejected
(`ACTIVATION_REQUIRES_MODERATION`). To bring a deactivated fact back:
`POST /admin/facts/:id/resubmit-for-moderation` re-enters it at `prep_pending`,
exactly like a first-time staging fact — same enrichment → Visual Concept →
Test Renders → production-approval pipeline, reusing the fact's existing id and
history (never a duplicate row). It rejects (409) if the fact is already active
(use Send Back to Review instead), if a review is already in progress for it, or
if a variant's `parent_id` points at a parent that no longer exists (a hard-delete
orphan) — the admin must re-parent or promote it to a root first.

## Staging facts

Provisional acceptance creates an **inactive staging fact** (`facts` row with
`isActive = false`), linked from the review (`stagingFactId`). All paid prep runs
**against the staging fact**, so the live catalogue is never touched by
in-progress work. `isActive = false` = staging; `isActive = true` = live/published
(there is no status enum on `facts` — published means an active row exists).

## Triage

The cheap first pass. A moderator either rejects outright (`triage_rejected`,
picking a reason) or **provisionally accepts**, which creates/reuses the staging
fact and enqueues prep. **No paid enrichment/render work runs before this
point.**

### The wording locks at triage

A fact's wording is edited **only at triage** and never changes once the
submission is accepted (plan `docs/plans/PLAN_THREE_GAGS.md`, increment 3;
David, 2026-11-14: *"If it's a new fact and it's in moderation, an admin should
be able to edit it before any enrichment happens. Once it's locked, that's it.
Locking should be the very first thing that happens as part of step 1."*).

- **The triage edit** — `POST /admin/reviews/:id/wording`
  (`lib/reviewWording.ts`, `editTriageWording`): allowed only while the review
  is `triage_pending` with no staging fact. The wording is validated like a
  submission (10–2,000 characters, token grammar), the duplicate match is
  recomputed for it, and the review keeps the wording as submitted
  (`submitted_text_original`, set at the first edit) and who edited it, when
  (`wording_edited_by`, `wording_edited_at`). The moderation screen shows the
  wording in an editable box at triage and holds acceptance while an edit is
  unsaved.
- **Acceptance locks it first.** Provisional approval takes the review row's
  lock (`lockReview`) and creates the staging fact from the wording it reads
  under that lock; the triage edit takes the same lock and re-checks the
  stage, so an edit either lands before acceptance or is refused
  (`WORDING_LOCKED`), never overwritten by wording read earlier.
- **The database holds it.** Trigger `facts_text_is_locked` (migration 0141)
  refuses any `UPDATE` that changes `facts.text`. A token or normalisation
  repair that would rewrite stored text needs its own migration that lifts the
  rule, on David's say. `PATCH /admin/facts/:id` refuses a changed wording with
  `WORDING_LOCKED` (an unchanged or normalisation-equal wording is ignored);
  the confirmation-gated approved-text edit and the staging-fact text edit
  that re-ran prep are gone. Past entries in the text-edit history
  (`fact_text_edit_history`) stay readable in the Facts editor.
- **Replacing a wording.** A live fact: deactivate it (soft delete, which also
  deactivates its active variants; its memes are kept) and submit the
  corrected wording as a new fact, with no transferred votes, comments or
  shares. A submission past triage: **Withdraw** (below), then submit the
  corrected wording, which enters triage as a new fact.

## Enrichment (the "prep" stage)

`prep_pending` runs the async prep jobs against the staging fact: **enrichment**
(AI classification/taxonomy — see
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md)) and render-scenario
preparation. On terminal failure the review moves to
`prep_failed` — retryable only; a first-time submission is never rejected here,
it stays pending until the retry succeeds.

## Gags review ("Step 2", `concept_review`)

The mandatory human gate on the fact's **gags** — each one a
[Visual Concept](./glossary.md#visual-concept), the authoritative scene
description of one way the joke works (see [`visual-pipeline.md`](./visual-pipeline.md))
— **before any render spend**. A fact has one to three gags (plan
`docs/plans/PLAN_THREE_GAGS.md`); the second and third are optional. In
`concept_review` the moderator, in the **Gags panel**:

- writes or edits a gag, or uses an AI-drafted Visual Idea on one —
  **instead of the default gag**, **as an additional gag**, or **in place of
  gag N** — each saved as that gag's pending change,
- tunes the enrichment via the embedded **Enrichment Editor** (Advanced Options),
- inspects the **Runtime Compiled Prompt** preview,
- then **approves the gags** (advances to Step 3, force-firing renders)
  or sends it back to prep. (A first-time submission is never rejected here —
  see **Rejection paths** below.)

A gag is saved through the gag routes (`/api/admin/facts/:id/gags`), and a
blank scene can't be saved (`fact_gags_pending_scene_nonempty`). The enrichment
no longer carries a gag: a save that sends one is refused (`GAG_IN_ENRICHMENT`),
and the candidate PATCH that saved a refresh's gag is retired (`410`).

**Visual Ideas are a blocking prep artifact here**, not best-effort: the gag
gate requires a saved gag with a non-empty scene **and** terminal-OK generated
ideas (`facts.visual_concept_status === "ok"`).
A stale-but-saved concept is allowed (the *saved* concept, not the AI candidate
cards, is the approved artifact). Re-prep/regenerate is blocked while ideas are
`pending` so a new cycle can't coalesce onto a stale in-flight concept job.

## Test Renders review ("Step 3", `production_review`)

The expensive render review. Renders **auto-fire** on arrival (a forced,
no-dedupe-key batch). All taxonomy/enrichment knobs stay exposed for render
tweaking. The moderator:

- inspects the **test-render** meme grid and the **Runtime Compiled Prompt**,
- tweaks enrichment and gags and re-runs renders as needed; each gag in the
  Gags panel has its own renders, and **Approve this render** makes a finished,
  current render that gag's **example**, which approves it,
- then **production-approves** (existing render/waiver gate; a first-time fact
  also needs at least one gag with an example, `CONCEPT_MISSING` otherwise),
  or **sends the fact back to Gags** (Step 3 → Step 2), which supersedes the
  in-flight renders; re-approval force-creates a fresh batch. (A first-time
  submission is never rejected here — a render that isn't working is the
  admin's job to fix, per **Rejection paths** below.)

## Test renders, the hero gate, and Pexels

**Today:** test renders are **review tools, not hard gates**. A moderator may
approve despite missing/stale required render scenarios, and doing so records
a `visualRenderApprovalWaiver` on the review (an auditable override, not a
silent skip). No render scenario is designated "hero" in the code.

**Decided, not yet shipped (David, 2026-10-06,
[launch definition](./launch-definition.md)):** a fact's
[hero renders](./glossary.md#hero-render) — its moderation-approved renders,
published as its own image assets — are a **hard gate on going live**. A
successful moderation is one that ends with confirmed, approved hero renders;
there is no "no-hero fallback", and the waiver will not cover them. The
[product strategy](./product-strategy.md#gags-and-examples) (2026-11-11) sets
the minimum: a fact may have up to three approved gags, and one unstyled
example per approved gag is required; styled examples are optional. The PR
that builds it replaces this paragraph with the shipped behaviour. Every other render scenario stays waivable.

Pexels stock images were a second review aid and the source of user-facing
stock backgrounds; Pexels was deleted entirely in launch Phase 4, removal 6
(David, 2026-10-05; ledger [`docs/retired/README.md`](../retired/README.md),
lessons [`docs/retired/pexels.md`](../retired/pexels.md)).

## Final production approval

Production approval:

1. flips the staging fact **active** (`isActive = true`, now live),
2. stores the approved-fact linkage (`approvedFactId`) on the review,
3. embeds the fact (pgvector) for duplicate detection,
4. notifies the submitter (activity feed + email),
5. sets stage `production_approved`, status `approved`.

**Refresh cycle:** re-reviewing an already-live fact uses a *candidate*
enrichment version (`candidateVersionId`). The live fact stays published no
matter what happens to the review — approval promotes the candidate onto it;
declining just discards the candidate (retained as rejected history, never
hard-deleted) and the fact keeps its current taxonomy/enrichment until a
future refresh is promoted. See
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md#versioning-model).

**Gags in a refresh** (plan `docs/plans/PLAN_THREE_GAGS.md`): gags are written
as the last step of a refresh, inside its review — while a refresh is open, a
fact's gags can't be changed from the Facts editor. The live fact's approved
gags stay offered to users throughout. A change saved in the review, a render
picked as its example, or a removal is owned by the review and lands when the
refresh is promoted; declining the refresh discards them. A refresh can be
promoted only if the fact keeps at least one approved gag afterwards.

## Rejection paths

**A fact can only ever be rejected at `triage_pending`.** Rejection means "not
worthy of being in the database" — it is a first-time-submission-only concept.

- `triage_rejected` — rejected at first pass (no paid work spent). **This is
  the only rejection path for what a fact is.** Once triage passes, `canReject`
  (`lib/api-zod/src/moderationWorkflow.ts`) refuses every other stage for a
  first-time submission — the route 409s and the UI hides the Reject button —
  so a stuck candidate (`prep_failed`, an unfinished gag, a render
  that isn't ready) stays pending until an admin resolves it.
- `production_rejected` — reachable **only** via a **refresh cycle's** decline
  ("don't promote this update"), which is a *distinct concept from rejection*:
  a refresh candidate is a proposed update to a fact that already cleared
  triage, so it is never judged for database-worthiness again. Declining one
  never sets a `rejectionReason` (duplicate/spam/offensive/lame — those judge
  the fact, not the update) and never touches the live fact; it just doesn't
  get promoted. A refresh always starts past triage by design.
- **Withdraw: wording needs replacing** — `POST /admin/reviews/:id/withdraw`
  (`lib/reviewWording.ts`, `withdrawForWording`), the one way a first-time
  submission ends after triage. Available from acceptance until production
  approval (`prep_pending`, `prep_failed`, `concept_review`,
  `production_review`), never on a refresh, which is declined instead. It sets
  the review `rejected` / `production_rejected` with `withdrawn_at` /
  `withdrawn_by` (the note goes to `production_rejection_note`), so the
  submission leaves the queue and the submitter's pending count; it stamps the
  staging fact's `wording_withdrawn_at`, and CHECK
  `facts_withdrawn_stays_inactive` keeps that fact inactive for good. Resubmit
  for moderation refuses it (`WORDING_WITHDRAWN`), and a prep result or stale
  action arriving afterwards finds a resolved review. The submitter's activity
  feed says the wording needs replacing and invites a new submission. The
  moderation screen offers it behind a confirmation on the triage step's
  wording card. The rule that a moderator fixes rather than rejects stays for
  every other reason.

## Retry and failure states

`prep_failed` is retryable only (re-enqueues prep) — never rejectable for a
first-time submission. Underlying prep jobs have their own
`attempts`/`maxAttempts` in `async_jobs`; the backend's retry logic is what
ultimately fails a crash-looping job — the UI just reflects `done`/`failed`.

## Admin UX expectations

Moderation is async-heavy, so it must obey the two-altitude status rule (see
[`known-failure-patterns.md`](./known-failure-patterns.md#async-enqueue-treated-as-completion)):
clearly show **empty, loading, running, failed, partial, retryable, skipped,
complete, and no-op** states. The moderation sidebar item carries a red pending
badge (pending fact reviews + pending comments). Never impose a UI timeout on
legitimately long prep/render work — poll until terminal.

## Files to inspect before moderation work

- `lib/api-zod/src/moderationWorkflow.ts` — the stage/status/reason enums and
  stage display grouping (source of truth).
- `artifacts/api-server/src/routes/reviews.ts` — submission + transition logic.
- `artifacts/overhype-me/src/pages/admin/moderation.tsx` — the review UI.
- `artifacts/overhype-me/src/components/admin/EnrichmentEditor.tsx` — Step-2 editor.
- Staging/approval linkage columns in `lib/db/src/schema/reviews.ts` and `facts.ts`.
- Comment moderation: the comment panel in `pages/admin/moderation.tsx` + comment `status`/`flagged` (`/admin/comments` redirects there).
