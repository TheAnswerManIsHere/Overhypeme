# PR192 — Visual Concept leads the prompt · UAT (click-through)

> **For David.** In-app acceptance test for the compiler redesign. Companion
> engineering checklist: `docs/PR192_VISUAL_CONCEPT_LEADS_TEST_RUN.md`.
>
> **What changed:** the compiled image prompt used to lead with boilerplate
> ("No reference identity is being preserved…"), bury the Visual Concept in the
> middle, and repeat the scene three more times — including the broken
> *"Alex Franklin is Alex Franklin leans against…"* you spotted. Now **the Visual
> Concept leads the prompt and drives it**; everything else is either an
> operational instruction (identity, style, policy) or a concrete detail the
> Concept left out. This is the first of the two PRs; the plain-English
> authoring / auto-tokenization is the next one.

---

## Where to look

Admin → open a fact's **Runtime Compiled Prompt Preview** (or a moderation
review's Test Renders → expand a tile's compiled prompt). The preview goes
through the exact runtime compile path, so what you read here is what the engine
gets.

## The main thing to confirm: the prompt now reads top-down like the gag

| # | Do this | Expect |
|---|---------|--------|
| 1 | Open the compiled prompt for the finger-countdown fact (Review #6810) or any fact with a Visual Concept. | It **starts with `CORE SCENE:`** (your Visual Concept), not with reference/identity boilerplate. |
| 2 | Read the section right after CORE SCENE. | For an uploaded-photo (i2i) render it's `IDENTITY & REFERENCE:` with strong "preserve the recognizable face/likeness" language. For the generic (t2i) render it's a short `RENDER TASK:` line — no reference-photo talk. |
| 3 | Look for the old `REFERENCE INTERPRETATION:` section and the *"Alex Franklin is Alex Franklin…"* text. | **Gone.** Role info now lives in a `ROLE DETAILS:` section that only appears when it adds something the scene didn't already say — and it never doubles a name. |
| 4 | Scan `SUBJECT DETAILS:` / `ENVIRONMENT:`. | They should read as *additions* to the scene, not a re-description of it. Repeated phrasing of the Visual Concept is dropped. |
| 5 | Scan `STRICT CONSTRAINTS:` at the end. | Still present — the no-baked-caption/overlay text rule and the "keep incidental background text non-readable" guard are intact. |

## The render A/B — this is the real gate (please do this)

Unit tests prove the prompt is well-formed; only a real render proves it looks
right. In **Test Renders**, run these and compare against how the fact rendered
before:

| # | Render | Expect / check |
|---|--------|--------|
| 1 | **Generic (t2i)** on the finger-countdown fact (and 1–2 others). | Produces an on-concept image; the "00:01" countdown + middle-finger gag reads. Should feel *more* on-concept than before, not less. |
| 2 | **Male / Female (i2i)** on a fact where the face is easy to judge. | **The uploaded person's likeness still holds.** This is the one thing to watch closely — the identity clause moved to just after the scene, and this render is the proof it's still strong. If a face looks *less* like the reference than before this change, that's the thing to flag. |
| 3 | **Non-human (i2i)** on a non-human-subject fact. | The uploaded subject is preserved and **not** turned into a human. |
| 4 | A **multi-character** fact with role bindings. | Each character keeps its role; the subject stays the one doing the central action; no "X is X" garbage in the prompt. |
| 5 | A fact that needs **in-scene text** (a sign, a scoreboard, the "00:01"). | The requested in-scene text still renders; no blanket "no text" behavior crept back. |

## If a detail seems missing from a render

The compiler now drops role/element lines it judges the Visual Concept already
covers. If you expected a detail and don't see it, open the preview's
**diagnostics** — dropped candidates are recorded there with a reason (e.g.
"already-in-core-scene"). That tells you whether it was intentionally de-duped
(reword the Visual Concept to include it) vs. genuinely lost.

## Known non-bug behavior

- **`ROLE DETAILS:` is often empty / absent.** That's correct — when the Visual
  Concept already describes who's doing what, there's nothing additive to add.
- **The prompt is shorter / less repetitive.** Intended. The scene isn't restated
  three times anymore.
- **Existing facts are unaffected until re-rendered.** Nothing was migrated; the
  new prompt shape applies to new renders.

## If something's off, report it like this

> **Fact / Review:** which fact, which review ID
> **Render:** Generic (t2i) / Male (i2i) / Female (i2i) / Non-human (i2i)
> **Expected / Got:** e.g. "face matches the reference" / "face drifted"; or
> "the countdown renders" / "a detail from the Visual Concept is missing"
> **Prompt check:** does the compiled prompt start with CORE SCENE, and is there
> any "X is X" doubling?
