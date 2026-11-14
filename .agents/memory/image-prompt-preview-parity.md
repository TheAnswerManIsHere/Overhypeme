---
name: Image-prompt preview parity (Fact page vs production)
description: Why the admin prompt preview can differ from production for the same fact, and the single shared rendering path they must use.
---

# Image-prompt preview parity

Two surfaces render the render-time image prompt, and they share ONE core
path: `generateImagePromptPlan()` (OpenAI planner) + `compileForSubjectRenderMode()`
(deterministic Nano Banana 2 compiler).

- Fact page "Runtime Compiled Prompt Preview" → `POST /admin/image-prompt/preview`
  (adminImagePrompt.ts) → `assembleImagePromptForPreview()`.
- Production meme generator → imagePromptJobs.ts → calls the two underlying
  functions directly (uses the REAL user identity via `resolveAttemptIdentity`,
  not the test identity).

(A third, the i2i/t2i engine workbench on the Engines page, was removed with
that page on 2026-11-14: decisions.md, *AI call settings live in code*. The
read-only `/admin/ai` page now shows each step's settings.)

## Rule: the preview uses the canonical test identity
It renders fact templates ({NAME}/{SUBJ}/…) down to the constants
`PREVIEW_SUBJECT_NAME` / `PREVIEW_SUBJECT_PRONOUNS` (exported from
`lib/imagePrompt/preview.ts`). Never re-hardcode a per-route name.

**Why:** two previews once diverged ("David" vs "David Franklin"), so the
planner saw different rendered fact text and produced visibly different prompts
for the same fact.

## Divergence is sampling, NOT caching
The planner is a reasoning model (`gpt-5.5` at high effort) and takes no
temperature (the parameter audit, 2026-11-14), so two separate live calls
produce differently-worded prose ("baby" vs "newborn baby gripping the wheel")
even with byte-identical input. The preview does NOT cache and does NOT read the
production `aiScenePrompts` blob (that cache serves only the AI background
backfill). So if a preview and a production prompt differ: first suspect input
drift (identity/style/aspect), then sampling — not a cache.

**How to apply:** to make outputs byte-identical a surface must reuse the
other's generated result — ask the user before doing that.
