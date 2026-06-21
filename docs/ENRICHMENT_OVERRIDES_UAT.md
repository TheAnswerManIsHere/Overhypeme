# AI-derived vs. manual override tracking — user acceptance testing

Paired with **`docs/ENRICHMENT_OVERRIDES_TEST_RUN.md`**. Click-through for David.

## What you're verifying

On the admin **Facts** page, when you change a taxonomy field the editor now
remembers **what the AI decided** and stores your change as an **override** that
**wins** and **sticks** — even after re-running classification. The editor stays
clean until something actually diverges: *highlight the change, don't show
everything twice.* Flagship: overriding **Primary Archetype** on the Grenade fact.

## Where to look

Admin → **Facts** → pick a fact → the **Visual Taxonomy Enrichment** panel.

## 1. Override a field (the core loop)

1. Open a fact that's enriched (has an archetype). The fields look exactly as
   before — **no badges, no AI lines**.
2. Change **Overhype Fit** (or any field) to a different value.
3. Expect, immediately under that field:
   - an **"overridden"** badge,
   - an **"AI: <original value>"** line,
   - a **Revert to AI** link,
   - a brief **"saving…"** then it settles (no page refresh needed).
4. The **list row** for that fact (left list) now shows a small **"overridden"**
   pill next to the archetype chip.
5. A compact **"Overridden: Overhype Fit"** summary appears at the top of the panel.

## 2. Flagship — override Primary Archetype on the Grenade fact

1. Find the Grenade fact; change **Primary Archetype** to a different archetype.
2. Expect **both** Primary Archetype **and** Subtype to show "overridden" — the
   subtype is **auto-adjusted** to a compatible one for the new archetype (you
   don't have to know the subtype rules).
3. The render preview / projections reflect the new archetype (it's the active
   value now).

## 3. Revert

1. On any overridden field, click **Revert to AI** (or set the dropdown back to
   the AI value).
2. Expect the decoration to **disappear** — the field is back to plain AI, the
   list-row pill clears, and the summary updates.

## 4. Sticky re-enrich + "AI changed" review

1. Override a field (e.g. Overhype Fit → a new value).
2. Click **Re-run classification**. Read the confirmation — it now explains the
   baseline will regenerate but **your overrides are preserved**.
3. After it finishes:
   - your **override still wins** (the active value is what you chose), and
   - **if** the AI's new value differs from what it originally said, the field
     shows an amber **"review — AI changed"** with **AI was: X / AI now: Y** and a
     **Keep override** option. The list row shows **"override needs review"**.
4. Click **Keep override** to acknowledge the new AI baseline (the warning clears,
   your override stays). Or **Revert to AI** to take the new AI value.

## 5. Notes are editable and sticky

1. Type into **Admin Review Notes** or **Adult Suitability Notes** and click away
   (blur). It shows a subtle "edited · Revert to AI".
2. Re-run classification → your note **survives** (it no longer gets wiped).

## 6. List filters

1. In the Facts list toolbar, toggle **Overridden** → only facts with manual
   overrides show.
2. Toggle **Needs review** → only facts whose override baseline changed show.

## Regression smoke table

| Area | Expectation |
|------|-------------|
| A fact with **no overrides** | Editor looks exactly as before — no badges/AI lines |
| **Save enrichment** button | Still works for hashtags / Visual Strategy Override |
| **Visual Strategy Override** panel | Unchanged; still previews and persists |
| Approving a **new review** | Works; the new fact starts with a clean AI baseline |
| **Runtime Compiled Prompt Preview** | Reflects the active (overridden) values |
| Cultural references / semantic entities | Editable; show a section-level "overridden" when changed |

## Known non-bugs / limitations

- **Legacy facts** (created before this feature) treat their current enrichment as
  the AI baseline; any *old* in-place manual edits can't be detected as overrides.
  New overrides you make from now on are sticky.
- The two **notes** fields use a light treatment (plain textarea + Revert), not the
  full "AI was / AI now" comparison — by design.
- **Hashtags** and the **Visual Strategy Override** are not part of the override
  map; they keep the existing Save-button flow.

## Bug report template

```
Fact id / text:
Field you changed:
What you did (click path):
Expected:
Actual:
Did the list-row pill / summary update? :
Did a page refresh change anything? (should be "no"):
```
