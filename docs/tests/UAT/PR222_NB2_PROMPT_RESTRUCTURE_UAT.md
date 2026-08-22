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

### 2. The concept isn't restated three times

**Do:** Look at `ROLE DETAILS` / `SUBJECT DETAILS` / `ENVIRONMENT` in the
same compiled prompt.

**Expect:** the gag elements from the Concept appear once, in `CORE
SCENE`; these sections only add details the Concept omitted (often
little or nothing) — they no longer re-tell the whole scene.

### 3. Style lives in its own section when no style is selected

**Do:** With no visual style selected, open the compiled prompt and look
at `RENDER STYLE:` and `LIGHTING:`.

**Expect:** `RENDER STYLE:` reads "Photorealistic rendering: …";
`LIGHTING:` contains only light/mood — no "anime" / "oil painting" /
medium words mixed in.

### 4. Style lives in its own section when a style is selected

**Do:** Pick a visual style (e.g. Anime) in the style control, re-open
the preview, and look at `RENDER STYLE:` and `LIGHTING:`.

**Expect:** `RENDER STYLE:` carries that style's phrasing; `LIGHTING:`
still contains only light/mood, with no style/medium words mixed in, and
the style doesn't appear twice.

### 5. Readable in-scene text is quoted

**Do:** Find a scene with a readable label (e.g. a toe tag reading
`COBRA`) and check how it appears in the compiled prompt.

**Expect:** it appears quoted: `Render this in-scene text clearly:
"COBRA"`.

### 6. Picture-only text is not quoted as words

**Do:** Find a scene with a visual that used to get quoted (a flatline
trace, crossed-off calendar days) and check how it appears in the
compiled prompt.

**Expect:** it appears under `Depict these as visuals, not as written
words: …` — unquoted.

### 7. An owned-language warning is advisory only

**Do:** Author a Concept that includes a phrase the compiler owns (e.g.
"preserve his recognizable face") and open the preview.

**Expect:** the phrase is kept verbatim (not stripped), and the preview's
diagnostics show a `moderator_core_scene_owned_language` warning nudging
you to rewrite it as pure scene description; the render still proceeds.

### 8. An empty Concept still uses the AI scene, at full strictness

**Do:** Open the preview for a fact with no authored Concept.

**Expect:** it uses the AI scene, and the AI scene still requires its
usual detail (subject + environment) — the "may be empty" relaxation
applies only when a moderator Concept is present.

### 9. Style phrasing differs between i2i and t2i, with a default for none

**Do:** Compare the compiled prompt for a styled image-to-image render
against a styled text-to-image render, then check the `none` style.

**Expect:** i2i uses "Reimagine this…" phrasing; t2i uses the declarative
form; the `none` style shows a "Default for Nano Banana 2:
Photorealistic" default line.

## Regression

### R1. Overlay-text exclusion still holds

**Do:** Open the compiled prompt for any fact and check `STRICT
CONSTRAINTS`.

**Expect:** the overlay-text exclusion (no baked meme caption, watermark,
or logo) is still present.

### R2. Subject binding / anti-split still holds

**Do:** Open the compiled prompt for a de-aging fact and check subject
binding.

**Expect:** unchanged — one subject, no clone.

### R3. Violence policy default is unchanged

**Do:** Open the compiled prompt for any fact and check the violence
policy.

**Expect:** unchanged default (visible consequences, no gratuitous gore).

### R4. Identity/reference clause is still emitted

**Do:** Open the compiled prompt for any fact and check the
identity/reference clause.

**Expect:** still compiler-owned, still emitted.

### R5. Nonhuman i2i/t2i fallback prompts are unchanged

**Do:** Open the compiled prompt for a nonhuman subject in both i2i and
t2i mode.

**Expect:** unchanged mode preambles.

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
