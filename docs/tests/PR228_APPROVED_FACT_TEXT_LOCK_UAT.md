# PR228 — Approved Fact Text Lock — UAT (in-app acceptance)

> Click-through acceptance test for David. The intent: **an approved fact's text
> can't be changed casually** — it takes a deliberate, warned, recorded action —
> while a brand-new fact still in first-time review stays freely editable.

All steps are in the **Admin → Facts** page (and one in **Moderation**). You need
an admin login.

## Part A — Editing an APPROVED (live) fact's text is gated (~4 min)

1. Open **Admin → Facts**, pick any **live** fact, and click into it.
2. In the **Text** box, change the wording. Click **Save Changes**.
   **Expect:** a red-bordered **"Change approved fact text"** modal appears — NOT a
   silent save, and NOT a generic "Save failed" error.
3. Read the modal. It shows the **old wording (struck through) → new wording**, and a
   consequence list. **Expect** the list to mention: existing memes keep the old wording,
   the fact's taxonomy will be marked stale for review, and (if this fact has variants)
   that its variants will be marked stale.
4. Try to confirm without doing anything — the **Change the text** button is disabled.
   - Type something *other* than the exact phrase → still disabled.
   - Type the exact phrase `CHANGE APPROVED FACT TEXT` but leave the reason blank (or under
     10 characters) → still disabled.
   - Type the exact phrase **and** a real reason → the button enables.
5. Click **Change the text**.
   **Expect:** the modal closes, a green "Saved" confirmation shows, and the fact now
   displays the new wording. If it had variants, the message says how many were marked
   stale.
6. Scroll down to **Approved text edit history** and expand it.
   **Expect:** your edit is listed — who, when, old → new wording, and the reason you typed.

## Part B — A non-text edit is NOT gated (~1 min)

1. On a live fact, change only a non-text field (e.g. toggle Active, or edit the use-case),
   leaving the **Text** unchanged. Save.
   **Expect:** it saves immediately with **no** warning modal. The gate is only for a real
   text change.

## Part C — Cancelling leaves your work intact (~1 min)

1. Edit a live fact's text, click **Save Changes**, and when the modal appears click
   **Cancel**.
   **Expect:** the modal closes, nothing is saved, and your edited text is **still in the
   box** (your draft isn't thrown away). You can edit more or Discard.

## Part D — A brand-new fact in first-time review edits freely (~3 min)

> This is the "staging" case — a submission you provisionally accepted that has **not**
> been production-approved yet.

1. In **Moderation**, provisionally accept a fresh submission so it enters prep, and let it
   reach the **Visual Concept** step.
2. Go to **Admin → Facts**, find that (inactive) staging fact, and edit its **Text**. Save.
   **Expect:** **no** dire-warning modal — it just saves. The message notes that prep is
   restarting.
3. Back in **Moderation**, that review should be back at the **prep** stage, re-running
   enrichment and images. **Expect** you cannot production-approve it until fresh prep +
   Visual Concept complete.

## Part E — Parent with a variant mid-review is protected (~2 min)

1. Find a live **root** fact that has a **variant currently in review** (or send a variant
   back to review).
2. Try to edit the **root's** text and confirm.
   **Expect:** instead of saving, a message says the parent can't be re-worded while a
   variant is mid-review, naming the blocking variant. Resolve/finish the variant, then the
   root edit works.

## Regression smoke (nothing else broke)

| Check | Expect |
|---|---|
| Provisionally accept a new submission | Prep starts as before (enrichment + images) |
| Production-approve a finished fact | Approves and goes live as before |
| Send a live fact back to review (refresh) | Works as before |
| Edit a fact's enrichment/taxonomy (not text) | Saves as before, no text modal |

## Known non-bugs (don't report these)

- **Existing memes keep the old wording** after a text edit — that's expected; their caption
  is baked into the rendered image. The warning says so.
- After a confirmed edit, the fact shows as **stale for reprocess** in Taxonomy Health —
  that's intended; send it back to review to refresh its taxonomy against the new wording.
- A first-time staging text edit **restarting prep** (re-running enrichment/images) is
  intended, not a regression.
- The `*_TEST_RUN.md` sibling doc may be deleted after Replit runs it — that's expected;
  this UAT is the durable half.

## Bug report template

```
Where (which part A–E + fact id):
What I did:
What I expected:
What happened instead (+ any modal text / error):
```
