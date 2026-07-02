# PR155 — Moderation override tracking (lockstep with Edit Fact) — UAT (David)

In-app click-through. Engineering checklist:
`PR155_MODERATION_OVERRIDE_LOCKSTEP_TEST_RUN.md`.

## What changed, in one breath

The moderation screen now tracks enrichment changes **exactly like the Edit
Fact screen**: change any classification field and it saves **instantly** as
an override — "overridden" chip, the AI's original value, "Revert to AI",
"AI changed — review" — and the Visual Strategy Override auto-drafts to your
browser so closing the modal never loses work. This is PR 3 of the moderation
redesign: the two screens now literally run the same code.

## Why it matters

Before, moderation edits lived only in the modal's memory, saved as one big
blob, and — worse — saving or approving **erased** the override history on
the fact. You could override Subtype during moderation, approve, open the
fact in Edit Fact, and see no trace that you'd changed anything. Now the
override survives the whole journey: moderation edit → re-run classification
→ approve → Edit Fact shows the same chips and history.

## Walkthrough

Open **Admin → Moderation → Fact Reviews**, get a review to **Step 2 —
Visual review** (provisionally approve a pending fact, let prep finish), and
expand **Advanced Options**.

1. **Instant per-field override.** Change **Subtype** (or any dropdown).
   Expect — with **no Save click**:
   - an "overridden" chip appears under the field, with "AI: <old value>"
     and a **Revert to AI** link;
   - the "Overridden: …" summary bar appears at the top of the editor;
   - any already-rendered test tiles flip **stale** immediately.
2. **Revert.** Click **Revert to AI** — the chip disappears, the field
   returns to the AI value, tiles reflect the change.
3. **Override survives re-classification.** Override a field again, then
   **Re-run classification** (note the new confirm text: overrides are
   preserved). After it finishes: your override still wins. If the AI's new
   opinion differs from what you originally overrode, the amber
   **"review — AI changed"** appears with **Keep override**.
4. **Visual Strategy Override drafts.** Enable/edit the VSO. Expect an
   **"Unsaved changes"** hint naming the Visual Strategy Override (with a
   Discard link) and a **Save enrichment** button. Now **close the modal and
   reopen the same review** — your unsaved VSO edit is still there (browser
   draft). Click **Save** → saved hint, tiles stale.
5. **Approve.** With an **unsaved** VSO edit, Approve is blocked with a clear
   message (Save or Discard first). After saving, approve normally.
6. **The lockstep proof.** Open the just-approved fact on the **Facts page →
   Edit Fact**. Expect the **identical** override chips, "Overridden:"
   summary, and override history you created during moderation. That's the
   whole feature.

## Expect vs. don't-expect

| Expect | Don't expect |
| --- | --- |
| Dropdown edits persist instantly (chip appears, no Save) | A Save button being needed for tracked fields |
| "AI: <old value>" + Revert to AI on each overridden field | Override info visible only in a summary |
| Overrides surviving Re-run classification | A re-run silently discarding your edits |
| VSO edits surviving a closed/reopened modal (draft) | Losing VSO work by closing the modal |
| Save button appearing **only** for VSO/untracked edits | "Unsaved changes" for a dropdown edit |
| Approve blocked (clear message) with an unsaved VSO draft | Approval silently dropping the unsaved edit |
| Edit Fact showing the same chips/history after approval | Edit Fact showing "no overrides" after moderation edits |

## Regression smoke

| Area | Check |
| --- | --- |
| Final hashtags | Step 2 hashtag curation unchanged: final list + "AI suggested" chips + Add all; approval still requires ≥1 tag |
| Test renders | Per-tile live status, run-selected, stale markers all behave as before |
| Reject | Rejecting at Step 1 or Step 2 still works |
| Edit Fact page | Behaves exactly as before (it now runs the shared hook) — chips, Revert, acknowledge, VSO Save/Discard |
| Draft carry-over | An unsaved moderation VSO draft on a fact you later open in Edit Fact appears there too — same fact, same draft (intentional: no work lost) |

## Known non-bugs (this version)

- **Tracked-field edits don't wait for Save** — that's the feature. The Save
  button now belongs only to the Visual Strategy Override.
- **Editing after approval is allowed** — the staging fact becomes the live
  fact, so a late override edit is just normal Edit-Fact editing (tracked and
  audited), not a bug.
- **The browser draft is per-browser** — a VSO draft made on the iPad won't
  appear on another machine until saved. Saved edits are everywhere.
- A brief "saving…" pip next to a field right after a change is the per-field
  write in flight; an error pip there means that one write failed (retry the
  change).

## Bug report template

```
Screen/step: (Moderation Step 2 / Advanced Options / Edit Fact after approval)
Review id / fact:
Field I changed + how (dropdown vs VSO):
What I expected (chip / revert / draft / stale tile):
What happened (exact text/state, any error pip):
Screenshot:
```
