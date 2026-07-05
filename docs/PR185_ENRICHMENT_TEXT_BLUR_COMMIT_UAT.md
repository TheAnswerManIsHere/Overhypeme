# PR185 — Enrichment text blur-commit · UAT (click-through)

> **For David.** In-app acceptance test for the fixed typing behavior in the
> enrichment editors (semantic entities, cultural references, and the two
> notes fields). Companion engineering checklist:
> `docs/PR185_ENRICHMENT_TEXT_BLUR_COMMIT_TEST_RUN.md`.
>
> **What changed:** PR #182 tried to stop the "my trailing space disappears
> while I type" bug with a 600ms delay on saves. Review found the delay only
> shrank the bug's window and introduced ways to silently lose edits. Now the
> text fields work like the notes fields always have: **while you're typing,
> nothing is sent to the server; the save happens once, when you leave the
> field** (click elsewhere / Tab). Checkboxes, dropdowns, add/remove-row
> buttons save instantly, as they did before PR #182.

---

## Where to go

1. Open **Admin → Facts**, pick a live fact that has AI enrichment, and open
   its enrichment editor (this is override mode — the per-field override pills
   are visible).
2. Scroll to **References & Scene Entities**. If the fact has no semantic
   entity, click **Add entity** first.

## The main fix: typing is never interrupted

| # | Do this | Expect |
|---|---------|--------|
| 1 | Click into a semantic entity's **Visual referent** and type a few words **with a trailing space**, e.g. `hands signing ` | The space stays. No flicker, no caret jump. |
| 2 | **Stop typing and wait 5+ seconds** with the cursor still in the field. | Nothing happens. The space is still there. (This is the case PR #182's debounce did NOT fix — it used to snap back after ~1s.) |
| 3 | Keep typing after the pause: `hands signing quickly`. | Typing continues normally — mid-sentence pauses never cost you a space again. |
| 4 | Click anywhere outside the field (or press Tab). | ONE save fires: the field's override pill flips to **overridden** (brief saving state). Trailing whitespace, if any is left at the very end, is trimmed by the server at this point — that's cleanup of the finished edit, not interference while typing. |
| 5 | Click into the field and immediately click out **without changing anything**. | No save fires — the pill/state doesn't churn. |

Repeat step 1–4 once on a **cultural reference Explanation** textarea (same
contract; if the fact has none, **Add reference** first) and once on
**Admin review notes** (bottom of the editor — this field already worked this
way; confirm it still does).

## Instant saves still instant

| # | Do this | Expect |
|---|---------|--------|
| 1 | Toggle **Requires admin review** on an entity. | Saves immediately (override pill reacts right away, no blur needed). |
| 2 | Change an entity's **Kind** dropdown. | Same — immediate. |
| 3 | Click the trash icon to **remove** an entity or reference. | The row disappears AND the save fires immediately. Reload the page: the row is still gone. (Under PR #182's debounce, a fast tab-close here silently kept the deleted row.) |

## Reset can't be undone by a ghost save

| # | Do this | Expect |
|---|---------|--------|
| 1 | Edit a Visual referent, click out (save fires, pill shows **overridden**). | — |
| 2 | Immediately click that field's **Revert to AI** reset. | The value returns to the AI baseline **and stays there**. Wait 2–3 seconds and reload: still the AI value. (Under the debounce, a pending timer could re-write your edit right after the reset.) |

## Edits made right before Approve are not lost

| # | Do this | Expect |
|---|---------|--------|
| 1 | On a review candidate at Step 3 (refresh cycle), open **Advanced Options**, edit a semantic entity's Visual referent, and **immediately** click the approve/promote action. | The click leaves the text field first, which commits the edit — the promoted fact includes it. Verify on the live fact afterwards. (Under the debounce, an approve within 600ms of typing silently dropped the edit.) |

## Regression smoke

| Area | Check |
|------|-------|
| Review flow (Moderation, no override pills) | Typing in entity/reference text fields still updates the draft per keystroke; close and reopen the review modal — typed text (even unblurred) is still in the draft. |
| Notes fields | `Adult suitability notes` + `Admin review notes` still commit on blur in override mode and type normally in review mode. |
| Other tracked fields | Archetype/subtype/complexity selects, modifiers chips: unchanged, instant persistence with override pills. |
| PR #182 backend half | Step-3 → Step-2 → re-approve still clears old thumbnails and renders a fresh batch (covered by PR #182 itself; unchanged here). |

## Known non-bug limitations

- **Blur is the save gesture in override mode.** If you type in a field and
  close the browser tab with the cursor STILL in that field, that in-progress
  text was never committed and is not saved. Clicking anything in the app
  first (including Save/Approve) commits it. This matches how the notes
  fields have always behaved.
- **Trailing spaces are trimmed at commit.** A value ending in whitespace is
  canonicalized by the server when the save fires (after you leave the
  field). Mid-typing spaces are never touched — that was the bug; the
  end-of-value trim on the finished edit is intended.

## If something's off, report it like this

> **Field:** (e.g. semantic entity → Visual referent)
> **Mode:** live Facts page (override pills) / review modal
> **Steps:** what you typed/clicked, including pauses
> **Expected / Got:** e.g. "space preserved while typing" / "value snapped back"
> **Timing:** did it happen while typing, on blur, or after a delay?
