# Stop leaking interpretation meta (cultural refs + semantic entities) · PR #115 — user acceptance testing

Paired with **`docs/PR115_CULTURAL_REFERENCE_LEAK_FIX_TEST_RUN.md`** (the automated
checklist). Click-through test for David.

## What you're verifying

Two kinds of behind-the-scenes "how to read the fact" data were leaking into the
final image-engine prompt, and now don't — **but the actual visual they produce
still reaches the engine**:

1. **Cultural references** — `treat "Shark Week" as Discovery Channel's Shark Week`
   (the explanation + brand name) no longer appears. The *scene* it implies
   (sharks watching the subject on a screen) still does.
2. **Semantic entities** — `Interpret these terms exactly: "Earth" means the planet
   Earth` no longer appears. The *resolved thing* (the planet Earth in the scene)
   still does.

The key guarantee: even if the AI planner forgets to write the gag into the main
scene description, the compiler still feeds the concrete visual to the engine — so
the joke can't silently vanish. It just feeds the **picture**, never the
explanation or the brand.

**Nothing to switch on.** Verify in the existing **Runtime Compiled Prompt
Preview**.

## 1. Sharks {NAME} Week — meta gone, gag survives

1. Open **"Sharks have a {NAME} Week"** (enriched, with the Shark Week cultural
   reference) → **Runtime Compiled Prompt Preview** → Generate.
2. **Expect NOT to see** anywhere in the prompt:
   - `Cultural references: treat "Shark Week" as …`
   - the brand **"Discovery Channel"** (or any canonical-reference text)
3. **Expect to see** the gag as concrete scene content — either inside **CORE
   SCENE** (if the planner baked it in) or under **"Ensure these elements are
   clearly visible: … sharks … on a screen …"** (the compiler safety net). Either
   way the sharks-watching-the-subject visual is present.
4. Any **required supporting-text** override (the TV title) is unaffected and
   still appears.

## 2. "Earth" fact — planet reaches the scene, no interpretation line

1. Open a fact where enrichment flagged **"Earth"** as the planet (capitalized) —
   e.g. *"{NAME} bench-presses the Earth"* → Generate.
2. **Expect NOT to see** `Interpret these terms exactly: "Earth" means …`.
3. **Expect to see** the planet as concrete content — in **CORE SCENE** or under
   **"Ensure these elements are clearly visible"** (e.g. "the planet Earth seen
   from orbit"). The disambiguation still reaches the engine, just as a picture.

## 3. Forbidden detail with a curly apostrophe (unchanged from first cut)

1. On a fact with a Visual Strategy Override, add a **Forbidden Visual Detail**:
   `Don’t render any other text besides what is asked for` (curly apostrophe).
2. Generate → **STRICT CONSTRAINTS** shows the line once — **not** `Do not Don’t …`.

## Regression smoke table

| Surface | Action | Expect |
|---|---|---|
| Facts → preview | Shark-Week fact | gag present (CORE SCENE or ensure-visible); no `Cultural references:` / "Discovery Channel" / "treat as" |
| Facts → preview | Shark-Week, generic AI scene | gag still feeds via ensure-visible (safety net) |
| Facts → preview | "Earth" = planet fact | planet present; no "Interpret … means" |
| Facts → preview | required-text override | title still rendered (unaffected) |
| Facts → preview | forbidden detail starting "Don’t…" | single line, no double "Do not" |
| Facts → preview | fact with no cultural/semantic flags | unchanged |

## Known non-bugs / out of scope

- This PR doesn't change how the planner *uses* cultural references or semantic
  entities — only that the deterministic compiler no longer copies the
  interpretation meta into the final prompt (while still guaranteeing the concrete
  visual).
- If a cultural `visualImplicationUsed` or semantic `visualReferentUsed` itself
  contains a brand word, that's authored upstream by the planner (the system
  prompt forbids brand marks); this change removes the *canonical-reference*
  brand leak the compiler was adding.

## Bug report template

```
Fact: <text>
What I expected (per this doc): …
CORE SCENE paste: …
"Ensure these elements are clearly visible" line paste: …
STRICT CONSTRAINTS paste: …
```
