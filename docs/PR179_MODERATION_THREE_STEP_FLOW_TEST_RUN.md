# PR179 — Moderation three-step flow · TEST_RUN (engineering checklist)

> **For Replit (the technical safety net).** Automated verification for the
> three-gate moderation flow (`concept_review` stage). Companion click-through:
> `docs/PR179_MODERATION_THREE_STEP_FLOW_UAT.md`.
>
> Replit owns the database connection — do **not** set `DATABASE_URL` from this
> doc. "Apply migrations" / "run these tests" against Replit's own DB.

---

## 1. Build + typecheck

```bash
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
pnpm typecheck
```

Expect: all four projects report **Done**, no TS errors. (`check:cycles` and
`check:no-console` also pass as part of the api-server typecheck.)

## 2. Migration + schema

- Apply migrations against Replit's DB (the hash-based runner: `pnpm --filter
  @workspace/db run migrate`). The new file is
  `0083_review_workflow_stage_concept_review.sql`.
- Snapshot chain check:
  ```bash
  pnpm --filter @workspace/db check-snapshots
  ```
  Expect: ✓ all journal entries have snapshots or are exempt (0083 is exempt,
  hand-authored — same pattern as 0074–0081).
- Confirm the enum after migration:
  - `review_workflow_stage` contains **`concept_review`**, positioned between
    `prep_failed` and `production_review`.
  - `pending_reviews.workflow_stage` is still **NOT NULL** with default
    `'triage_pending'`, and the `idx_pending_reviews_workflow_stage` index still
    exists (the drop-and-recreate recast preserves all three).
  - Existing rows keep their prior stage value (no backfill — old
    `production_review` rows stay put).

The migration is idempotent (drop-and-recreate re-runs cleanly); re-running
`migrate` a second time reports 0 applied.

## 3. Backend tests

```bash
pnpm --filter @workspace/api-server test
```

Expect **all shards pass**. New/updated files that must be green:

- `moderationWorkflow.guards.test.ts` — `concept_review` is unresolved;
  `canApproveVisualConcept` true only at `concept_review`; `canProductionApprove`
  false at `concept_review`; `canRejectAfterPrep` true; `canEditRefreshCandidate`
  true for `concept_review` + `production_review` only.
- `moderationConceptLifecycle.test.ts` — first-time enrichment **success →
  `concept_review`**, concept job enqueued, **no** `review_render_scenarios_prepare`
  job; terminal failure → `prep_failed`.
- `routes.approveVisualConcept.test.ts` — admin-only; wrong-stage 409; each
  distinct 409 code (`CONCEPT_DISABLED`/`CONCEPT_MISSING`/`IDEAS_PENDING`/
  `IDEAS_NOT_GENERATED`); happy path → `production_review` + a **no-dedupe-key**
  force prepare job; **stale-but-saved advances**; **two concurrent approvals →
  exactly one 200 + one 409 (`CONCEPT_STAGE_ALREADY_ADVANCED`) + exactly one
  force batch**; `back-to-visual-concept` bounce + fresh batch on re-approval.
- `visualConceptJobs.test.ts` — regenerate is a Step-2 action (202 from
  `concept_review`, 409 elsewhere) and is **blocked while ideas pending**
  (`IDEAS_PENDING`).
- `enrichmentVersioning.refresh.test.ts`, `routes.candidateEnrichmentEditing.test.ts`,
  `routes.reviews.test.ts` — updated to the new flow (enrichment lands at
  `concept_review`; Step-3 assertions advance the cycle first).

Single-file runs (if triaging):

```bash
bash artifacts/api-server/scripts/run-test.sh src/__tests__/routes.approveVisualConcept.test.ts
bash artifacts/api-server/scripts/run-test.sh src/__tests__/moderationConceptLifecycle.test.ts
```

## 4. Frontend tests

```bash
pnpm --filter @workspace/overhype-me test
```

Expect all pass, including `src/components/admin/moderationQueueState.test.ts`
(the full §8 label table for `deriveModerationQueueState` + `stageToWizardStep`).

## 5. Acceptance assertions (what "done" means)

- After successful enrichment, **no** `review_render_scenarios_prepare` job exists
  for the review until `approve-visual-concept` is called.
- The force approval is **not** absorbed by a pre-existing non-terminal prepare
  job on the stable key — a distinct **keyless** force prepare job is scheduled.
- Non-force `ensureDefaultReviewRenders` stays idempotent (no duplicate attempts
  for current-hash scenarios); force creates fresh attempts even for identical
  hashes.
- List endpoint rows carry `visualConceptStatus` (from the staging fact) and a
  coarse `renderReviewState` (`not_started`/`running`/`ready`/`needs_attention`);
  a no-attempt `production_review` row is **not** `"ready"`.

## What's deliberately NOT shipped

- No render-cycle token / batch table (the no-dedupe force enqueue makes it
  unnecessary — deferred).
- No `"stale"` in `renderReviewState` (staleness needs the TS input-hash recompute;
  the modal/grid stays authoritative).
- No hard-cancel of in-flight render jobs on bounce (superseded by the fresh
  forced batch — D2).
- No change to the render compiler, concept generator, or enrichment classifier —
  only *when* they run and how stages gate them.
- No back-migration of existing `production_review` rows (D3).
