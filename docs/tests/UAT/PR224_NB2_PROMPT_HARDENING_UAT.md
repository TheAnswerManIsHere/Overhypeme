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

### 1. An over-long Visual Concept cannot be entered

**Do:** Paste a Visual Concept longer than 1,500 characters into the Visual
Concept box.

**Expect:** the box stops accepting text at 1,500 characters and its counter
reads 1500/1500, so an over-long Concept can never be saved and quietly break
the render (David, 2026-10-15: rewritten from a raw-length rejection the
editor's own cap prevents a moderator from reaching).

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/promptBudget.test.ts:rejects a Concept over the raw cap`

**Deferred:** #631 — 7b — the Visual Concept box's textarea carrying maxLength 1500, so text pasted past 1,500 characters is cut there and the counter reads 1500/1500 — `artifacts/overhype-me/src/components/admin/VisualConceptCard.test.tsx`

### 2. A Visual Concept that expands over budget via tokens is rejected

**Do:** Paste a Visual Concept stuffed with many `{NAME}` tokens (short raw
length, but large once names are filled in) and click Save.

**Expect:** a specific rejection saying it "expands to up to N characters
once names are filled in."

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/promptBudget.test.ts:rejects a Concept whose WORST-CASE rendered length blows the cap even under the raw cap` `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx:REGRESSION #685: an over-budget save shows the server's budget sentences, not the error code`

**Deferred:** #631 — 7b — the fact enrichment PATCH answering 400 with a core_scene_rendered_too_long detail for a Concept of 110 {NAME} tokens under the raw cap — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`

### 3. Trimming an over-budget Concept lets it save

**Do:** Trim either over-budget Concept from step 1 or step 2 back under
budget and Save again.

**Expect:** it saves normally.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/promptBudget.test.ts:accepts an empty / small override` `artifacts/api-server/src/__tests__/promptBudget.test.ts:the moderator Concept rendered reserve is at least its raw cap (a token-free Concept must fit)` `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts:accepts a PATCH that leaves tracked fields unchanged (visual override / hashtags)` `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx:REGRESSION #685: after a budget refusal, trimming the Concept and saving again succeeds`

**Deferred:** #631 — 7b — the fact enrichment PATCH accepting with 200 and storing a token-free Concept just under the cap, about 1,490 characters — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`

### 4. Excessive aggregate visual guidance is rejected

**Do:** Add role bindings, required details, composition notes, and
additions together until the combined total is very large, then Save.

**Expect:** a specific rejection reporting the *combined* guidance is over
budget. Individual normal entries are fine on their own — it's the
aggregate that's capped.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/promptBudget.test.ts:rejects when the (compiler-measured) additions emission exceeds the pool` `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx:REGRESSION #685: an over-budget save shows the server's budget sentences, not the error code`; `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`:canonicalizes {name}/{Name} tokens and rejects unknown tokens in the override — a single normal required detail saves with 200

**Deferred:** #631 — 7b — the fact enrichment PATCH answering 400 with a moderator_additions_rendered_too_long detail for many role bindings, required details, composition notes and additions together — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`; #631 — 7b — the combined-guidance rejection for an actual mix of role bindings, required details, composition notes and additions measured through the compiler is unasserted, the cited checks inject the emitted length — `artifacts/api-server/src/__tests__/promptBudget.test.ts`

### 5. A deterministically-broken render fails fast with a specific reason

**Do:** Trigger a render that can't succeed for a fixed reason — corrupt
frozen data, a leaked personalization token, or content that can't fit the
prompt.

**Expect:** it fails fast with a specific reason instead of retrying
forever or shipping a degraded image.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/asyncJobs.test.ts:terminalFailure marks the row failed on the FIRST attempt, ignoring maxAttempts (§12)` `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:signals required_budget_overflow instead of silently truncating required content (§10.5)`

**Deferred:** #631 — 7b — the image-prompt job turning a corrupt frozen enrichment, a leaked {NAME} token or a required-budget overflow into a first-attempt terminal failure with its specific code and no image_generation job — `artifacts/api-server/src/__tests__/imagePromptJobs.test.ts`

### 6. Built-in style descriptions are shorter but look the same

**Do:** Open the style picker and read the built-in style descriptions,
then render using one of them (e.g. cinematic or anime).

**Expect:** the copy is shorter and cleaner, but the rendered style look is
unchanged from before.

**Lane:** human

**Deferred:** #628 — Phase 8 (Engine evaluation) — built-in style presets are re-reviewed and tuned against the winning engine, so an unchanged-look comparison belongs there

## Regression

### R1. A normal Visual Concept still saves fine

**Do:** Enter a typical Visual Concept (a few sentences) with normal visual
guidance (a handful of role bindings / required details) on a fact, and
Save.

**Expect:** it saves with no change from before.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/promptBudget.test.ts:accepts an empty / small override`

**Deferred:** #631 — 7b — a typical Concept with several role bindings and required details saving through the PATCH route is unasserted, the cited check validates an empty override — `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts`

### R2. A valid fact still renders end-to-end

**Do:** Render a valid fact, any style.

**Expect:** it renders as before.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journeys 3 and 6: a valid fact's review renders reach done with decodable images, and the paid user's render reaches image_ready

**Deferred:** #631 — 7b — a paid generate with a selected look style polling to image_ready with a decodable image, every journey renders with no style selected — acceptance journey 6

## Not bugs

- **No in-editor character counter yet.** The budget is enforced on Save
  (with a clear message); a live "N / max" counter in the editor is a
  follow-up.
- **The §21 numbers** (the exact Concept / additions size limits) are set
  from a measurement and were approved before merge (this PR raised the
  engine ceiling from 4000 to 6000 chars; it is **6900** today, raised
  again since to fund the dedicated bubble pool — NB2's real context window
  is ~131K tokens, so none of these were capacity limits, just editorial
  discipline). If a limit
  feels too tight or loose in practice, it's a one-line tuning change.
- **Look-style copy is not admin-editable** (it ships via migration), so
  there's no style-copy save form to test.
- **A transient render hiccup (e.g. a model timeout) still retries
  automatically** rather than being treated as a permanent failure. This
  isn't independently forceable in this UAT — if you happen to see a
  render retry after a blip, that's expected, not the new fast-fail
  behavior kicking in.
