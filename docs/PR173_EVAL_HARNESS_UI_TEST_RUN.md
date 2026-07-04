# PR173 — Eval harness UI (Slice 2B, frontend) · TEST_RUN

> **Companion UAT:** `docs/PR173_EVAL_HARNESS_UI_UAT.md` — the click-through for
> the per-tile rating control, golden toggle, and the `/admin/eval` dashboard.
> Run this automated checklist; it should be fully green.
>
> **Replit owns the database connection** — just run the suites; don't set any
> DB env. No new migration ships in this PR (the eval schema landed in #170 /
> `0081_eval_harness`); this is frontend + one admin-projection field.

---

## 1. What this PR changes (engineering summary)

The UI surface for the eval harness whose backend shipped in #170. Frontend only,
plus one additive field on an existing admin projection.

1. **`components/admin/AttemptEvalControl.tsx`** — reusable per-attempt eval
   control: rating 1–5 + failure-tag (concept | compiler | image_model | none) +
   optional note. Every field independent and **clearable** (click an active
   rating/tag again to clear). Optimistic with **revert-on-error**.
   Endpoint-agnostic via an `onSave` prop so the same control drives the
   review-scoped route (moderation tile) and the eval-run route (dashboard).
   Exports `FAILURE_TAG_LABELS` (label + moderator tooltip) and `EvalWriteBody`.
2. **`components/admin/GoldenToggle.tsx`** — mark/unmark a fact for the golden
   set. Active-only to **add** (disabled + tooltip otherwise); an inactive golden
   fact stays **removable**. Optimistic, reverts on failure.
3. **`pages/admin/evalDashboard.tsx`** (`/admin/eval`) — golden set list; runs
   grouped **by fact → attempt-signature**; **Start eval run** gated behind a
   cost confirmation; **active-run per-item live status** (rule 8: a chip per
   item goes spinner → check / amber, plus a running tally, polled at 1.5s until
   every item is terminal, no refresh, no timeout); **run N-vs-N-1 diff**;
   opportunistic (non-run) ratings shown separately, labeled directional.
4. **`components/admin/FactRenderScenarioTile.tsx`** — renders `AttemptEvalControl`
   under each tile's diagnostics, saving through the review-scoped eval route.
5. **`pages/admin/facts.tsx`** — `GoldenToggle` in the fact status-badges row.
6. **`App.tsx`** + **`AdminLayout.tsx`** — `/admin/eval` route (lazy) + an **Eval**
   nav item (FlaskConical icon).
7. **`routes/admin.ts`** — the facts-list projection now surfaces `evalGolden` /
   `evalGoldenReason` so the toggle reflects saved state.

## 2. What is deliberately NOT shipped

- **No schema / migration** — the eval columns + `eval_runs` table are already on
  `main` (`0081_eval_harness`, from #170).
- **No new backend routes** — this UI consumes the routes shipped in #170
  (`/admin/eval/*`, `/admin/reviews/:id/.../eval`, `/admin/facts/:id/eval-golden`).
- Opportunistic (non-run) ratings remain labeled directional; only eval-run rows
  roll into a run average.

## 3. Automated checks to run

```bash
pnpm --filter overhype-me run typecheck
pnpm --filter @workspace/api-server exec tsc -b   # the admin.ts projection field
pnpm --filter overhype-me test
```

**Expected:** both typechecks clean; the overhype-me vitest suite **all green**
(721 passed at time of writing), including the three new files:
`AttemptEvalControl.test.tsx`, `GoldenToggle.test.tsx`, `evalDashboard.test.tsx`.

## 4. Targeted assertions to confirm

- **`AttemptEvalControl.test.tsx`**
  - Clicking rating `4` posts `{rating:4}`; clicking `4` again posts `{rating:null}`
    (clear). Clicking a failure chip posts `{failureTag:…}`; independent of rating.
  - A failed save **reverts** the optimistic value and surfaces the `eval-error`
    node.
- **`GoldenToggle.test.tsx`**
  - Active fact → posts `{golden:true}`, label flips to **Golden**.
  - Inactive + non-golden → button **disabled** (can't add).
  - Inactive + already golden → **removable**, posts `{golden:false}`.
  - Failed save reverts the label.
- **`evalDashboard.test.tsx`**
  - Golden set + runs render; **Start eval run** requires the cost confirmation
    before POSTing; run-vs-run diff renders when a `runDiff` is present;
    opportunistic ratings render in their own labeled section.

## 5. Live end-to-end (needs an OpenAI/fal key on Replit)

Follow the UAT (`docs/PR173_EVAL_HARNESS_UI_UAT.md`) start-to-finish: rate a
Step-2 tile, mark 2–3 facts golden, open `/admin/eval`, Start eval run (confirm
cost), watch per-item status go terminal, rate a couple of rendered attempts,
change the pipeline, run a second eval run, and confirm the run-vs-run diff.

## 6. Gotchas

- Eval-run i2i scenarios need the default reference assets; without them those
  items return **skipped/blocked** (amber) — the per-item guard, not a run
  failure. The generic t2i scenario always enqueues.
- The active-run poller stops only when every item is terminal (`working === 0`);
  it deliberately imposes **no UI timeout** per the async-status contract.
- Eval attempts carry **no `review_id`**, so they never appear in the moderation
  Step-2 grid and their images stream via the admin-gated
  `GET /admin/eval/attempts/:id/image` (backend #170).
