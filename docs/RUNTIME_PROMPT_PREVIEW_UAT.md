# Runtime Compiled Prompt Preview — User acceptance testing (in-app)

You're the end user (admin) here. The problem this fixes: during UAT you
mistook the enrichment editor's **"Example I2I prompt"** field for the
actual prompt sent to the image engine. It isn't — that field is a
preview-only sample generated during taxonomy enrichment under default
assumptions. The *real* engine prompt is built at render time from the
source-image analysis, subject render mode, identity policy, render
controls, selected style, and the fact's semantic/cultural enrichment.

This work makes the distinction unmissable:

1. The enrichment editor's example prompts are **relabeled** as
   preview-only, with helper text pointing you to the real thing.
2. A new **Runtime Compiled Prompt Preview** panel on the Facts admin
   page calls the actual Phase 2 prompt service and shows the
   `visualPlan` + compiled Nano Banana prompt an engine would receive
   under render assumptions you pick.

The automated test side is in
[`RUNTIME_PROMPT_PREVIEW_TEST_RUN.md`](./RUNTIME_PROMPT_PREVIEW_TEST_RUN.md)
and is owned by Replit AI; it runs in parallel and you don't need to
read it.

If anything below fails, note the section + step, what you saw vs.
expected, and a screenshot if visual. Bug template at the bottom.

---

## What this work explicitly does NOT ship

Not expected to work yet — not failures if you hit them:

- **A fix to the production render prompt.** The runtime preview renders
  `{NAME}` as "David" correctly. The live render pipeline still has a
  separate, known token-rendering bug (annotated in code with a TODO);
  fixing that is a dedicated follow-up with its own UAT.
- **Cultural references showing as "used."** The plan doesn't echo which
  cultural references it used, so the debug panel shows what was
  *provided* to the generator, not a "used" subset.
- **Editing a fact's enrichment from this panel.** It's read-only by
  default. Generating a preview never changes the fact. There's an
  explicit, off-by-default "Save this as an image-prompt attempt"
  checkbox if you want to persist a debug row.
- **A style content pass, provider swap, or video prompting.**

---

## Setup

1. Pull the latest of the feature branch
   (`claude/prompt-preview-runtime-separation-Yg5no`).
2. Boot the dev app. The session-start hook brings up the test DB. No
   new migrations ship here.
3. Sign in as an **admin** user.
4. Have at least one **approved fact that already has enrichment**. If a
   fact has no enrichment yet, run **Backfill enrichment** on it first
   (the runtime preview needs enrichment to exist).

---

## A — The relabel (moderation enrichment editor)

Open a fact in the moderation/enrichment editor where the visual
preview section is shown.

| #  | Step | Expect |
| -- | ---- | ------ |
| A1 | Find the two example-prompt text areas in the Visual Preview section | Labels read **"Preview-only example I2I prompt"** and **"Preview-only example T2I prompt"** — NOT "Example i2i/t2i prompt" |
| A2 | Read the helper line under the pair | It says this is an admin preview generated during enrichment, **not** the final image-engine prompt, and points you to **Runtime Compiled Prompt Preview** on the Facts admin page |
| A3 | Open the collapsed enrichment summary (where the saved preview is summarized) | The expandable row is labeled **"Preview-only example I2I / T2I prompts"** |

---

## B — Runtime Compiled Prompt Preview (Facts admin)

Go to the **Facts** admin page and select a fact (the right-hand editor
panel opens). Scroll down past the **Pexels Image Pipeline** card — the
**Runtime Compiled Prompt Preview** panel sits directly above the
**Visual Taxonomy Enrichment** editor. (Use a fact that already has
enrichment; if it doesn't, see section E.)

| #  | Step | Expect |
| -- | ---- | ------ |
| B1 | Find the **Runtime Compiled Prompt Preview** panel | Present, collapsed, with a beaker icon, just above the Visual Taxonomy Enrichment editor |
| B2 | Expand it | Controls appear: subject render mode, source subject kind, subject description, style, aspect ratio, negative space, content mode, target engine (fixed `nano_banana_2`), plus "Preserve physique" and "Save this as an image-prompt attempt" checkboxes (both off) |
| B3 | Leave mode = `human_identity_i2i`, click **Generate runtime prompt preview** | After a moment, a **Compiled prompt** pane shows real prompt text. The fact's `{NAME}` appears resolved as **David** (no literal `{NAME}`). The prompt includes face-preservation language ("preserve the reference person's recognizable face") |
| B4 | Check the **Input summary** | Shows the mode, `generationMode: i2i`, `targetEngine: nano_banana_2`, and `styleSource: none` (since no style chosen) — with a note that no style suffix is being appended |
| B5 | Pick a **Style** from the dropdown, regenerate | `styleSource` becomes `selected_look_style`, `stylePrompt` is non-empty, and the style suffix is visible appended to the compiled prompt |
| B6 | Switch mode to `nonhuman_subject_i2i`, set a Subject description (e.g. "orange tabby cat"), regenerate | Compiled prompt contains a "do not replace … with a human" clause; the subject is treated as a non-human subject |
| B7 | Switch mode to `t2i_fallback` | The source-subject controls hide; a **Fallback gender** selector appears. Leaving it blank shows an amber warning. Pick a gender, regenerate → the compiled prompt reflects a generated protagonist of that gender |
| B8 | Toggle the **Visual plan debug** disclosure | A JSON pane shows the engine-neutral plan (sceneConcept, composition, supportingTextPolicy, semanticEntitiesUsed, subjectFactCompatibility, etc.) |
| B9 | Click **Copy** on the compiled prompt | The prompt text is copied to your clipboard |

---

## C — Semantic / cultural reference sanity (regression facts)

Use facts where capitalization/cultural meaning matters. Generate a
preview and read the **Visual plan debug**.

| #  | Fact (or similar) | Expect |
| -- | ----------------- | ------ |
| C1 | A fact mentioning **"Shark Week"** | Debug → `culturalReferencesProvided` lists the Shark Week reference (what the generator received). `culturalReferencesUsed` is empty by design |
| C2 | A fact with capitalized **"Earth"** (the planet) | Debug → `semanticEntitiesUsed` echoes Earth as the planet, and the prompt stages the planet rather than dirt/soil |
| C3 | A fact with lowercase **"earth"** (soil) | The entity referent is ground/dirt/soil, and the prompt reflects terrain, not the planet |

---

## D — Non-mutation + opt-in persist

| #  | Step | Expect |
| -- | ---- | ------ |
| D1 | Generate several previews for one fact without ticking the save checkbox | The fact's saved enrichment + its Phase 2A example prompts are unchanged (reload the moderation editor to confirm) |
| D2 | Tick **"Save this as an image-prompt attempt"**, generate | A debug attempt row is written (visible via the image-prompt attempts admin listing); the fact's enrichment is still unchanged |

---

## E — No-enrichment guard

| #  | Step | Expect |
| -- | ---- | ------ |
| E1 | Select an approved fact that has **no** enrichment, expand the panel, click Generate | A friendly message tells you to run **Backfill enrichment** first — not a raw error or a crash |

---

## Known non-bugs

- The runtime preview always renders the protagonist name as **David**.
  That's intentional — it's the brand protagonist used for previews. A
  real render would use the actual uploader's name/pronouns.
- The compiled prompt can differ from the enrichment "example" prompt
  even for the same fact. That's the entire point: the example is a
  default-assumption sample; the runtime preview reflects the render
  context you selected.
- `culturalReferencesUsed` is always empty in the debug pane. The plan
  doesn't echo cultural-reference usage; `provided` is authoritative.

---

## Bug report template

```
Section + step:        (e.g. B6)
Fact id / text:
Render assumptions:    (mode, style, aspect, gender, content mode)
What I saw:
What I expected:
Screenshot:
```
