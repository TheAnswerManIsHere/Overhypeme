# PR153 — Enrichment Field Documentation — UAT (David)

In-app click-through. Engineering checklist: `PR153_ENRICHMENT_FIELD_DOCS_TEST_RUN.md`.

## What changed, in one breath

Every field in the enrichment editor now has a little **ⓘ info icon**. Tap it and
a panel opens explaining exactly what the field is, how the AI decides it, how it
affects the final image, what every dropdown value means, and worked examples.
The panel **stays open and scrolls** (it's not a hover tooltip) so you can read it
on the iPad. There's also a full written reference at
`docs/ADMIN_FIELD_REFERENCE.md`, generated from the same source.

## Walkthrough

1. **Moderation.** Open a review in `production_review` → **Step 2 (Visual review)**
   → expand **Advanced Options**. Every field label — Primary Archetype, Subtype,
   Modifiers, the Visual Strategy Override fields, etc. — has an **ⓘ** beside it.
2. **Tap an ⓘ** (start with **Primary Archetype**). Expect a panel that:
   - stays open until you tap the ✕, press Escape, or tap outside it;
   - **scrolls** if the content is long (Primary Archetype lists all 11 archetypes);
   - lists **every dropdown value** with its meaning, render impact, and an example;
   - shows a small **badge** at the bottom saying how the field behaves — e.g.
     Overhype Fit reads *"Gating only — never rendered"*, Visual Literalness reads
     *"Advisory to the AI planner"*, Modifiers reads *"Feeds the render pipeline"*.
3. **Tap outside the panel** (on the dark area around the modal): the **panel
   closes but the review modal stays open**. Press Escape with a panel open: same —
   the panel closes first, the modal stays.
4. **Modifiers ⓘ**: scroll through — all 50 are documented. The ones that inject a
   real instruction (e.g. `baby_child_version`) **quote the literal sentence** the
   image model receives. Custom/unknown modifiers you type get a generic "no fixed
   effect" explanation.
5. **Repeater sections** (Cultural References, Semantic Entities): the **section
   header** has the ⓘ with the full explanation of how those rows drive the image;
   the **Reference type / Entity kind / Capitalization signal** dropdowns each have
   their own ⓘ (that's where per-value help matters). Individual text fields in a
   row don't each get an icon — that's intentional, not a miss.
6. **Facts page.** Open **Admin → Facts**, edit a fact's enrichment — the same
   icons and panels are there automatically.
7. **Written reference.** Open `docs/ADMIN_FIELD_REFERENCE.md` — the same content
   as a single browsable document.

## Please spot-check (authored-from-code content)

Most docs are lifted from the classifier prompt or traced compiler code. But some
fields had **no written definition anywhere** — I authored those from how the code
behaves, and they're flagged **"authored — verify"** in the panel and the reference
doc. Please sanity-check these in particular:

- **Subject Realization modes** (Visual Strategy Override): `normal_human`,
  `age_transformed_human`, `adult_head_on_transformed_body`, `subject_as_object`,
  `nonhuman_transformation`, `symbolic_or_implied`, `custom` (and `use_ai_plan`).
- **Setting modifiers**: `office_setting`, `gym_setting`, `courtroom_setting`,
  `hospital_setting`, `battlefield_setting`, `space_setting`, `underwater_setting`,
  and the other `*_setting` flags — I described these as "context only, no
  guaranteed effect"; confirm that matches your intent.
- **Identity modifiers** `identity_strict` / `identity_essence_only`: code doesn't
  currently consume these anywhere I could find — I documented them as
  **not currently wired to anything**. Please confirm that's true / expected.
- **`audience_inside_reference`**: no prose source existed; I inferred its meaning.

Everything with the amber **"authored — verify"** tag is fair game — if any
description is wrong, tell me the field and the correction and I'll fix the
registry (the reference doc and popovers both update from it).

## Expect vs. don't-expect

| Expect | Don't expect |
| --- | --- |
| An ⓘ beside every top-level field | An ⓘ beside every text box inside a repeater row |
| Panel stays open + scrolls | A hover tooltip that vanishes |
| Tap-outside closes only the panel | The whole review modal closing when you dismiss a panel |
| Honest effect badge per field | Every field implying it changes the image |
| Current field names unchanged | Renames yet — those come after your sign-off (below) |

## The naming pass — your call

I did **not** rename anything yet. The 12 proposed renames (e.g. "Primary
Archetype" → "Joke Mechanism (Archetype)", "Adult Suitability" →
"Adult-Mode Compatibility", "Negative Prompt Additions" → "Do-Not-Render
Additions") are in the plan and endorsed by ChatGPT, but they're **your call
row-by-row**. Tell me which to apply (or "all") and I'll ship them as one more
commit on this PR before merge. Everything works with the current names until then.

## Bug report template

```
Field / section:
What the ⓘ panel said:
What's wrong or unclear:
(If a value description is factually wrong: the value + the correction)
```
