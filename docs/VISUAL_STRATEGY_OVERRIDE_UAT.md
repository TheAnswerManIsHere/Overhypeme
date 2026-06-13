# Moderator visual-strategy override (Phase 2) — user acceptance testing

Paired with **`docs/VISUAL_STRATEGY_OVERRIDE_TEST_RUN.md`** (the automated
checklist). This is the click-through test for David.

## What you're verifying

The AI writes a first-pass visual strategy for each fact. Phase 2 lets you, the
moderator, **correct or sharpen** that strategy in structured fields — without
editing the final image prompt (which would freeze one name, gender, style,
render mode, or aspect ratio). At render time the compiler merges your override
into the prompt, and the prompt **still adapts** to the actual subject, pronouns,
reference photo, style, and aspect ratio.

Key principles you're confirming:

1. **You edit structured fields, not the final prompt.**
2. **Your override beats the AI plan** — but not the compiler's identity binding
   (the reference person stays the subject) or global product policy.
3. **Tokens stay dynamic** — you write `{NAME}` / pronoun tokens, and they render
   to whoever the meme is for.

**Nothing to switch on** — it's live by default. There's no new page: you edit in
the existing **Visual Taxonomy Enrichment** editor and verify in the existing
**Runtime Compiled Prompt Preview**.

## Where to look

- **Edit:** admin **Facts** page (or the **Moderation** review modal) → the
  **Visual Strategy Override** panel inside the enrichment editor (between
  *Admin Review Notes* and *Cultural References*).
- **Verify:** the **Runtime Compiled Prompt Preview** panel on the same screen.
  It now has **Sample name** + **Sample pronouns** inputs — set them to preview
  the override rendered for different people. Click **Generate** and read the
  compiled prompt's labeled sections.

> The preview reads the **saved** enrichment. On the Facts page, edits autosave;
> give it a second (or click Save) before Generate. In the Moderation modal the
> override is saved when you regenerate the preview / before a decision.

## 1. Newborn driving fact (subject realization)

Fact: **"When {NAME} was born, {SUBJ} drove {POSS} mom home from the hospital."**

1. Open the fact, enable **Visual Strategy Override**.
2. Set **Subject Realization** = `adult_head_on_transformed_body`, description:
   *"tiny newborn baby body with {NAME}'s recognizable adult head composited on,
   hospital cap and receiving blanket."*
3. **Required Visual Details:** "{NAME}'s adult face on a newborn body";
   "baby-sized hands on the steering wheel"; "mother in the front passenger seat".
4. **Forbidden Visual Details:** "a realistic generic de-aged baby face";
   "a separate adult version of the subject"; "the baby in a car seat".
5. **Role Bindings:** `subject` → "newborn baby-bodied driver with {NAME}'s adult
   head"; `mother` → "adult woman in the passenger seat, surprised and amused".
6. Save. In **Runtime Prompt Preview**, set **Sample name** to a few different
   names (e.g. *David Franklin*, *Maria*), Generate each.

Expect in the compiled prompt:
- **SUBJECT BINDING** still present (reference person is the subject, one
  instance) — your realization did **not** remove it.
- **SUBJECT REALIZATION** with your composited-look description, rendered for the
  sample name.
- **REQUIRED VISUAL DETAILS** and the role bindings in **REFERENCE INTERPRETATION**.
- **STRICT CONSTRAINTS** with "Do not …" lines for each forbidden detail.

**Expect NOT to see:** a realistic de-aged baby, a separate adult, a car seat, a
raw `{NAME}` token, or the same name hard-coded across different sample subjects.

## 2. Sharks {NAME} Week (required readable text + tokens)

1. On **"Sharks have a {NAME} Week"**, enable the override.
2. Check **Override supporting-text policy**, mode = `require`, guidance:
   *'a TV title reading "{NAME} Week: Capturing the World's Deadliest Predator"'*.
3. Save. Preview with **Sample name** = *David Franklin*.

Expect: a **SUPPORTING TEXT** line requiring the title, rendered as *"David
Franklin Week: …"*. **Expect NOT to see** a blanket "no readable text" line
contradicting it.

## 3. Grenade fact (violence override)

1. On **"{NAME} threw a grenade and killed 50 people, then it exploded"**, enable
   the override.
2. Check **Override violence policy**, mode = `allow`, intensity = `strong`,
   guidance: *"Visible bodies and lethal aftermath are required; action-hero
   styled, non-gratuitous."*
3. Save, Generate.

Expect: the violence guidance in the prompt; visible bodies/aftermath allowed.
**Expect NOT to see** PG-13 softening, and — even if the fact also has an
`avoid_gore` modifier — **not** a contradicting "keep it clean, no gore" line
(your override wins).

## Token validation

- Type an unknown token like `{FOO}` in any field → a yellow **warning** appears
  in the panel, and **Save fails** with a clear message on the Facts page.
- Type `{name}` or `{Name}` → it's normalized to `{NAME}` on save.

## Re-running AI classification keeps your work

1. With an override set, click **Re-run classification**.
2. When it finishes, confirm your **Visual Strategy Override** is **still there**
   (including its "Last edited by … " line). Re-running AI must never wipe it.

## Regression smoke table

| Surface | Action | Expect |
|---|---|---|
| Facts → enrichment | enable override, add required details | REQUIRED VISUAL DETAILS in preview |
| Facts → preview | set Sample name × 2 | override rendered for each, no hard-coded name |
| Facts → preview | realization override | SUBJECT REALIZATION added, SUBJECT BINDING still present |
| Facts → preview | forbidden details | "Do not …" lines, no double "Do not" |
| Facts → preview | supporting-text require + {NAME} | rendered title, no readable-text contradiction |
| Facts → preview | violence allow + avoid_gore modifier | violence guidance, no contradicting softening |
| Facts → enrichment | unknown token | warning + save rejected |
| Facts → re-run classification | with override set | override preserved |
| Facts → enrichment | override disabled | preview identical to no-override |

## Known non-bugs / deferred

- **No token picker yet** — you type `{NAME}` / pronoun tokens by hand (chips are
  Phase 3). The panel placeholder shows the tokens.
- The compiler does **not** rewrite conflicting AI sentences. Conflicts are
  resolved by your realization (added on top) and your **Forbidden Visual
  Details** ("Do not …"), which is enough for the cases above.
- **Moderator Intent / Notes** are admin-only — they never reach the image.
- The preview uses the **saved** override; unsaved edits won't show until autosave/
  save completes.

## Bug report template

```
Fact: <text>
Override fields set: <which>
Sample name/pronouns: <…>
What I expected (per this doc): …
What the compiled prompt showed: …
Section paste (SUBJECT REALIZATION / REQUIRED VISUAL DETAILS / REFERENCE INTERPRETATION / STRICT CONSTRAINTS): …
Warnings shown in the panel: …
```
