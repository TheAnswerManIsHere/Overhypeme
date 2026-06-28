# PR145 — Save Advanced-Options enrichment — UAT (David)

In-app click-through. Engineering checklist: `PR145_MODERATION_ENRICHMENT_SAVE_TEST_RUN.md`.

## What changed, in one breath

In moderation **Step 2 → Advanced Options**, you can now **Save** your enrichment /
visual-strategy-override edits. Before, there was no Save — edits only took effect
when you approved, and the test renders never reflected them, so re-running a tile
after an edit was a dead end.

## Why it matters

The Step-2 test renders are generated from the fact's **saved** enrichment. So the
loop is now: **edit → Save → the tiles you already rendered go "stale" → re-run them
→ the new images reflect your edit.** Without Save, a re-run just re-made the old
image.

## Walkthrough

1. Open **Admin → Moderation → Fact Reviews**, open a review, get it to **Step 2 —
   Visual review** (Keep / Provisional Approve a pending fact, let prep finish).
2. Let the default test renders finish so at least one tile shows an image.
3. Expand **Advanced Options** (collapsed by default).
4. Change something that affects the picture — e.g. a **Modifier**, the **Visual
   Strategy Override**, or a taxonomy value.
5. You should see an amber **"Unsaved changes — Save to update the test renders
   below, then re-run them."** line, and a **Save enrichment** button.
6. Click **Save enrichment**. Expect:
   - A green **"Saved. Re-run any stale test renders to see the change."** line.
   - The grid refreshes; the tiles you'd already rendered now show a **stale**
     marker (and the tally line shows `· N stale`). The old image stays visible.
7. Re-run the stale tiles (checkboxes + **Run selected**, or a tile's **Rerun**).
   The new images reflect your saved edit, and the stale marker clears.
8. **Approve for Production** as usual — it publishes the saved enrichment.

## Expect vs. don't-expect

| Expect | Don't expect |
| --- | --- |
| A **Save enrichment** button in Advanced Options | Edits silently taking effect with no Save |
| "Unsaved changes" hint while you have pending edits | The hint lingering after a successful Save |
| After Save, already-rendered tiles flip **stale** | Tiles auto-re-rendering (and spending) on Save |
| Re-running a stale tile uses your **saved** edit | The re-run reproducing the pre-edit image |
| Save blocked with a clear error if the enrichment is invalid | A broken/empty enrichment being saved |

## Regression smoke

| Area | Check |
| --- | --- |
| Approve | Approving still works and publishes the (saved) enrichment |
| Renders | Default + manual reruns still show live per-tile status (no timeout) |
| Facts page | The Edit Fact enrichment editor + its Save/Discard are unchanged |
| Triage | Step 1 keep/reject unaffected |

## Known non-bugs (this version)

- **Save does not auto-re-render.** It marks tiles stale and waits for you to
  re-run — re-rendering costs money, so it stays a deliberate click.
- **Edit Fact screen** still uses its own enrichment editor; this Save is the
  moderation (staging-fact) one. (Unifying the two surfaces is the later PR 3.)
- Field tooltips / clearer field names are still PR 2.

## Bug report template

```
Screen/step: (Step 2 / Advanced Options / after Save / after Rerun)
Review id / fact:
What I edited:
What I expected after Save:
What happened (tile name + its status, any error text):
Screenshot:
```
