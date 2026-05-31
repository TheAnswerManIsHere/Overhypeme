# Visual Taxonomy on Facts — User acceptance testing (in-app)

You're the end user here (an admin). Until now, the **Visual Taxonomy
Enrichment** panel — the form that holds a fact's archetype, subtype,
modifiers, hashtags, cultural references, semantic entities, and the
visual prompt preview — only appeared on the **Moderation** page while a
submission was still pending. Once a fact was approved it was a black
box: if it rendered bad images or videos, there was no way to see or
tune the metadata driving generation.

This change surfaces that **same** editor on the **Facts** admin page
(`/admin/facts`), so you can open any live fact and edit its taxonomy,
regenerate its visual preview, or re-run classification from scratch.
Because it's the *same* reusable component, any future change to how the
form works shows up in both places automatically.

The automated test side is in
[`VISUAL_TAXONOMY_FACTS_TEST_RUN.md`](./VISUAL_TAXONOMY_FACTS_TEST_RUN.md)
and is owned by Replit — it runs in parallel and you don't need to read
it.

If anything fails, note the section + step, what you saw vs. expected,
and a screenshot if it's visual. Bug-report template at the bottom.

---

## Setup

1. Pull the latest of `claude/affectionate-hamilton-S3TAK`.
2. Boot the dev app. The session-start hook brings up the test DB; this
   change ships one migration (`0069_facts_enrichment_status.sql`) that
   applies automatically.
3. Log in as an **admin**.
4. Have on hand:
   - at least one **approved fact that already has enrichment** (look for
     the ✨ chip in the Facts list — see A1);
   - ideally one **older fact with no enrichment** (no chip) to test the
     empty/manual path.

---

## A — The editor appears and is populated

| # | Do this | Expect |
| --- | --- | --- |
| A1 | Open `/admin/facts`. Scan the list rows. | Facts that have enrichment show a small ✨ chip with their archetype (e.g. `superhuman_physical_feat`). Facts without enrichment show no chip. |
| A2 | Click a fact that has the ✨ chip. | The edit panel opens on the right. Scroll past the usual fields (text, votes, variants, Pexels pipeline) to a **"Visual Taxonomy Enrichment"** section — the same panel you've seen on Moderation. |
| A3 | Look at the panel. | It's populated: Primary Archetype, Subtype, Visual Literalness/Complexity, Overhype Fit, Adult Suitability, Modifiers, Suggested Hashtags, Cultural References, Semantic Entities, and the Visual Interpretation Preview — all filled from the fact's stored metadata. Briefly you may see "Loading enrichment…". |
| A4 | Click a different fact. | The panel resets and loads that fact's own metadata. No values bleed over from the previous fact. |

---

## B — Edit + autosave

| # | Do this | Expect |
| --- | --- | --- |
| B1 | Change a free-text field — e.g. add a line to **Admin Review Notes**. | Within ~1.5s a status line under the panel shows **"Saving…"** then a **"Saved …"** timestamp. No Save button to press — it autosaves. |
| B2 | Reload the page and re-open the same fact. | Your edit persisted. |
| B3 | Change the **Primary Archetype** dropdown to a different value (the Subtype auto-corrects to a valid one for that archetype). Wait for "Saved". Reload. | The change persisted, and the list-row ✨ chip now shows the new archetype. |
| B4 | Put the form into an **invalid** state — e.g. remove hashtags until there are fewer than 3. | The editor shows a red validation message, and the status line reads **"Unsaved — resolve validation errors to autosave."** It does **not** save the broken state. |
| B5 | Fix the validation (add hashtags back to ≥3). | Status returns to "Saving…" → "Saved". The previously-broken state was never persisted. |

---

## C — Regenerate the visual preview

| # | Do this | Expect |
| --- | --- | --- |
| C1 | In the **Visual Interpretation Preview** sub-panel, click **Regenerate** (the refresh control). | It saves the current metadata first, then queues a preview job. A spinner/"working" state appears. |
| C2 | Wait (up to ~100s). | The preview fields (scene concept, visual plan, example prompts, etc.) refresh with newly generated content. |
| C3 | If the preview job fails | The metadata you edited is still intact and saved; only the preview shows a failed state. The fact's enrichment status is not knocked back. |

---

## D — Re-run classification (destructive, with confirmation)

| # | Do this | Expect |
| --- | --- | --- |
| D1 | Click **Re-run classification** at the top of the panel on a fact **that already has enrichment**. | A confirmation dialog appears: *"Re-running classification will overwrite the current, possibly admin-tuned, enrichment for this fact. Continue?"* |
| D2 | Cancel the dialog. | Nothing happens; your metadata is untouched. |
| D3 | Click Re-run again and confirm. | The panel shows **"Classifying…"**. After the AI finishes, the whole enrichment refreshes with newly derived values. |
| D4 | (Optional) Watch the list-row chip during D3. | It briefly shows "classifying…", then settles on the new archetype. |

---

## E — Empty / manual path

| # | Do this | Expect |
| --- | --- | --- |
| E1 | Open a fact with **no** enrichment (no ✨ chip). | The panel renders with empty defaults — no values, validation warnings visible. |
| E2 | Either click **Re-run classification** (no confirm needed — there's nothing to overwrite) to have the AI fill it… | …"Classifying…" then a fully populated panel. |
| E3 | …or hand-fill the required fields to a valid state. | Once valid, it autosaves ("Saved"), and the ✨ chip appears on the list row. |

---

## F — Moderation regression (the editor's original home)

The same editor still powers Moderation — confirm nothing regressed.

| # | Do this | Expect |
| --- | --- | --- |
| F1 | Open `/admin/moderation`, open a **pending** fact review. | The Visual Taxonomy Enrichment panel appears and behaves exactly as before: edit + autosave, re-run classification, regenerate preview. |
| F2 | Edit a field, then watch the **Approve** button. | Approve stays gated until the enrichment is valid **and** a visual preview exists — unchanged behavior. |
| F3 | Approve / reject as usual. | Decision flow works exactly as before. |

---

## What this change explicitly does NOT do

Not failures if you notice them:

- It doesn't change how images or videos are actually generated — only
  the metadata that feeds them.
- It doesn't add a new bulk tool; the existing "Backfill enrichment"
  button on the Facts page is unchanged. This is per-fact editing.
- Re-running classification on Moderation (pending reviews) still has
  **no** confirmation dialog — those are pre-approval drafts. The
  confirmation only guards live, already-enriched facts.

---

## Bug-report template

```
Section + step:        (e.g. B4)
Fact id:
What I did:
What I expected:
What I saw:
Screenshot / console error:
```
