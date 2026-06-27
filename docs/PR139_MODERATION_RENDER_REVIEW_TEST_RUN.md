# Moderation render-review tools — engineering test run (Replit)

**PR:** #139 · **Companion:** [`PR139_MODERATION_RENDER_REVIEW_UAT.md`](./PR139_MODERATION_RENDER_REVIEW_UAT.md)

The technical safety net for the two new `production_review` surfaces: viewing the
fact's Pexels images and rendering its AI background through the real pipeline.
Replit owns the database connection — this doc describes **what** to run against
the DB, never a `DATABASE_URL`/env setup. **No schema migration in this PR.**

## What changed (engineering summary)

- **`artifacts/api-server/src/lib/imagePromptAttempts.ts`** — `RenderControlsWithRefs`
  gains three internal (JSONB, route-written) fields: `mirrorToLegacyStorage?`,
  `reviewRenderSubject?`, `reviewAudit?`. `BuildImagePromptAttemptArgs` gains
  `requestId?` (written to the attempt row). New pure `buildRenderStatusPayload()`
  shared by the user + admin poll routes.
- **`artifacts/api-server/src/lib/imagePromptJobs.ts`** — `imageGenerationHandler`
  skips `mirrorToLegacyStorage()` when `renderControls.mirrorToLegacyStorage === false`
  (still writes `generatedImageObjectPath`). `resolveAttemptIdentity()` now prefers
  `renderControls.reviewRenderSubject` before the `userId` lookup / "Alex" fallback.
- **`artifacts/api-server/src/lib/imagePrompt/resolveRenderReviewInput.ts`** (new) —
  the single deterministic input assembler (analysis, subject render mode, identity
  policy, render controls, style suffix, sample subject, rendered fact text) used by
  **both** the preview route and the render route, so they can't drift.
- **`artifacts/api-server/src/routes/adminImagePrompt.ts`** — preview route refactored
  to call `resolveRenderReviewInput` (behaviour unchanged; proven by the existing
  preview suite).
- **`artifacts/api-server/src/routes/memes.ts`** — `GET /memes/ai/renders/:renderJobId`
  now returns `buildRenderStatusPayload(attempt)` (identical shape; no behaviour change).
- **`artifacts/api-server/src/routes/reviews.ts`** — three new admin endpoints:
  `GET /admin/reviews/:id/pexels-images`, `POST /admin/reviews/:id/render`,
  `GET /admin/reviews/:id/renders/:renderJobId`.
- **Frontend:** `RuntimePromptPreview.tsx` (new `reviewIdForRender` prop + "Render AI
  background" section), `ModerationPexelsPanel.tsx` (new), `useModerationRender.ts`
  (new render kick/poll hook), `moderation.tsx` (mounts both).

## Automated checks

From repo root:

```bash
# Typecheck (builds api-zod + db project refs too)
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/overhype-me exec tsc -b

# Full api-server suite — expect ALL pass
pnpm --filter @workspace/api-server test
```

Targeted, fast feedback on just the new logic:

```bash
# Backend (from artifacts/api-server/) — expect: tests 19, fail 0
node --import tsx/esm --test src/__tests__/adminReviewRenderTools.test.ts

# Confirm the shared refactors didn't regress the routes they touch
node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts   # tests 12
node --import tsx/esm --test src/__tests__/routes.memes.test.ts         # tests 23

# Frontend (from artifacts/overhype-me/) — expect: 7 passed
npx vitest run src/components/admin/ModerationPexelsPanel.test.tsx \
               src/components/admin/useModerationRender.test.tsx
```

### What the tests pin down

- **`GET /admin/reviews/:id/pexels-images`** — 401 anon / 403 non-admin; serves the
  **inactive** staging fact (no `isActive` gate); legacy `url`-only entries render;
  prefers `src.large2x` when present; `ok`+0-images is distinct from `pending`/`failed`;
  no `stagingFactId` ⇒ empty groups + `pexelsStatus:null`.
- **`POST /admin/reviews/:id/render`** — 403 non-admin; 409 off-`production_review`;
  400 `i2i_unavailable_in_moderation` (no enqueue); 400 `fact_enrichment_invalid` for
  a bad staging enrichment; happy path inserts an attempt with `userId:null`,
  `factId === stagingFactId`, `subjectRenderMode:"t2i_fallback"`, token-resolved
  `renderedFactText`, `requestId` matching `admin-review:{reviewId}:{adminUserId}:`,
  and `renderControls.{mirrorToLegacyStorage:false, reviewRenderSubject, reviewAudit}`.
- **`GET /admin/reviews/:id/renders/:renderJobId`** — 403 non-admin; 200 admin returns
  the status payload; 404 when the attempt's `reviewAudit.reviewId` ≠ path id; 404 for
  an unknown job id.
- **`buildRenderStatusPayload`** — all five states (`pending`/`prompt_ready`/
  `image_ready`/`blocked`/`failed`), incl. the deliberate `blocked` for
  `subject_fact_compatibility_poor`.
- **`resolveRenderReviewInput`** — resolves `{NAME}` to the sample subject, assembles a
  t2i input, and is deterministic for identical inputs (the cross-route parity guarantee).
- **Frontend** — `ModerationPexelsPanel` ok/empty/failed/pending-poll states;
  `useModerationRender` kick→poll→`image_ready` then stops, `blocked` distinct from
  failure, and restored **terminal** rows do not resume polling.

### DB spot-checks (Replit runs against its own DB)

After a moderation render of a fact under review (UAT step), the attempt row exists and
is ephemeral:

```sql
-- The review render attempt: userId null, ephemeral, audited.
SELECT id, fact_id, user_id, subject_render_mode, request_id,
       render_controls->>'mirrorToLegacyStorage' AS mirror,
       render_controls->'reviewAudit'            AS review_audit
FROM image_prompt_attempts
WHERE request_id LIKE 'admin-review:%'
ORDER BY created_at DESC LIMIT 5;
-- expect: user_id NULL, mirror = 'false', review_audit has the reviewId + adminUserId.

-- Ephemeral guarantee: the staging fact's shared AI image set is untouched by the render.
SELECT id, is_active, ai_meme_images FROM facts WHERE id = <stagingFactId>;
-- expect: ai_meme_images unchanged (no new path appended by the moderation render).
```

## Gotchas

- **The render job needs the async worker + fal.** The route only *enqueues*
  `image_prompt_generation`; the image only appears once the worker runs the two-queue
  pipeline (`image_prompt_generation` → `image_generation`) against fal. In a worker-less
  environment the attempt stays `pending`/`prompt_ready` — that's the queue, not a bug.
- **Render is t2i-only.** Review facts have no source image; i2i is rejected at the route
  (`i2i_unavailable_in_moderation`) and disabled in the UI. The default fallback gender is
  `neutral`.
- **Admin poll route is the only safe one for review renders.** Review attempts are
  `userId:null`, which bypasses the ownership gate on the public `/memes/ai/renders/:id`
  route — so moderation polls the admin-gated `/admin/reviews/:id/renders/:renderJobId`,
  which additionally checks `reviewAudit.reviewId`.
- **No DB schema change / migration.** The ephemeral flag + provenance live in the
  existing `render_controls` JSONB and the existing `request_id` column.

## Deliberately NOT shipped

- **No composited test-meme preview.** Output is the raw AI background only (matches the
  Engines test bed); text-overlay/layout is intentionally not validated here.
- **No mirroring of moderation renders onto the fact.** Renders are verification
  artifacts; production backgrounds are still generated by the normal pipeline.
- **No backend listing of historical review attempts.** The render list is per-review in
  `localStorage` for now; the `reviewAudit` provenance makes a DB-backed list easy later.
- **No new `isReviewRender` column.** The `renderControls` flag suffices pre-launch.
- **No change to user-facing generation.** `generate` / `generate-v2` omit the new flag
  ⇒ they still mirror to legacy storage exactly as before.
