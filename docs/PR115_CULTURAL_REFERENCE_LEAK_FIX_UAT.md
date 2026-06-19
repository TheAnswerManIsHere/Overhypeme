# Cultural-reference leak + Do-not normalizer (PR #115) — user acceptance testing

Paired with **`docs/PR115_CULTURAL_REFERENCE_LEAK_FIX_TEST_RUN.md`** (the automated
checklist). Click-through test for David.

## What you're verifying

A bug fix on top of Phase 2 (#114). Two things stopped leaking into the final
image-engine prompt:

1. **The cultural-reference explanation no longer appears in the prompt.** Cultural
   references exist to tell the *planner* how to read the fact (e.g. "Shark Week"
   → a TV programming block, so depict sharks watching the subject on a screen).
   The planner already turns that into the actual scene. The engine prompt should
   carry the **scene**, not the meta-explanation or the brand name.
2. **No more `Do not Don’t …`** — a forbidden detail you typed starting with a
   curly apostrophe (`Don’t`) used to get a second "Do not" stuck in front of it.

**Nothing to switch on.** Verify in the existing **Runtime Compiled Prompt
Preview**.

## 1. Sharks {NAME} Week — cultural reference no longer leaks

1. Open **"Sharks have a {NAME} Week"** (enriched, with the Shark Week cultural
   reference) → **Runtime Compiled Prompt Preview** → Generate.
2. In **CORE SCENE**, expect the gag itself — sharks gathered around a screen
   watching the subject.
3. In **STRICT CONSTRAINTS**, **expect NOT to see**:
   - `Cultural references: treat "Shark Week" as …`
   - the brand name **"Discovery Channel"** (or any canonical-reference text)
4. If you added a **required supporting-text** override (the TV title), it still
   appears in **REQUIRED VISUAL DETAILS** / **SUPPORTING TEXT** — that's your
   intended text and is unaffected.

**Expect:** the scene reads the same (sharks watching the subject), but the
behind-the-scenes "what Shark Week means" explanation is gone from the prompt.

## 2. Forbidden detail with a curly apostrophe

1. On any fact with a Visual Strategy Override enabled, add a **Forbidden Visual
   Detail**: `Don’t render any other text besides what is asked for` (note the
   curly apostrophe — what you get from most editors/phones).
2. Save, Generate.
3. In **STRICT CONSTRAINTS**, expect the line exactly once: *"Don’t render any
   other text besides what is asked for."* — **not** `Do not Don’t render …`.

## Regression smoke table

| Surface | Action | Expect |
|---|---|---|
| Facts → preview | Shark-Week fact | gag in CORE SCENE; no `Cultural references:` / "Discovery Channel" in STRICT CONSTRAINTS |
| Facts → preview | required-text override | the title still rendered (unaffected) |
| Facts → preview | forbidden detail starting "Don’t…" | single line, no double "Do not" |
| Facts → preview | any non-cultural fact | unchanged |

## Known non-bugs / out of scope

- **Semantic-entity** lines (`Interpret these terms exactly: "Earth" means the
  planet Earth…`) are **still emitted** on purpose — they resolve capitalization
  ambiguity that affects the image. If you want those treated as planner-only too,
  tell me and I'll apply the same change.
- This PR doesn't change how the planner *uses* cultural references — only that
  the deterministic compiler no longer copies them into the final prompt.

## Bug report template

```
Fact: <text>
What I expected (per this doc): …
STRICT CONSTRAINTS paste: …
CORE SCENE paste: …
```
