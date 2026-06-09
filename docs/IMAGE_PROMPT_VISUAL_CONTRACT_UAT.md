# Image-prompt visual contract + age-transform binding — user acceptance testing

Paired with **`docs/IMAGE_PROMPT_VISUAL_CONTRACT_TEST_RUN.md`** (the automated
checklist). This is the click-through test for David.

## What you're verifying

The "born → drove mom home from the hospital" meme used to render an **adult**
David next to a **separate** baby (or just an adult driving). We rebuilt how the
Nano Banana prompt is assembled so that:

1. The model is told **David IS the baby** — the same person, de-aged — and
   explicitly told **not** to add a separate baby or keep an adult version.
2. The prompt **describes the picture** (subject, pose, setting, lighting,
   composition) instead of explaining the joke ("showcasing the absurdity", etc.).
3. The final prompt is a clean, labeled spec you can read top to bottom.

Reference-photo uploads, the engine bench, and the generic generator all use this
same engine, so the change applies everywhere a fact becomes an image.

## Where to look

The fastest place to see the prompt itself is the **Runtime Compiled Prompt
Preview** panel — it's on the admin **Facts** page (per fact) and on the
**Moderation** page (per review). Open it, pick your controls, and click
**Generate**.

## 1. The hospital / baby fact (the headline fix)

1. Open a fact like **"When David was born, he drove his mom home from the
   hospital"** (or add one), make sure it's enriched, and open the **Runtime
   Compiled Prompt Preview**.
2. Choose **image-to-image (human)** mode and Generate.
3. In the **compiled prompt**, expect a labeled structure with these headers, in
   order:
   - **IMAGE-TO-IMAGE TASK** — says to preserve recognizable identity/likeness and
     that age / body / hair / clothing may transform.
   - **SUBJECT BINDING** — reads like: *"The reference person is David. David is a
     baby/infant in this scene. Render exactly one David. The transformed baby IS
     David — the same person de-aged, not a second person."*
   - **CORE SCENE / SUBJECT DETAILS / ENVIRONMENT / COMPOSITION / LIGHTING AND
     STYLE** — concrete visual detail.
   - **STRICT CONSTRAINTS** — includes *"Do not render the adult reference person
     separately. Do not add a second, generic baby."*
4. Expect **NOT** to see: "Intent: …", "Stage it as: …", "showcasing the
   absurdity", "emphasizing the humor", "creating a humorous contrast", or any
   sentence that explains *why* it's funny instead of *what's in the frame*.
5. If you render it: expect **one** baby with David's likeness driving — no adult
   David, no extra/second baby.

## 2. Other age transforms

Try a fact that implies a different age — e.g. "As a kid, David…" or "In his 90s,
David…". Expect the **SUBJECT BINDING** to name the right life stage
("a young child", "an elderly man") and the same one-person, no-split language.

## 3. "Sharks have a David Week" (no accidental duplication)

1. Open/seed **"Sharks have a David Week."**, enriched, and Generate (human i2i).
2. Expect the Shark Week reference to show up as a concrete visual (e.g. sharks on
   a TV / in the water) with a "no real logos / brand marks" guard.
3. Expect **one** David — he should not be duplicated across the frame — and,
   because this isn't an age fact, **no** SUBJECT BINDING de-aging lines.

## 4. A plain fact (regression smoke)

Pick an ordinary fact with no age/duplication angle (e.g. a superhuman feat).
Expect the labeled structure **without** a SUBJECT BINDING section, concrete
visual sections filled in, and no intent commentary.

## 5. Visual plan debug (optional)

In the preview, expand **Visual plan debug**. Expect to see the new fields:
`coreScene`, `subjectDetails`, `environment`, `lightingAndStyle`, and
`subjectTreatment.ageLifeStageTransform`.

## Regression smoke table

| Surface | Expect |
| --- | --- |
| Runtime preview — human i2i | Labeled prompt; binding only for age/duplication facts |
| Runtime preview — generic (t2i) | Labeled prompt; no human "reference person" binding |
| Reference upload generate | Single de-aged subject for age facts; no separate baby |
| Engine bench (image) | Prompt assembles; renders in the chosen aspect ratio |
| Breakdown chips | Sections labeled IMAGE-TO-IMAGE TASK … STRICT CONSTRAINTS |

## Known non-bugs / limitations

- For **non-human** subjects (a pet/object with an age angle), there's no
  "reference person / adult version" binding — that wording is human-only by
  design; the age direction still appears as a directive.
- `visualGoal` / `visualApproach` still exist in the debug JSON but are **not**
  in the engine prompt anymore — they're internal reasoning.
- The model can still occasionally misplace details; this change makes the
  *instructions* correct and unambiguous, not the model perfect.

## If something's wrong

Report with: the fact text, the mode you picked, a screenshot of the **compiled
prompt** (and the render if any), and what you expected vs. saw. The compiled
prompt text is the ground truth for whether the binding/sections are right.
