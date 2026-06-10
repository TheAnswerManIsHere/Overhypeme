# Image-prompt role/action hardening (v4) — user acceptance testing

Paired with **`docs/IMAGE_PROMPT_ROLE_ACTION_HARDENING_TEST_RUN.md`** (the
automated checklist). This is the click-through test for David.

## What you're verifying

v3 already fixed the **identity split** (David rendered as an adult *plus* a
separate baby). v4 hardens the next layer — **roles and actions** — so that:

1. The model is told, up front, **what each person in the scene is** — the
   subject's role *and* every other character's role — in a new
   **REFERENCE INTERPRETATION** line.
2. A secondary character **keeps their role** and can't quietly take over the
   subject's action (e.g. the *mother* shouldn't end up driving).
3. When the fact is an **active feat**, the subject is told to be **actively
   doing it**, not posing afterward.
4. None of this **over-constrains** facts where the subject isn't the lone actor
   (crowd reactions, subject-as-object, symbolic scenes).

This is the same engine everywhere a fact becomes an image (reference-photo
uploads, the engine bench, the generic generator), so it applies across the
board. **Nothing to switch on** — it's live by default.

## Where to look

Open the **Runtime Compiled Prompt Preview** panel (admin **Facts** page per
fact, or the **Moderation** page per review). Pick controls, click **Generate**,
and read the **compiled prompt** + the **diagnostics/warnings** panel. The new
**REFERENCE INTERPRETATION** section shows in the prompt breakdown, and
`secondaryCharacters` appears in the **Visual plan** debug view.

## 1. The hospital / baby fact (the proving case)

1. Open **"When David was born, he drove his mom home from the hospital"**
   (enriched), open the preview, choose **image-to-image (human)**, Generate.
2. In the **compiled prompt**, in order, expect:
   - **SUBJECT BINDING** — David IS the baby, one person, de-aged (the v3 fix).
   - **REFERENCE INTERPRETATION** — binds *David* as the baby who is **driving**,
     and *his mother* as **a separate adult woman in the passenger seat**.
   - **STRICT CONSTRAINTS** — includes *"keep each named character in their
     stated visual role … only David performs the central action"* and *"show
     David actively performing the central action, not posing or passively
     present afterward."*
3. **Expect NOT to see:** the mother driving; a second baby; David as a passive
   passenger in a car seat; the joke explained in words.

## 2. Solo active feat (no overfitting to multi-character)

1. Open a fact like **"David bench-pressed the moon"**, Generate.
2. Expect the **active-action** line (David actively performing).
3. **Expect NOT to see:** a "keep each named character in their role" line —
   there are no secondary characters, so there's no role-lock noise.

## 3. Multi-character authority fact

1. Open **"David fired the referee during the game"**, Generate.
2. Expect **REFERENCE INTERPRETATION** to name the **referee** as a separate
   character in their own role, and a **role-preservation** line in STRICT
   CONSTRAINTS.
3. **Expect NOT to see:** any "do not render the adult reference person
   separately" age-split language (this isn't an age transform).

## 4. Crowd reaction (subject must stay the star)

1. Open **"When David entered the room, the crowd gave itself a standing
   ovation"**, Generate.
2. Expect a soft line keeping **David the focal point** while **the crowd reacts
   to and supports him**.
3. **Expect NOT to see:** any instruction that the crowd *cannot* react, or that
   only David may act — the crowd reacting **is** the joke.

## 5. Subject-as-object / symbolic (regression — must NOT get worse)

1. Open **"The calendar added a David Franklin Week"**, Generate.
2. **Expect NOT to see:** an "actively performing the central action" line or a
   sole-agent role-lock forced onto David — he isn't literally acting here.
3. The scene should read as before; v4 must not bolt on bad action constraints.

## 6. Nonhuman / cultural (regression)

1. Open **"Sharks have a David Franklin Week"**, Generate.
2. Expect the existing **cultural reference** handling to stay intact.
3. **Expect NOT to see:** a duplicate David, or David assumed to be an active
   human agent, introduced by the new role/action logic.

## Density warnings (advisory)

If a generated plan is thin (very short core scene, empty subject details /
environment, an abstract `roleInScene` like "protagonist" on an action fact, or
a secondary character with no concrete role), the **diagnostics/warnings** panel
shows an advisory note. These are **informational only** — they never block
generation and never fail the render.

## Regression smoke table

| Surface | Action | Expect |
|---|---|---|
| Facts → preview (i2i human) | baby fact | REFERENCE INTERPRETATION + role-lock + active-action |
| Facts → preview (i2i human) | solo feat | active-action, no role-lock |
| Facts → preview (i2i human) | referee fact | referee bound, role-preservation, no age-split |
| Facts → preview | crowd fact | subject focal, crowd may react |
| Facts → preview | calendar/subject-as-object | no false active-action / role-lock |
| Visual plan debug view | any fact | `secondaryCharacters` listed |
| Diagnostics panel | thin plan | advisory density warning, render still succeeds |

## Known non-bugs / deferred

- **Subject-as-object, nonhuman transformation, symbolic/absent subjects, and
  temporal inversion are NOT "solved" here** — v4 only guarantees it doesn't make
  them worse. Their full handling is a later, larger piece of work.
- The compiler does **not** detect specific actions from prose (e.g. it won't
  infer "driving" to add vehicle-operator rules). It keys only off the structured
  frame/modifiers/roles, so a fact whose plan lacks those signals simply gets the
  conservative defaults — by design.
- The role-binding quality depends on the LLM filling `secondaryCharacters` and a
  concrete `roleInScene`; if those come back thin, you'll see a density warning
  rather than a wrong constraint.

## Bug report template

```
Fact: <text>
Mode: <i2i human / i2i nonhuman / t2i>
What I expected (per this doc): …
What the compiled prompt / image showed: …
REFERENCE INTERPRETATION line (paste): …
STRICT CONSTRAINTS lines (paste): …
Warnings shown: …
```
