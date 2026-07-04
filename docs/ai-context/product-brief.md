# Overhype.me Product Brief

> Current, concise product truth. If this conflicts with an older note or an
> agent's memory, **this file wins** (and if it's wrong, fix it here). For the
> *why/priorities* see [`product-direction.md`](./product-direction.md) and
> [`current-roadmap.md`](./current-roadmap.md); for *how it's built* see
> [`architecture-map.md`](./architecture-map.md); for term definitions see the
> [`glossary.md`](./glossary.md).

## Product in one paragraph

Overhype.me is a **personalized impossible-facts platform**: a community-driven
database of exaggerated, Chuck-Norris-style boasts that render with *your* name
and pronouns and turn into shareable image and video memes starring you. A fact
is authored once as a tokenized template — e.g.
`When {NAME} {laughs|laugh}, the earth cries.` — and rendered on demand for any
name/pronoun set, so the same fact reads naturally about "David" (he/him),
"Alex" (they/them), or anyone. Type your name on the homepage and every fact on
the site instantly becomes about you; no account required to browse.

## Core product loop

**Personalize → submit → moderate & enrich → render a meme → share → new visitor
personalizes.** A visitor sets a name and sees personalized facts; a registered
user submits their own fact; a human moderator triages, enriches, and approves it
into a live fact with an authored visual concept; the fact renders into an image
or video meme; the shared meme pulls the next visitor back into the loop. A large
catalogue of great-rendering, personalizable facts is the fuel the loop runs on.

## Brand and tone

**Mock-heroic, positive, cinematic, tongue-in-cheek.** Facts celebrate the
subject as an over-the-top legend — grounded and confident, never mean or
degrading. Visually the public app is a dark theme with fire-orange accents; the
rendered name is highlighted in orange. Keep the humor warm and the hero
flattering. The public frontend follows the `overhype-design` skill (brand
tokens, component patterns, anti-patterns); **internal/admin tools deliberately
do not** — they favor speed and legibility over polish.

## User personalization model

Personalization is **fundamental, not incidental**. Facts are stored as templates
containing a closed set of tokens (name, pronoun set, verb-conjugation pairs) and
are rendered per viewer. Names and pronouns are first-class: the tokenizer must
produce grammatically correct output across he/him, she/her, and they/them, and
the renderer substitutes tokens deterministically. See
[`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md).

## AI-generated media model

Facts become media through a multi-stage, human-supervised pipeline:

- **Image memes** — a moderator authors or picks a **Visual Concept** (the
  authoritative scene), a frontier-model **visual planner** realizes it, and a
  deterministic compiler produces the engine prompt for the current image engine.
  Free users get **photo memes** (their own face composited onto scenes);
  **Legendary** subscribers unlock **AI image memes** (their face in impossible
  scenes).
- **Video memes** — a multi-stage pipeline (identity stylization → image-to-video
  → caption burn-in); Legendary only.

See [`visual-pipeline.md`](./visual-pipeline.md). AI **classification**
(archetype, taxonomy) is separate from image generation — see
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).

## Pre-launch assumptions

- The product is **pre-launch.** Top goals are **stability / launch-readiness**
  and **content volume + quality**.
- New features ship **on-by-default, without rollout flags** (see product
  principles). The bar is "confidently correct," not "toggleable."
- Moderation is intentionally human-heavy right now to guarantee quality while the
  catalogue is small; the long-term arc is to scale that quality bar with more AI
  assistance as volume grows.

## Paid / free model (currently relevant)

Two user-facing tiers gate on **per-use cost**, not a credit balance:

- **Free** — everything that doesn't cost per-render money: browse, personalize,
  submit facts, comment, vote, and **photo** memes (your face on templates).
- **Legendary** — the paid per-render surfaces: **AI image memes** and **AI video
  memes**. Plans are monthly, annual, and a one-time lifetime ("Legendary for
  Life"), fetched live from Stripe. There are **no consumer "credits"**; server-side
  budget/spend caps gate generation cost.

Membership tiers in code: `unregistered | registered | legendary` (separate from
the `is_admin` flag). Merch is print-on-demand via a Zazzle affiliate.

## Product principles agents must preserve

(Full list in [`agent-working-rules.md`](./agent-working-rules.md) and the root
[`AGENTS.md`](../../AGENTS.md); the load-bearing product ones:)

- **Human-moderated decisions must not be silently overwritten by AI reprocessing.**
- **Runtime behavior must match admin preview/debug surfaces** (what the moderator
  sees is what ships).
- **Ship the surface with the behavior** — no dead UI, no invisible backend.
- **Async work shows per-item + aggregate status** at all times (Taxonomy Health is
  the reference implementation).
- **Avoid duplicate sources of truth.**

## Things intentionally deferred

- Broad public-growth features and free→Legendary conversion optimization —
  *real, but after stability + content quality.*
- New content formats beyond "facts" — *Future / not current scope.*
- A multi-role admin permission system — *not needed yet; one `is_admin` role.*
- R2 storage consolidation (images currently persist to Google Cloud Storage) —
  *Future / not current scope.*
- Net-new monetization mechanics — *Future / not current scope.*
