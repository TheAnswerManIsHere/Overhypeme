# PR #222 — NB2 Prompt Restructure — UAT

The **compiled image prompt** the engine receives is now leaner and less
self-contradictory. The moderator Visual Concept reaches the engine
**verbatim** (no longer paraphrased or partly stripped), the selected
visual **style** lives in its own line instead of being mixed into the
scene lighting, and text that is meant as a **picture** (a flatlined
monitor trace) is no longer quoted as if it were **words** to spell out.

You verify this in the **admin Runtime Compiled Prompt preview** — no
render spend required to see the prompt change.

## Setup

- [david] Sign in as an admin.
- [claude] Ensure a fact has a moderator Visual Concept (Core Scene)
  authored — the David-vs-cobra scene is the reference case — or author
  one on any fact.

## Steps

### 1. The concept text reaches the prompt verbatim

**Do:** Compare the `CORE SCENE:` block in the compiled prompt against
the Visual Concept you authored.

**Expect:** they match word for word (after name/pronoun rendering) —
nothing reworded, no sentences dropped.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:emits the moderator scene VERBATIM — compiler-owned language kept, not stripped — and warns`

### 2. The concept isn't restated three times

**Do:** Look at `ROLE DETAILS` / `SUBJECT DETAILS` / `ENVIRONMENT` in the
same compiled prompt.

**Expect:** the gag elements from the Concept appear once, in `CORE
SCENE`; these sections only add details the Concept omitted (often
little or nothing) — they no longer re-tell the whole scene.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:drops a tight restatement of the scene but keeps a distinct detail that reuses scene words`

### 3. Style lives in its own section when no style is selected

**Do:** With no visual style selected, open the compiled prompt and look
at `RENDER STYLE:` and `LIGHTING:`.

**Expect:** `RENDER STYLE:` reads "Photorealistic rendering: …";
`LIGHTING:` contains only light/mood — no "anime" / "oil painting" /
medium words mixed in.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:emits the photorealistic default RENDER STYLE when no style is selected`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 4. Style lives in its own section when a style is selected

**Do:** Pick a visual style (e.g. Anime) in the style control, re-open
the preview, and look at `RENDER STYLE:` and `LIGHTING:`.

**Expect:** `RENDER STYLE:` carries that style's phrasing; `LIGHTING:`
still contains only light/mood, with no style/medium words mixed in, and
the style doesn't appear twice.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:single-channel style: LIGHTING carries only light/mood, style goes to its own RENDER STYLE section`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 5. Readable in-scene text is quoted

**Do:** Find a scene with a readable label (e.g. a toe tag reading
`COBRA`) and check how it appears in the compiled prompt.

**Expect:** it appears quoted: `Render this in-scene text clearly:
"COBRA"`.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:renders the planner's in-scene text and excludes overlay text (no blanket ban)`

### 6. Picture-only text is not quoted as words

**Do:** Find a scene with a visual that used to get quoted (a flatline
trace, crossed-off calendar days) and check how it appears in the
compiled prompt.

**Expect:** it appears under `Depict these as visuals, not as written
words: …` — unquoted.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:routes kind=visual_graphic UNQUOTED (never baked in as literal words) while literal_text stays quoted`

### 7. An owned-language warning is advisory only

**Do:** Author a Concept that includes a phrase the compiler owns (e.g.
"preserve his recognizable face") and open the preview.

**Expect:** the phrase is kept verbatim (not stripped), and the preview's
diagnostics show a `moderator_core_scene_owned_language` warning nudging
you to rewrite it as pure scene description; the render still proceeds.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:emits the moderator scene VERBATIM — compiler-owned language kept, not stripped — and warns`

### 8. An empty Concept still uses the AI scene, at full strictness

**Do:** Open the preview for a fact with no authored Concept.

**Expect:** it uses the AI scene, and the AI scene still requires its
usual detail (subject + environment) — the "may be empty" relaxation
applies only when a moderator Concept is present.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:keeps the AI path unchanged when the override's scene is empty/blank or absent`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 9. Style phrasing differs between i2i and t2i, with a default for none

**Do:** Compare the compiled prompt for a styled image-to-image render
against a styled text-to-image render, then check the `none` style.

**Expect:** i2i uses "Reimagine this…" phrasing; t2i uses the declarative
form; and with the `none` style the `RENDER STYLE:` line reads
"Photorealistic rendering: true-to-life materials and textures, realistic
optical detail, and the clarity of a high-quality photograph."

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/styleResolution.test.ts:resolves a valid active style, i2i uses promptSuffixReference` `artifacts/api-server/src/__tests__/styleResolution.test.ts:resolves a valid active style, t2i uses promptSuffix` `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:emits the photorealistic default RENDER STYLE when no style is selected`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted


## Regression

### R1. Overlay-text exclusion still holds

**Do:** Open the compiled prompt for any fact and check `STRICT
CONSTRAINTS`.

**Expect:** the overlay-text exclusion (no baked meme caption, watermark,
or logo) is still present.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:STRICT CONSTRAINTS policy guardrails are preserved (overlay-text + incidental-text)`

### R2. Subject binding / anti-split still holds

**Do:** Open the compiled prompt for a de-aging fact and check subject
binding.

**Expect:** unchanged — one subject, no clone.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:emits anti-entity-split constraints for age transforms`

### R3. Violence policy default is unchanged

**Do:** Open the compiled prompt for any fact and check the violence
policy.

**Expect:** unchanged default (visible consequences, no gratuitous gore).

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:emits the self-conditioned violence permission line for a violent fact (default policy)`

### R4. Identity/reference clause is still emitted

**Do:** Open the compiled prompt for any fact and check the
identity/reference clause.

**Expect:** still compiler-owned, still emitted.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:human i2i: a STRONG identity clause is the section right after CORE SCENE`

### R5. Nonhuman i2i/t2i fallback prompts are unchanged

**Do:** Open the compiled prompt for a nonhuman subject in both i2i and
t2i mode.

**Expect:** unchanged mode preambles.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:nonhuman: prepends the i2i lead with the human guard exactly once` `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:t2i: bakes in fallback gender once, no i2i identity language, no reference url`

## Not bugs

- **Preview ≠ byte-identical to a live render** — the planner runs at
  temperature 0.4, so wording varies run to run. That's temperature, not
  a bug.
- **Reproducibility / budget hardening is a follow-up.** Freezing the
  exact identity+style used by a queued render, terminal-vs-retryable
  failure handling, and the enforced authoring character-budget are the
  *next* PR — not this one.
- **Global style-copy trim (PR-B) is separate** — the style *phrasing*
  itself is trimmed in a later PR; this PR only changes *where* style is
  emitted (its own section) and adds the photorealistic default.
