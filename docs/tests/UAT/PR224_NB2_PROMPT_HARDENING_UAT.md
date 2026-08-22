# PR #224 — NB2 prompt hardening — UAT

The image-render pipeline now **fails loudly and specifically instead of
quietly degrading**, and moderator visual editing has a **real budget** so
an over-long Visual Concept can't silently push the safety guardrails out
of the prompt. Plus a cosmetic cleanup: the built-in style descriptions are
trimmed to tighter, cleaner copy.

Before this PR, if a prompt got too long the compiler chopped the end
off — and the safety guardrails (the "don't bake in caption text / keep
violence non-graphic" constraints) live at the end, so they were the first
thing silently dropped. Now the compiler never drops them: either the
content fits, or the render fails loudly. Combined with the save-time
budget, a moderator can't accidentally author a Concept that pushes the
guardrails out.

## Setup

- [david] Sign in as admin — every check below is in the admin console
  (the Visual Concept editor, a render trigger, and the style picker).
- [claude] Confirm a fact exists you can edit the Visual Concept for, and a
  review candidate is available in the enrichment queue (Visual Concept
  editing applies to both).

## Steps

### 1. An over-long Visual Concept is rejected on raw length

**Do:** Paste a Visual Concept longer than ~1500 characters and click Save.

**Expect:** a specific rejection explaining it's over the prompt budget by
raw length, instead of it saving and quietly breaking the render.

### 2. A Visual Concept that expands over budget via tokens is rejected

**Do:** Paste a Visual Concept stuffed with many `{NAME}` tokens (short raw
length, but large once names are filled in) and click Save.

**Expect:** a specific rejection saying it "expands to up to N characters
once names are filled in."

### 3. Trimming an over-budget Concept lets it save

**Do:** Trim either over-budget Concept from step 1 or step 2 back under
budget and Save again.

**Expect:** it saves normally.

### 4. Excessive aggregate visual guidance is rejected

**Do:** Add role bindings, required details, composition notes, and
additions together until the combined total is very large, then Save.

**Expect:** a specific rejection reporting the *combined* guidance is over
budget. Individual normal entries are fine on their own — it's the
aggregate that's capped.

### 5. A deterministically-broken render fails fast with a specific reason

**Do:** Trigger a render that can't succeed for a fixed reason — corrupt
frozen data, a leaked personalization token, or content that can't fit the
prompt.

**Expect:** it fails fast with a specific reason instead of retrying
forever or shipping a degraded image.

### 6. Built-in style descriptions are shorter but look the same

**Do:** Open the style picker and read the built-in style descriptions,
then render using one of them (e.g. cinematic or anime).

**Expect:** the copy is shorter and cleaner, but the rendered style look is
unchanged from before.

## Regression

### R1. A normal Visual Concept still saves fine

**Do:** Enter a typical Visual Concept (a few sentences) with normal visual
guidance (a handful of role bindings / required details) on a fact, and
Save.

**Expect:** it saves with no change from before.

### R2. A valid fact still renders end-to-end

**Do:** Render a valid fact, any style.

**Expect:** it renders as before.

## Not bugs

- **No in-editor character counter yet.** The budget is enforced on Save
  (with a clear message); a live "N / max" counter in the editor is a
  follow-up.
- **The §21 numbers** (the exact Concept / additions size limits) are set
  from a measurement and were approved before merge (engine ceiling raised
  to 6000 chars — NB2's real context window is ~131K tokens, so the
  original 4000 was editorial discipline, not a capacity limit). If a limit
  feels too tight or loose in practice, it's a one-line tuning change.
- **Look-style copy is not admin-editable** (it ships via migration), so
  there's no style-copy save form to test.
- **A transient render hiccup (e.g. a model timeout) still retries
  automatically** rather than being treated as a permanent failure. This
  isn't independently forceable in this UAT — if you happen to see a
  render retry after a blip, that's expected, not the new fast-fail
  behavior kicking in.
