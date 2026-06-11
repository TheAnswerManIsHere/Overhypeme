---
name: Image-prompt preview parity (Fact page vs workbench vs production)
description: Why the two admin prompt previews can differ for the same fact, and the single shared rendering path they (and production) must use.
---

# Image-prompt preview parity

Three surfaces render the render-time image prompt, and they all share ONE core
path: `generateImagePromptPlan()` (OpenAI planner) + `compileForSubjectRenderMode()`
(deterministic Nano Banana 2 compiler).

- Fact page "Runtime Compiled Prompt Preview" → `POST /admin/image-prompt/preview`
  (adminImagePrompt.ts) → `assembleImagePromptForPreview()`.
- i2i/t2i engine workbench → `/admin/engines/:id/assemble-prompt` and `/test`
  (adminEngines.ts) → `assembleImagePromptForPreview()`.
- Production meme generator → imagePromptJobs.ts → calls the two underlying
  functions directly (uses the REAL user identity via `resolveAttemptIdentity`,
  not the test identity).

## Rule: both PREVIEW surfaces must share the test identity
Both render fact templates ({NAME}/{SUBJ}/…) down to the canonical constants
`PREVIEW_SUBJECT_NAME` / `PREVIEW_SUBJECT_PRONOUNS` (exported from
`lib/imagePrompt/preview.ts`). Never re-hardcode a per-route name.

**Why:** they previously diverged — adminImagePrompt used "David" while
adminEngines used "David Franklin" — so the planner saw different rendered fact
text and produced visibly different prompts for the same fact. Standardized on
"David Franklin" because `adminEngines.test.ts` asserts that exact string while
`imagePromptPreview.test.ts` only matches `/David/`.

## Divergence is temperature, NOT caching
`IMAGE_PROMPT_TEMPERATURE = 0.4`, so two separate live calls produce
differently-worded prose ("baby" vs "newborn baby gripping the wheel") even with
byte-identical input. The previews do NOT cache and do NOT read the production
`aiScenePrompts` blob (that cache serves only video/PuLID/backfill; tests assert
the image bench never touches it). So if the two previews differ: first suspect
input drift (identity/style/aspect), then temperature — not a cache.

**How to apply:** to make outputs byte-identical you must either set
temperature 0 (changes production quality) or have one surface reuse the other's
generated result — ask the user before doing either.
