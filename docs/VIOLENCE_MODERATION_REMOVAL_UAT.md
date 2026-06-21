# Remove automatic violence/gore self-censoring — user acceptance testing

Paired with **`docs/VIOLENCE_MODERATION_REMOVAL_TEST_RUN.md`**. Click-through for David.

## What you're verifying

The image generator no longer **auto-censors** violence. The Grenade fact's CORE
SCENE used to say "…but no bodies or gore are depicted…" even when your override
asked to show the bodies. That automatic moderation is gone platform-wide: violent
facts now depict the action, bodies, and casualties the fact calls for (without
gratuitous gore). The **only** thing that softens or suppresses violence now is an
explicit **moderator render-policy override** on a specific fact.

## Where to look

Admin → **Facts** → the Grenade fact → **Runtime Compiled Prompt Preview**
(the single source of truth for the rendered prompt).

## 1. Grenade — default (the bug)

1. Open the Grenade fact and **re-run classification** (so the fresh AI baseline
   no longer carries the retired `avoid_gore` / `non_graphic_action` modifiers —
   the data migration also strips them from the existing record).
2. Open the Runtime Compiled Prompt Preview.
3. Expect the **CORE SCENE** to NOT contain "no bodies or gore are depicted" (or
   "non-graphic", "no blood", "no casualties").
4. Expect **STRICT CONSTRAINTS** to carry the violence allow line: *"When the fact
   explicitly requires violence, death, weapons, or destruction, depict the action
   and consequences clearly without gratuitous gore."*

## 2. Grenade — with your "show the bodies" override

1. On the Grenade fact's **Visual Strategy Override**, keep your guidance to show
   the fallen soldiers.
2. Preview again → the override now **reinforces** the scene (CORE SCENE + STRICT
   CONSTRAINTS both point the same way) instead of contradicting a "no bodies"
   line.

## 3. Moderator suppress still works

1. On a violent fact, set the **violence policy override** to **suppress** (with
   guidance, e.g. "keep it bloodless / symbolic").
2. Preview → STRICT CONSTRAINTS shows the suppress line ("Do not depict violence,
   injury, or death directly…") and the allow line is **absent**. The RENDER
   POLICY context the generator sees also says SUPPRESS.
3. Set it to **soften** → the soften line appears instead. This confirms
   deliberate moderator control is intact.

## 4. A wholesome / non-violent fact is unaffected

1. Open a non-violent fact (e.g. a wholesome feat) and preview.
2. Expect **no** violence allow line and no violent content — nothing changed for
   non-violent facts.

## Regression smoke table

| Area | Expectation |
|------|-------------|
| Non-violent fact render | Unchanged; no violence directives |
| Visual Strategy Override panel | Works as before; suppress/soften still honored |
| Re-classification of any fact | No longer adds `avoid_gore` / `non_graphic_action` |
| Existing facts (post-migration) | Retired modifiers already stripped from stored data |
| `avoid_weapons_focus` / `avoid_gross_literalization` | Still selectable; still apply their (non-violence) presentation directive |

## Known non-bugs / limitations

- Violent/destructive facts can now render **more direct** bodies/casualties/
  aftermath than before — that's the intended change. Gratuitous gore remains the
  boundary, and a moderator can still `soften`/`suppress` a specific fact.
- This is generation guidance: the image model is *told* not to self-censor, but
  model behavior isn't 100% deterministic. If a specific render still looks
  sanitized, re-running it or strengthening the override guidance helps.

## Bug report template

```
Fact id / text:
Default or override (which mode)?:
CORE SCENE excerpt:
STRICT CONSTRAINTS excerpt:
Expected vs actual:
```
