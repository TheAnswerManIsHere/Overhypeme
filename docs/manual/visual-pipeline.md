# Visual Pipeline

> How a fact becomes a rendered image — the machinery behind every meme
> Overhype.me makes, whatever the fact and whoever it's personalized for.
> The moderator's experience of *using* this machinery — writing and
> approving a Visual Concept — is [`moderation.md`](./moderation.md)'s
> chapter; this one is the pipeline underneath it.
>
> Deep spec: [`visual-pipeline.md`](../ai-context/visual-pipeline.md).
> Rationale history: [`decisions.md`](../ai-context/decisions.md).

## What it does

Every render starts from one thing: a **Visual Concept** — a plain-English
description of the scene, authored by a moderator (or picked from an
AI-drafted option) and stored on the fact. From there, the pipeline is
mechanical and the same for every fact: a planner turns the concept and the
fact's other details into a structured scene plan, a compiler turns that
plan into the actual instructions sent to the image engine, and the engine
renders it. Nothing about *what the picture shows* is left to chance once a
concept exists — the concept is the contract, and the rest of the pipeline
exists to carry it faithfully into a real image.

## How it works

### The Visual Concept leads

The compiled prompt sent to the image engine always opens with the Visual
Concept, verbatim (once tokenized for whoever the fact is being personalized
for). Everything the pipeline adds after it — identity handling, role
details, environment, lighting, style, the engine's safety rules — is either
mechanical setup or an *additive* detail that earns its place only by adding
something the Concept didn't already say. If a later section would just
restate the Concept in different words, it's left out rather than sent
twice. This is why a moderator authoring a scene doesn't need to think about
the rest of the prompt at all — they're writing the one sentence that
actually drives the picture, in plain language, the same way they'd describe
the joke to another person.

### Candidate concepts, so no moderator starts from a blank page

Before a moderator ever sees the Visual Concept field, the pipeline has
already drafted candidate scenes for them to consider — full concepts, not
just fragments, each usable regardless of which render mode the fact ends up
using. Picking one adopts it whole; nothing from a candidate gets partially
merged into what's already there, so a moderator is never left guessing
which half of a scene came from where. See
[`moderation.md`](./moderation.md#for-the-moderator-three-steps) for what
picking, editing, or writing a concept actually looks like from the review
screen.

### Speech and thought bubbles are compiler language, not moderator prose

A moderator can mark that a character in the scene is speaking or thinking
something specific, and the pipeline turns that into its own dedicated
instruction to the engine — deliberately not left for the moderator to write
into the Concept as prose. Two different authors writing about the same
balloon in two different places is exactly the kind of drift this pipeline
is built to avoid, so bubble language has exactly one owner.

### Render modes: what the engine is asked to preserve

Not every fact renders the same way. Depending on what image material is
available for whoever the fact is personalized for, the pipeline asks the
engine to preserve a real uploaded likeness, preserve a non-human subject
from a reference image, or render from description alone with no reference
at all. Which mode applies is inferred automatically from the available
image material, with room for a human override when the automatic read is
wrong.

### Frozen at the moment of generation, not resolved live

The specific identity and visual style a render uses are locked in the
instant generation is requested — not re-looked-up later by whatever worker
happens to pick up the job. That matters because a render can queue for a
while before it actually runs, and identity or style preferences can change
in the meantime; freezing means the image that comes back always matches
what the person saw when they clicked, not whatever happened to be true by
the time a worker got to it.

### The engine gets a scene, never bare instructions to avoid text

There's no rule anywhere in this pipeline against an image containing
readable text. What's actually excluded is narrow: the pipeline never bakes
a meme's caption, the fact's own wording, or a watermark into the image
itself as rendered text — those belong to the meme layer on top of the
image, not inside it. Signage, screens, scoreboards, or other text that's
genuinely part of the scene is allowed, and a moderator can lean into or
away from it for a given fact.

## Why it works this way

- **A human writes the one sentence that actually matters, and the machine
  handles everything else.** Cultural nuance, phrasing, and knowing what
  makes a joke *land visually* are all things a moderator judges far better
  than a model — so the pipeline hands the AI planner and compiler a fixed,
  human-authored anchor and lets them handle only the mechanical parts:
  identity preservation, layout, style, and the engine's own operational
  rules. Splitting the work this way is also what makes "approve the visual
  gag" (see [`moderation.md`](./moderation.md)) a meaningful human checkpoint
  instead of a rubber stamp — the moderator is approving the thing that
  actually decides how the joke reads, not a downstream detail.
- **Bubble language has exactly one owner because two owners drift.** If
  both a moderator's free-text Concept and the compiler's own dedicated
  instruction could describe the same speech balloon, they'd eventually say
  different things about it — one authored ahead of time, one generated at
  compile time. Giving the compiler sole ownership of that language removes
  the seam entirely, and the moderator still controls *what* is said and
  *who* says it, just not the exact phrasing sent to the engine.
- **Freezing identity and style at generation time, not re-resolving them
  later, is what makes a render reproducible.** A worker that looked up
  "whatever the user's current style preference is" at execution time could
  render something the person never actually asked for, if they changed a
  preference while the job was queued. Freezing at the moment of the click
  ties the image to what was true then, permanently.
- **No blanket ban on in-image text, because the exclusion that actually
  matters is much narrower.** The real risk is the engine baking a caption
  or watermark into the picture itself, where it can't be edited or
  localized like the meme layer on top can be. Signage or a scoreboard that's
  genuinely part of the scene doesn't carry that risk, so banning all
  in-image text would trade a real problem for a much larger, unnecessary
  restriction on what a scene can depict.

## Boundaries & known limitations

- **The AI's read on how well a fact suits its identity material is
  advisory only — it never blocks a render.** Facts are curated by hand
  already, so a render proceeds even when the pipeline itself would have
  rated the fit poorly; the rating exists for a moderator to notice, not to
  gate anything automatically.
- **The admin preview of the compiled prompt runs through the same code as
  a real render, but isn't guaranteed to produce byte-identical output** —
  the underlying model call isn't fully deterministic, so a preview is a
  faithful preview of the *shape* of what will be sent, not a promise that
  the exact wording will match a subsequent real render word for word.
- **A candidate concept being pickable doesn't guarantee it will still fit
  once actually saved** — a candidate is checked against its own scene and
  bubbles in isolation; whether it fits alongside everything else already
  on that fact's Visual Strategy is checked again, separately, at the
  moment of saving.

## Going deeper

- Spec: [`visual-pipeline.md`](../ai-context/visual-pipeline.md) — the
  planner, the compiler's section-by-section assembly, the prompt budget,
  render-mode resolution, frozen-input mechanics, and the full list of
  retired mistakes this pipeline must not reintroduce.
- Related: [`moderation.md`](./moderation.md) (the Visual Concept gate and
  the moderator's review experience), [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md)
  (enrichment as a planner *input*, never the prompt itself),
  [`token-rendering-and-grammar.md`](../ai-context/token-rendering-and-grammar.md)
  (the same tokenizer core that personalizes both facts and authored
  Visual Concepts).
- Rationale: the visual-pipeline entries in
  [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 6 — *meme and video studio*, what an end user actually
makes with this pipeline. [Not yet written](./README.md#contents).

*Verified against `0ea4ed8` (2026-08-08) · claim inventory in PR #361.*
