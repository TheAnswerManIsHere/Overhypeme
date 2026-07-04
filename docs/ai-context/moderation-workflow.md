# Moderation Workflow

> Staged, cost-gated review of user-submitted facts. Source of truth for the
> stages: `lib/api-zod/src/moderationWorkflow.ts`. Route logic:
> `artifacts/api-server/src/routes/reviews.ts`. Admin UI:
> `artifacts/overhype-me/src/pages/admin/moderation.tsx`.
>
> **Reconciliation note:** some older/spec notes call the AI-prep stages
> `enrichment_pending` / `enrichment_failed`. The **current repo enum uses
> `prep_pending` / `prep_failed`** (prep = enrichment + Pexels + render prep). Use
> the repo names below.

## Why staged moderation exists

Enrichment, Pexels lookups, and test renders **cost money** (model calls, image
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
concept_review ──reject──> production_rejected        ← Step 2: Visual Concept gate
      │  approve the visual gag        ↑ back to visual concept
      │  (saved coreScene + ideas OK → force-enqueue the default render batch)
      ▼
production_review ──reject──> production_rejected      ← Step 3: Test Renders gate
      │ production approve
      ▼
production_approved   (fact is now live)
```

Stages group in the UI as **Needs first pass → Prep → Visual Concept →
Test Renders → Resolved**. The wizard shows three steps: **Triage → Visual
Concept → Test Renders**. Rejection reasons (`review_reason`): `duplicate | spam
| offensive | lame`.

**Three gates, not two.** Enrichment success now lands at `concept_review`
(Step 2), NOT `production_review`, and enqueues **no renders**. The moderator
must evaluate/approve the **Visual Concept** — the core description of how the
gag works visually — on every fact before any render spend. "Approve the visual
gag" advances `concept_review → production_review` via an atomic compare-and-set
and force-enqueues a fresh default render batch (no dedupe key). Renders only
ever fire in Step 3.

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

## Enrichment (the "prep" stage)

`prep_pending` runs the async prep jobs against the staging fact: **enrichment**
(AI classification/taxonomy — see
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md)), **Pexels** image
lookup, and render-scenario preparation. On terminal failure the review moves to
`prep_failed` (retryable, or reject).

## Visual Concept review ("Step 2", `concept_review`)

The mandatory human gate on the **Visual Concept** — the authoritative scene
description of how the gag works (see [`visual-pipeline.md`](./visual-pipeline.md))
— **before any render spend**. In `concept_review` the moderator:

- accepts an AI-drafted Visual-Idea candidate, edits it, or writes a new concept,
- tunes the enrichment via the embedded **Enrichment Editor** (Advanced Options),
- inspects the **Runtime Compiled Prompt** preview,
- then **approves the visual gag** (advances to Step 3, force-firing renders),
  sends it back to prep, or rejects.

**Visual Ideas are a blocking prep artifact here**, not best-effort: the gag
gate requires a saved, non-empty `visualPromptStrategyOverride.coreSceneOverride`
**and** terminal-OK generated ideas (`facts.visual_concept_status === "ok"`).
A stale-but-saved concept is allowed (the *saved* concept, not the AI candidate
cards, is the approved artifact). Re-prep/regenerate is blocked while ideas are
`pending` so a new cycle can't coalesce onto a stale in-flight concept job.

## Test Renders review ("Step 3", `production_review`)

The expensive render review. Renders **auto-fire** on arrival (a forced,
no-dedupe-key batch). All taxonomy/enrichment knobs stay exposed for render
tweaking. The moderator:

- inspects the **test-render** meme grid and the **Runtime Compiled Prompt**,
- tweaks enrichment/concept and re-runs renders as needed,
- then **production-approves** (existing render/waiver gate) or rejects — or
  **sends the fact back to Visual Concept** (Step 3 → Step 2), which supersedes
  the in-flight renders; re-approval force-creates a fresh batch.

## Pexels and test renders

Pexels stock images and test renders are **review tools, not hard gates** — they
help the moderator judge how a fact will render. A moderator may approve despite
missing/stale required render scenarios; doing so records a
`visualRenderApprovalWaiver` on the review (an auditable override, not a silent
skip). *(If the repo later makes any render a hard gate, update this line.)*

## Final production approval

Production approval:

1. flips the staging fact **active** (`isActive = true`, now live),
2. stores the approved-fact linkage (`approvedFactId`) on the review,
3. embeds the fact (pgvector) for duplicate detection,
4. notifies the submitter (activity feed + email),
5. sets stage `production_approved`, status `approved`.

**Refresh cycle:** re-reviewing an already-live fact uses a *candidate*
enrichment version (`candidateVersionId`). The live fact stays published; approval
promotes the candidate, rejection leaves the live fact untouched and keeps the
candidate as rejected history (never hard-deleted). See
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md#versioning-model).

## Rejection paths

- `triage_rejected` — rejected at first pass (no paid work spent).
- `prep_failed` → reject — abandoned during prep.
- `production_rejected` — rejected after prep; audit columns capture the
  reject-after-spend so the cost is visible.

## Retry and failure states

`prep_failed` is retryable (re-enqueues prep) or rejectable. Underlying prep jobs
have their own `attempts`/`maxAttempts` in `async_jobs`; the backend's retry logic
is what ultimately fails a crash-looping job — the UI just reflects
`done`/`failed`.

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
- Comment moderation: `pages/admin/comments.tsx` + comment `status`/`flagged`.
