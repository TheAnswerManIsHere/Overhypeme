# PR #688 — A refused generation says why in plain words — UAT

**Workstream:** #686

When someone generates an AI image with a style an admin has turned off, the
server refuses, which is right. Until this PR the screen then showed the bare
code `style_invalid` in red. Now it says the style isn't available and asks
them to pick another, and no other internal code can reach that message
either. Readable messages the server already writes, such as the storage-limit
notice, still come through word for word.

## Setup

- [claude] Confirm the Repl is synced to the merge commit.
- [david] Signed in as an admin, open Admin → Look styles and deactivate one active style. Note which one.
- [restore] Re-activate the style deactivated in Setup.

## Steps

### 1. The photo flow shows a readable refusal for a disabled style

**Do:** In the reference-photo confirm dialog, generate with a style the server refuses as `style_invalid`.

**Expect:** The dialog shows a sentence saying the style isn't available, never the text `style_invalid`, and no render is polled because nothing was queued.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/SourceImageConfirmModal.styleInvalid.test.tsx`

### 2. No other internal code reaches the screen

**Do:** Feed the message helper every code the generate routes return, such as `generate_v2_failed`, `fact_template_unresolved` and `BUDGET_EXCEEDED`.

**Expect:** Each becomes the generic "Generation failed" style fallback, and `style_invalid` becomes its own "style isn't available" sentence.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/lib/generation-errors.test.ts`

### 3. Both generation screens route every server error through the helper

**Do:** Scan the confirm dialog and the AI background picker for a server error string printed directly.

**Expect:** None is found, in the generate, render-status and delete paths alike.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/generationErrorText.guard.test.ts`

### 4. The message reads right on the real screen

**Do:** In the meme builder, open the AI background picker, choose the style you deactivated in Setup, and generate without uploading a photo.

**Expect:** A short red message says that style isn't available and to pick a different one. It reads naturally to you, and no code with underscores appears anywhere.

**Lane:** human

## Regression

### R1. Readable server messages still come through unchanged

**Do:** Feed the message helper a server sentence such as the image storage-limit notice.

**Expect:** The sentence is returned word for word.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/lib/generation-errors.test.ts`

## Not bugs

- The server still answers `400 style_invalid`; only what the user sees changed.
- Whether the generate route enqueues nothing for a disabled style is owned by #631 increment 7b, not this PR.
- Other screens that print a server error, such as the Library and Profile deletes, were not part of this fix.
