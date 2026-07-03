# PR162 — Faster moderation (Approve preflight removal + test-renders list pill) · TEST_RUN

> **Companion:** `docs/PR162_APPROVAL_PREFLIGHT_REMOVAL_UAT.md` (David's in-app
> click-through). Run this automated checklist first — it should be fully green
> before David starts the UAT.
>
> **Replit owns the database connection.** Don't set `DATABASE_URL` or any
> test-DB env here — just run the suite; the harness stands up its own DB.

---

## 1. What this PR changes (engineering summary)

1. **Removed the synchronous approval render preflight.** Deleted
   `artifacts/api-server/src/lib/imagePrompt/renderPreflight.ts` and the
   `runApprovalRenderPreflight` helper. Both approval branches in
   `routes/reviews.ts` — `approveForProduction` and
   `approveRefreshCandidateForProduction` — no longer make a synchronous
   planner/compiler call. Renderability is gated solely by
   `resolveVisualRenderGate` (the required-render check).
2. **Waiver is now a true override.** With the preflight gone, an explicit
   render-problem waiver approves with no hidden second veto. Still audited via
   `pending_reviews.visual_render_approval_waiver`.
3. **Test-renders list pill.** New `reviewsWithActiveRenders()` in
   `lib/reviewRenderScenarios.ts` powers a per-row `rendersRunning` flag on
   `GET /admin/reviews`, surfaced as a "Test renders · working…" pill.

**No schema/migration in this PR.** No new columns, no SQL to apply.

## 2. What is deliberately NOT shipped
- No change to the required-render gate itself (`requiredScenarioProblems` /
  staleness) — it remains the approval renderability gate.
- No change to test-render generation, the scenario grid, or the refresh-cycle
  (#160) machinery beyond removing the preflight call from its approve path.
- No async/background approval (that was an alternative we did not take).

## 3. Automated checks to run

```bash
# From repo root. Typecheck both workspaces:
pnpm --filter @workspace/api-server run typecheck
pnpm --filter overhype-me run typecheck

# Full api-server suite (sharded; stands up its own DB):
pnpm --filter @workspace/api-server test

# Touched frontend tests:
pnpm --filter overhype-me exec vitest run \
  src/components/admin/FactVisualReviewGrid.test.tsx
```

**Expected:** all green. The api-server suite reports `result=pass` across all
shards (≈980 tests total across the two shard groups; 0 fail).

## 4. Targeted assertions to confirm

- **`routes.reviews.test.ts` → `describe("approval renderability gating")`**
  - `approves via waiver WITHOUT invoking the visual planner, and records the
    waiver` — installs a plan-generator that **throws if called**, waives the
    required renders, and asserts `200` + waiver snapshot written. Proves
    approval makes no planner call.
  - `blocks approval (409 visual_render_incomplete) when required renders are
    missing and unwaived` — proves the required-render gate still protects an
    unvalidated fact.
- **`enrichmentVersioning.refresh.test.ts` → `refresh approve → promote`** still
  passes: the refresh-candidate approval promotes with the required renders
  waived and **no** preflight.
- **Grep guard — no preflight references remain in source:**
  ```bash
  grep -rn "runApprovalRenderPreflight\|assertFactPassesCanonicalRenderPreflight\|renderPreflight\|RENDER_PREFLIGHT_TIMEOUT_MS" \
    artifacts/*/src lib/*/src
  ```
  Expect **no matches** (a single self-describing comment "No synchronous render
  preflight" in `reviews.ts` is fine; there must be no code references).

## 5. `reviewsWithActiveRenders()` behavior (already unit-verified)
The list pill's signal returns a review as "rendering" iff the **latest** attempt
for at least one scenario is still queued/rendering (no `error`, no image yet).
Superseded-by-done and per-scenario failures correctly drop out. This was
verified end-to-end against the DB; the route test covers the endpoint shape.

## 6. Gotchas
- If any refresh test (`enrichmentVersioning.refresh.test.ts`) fails with an
  "undefined function" error, the preflight removal didn't fully apply to the
  refresh branch — check `approveRefreshCandidateForProduction` in
  `routes/reviews.ts` has no `runApprovalRenderPreflight` call.
- The suite must show `result=pass`; a hung shard usually means a stray
  never-resolving planner stub — not expected here (the guard test's throwing
  stub resolves synchronously).
