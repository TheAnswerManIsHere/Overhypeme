# PR #228 — Approved Fact Text Lock — UAT

The intent: an approved fact's text can't be changed casually — it takes a
deliberate, warned, recorded action — while a brand-new fact still in
first-time review stays freely editable.

## Setup

- [david] Sign in as admin. Checks are in **Admin → Facts**, with one in
  **Moderation**.

## Steps

### 1. Editing an approved fact's text triggers a warning modal

**Do:** Open Admin → Facts, click into any live fact, change the wording in
the Text box, and click Save Changes.

**Expect:** a red-bordered "Change approved fact text" modal appears — not
a silent save, and not a generic "Save failed" error.

### 2. The modal names the consequences

**Do:** Read the modal that appeared in step 1.

**Expect:** it shows the old wording (struck through) → new wording, and a
consequence list mentioning: existing memes keep the old wording, the
fact's taxonomy will be marked stale for review, and (if this fact has
variants) that its variants will be marked stale.

### 3. A wrong confirmation phrase leaves the button disabled

**Do:** In the modal, type something other than the exact phrase `CHANGE
APPROVED FACT TEXT` into the confirmation field.

**Expect:** the "Change the text" button stays disabled.

### 4. A short or missing reason leaves the button disabled

**Do:** Type the exact phrase `CHANGE APPROVED FACT TEXT`, but leave the
reason blank (or under 10 characters).

**Expect:** the "Change the text" button stays disabled.

### 5. The exact phrase plus a real reason enables the button

**Do:** Type the exact phrase `CHANGE APPROVED FACT TEXT` and a real reason
(10 or more characters).

**Expect:** the "Change the text" button enables.

### 6. Confirming the change saves it and shows the new wording

**Do:** Click "Change the text".

**Expect:** the modal closes, a green "Saved" confirmation shows, and the
fact now displays the new wording. If it had variants, the message says how
many were marked stale.

### 7. The edit is recorded in history

**Do:** Scroll down to "Approved text edit history" on the fact and expand
it.

**Expect:** your edit is listed — who, when, old → new wording, and the
reason you typed.

### 8. A non-text edit is not gated

**Do:** On a live fact, change only a non-text field (e.g. toggle Active,
or edit the use-case), leaving the Text unchanged, and Save.

**Expect:** it saves immediately with no warning modal — the gate is only
for a real text change.

### 9. Cancelling the modal preserves your draft

**Do:** Edit a live fact's text, click Save Changes, and when the modal
appears click Cancel.

**Expect:** the modal closes, nothing is saved, and your edited text is
still in the box — you can edit more or discard it.

### 10. A brand-new (staging) fact's text edits freely

**Do:** In Moderation, provisionally accept a fresh submission so it enters
prep and reaches the Visual Concept step; then go to Admin → Facts, find
that inactive staging fact, edit its Text, and Save.

**Expect:** no dire-warning modal — it just saves, and the message notes
that prep is restarting.

### 11. A restarted staging fact re-enters prep and blocks approval

**Do:** Back in Moderation, check that review's stage after the text edit
in step 10, and try to production-approve it right away.

**Expect:** the review is back at the prep stage, re-running enrichment and
images; you cannot production-approve it until fresh prep + Visual Concept
complete.

### 12. A live root fact can't be re-worded while a variant is mid-review

**Do:** Find a live root fact that has a variant currently in review (or
send a variant back to review), then try to edit the root's text and
confirm.

**Expect:** instead of saving, a message says the parent can't be
re-worded while a variant is mid-review, naming the blocking variant.

### 13. Resolving the blocking variant unblocks the root edit

**Do:** Resolve or finish the blocking variant from step 12, then repeat
the root fact's text edit.

**Expect:** the root edit works normally.

## Regression

### R1. Provisionally accepting a new submission still starts prep

**Do:** Provisionally accept a new submission.

**Expect:** prep starts as before (enrichment + images).

### R2. Production-approving a finished fact still works

**Do:** Production-approve a finished fact.

**Expect:** it approves and goes live as before.

### R3. Sending a live fact back to review still works

**Do:** Send a live fact back to review (refresh).

**Expect:** it works as before.

### R4. Editing a fact's enrichment/taxonomy (not text) still saves plainly

**Do:** Edit a fact's enrichment or taxonomy without touching the Text
field, and Save.

**Expect:** it saves as before, with no text modal.

## Not bugs

- **Existing memes keep the old wording** after a text edit — that's
  expected; their caption is baked into the rendered image. The warning
  says so.
- After a confirmed edit, the fact shows as **stale for reprocess** in
  Taxonomy Health — that's intended; send it back to review to refresh its
  taxonomy against the new wording.
- A first-time staging text edit **restarting prep** (re-running
  enrichment/images) is intended, not a regression.
