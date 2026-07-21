# PR222 — NB2 prompt restructure (core) · UAT (click-through)

What this PR changes, in product terms: the **compiled image prompt** the engine
receives is now leaner and less self-contradictory. The moderator Visual Concept
reaches the engine **verbatim** (no longer paraphrased or partly stripped), the
selected visual **style** lives in its own line instead of being mixed into the
scene lighting, and text that is meant as a **picture** (a flatlined monitor
trace) is no longer quoted as if it were **words** to spell out.

You verify this in the **admin Runtime Compiled Prompt preview** — no render
spend required to see the prompt change.

## Where to go

1. Admin → a fact that has a moderator **Visual Concept (Core Scene)** authored
   (or author one on any fact — the David-vs-cobra scene is the reference case).
2. Open the **Runtime Compiled Prompt** preview for that fact.
3. (Optional) Pick a **visual style** (e.g. Anime) in the style control and
   re-open the preview to see the style behavior.

## The happy path

- **Concept is verbatim.** The `CORE SCENE:` block in the compiled prompt matches
  the Visual Concept you authored, word for word (after name/pronoun rendering).
  Nothing is reworded, and sentences aren't dropped.
- **No triple-restatement.** The gag elements from the Concept appear once, in
  `CORE SCENE`. `ROLE DETAILS` / `SUBJECT DETAILS` / `ENVIRONMENT` only add
  details the Concept omitted (often little or nothing) — they no longer re-tell
  the whole scene.
- **Style is one line.** There's a `RENDER STYLE:` section. With no style
  selected it reads "Photorealistic rendering: …". With a style selected it
  carries that style's phrasing. `LIGHTING:` contains only light/mood — no
  "anime" / "oil painting" / medium words mixed in.
- **Picture-text vs word-text.** If the scene has a readable label (e.g. a toe
  tag reading `COBRA`), it appears quoted: `Render this in-scene text clearly:
  "COBRA"`. If the scene has a *visual* that used to get quoted (a flatline
  trace, crossed-off calendar days), it now appears under `Depict these as
  visuals, not as written words: …` — **unquoted**.

## Edge cases to spot-check

- **Concept with instruction-y wording.** If a Concept happens to include a
  phrase the compiler owns (e.g. "preserve his recognizable face"), it is **kept
  verbatim** (not stripped) but the preview's diagnostics show a
  `moderator_core_scene_owned_language` warning nudging you to rewrite it as pure
  scene description. This is advisory — the render still proceeds.
- **Empty Concept.** A fact with no authored Concept still uses the AI scene, and
  the AI scene still requires its usual detail (subject + environment) — the
  "may be empty" relaxation applies only when a moderator Concept is present.
- **Styled i2i vs t2i.** In an image-to-image render the style uses its
  "Reimagine this…" phrasing; in text-to-image it uses the declarative form. The
  `none` style shows a "Default for Nano Banana 2: Photorealistic" default line.

## What should NOT happen

- The Concept text is **not** reworded, summarized, or missing sentences.
- A visual description is **not** wrapped in quotes as literal text to spell out.
- The selected style does **not** appear inside `LIGHTING`, and does **not**
  appear twice.
- A fact **with** a Concept is **not** rejected for having empty
  subject/environment/key-element lists.

## Regression smoke (existing behavior unchanged)

| Check | Expect |
|---|---|
| Overlay-text exclusion (no baked meme caption/watermark/logo) | still present in `STRICT CONSTRAINTS` |
| Subject binding / anti-split (de-aging facts) | unchanged — one subject, no clone |
| Violence policy default | unchanged (visible consequences, no gratuitous gore) |
| Identity/reference clause | still compiler-owned, still emitted |
| Nonhuman i2i / t2i fallback prompts | unchanged mode preambles |

## Known non-bugs / limitations

- **Preview ≠ byte-identical to a live render** — the planner runs at temperature
  0.4, so wording varies run to run. That's temperature, not a bug.
- **Reproducibility / budget hardening is a follow-up.** Freezing the exact
  identity+style used by a queued render, terminal-vs-retryable failure handling,
  and the enforced authoring character-budget are the *next* PR — not in this one.
- **Global style-copy trim (PR-B) is separate** — the style *phrasing* itself is
  trimmed in a later PR; this PR only changes *where* style is emitted (its own
  section) and adds the photorealistic default.

## Bug report template

```
Fact / Concept:
Style selected:
Section that looks wrong (CORE SCENE / RENDER STYLE / LIGHTING / STRICT CONSTRAINTS / …):
What the compiled prompt shows:
What you expected instead:
```
