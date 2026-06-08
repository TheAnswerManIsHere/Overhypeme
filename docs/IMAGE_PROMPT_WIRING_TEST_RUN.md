# New image-prompt engine → bench + meme generator — automated test run

Paired with **`docs/IMAGE_PROMPT_WIRING_UAT.md`** (the click-through acceptance
test). This doc is the engineering safety net for Replit.

## TL;DR

```
# api-server (from artifacts/api-server)
pnpm run typecheck            # tsc + cycles + no-console
# Targeted test files (Replit owns the DB connection):
node --import tsx/esm --test src/__tests__/adminEngines.test.ts          # 53 pass
node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts     # 12 pass
node --import tsx/esm --test src/__tests__/memesGenerateGeneric.test.ts   #  3 pass
node --import tsx/esm --test src/__tests__/routes.memes.test.ts           # 23 pass (non-regression)

# overhype-me (from artifacts/overhype-me)
pnpm run typecheck            # clean
```

## What changed

The render-time image-prompt engine (`lib/imagePrompt/generator.ts` +
`compilers/nanoBanana2.ts`) — already live for reference uploads via
`/memes/ai/:factId/generate-v2` — now also drives the two remaining image
surfaces, replacing the legacy `aiMemePipeline.generateScenePrompts` (FLUX) path
there:

1. **t2i/i2i engine bench** — `POST /admin/engines/:id/assemble-prompt` (image
   branch) builds the bench prompt with the new engine. t2i bench →
   `t2i_fallback` (bench gender → `fallbackSubjectGender`); i2i bench →
   `human_identity_i2i`, analyzing + rendering against ONE resolved reference URL
   (the admin's sample image, else the bundled test face).
2. **Generic (no-upload) meme generator** — the non-reference branch of
   `POST /memes/ai/:factId/generate` now enqueues a `t2i_fallback`
   `image_prompt_attempts` row via the shared
   `buildAndEnqueueImagePromptAttempt` (same pipeline as `generate-v2`) and
   returns `202 { renderJobId, attemptId }`. Renders with `nano-banana-2`.

Shared helpers extracted (no behavior change): `lib/imagePrompt/preview.ts`
(`assembleImagePromptForPreview`, pure — no persistence) and
`lib/imagePromptAttempts.ts` (`buildAndEnqueueImagePromptAttempt`,
`parseAspectRatio`, `normalizeStyleId`).

Both surfaces **require valid enrichment** (`fact_enrichment_invalid` 400) and
honor a **user-selected aspect ratio** (`renderControls.aspectRatio`).

## A — Engine bench (`adminEngines.test.ts`)

New/updated assemble-prompt cases (plan generator stubbed via
`__setPlanGeneratorForTest`; source analyzer stubbed via
`__setSourceImageAnalyzerForTest` — no OpenAI/fal):

- t2i: returns the compiled Nano Banana prompt; the bench gender + aspect ratio
  flow into `renderControls` (`fallbackSubjectGender`, `aspectRatio`).
- i2i: the SAME resolved reference URL is analyzed, fed to the generator input,
  and written into `renderControls.referenceImageUrl`.
- Missing enrichment → `400 fact_enrichment_invalid`.
- The image bench does NOT write the legacy `facts.aiScenePrompts` cache.
- Video / utility benches unchanged (their tests still pass).

Expected: **53 pass**.

## B — Preview helper non-regression (`imagePromptPreview.test.ts`)

`POST /admin/image-prompt/preview` now delegates to the shared
`assembleImagePromptForPreview`; the response contract is unchanged. Expected:
**12 pass** (auth gate, validation, human/nonhuman/t2i happy paths, style
source, debug surfacing + non-mutation).

## C — Generic meme branch (`memesGenerateGeneric.test.ts`)

The async worker is NOT running, so enqueue only inserts the attempt + job rows
(no OpenAI/fal). Cases:

- `scope: "gendered"` → `202 { renderJobId, attemptId }`; attempt is
  `t2i_fallback` / `generationMode "t2i"` / `targetEngine "nano_banana_2"`;
  requester pronouns (she/her) → `fallbackSubjectGender "female"`; aspect ratio
  flows through; `renderedFactText` has no `{NAME}`; `aiScenePrompts` not written.
- `scope: "abstract"` → `fallbackSubjectGender "neutral"`.
- Unenriched fact → `400 fact_enrichment_invalid`.

Expected: **3 pass**.

## D — Non-regression

- `routes.memes.test.ts` — **23 pass** (the reference branch + the rest of the
  memes router are untouched).
- Grep gate: `generateScenePrompts` is no longer referenced by
  `routes/adminEngines.ts` or the generic branch of `routes/memes.ts`
  (still referenced by the video pipeline, PuLID jobs, `regenerate-scene-prompts`,
  and backfill — expected, see below).

## E — Cost / governance parity (manual code check)

The generic path moved from synchronous FLUX to the async attempt pipeline. The
route-level `enforceGovernance`/`completeGovernance` wrapper is unchanged (it
records the estimate on the 202 success in the `finally`). FAL cost recording is
NOT done twice: the generic path now follows the SAME model as `generate-v2`
(the `image_generation` job owns the render). Confirm no caller of
`POST /memes/ai/:factId/generate` still expects a synchronous `{ objectPath }`
for the generic case — the only generic caller is `AiBgPicker` (now
`renderJobId`-aware); `runStylize` + the wizard use the untouched reference
branch.

## What this explicitly does NOT ship

- The video pipeline, PuLID reference jobs, `regenerate-scene-prompts`, the
  `/prompts` preview, and admin/script backfill stay on the legacy
  `generateScenePrompts` + FLUX/PuLID path. They are deliberately left for the
  upcoming Nano Banana **video rebuild** to retire; `generateScenePrompts` is
  marked `@deprecated` but NOT deleted.
- Deletable once that rebuild lands: `generateScenePrompts`,
  `generateAiMemeBackgrounds`, the FLUX render core, `scenePromptConfig`, and the
  `facts.aiScenePrompts` column.
