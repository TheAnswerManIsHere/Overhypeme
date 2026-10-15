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
refresh candidate under review. Steps 1–3 are checked by automated tests on
every PR. **Step 4 is the one for you:** whether the message reads well on
both screens, since the Facts page shows it in a narrow header bar and the
message can be two or three sentences long.

## Setup

- [claude] Confirm the Repl is synced to the merge commit of this PR.
- [claude] Post in chat a ready-to-paste Visual Concept that is over the budget (about 2,000 characters, full of `{NAME}` tokens), so you don't have to compose one.
- [restore] Nothing to restore on the server: a refused save writes nothing. Step 4 ends by discarding the unsaved edit on each screen, which clears it from your browser too.

## Steps

### 1. An over-budget Concept on a fact's enrichment shows the reasons, not the code

**Do:** Save a Visual Concept that is over the budget on a fact's enrichment.

**Expect:** The save is refused and the error reads the server's sentences: the raw length against its maximum, "expands to up to N characters once names/pronouns are filled in; the maximum is 2000", and the combined-guidance total when that is over too. The code `visual_strategy_override_over_budget` does not appear. The edit stays in the draft so it can be shortened.

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

### 4. The refusal reads well on both screens

**Do:** On the moderation page, open any item at the Visual Concept step, paste the over-budget Concept from chat into the Visual Concept, and click Save. Read the red message, then click Discard. Then on the Facts page, open any fact's Visual Taxonomy Enrichment, paste the same Concept, save, read the red message in the header bar, and click "Discard changes".

**Expect:** On both screens the message is readable and tells you what to shorten and by roughly how much. It is not cut off or crammed so tightly in the Facts header bar that you can't take it in. Nothing saves on either screen.

**Lane:** human

## Regression

### R1. A Concept within budget still saves

**Do:** Trim an over-budget Concept back under the budget and save it.

**Expect:** It saves normally.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/useFactEnrichmentEditing.test.tsx:moderation commit pins suggestedHashtags to the server value (anti-smuggle guard)` `artifacts/api-server/src/__tests__/promptBudget.test.ts:accepts an empty / small override` `artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts:accepts a PATCH that leaves tracked fields unchanged (visual override / hashtags)`

## Not bugs

- **A long message on the Facts page.** When a Concept breaks two or three limits at once, all of their sentences are shown together, so you can fix everything in one pass. If that reads badly in step 4, say so: showing only the first sentence is a one-line change.
- **`visual_concept_required` still shows as a bare code.** That is a different refusal, for a missing Concept, and the server sends no sentence behind it. It is outside this fix and is recorded on #631.
