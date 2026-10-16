# PR #223 — Render identity/style reproducibility — UAT

When you click **generate**, the image engine now gets a **frozen** copy of
*who* the render is about and *which style* it uses — captured at the moment
you click, not re-looked-up minutes later while the render sits in the
queue. Editing your profile name or a style **after** you click can no
longer quietly change a render already in flight; your *next* render picks
up the new values. (Before this PR, an edit in that window could produce a
render whose text and whose identity disagreed.) As part of the same
change, the name fed to the image model is shortened to a **first name** — a
long display name no longer gets stuffed into the image prompt — while your
**caption still shows your full name**, untouched.

Most of this is invisible correctness: a normal render looks the same. What
you can actually see is (1) generation still working fine with a long
display name, with the caption unaffected, and (2) a clean error if you
pick a disabled style instead of a silent plain render.

## Setup

- [david] Sign in with a **legendary** account (AI meme generation is
  legendary-gated).
- [claude] Confirm a fact exists that supports generating a meme both with a
  reference photo upload and without one.
- [david] Confirm you have admin access, for the disabled-style check.

## Steps

### 1. Generate with a reference photo

**Do:** The real-render capture run (`acceptance-run.ts --mode capture`, on the
Repl under the $2.00 cap), signed in as the paid test account, uploads the
reference face photo `artifacts/api-server/src/assets/test-face.jpg`,
generates an AI image for a fixture fact through the meme builder's
reference-photo path (`POST /api/memes/pulid-jobs`), and captures the
reference and the full-size result.

**Expect:** the render completes; the result shows the same person as the
reference photo, recognisably the same face and not a stranger or a garbled
face, placed in a scene that fits the fact; and the finished meme's caption
reads the account's full display name exactly as stored (the caption clause
is the unit test's, cited below).

**Lane:** capture

**Check:** `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:personalizes the sentence AND both halves with the creator's identity`; `artifacts/api-server/src/testing/acceptance/captureJourneys.ts:pr223-s1-result`

**Deferred:** #631 — 7b — a legendary reference-photo generate completing is undriven, journey 6 sends no photo — acceptance journey 6; #631 — 7b — the saved meme's served image draws the creator's full display name exactly as stored, equal to the hand-typed twin, the served-caption assertion PR398 already owes — acceptance journey 4

### 2. Generate without a reference photo

**Do:** Generate a meme for the same fact, this time with no reference photo
uploaded (the text-to-image path).

**Expect:** the render completes as before, and the caption reads your full
display name exactly as stored.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 6: the paid user's no-photo generate polls to image_ready, the generated image decodes and is saved as a private meme `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:personalizes the sentence AND both halves with the creator's identity`

**Deferred:** #631 — 7b — the saved meme's served image draws the creator's full display name exactly as stored, equal to the hand-typed twin, the served-caption assertion PR398 already owes — acceptance journey 4

### 3. A long display name doesn't leak into the caption

**Do:** Set your profile display name to something long and multi-word
(e.g. "David Franklin The Third"), then generate a meme.

**Expect:** the render completes normally and the caption shows the full
name you set, exactly ("David Franklin The Third"). The caption is
independent of what the image model receives either way, so this alone
does not prove the split — step 3b is what actually checks it.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 6: the paid user's generate reaches image_ready and the saved meme decodes `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:personalizes the sentence AND both halves with the creator's identity` `artifacts/api-server/src/__tests__/promptIdentity.test.ts:reduces a multi-word displayName to only its first token, not a truncated fragment of the whole string`

**Deferred:** #631 — 7b — after the paid account's display name is set to David Franklin The Third, its generate reaching image_ready and the saved meme's served image drawing that name whole — acceptance journey 6

### 4. The compiled prompt itself only carries the first name

**Do:** As admin, open the fact you just generated a meme for in
Admin → Facts, and expand its **Runtime Compiled Prompt Preview**.

**Expect:** the identity/reference section of the compiled prompt names
only your first name ("David"), not the full display name — this is the
actual oracle for the split; step 3's caption is a red herring for it.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/prepareAttemptInputs.test.ts:renders fact text from the SAME reduced identity the snapshot carries (user path)` `artifacts/api-server/src/__tests__/promptIdentity.test.ts:prefers firstName when present`

**Deferred:** #631 — 7b — the compiled prompt from the preview route naming only the first name of a multi-word previewName is unasserted, only the reducer and the prepare helper are — `artifacts/api-server/src/__tests__/imagePromptPreview.test.ts`

### 5. A disabled style is rejected, not silently dropped

**Do:** As admin, deactivate a look-style, then try to generate a meme
selecting that style.

**Expect:** a clear "style unavailable" rejection — not enqueued — instead
of the old behavior where it quietly rendered with no style at all.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/prepareAttemptInputs.test.ts:returns a typed style_invalid error for an inactive style (never silently 'no style')`

**Deferred:** #631 — 7b — the generate route, as the legendary account, answering 400 style_invalid with reason inactive and inserting no attempt for a deactivated styleId — `artifacts/api-server/src/__tests__/memesGenerateGeneric.test.ts`; #631 — 7b — the generate route's refusal of a deactivated style carrying a style-unavailable message the builder shows, not only the code style_invalid, with amendment 3's bugfix — `artifacts/api-server/src/__tests__/memesGenerateGeneric.test.ts`

### 6. Re-enabling the style lets the same generate succeed

**Do:** Re-enable the style you deactivated in step 5, then repeat the same
generate.

**Expect:** it succeeds and the style is applied as normal.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/styleResolution.test.ts:resolves a valid active style, t2i uses promptSuffix`

**Deferred:** #631 — 7b — the generate route, as the legendary account, answering 202 for a re-enabled styleId and freezing a selected-style snapshot with that style's prompt on the attempt — `artifacts/api-server/src/__tests__/memesGenerateGeneric.test.ts`; #631 — 7b — the image-prompt job compiling an attempt whose frozen style snapshot is selected into a RENDER STYLE line carrying that snapshot's prompt, resolveStylePrompt is untested — `artifacts/api-server/src/__tests__/imagePromptJobs.test.ts`

## Regression

### R1. A valid selected style still applies

**Do:** Generate a meme selecting an active, valid look-style.

**Expect:** the style is applied as before.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/prepareAttemptInputs.test.ts:renders fact text from the SAME reduced identity the snapshot carries (user path)`

**Deferred:** #631 — 7b — the generate route, as the legendary account, answering 202 for an active styleId and freezing a selected-style snapshot with that style's prompt on the attempt — `artifacts/api-server/src/__tests__/memesGenerateGeneric.test.ts`; #631 — 7b — the image-prompt job compiling an attempt whose frozen style snapshot is selected into a RENDER STYLE line carrying that snapshot's prompt, resolveStylePrompt is untested — `artifacts/api-server/src/__tests__/imagePromptJobs.test.ts`

### R2. An anonymous / no-profile render still falls back

**Do:** Generate a meme without a signed-in profile (or from an account with
no display name set).

**Expect:** it falls back to the canonical test identity and still renders.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/prepareAttemptInputs.test.ts:falls back to canonical identity when there is no user`

**Deferred:** #631 — 7b — a generate by an account with no display name enqueuing with the canonical fallback snapshot is unasserted, only the prepare helper is — `artifacts/api-server/src/__tests__/memesGenerateGeneric.test.ts`; #631 — 7b — the image-prompt job for an attempt carrying the canonical fallback identity snapshot compiling with the canonical name and enqueuing image_generation — `artifacts/api-server/src/__tests__/imagePromptJobs.test.ts`

### R3. Older renders still display correctly

**Do:** Open an older, already-completed render (or re-poll one from before
this PR).

**Expect:** it still displays correctly — legacy attempts are untouched.

**Lane:** ci

**Deferred:** #631 — 7b — a completed attempt with no frozen identity or style snapshot, polled through GET /memes/ai/renders/:renderJobId, answering image_ready with its image path — `artifacts/api-server/src/__tests__/adminReviewRenderTools.test.ts`

## Not bugs

- **Moderation preview / eval renders still show the full sample name.** The
  admin Runtime Compiled Prompt preview and the moderation/eval render paths
  use fixed sample subjects ("David Franklin" and gender variants) and are
  intentionally left as-is — they were already reproducible and their short
  fixture names don't need shortening. This is not the user-render path.
- **No new budget/length rejection at render time.** Enforcing a hard prompt
  budget is a later change; this PR only bounds the identity, it doesn't
  reject over-budget prompts yet.
