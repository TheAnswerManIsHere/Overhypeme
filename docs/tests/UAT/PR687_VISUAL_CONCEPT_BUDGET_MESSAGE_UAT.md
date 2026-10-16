# PR #687 — A too-long Visual Concept tells you why it was refused — UAT

**Workstream:** #685

When a moderator saved a Visual Concept that was over the image prompt's
budget, the save was refused correctly, but the red error showed only the
code `visual_strategy_override_over_budget`. The server was already sending
the reason, with the numbers ("expands to up to N characters once
names/pronouns are filled in; the maximum is 2000"). The editor just never
read it. Now it does, for every limit the Concept breaks at once.

The fix sits in the editor shared by the moderation page and the Facts page,
and it covers both ways a Concept is saved: a fact's own enrichment and a
refresh candidate under review. Steps 1–4 and 6 are checked by automated
tests on every PR, including the message's exact text on the moderation
page and its box on the Facts page. **Step 5 is yours:** whether the message
reads well. The message can be two or three sentences long, so on the Facts
page it now has its own red box under the enrichment heading instead of the
narrow status slot beside it.

## Setup

- [claude] Confirm the Repl is synced to the merge commit of this PR.
- [claude] Confirm, without seeding anything, that a moderation item is waiting at the Visual Concept step, and post its ID. If none is, say so and give David the admin steps to get one there.
- [claude] Post in chat a ready-to-paste Visual Concept of exactly 1,500 characters, dense with `{NAME}` tokens: it fits the box, but once names are filled in it expands past the 2,000-character budget.
- [restore] Nothing to restore on the server: a refused save writes nothing. The refused edits stay in your browser as unsaved drafts until you discard them, below.
- [restore] David — moderation page: reload the page, reopen the item you used in step 5 at the Visual Concept step, and click Discard on the Save/Discard bar that has returned (the page hides it behind the error until a reload, #691). Done when reopening that item shows its original saved Concept and no unsaved-changes bar.

## Steps

### 1. An over-budget Concept on a fact's enrichment shows the reasons, not the code

**Do:** Save a Visual Concept that is over the budget on a fact's enrichment.

**Expect:** The save is refused and the error reads the server's sentences: "expands to up to N characters once names/pronouns are filled in; the maximum is 2000", and the combined-guidance total when that is over too. The code `visual_strategy_override_over_budget` does not appear. The edit stays in the draft so it can be shortened.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx:REGRESSION #685: an over-budget save shows the server's budget sentences, not the error code`

### 2. The same on a refresh candidate under review

**Do:** Save an over-budget Visual Concept on a refresh candidate in the moderation queue.

**Expect:** The same refusal sentence, through the review-candidate save route, and no error code.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx:REGRESSION #685 (candidate route): an over-budget candidate save shows the budget sentence`

### 3. Every other refused save still shows what it showed before

**Do:** Trigger a refused save whose response carries no budget details, for example a malformed enrichment.

**Expect:** The error shows the server's own text exactly as before this change, such as "Invalid enrichment: …". A response whose details carry no usable sentence also falls back to that text.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx:a refused save with no details still shows the server's error text` `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx:details without a usable message fall back to the server's error text`

### 4. The refusal on the moderation page reads the server's sentence

**Do:** On the moderation page, open an item at the Visual Concept step, replace its Visual Concept with a 1,500-character one dense with `{NAME}` tokens (the counter reads 1500/1500), and click Save.

**Expect:** The message reads "The Visual Concept expands to up to N characters once names/pronouns are filled in; the maximum is 2000. Shorten it or use fewer personalization tokens." The code `visual_strategy_override_over_budget` does not appear. Nothing saves: the server refuses the save, and the edit stays in the box.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminScreens.spec.ts:an over-budget Visual Concept saved on the moderation page shows the budget sentence and is refused`

### 5. The refusal reads well on the moderation page

**Do:** On the moderation page, open any item at the Visual Concept step and note which item it is. Replace its Visual Concept with the one from chat posted in Setup (the counter reads 1500/1500), click Save, and read the red message. The Save/Discard bar disappearing behind the message is expected: that is #691, not a failure of this step.

**Expect:** It is readable and tells you what to shorten and by roughly how much.

**Lane:** human

### 6. The refusal on the Facts page sits in a wrapped box under the heading

**Do:** On the Facts page, open a fact's Visual Taxonomy Enrichment, replace its Visual Concept with a 1,500-character one dense with `{NAME}` tokens, and click Save enrichment.

**Expect:** A red box under the enrichment heading reads "The Visual Concept expands to up to N characters once names/pronouns are filled in; the maximum is 2000. Shorten it or use fewer personalization tokens." It wraps inside the panel, nothing runs past the panel edge, and the heading and "Discard changes" stay on their own line; the status beside the heading reads "Save refused". Nothing saves.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminScreens.spec.ts:an over-budget Visual Concept saved on the Facts page shows a wrapped refusal box under the heading`

## Regression

### R1. Trimming a refused Concept lets it save

**Do:** After an over-budget save is refused, shorten the Concept in the retained draft and save again through the same Save action.

**Expect:** The second save succeeds: the red message clears, the draft has no unsaved changes, and the trimmed Concept is what was sent.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx:REGRESSION #685: after a budget refusal, trimming the Concept and saving again succeeds` `artifacts/api-server/src/__tests__/promptBudget.test.ts:accepts an empty / small override`

## Not bugs

- **Several sentences in the red box.** When a Concept breaks two or three limits at once, all of their sentences are shown together, so you can fix everything in one pass.
- **A Concept pushed past 1,500 characters by name chips or by tokenizing shows "… at most 1500 character(s)".** The box stops typing and pasting at 1,500, but inserted name chips and the tokenizer can lengthen the text past it. The server's schema check then refuses it before the budget check, with its own wording and the number. That message predates this fix.
- **On the moderation page, the Save/Discard bar disappears after a refused save.** That predates this fix and is tracked as #691. Saving still works through "Save enrichment" in Advanced Options, and Discard comes back after a reload.
- **`visual_concept_required` still shows as a bare code.** That is a different refusal, for a missing Concept, and the server sends no sentence behind it. It is outside this fix and is recorded on #631.
