# PR170 — Eval harness (Slice 2B, backend) · TEST_RUN

> **Companion UAT:** none in this PR — PR-B1 is backend-only (no UI surface).
> The click-through UAT for the per-tile rating control, golden toggle, and the
> `/admin/eval` dashboard ships with **PR-B2** (the eval UI). Run this automated
> checklist; it should be fully green.
>
> **Replit owns the database connection** — just run the suites; don't set any
> DB env. The runner applies migrations (including 0080) itself.

---

## 1. What this PR changes (engineering summary)

A golden set + per-render moderator verdict + controlled eval runs, so a pipeline
change's effect on render quality is measurable rather than vibes. Backend only.

1. **Migration `0081_eval_harness.sql`** — `eval_runs` table; eval columns on
   `image_prompt_attempts` (`moderator_rating`, `failure_tag`, `eval_notes`,
   `eval_by`, `eval_at`; and `eval_run_id` / `eval_scenario_key` /
   `eval_input_hash` set ONLY on eval-run attempts, `review_id` NULL there so
   eval renders never appear in the moderation grid); `facts.eval_golden`(+reason)
   + partial dashboard indexes. Idempotent hand-written DDL; journal idx 80;
   `SNAPSHOT_EXEMPT_TAGS` updated.
2. **`lib/api-zod/src/eval.ts`** — `FAILURE_TAG_VALUES` (concept | compiler |
   image_model | none); `evalWriteSchema` clear-semantics: **key omitted = leave
   unchanged; key = null = clear; empty notes = null**; rating + failureTag
   INDEPENDENT. `resolveEvalColumns` + golden/run-create schemas + shared
   `EvalRunProfile` / `AttemptSignature` shapes.
3. **`lib/eval/signature.ts`** — `deriveAttemptSignature` (per-row; ACTUAL image
   engine, NOT coarse `targetEngine`; missing → "unknown") + `captureRunProfile`
   (broad, once per run).
4. **`lib/eval/evalRunJobs.ts`** — Option-A dedicated eval-run renderer (NOT
   synthetic reviews): renders the golden set's approval-required scenarios via
   `buildAndEnqueueImagePromptAttempt` tagged `eval_*`; per-item skip/fail without
   failing the run; run list + status.
5. **`lib/eval/dashboard.ts`** — per run → per fact → per attempt-signature; avg
   rating + tag distribution; run N-vs-N-1 diff; opportunistic ratings separated.
6. **Routes** (all `requireAdmin`): `POST /admin/reviews/:id/render-scenarios/
   :key/attempts/:id/eval` (reviews.ts, ownership-guarded); `POST /admin/eval/
   attempts/:id/eval` (eval-run only); `POST /admin/facts/:id/eval-golden`
   (active only); `POST|GET /admin/eval/runs`, `GET /admin/eval/runs/:id`;
   `GET /admin/eval/attempts/:id/image`; `GET /admin/eval/dashboard` (new
   routes/eval.ts).

## 2. What is deliberately NOT shipped

- **No UI** — the per-tile `AttemptEvalControl`, the golden toggle on the Facts
  page, the `/admin/eval` dashboard, and the "Start eval run" button are PR-B2.
- No change to the render pipeline itself — eval runs reuse the existing
  `buildAndEnqueueImagePromptAttempt` + `image_prompt_generation` queue.
- Opportunistic (non-run) ratings are stored but labeled directional; only
  eval-run rows are a true A/B.

## 3. Automated checks to run

```bash
pnpm --filter @workspace/api-server run typecheck
pnpm run typecheck:libs
pnpm --filter overhype-me run typecheck   # the RenderScenarioCard field add is optional — FE unaffected
pnpm --filter @workspace/db check-snapshots
pnpm --filter @workspace/api-server test
```

**Expected:** typecheck + snapshot clean; api-server suite **`result=pass`, 0
fail** (the Stripe webhook tests pass — their fix is on `main`). Both new
`eval.*.test.ts` files pass.

## 4. Targeted assertions to confirm

- **`eval.unit.test.ts`**
  - `resolveEvalColumns`: `{}` → `{}` (no-op); `{rating:4}` → set; `{rating:null}`
    → clear; omitted keys absent; empty/whitespace notes → null; rating & tag
    independent.
  - `deriveAttemptSignature`: t2i vs i2i differ on `actualImageEngineId`; missing
    planner provenance / scenario bucket "unknown"; the signature key groups
    identical rows and separates different scenarios.
- **`eval.routes.test.ts`**
  - Golden toggle: sets `eval_golden`+reason on an active fact; **409** on an
    inactive fact.
  - Review-scoped eval: persists rating+tag+notes (trimmed), clears rating via
    explicit `null` while an omitted tag is untouched; **400** empty body; **404**
    foreign review; **409** scenario mismatch.
  - Generic eval-run eval: rates a pure eval-run attempt; **409** for a
    moderation attempt (review_id set).
  - Eval runs: create returns `{runId, items}`; list + status resolve.
  - **Grid isolation:** an eval attempt on a fact that also has a review does NOT
    back any review scenario card (`latestAttemptId` stays null).
  - Image route: **404** for a non-eval attempt and an eval attempt with no image.
  - Dashboard: avg rating per run (4.5), run N-vs-N-1 `avgRatingDelta` (1.5),
    tag distribution, and opportunistic ratings separated (rated 1, avg 1) — NOT
    folded into a run's average.
  - **Admin-auth drift:** every new route returns 401/403 for a non-admin.

## 5. Live end-to-end (needs an OpenAI key on Replit)

1. Mark 2–3 stable active facts golden: `POST /admin/facts/:id/eval-golden
   {"golden":true,"reason":"…"}`.
2. `POST /admin/eval/runs {"label":"baseline"}` → returns a `runId` + per-item
   enqueue results. Watch `GET /admin/eval/runs/:runId` — items go
   pending → image_ready (or skipped when a reference asset is missing).
3. Rate a couple of the rendered attempts: `POST /admin/eval/attempts/:id/eval
   {"rating":4,"failureTag":"compiler"}`.
4. Change something in the pipeline, run a second eval run, rate it, then
   `GET /admin/eval/dashboard` — confirm the two runs group by fact/signature
   and the run-vs-run diff shows the avg-rating delta.

## 6. Gotchas

- Eval-run i2i scenarios need the default reference assets present; without them
  those items come back **skipped** (`reference_asset_unavailable`) — that's the
  per-item guard working, not a run failure. The generic t2i scenario always
  enqueues.
- Eval attempts have **no `review_id`** and no review-scoped image URL — their
  image streams via `GET /admin/eval/attempts/:id/image` (admin-gated).
- If the api-zod `eval` export goes missing after codegen, the fix is the
  allowlist entry in `lib/api-spec/patch-generated.mjs` (already added).
