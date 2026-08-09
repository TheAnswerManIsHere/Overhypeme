# Chapter 6 · Meme and Video Studio

> How you actually turn a fact into a meme — with your own photo, an
> [AI-generated image](../ai-context/glossary.md#ai-image-meme), or an AI-generated video — and what's true about each
> path underneath.
>
> Deep spec: [`meme-and-video-studio.md`](../ai-context/meme-and-video-studio.md).
> Related: [`visual-pipeline.md`](./visual-pipeline.md) (the shared machinery
> behind AI image generation), [`payments-and-membership.md`](./payments-and-membership.md)
> (what [Legendary](../ai-context/glossary.md#legendary) unlocks).

## What it does

Once you've found a fact you want to make into a meme, the [studio](../ai-context/glossary.md#studio) is where
you actually build it. You can build a meme from your own photo, a stock
or [template](../ai-context/glossary.md#template) background, or — if you're Legendary — an AI-generated image
or a short AI-generated video built around your own likeness. Whichever
[background](../ai-context/glossary.md#background) you choose, the studio composes it with the fact's text and
saves it as your meme.

## How it works

### Three ways to build a background

- **Your own photo or a built-in background.** Upload a photo, or pick a
  [stock image](../ai-context/glossary.md#stock-image) or one of the built-in templates. This is available to
  anyone signed in — no paid plan required.
- **An AI-generated image.** Legendary members can generate a new
  background image built around a source photo — this shares the same
  underlying image-generation machinery used elsewhere in the product (see
  [`visual-pipeline.md`](./visual-pipeline.md)), just entered from the
  studio instead of from moderation.
- **An AI-generated video.** Legendary members can also generate a short
  video meme, built the same way — starting from a source photo, styling
  it, then animating it. This runs as a background job with real progress
  you can watch, rather than something that finishes instantly.

Two different studio interfaces currently exist side by side while
Overhype.me finishes migrating from an older builder to a newer, guided
one — which one you land in depends on which version of the product
you're using, not on anything about your account. Both end up saving the
meme the same way underneath.

### What actually gets saved

A meme you build from your own photo, a stock image, or a template isn't
stored as a finished picture — it's saved as a **[recipe](../ai-context/glossary.md#recipe)**: which
background you chose and what text goes with it. The actual image is
composed fresh every time someone views it, not generated once and stored.
An AI-generated image or video, by contrast, *is* a real file, since
generating it is the expensive part — the meme recipe just points at that
already-generated file.

Whether an AI-generated image is private to you depends on how you made it.
One generated without a source photo joins that fact's shared gallery of AI
images, visible to anyone who later makes a meme from the same fact, the
same way a [Visual Concept](../ai-context/glossary.md#visual-concept) a moderator
authors is shared by everyone who sees that fact
(see [`visual-pipeline.md`](./visual-pipeline.md)). One generated from *your
own* source photo is the opposite — it's yours, stored only against your
account, never shared. An AI-generated video follows that same rule: it's
yours, tied to the meme you made with it.

### Where your media lives

Anything that's a real file — a photo you uploaded, an AI-generated image,
an AI-generated video — is stored the same way any other user content on
Overhype.me is stored. A meme built from a stock photo or template stores
no image of its own at all, just the recipe pointing back at the
already-existing stock photo or template.

## Why it works this way

- **Saving a recipe instead of a picture keeps a template-based meme
  current.** If Overhype.me improves how memes are composed — better text
  placement, a rendering fix — a recipe-based meme picks that improvement
  up automatically the next time anyone views it, instead of being frozen
  at whatever quality existed the moment it was made.
- **AI generation costs real money per use, so it's the Legendary
  perk.** Building from your own photo or a stock/template background
  costs Overhype.me nothing extra per meme, so it stays open to everyone
  signed in. Generating a new AI image or video does cost something every
  time, which is why that's the part gated to a paid membership rather
  than the studio as a whole.
- **AI image and video generation share the same underlying machinery on
  purpose.** Building a Visual Concept for moderation and generating a
  background from the studio both need the same identity-preserving,
  policy-respecting image generation — routing both through one shared
  pipeline means an improvement to one path is automatically true for the
  other.

## Boundaries & known limitations

- **Two studio interfaces currently coexist** during an in-progress
  migration to a newer, guided builder — this isn't a deliberate permanent
  design, just a transition David hasn't finished yet.
- **Uploading your own photo to build a meme isn't currently paywalled**,
  even though the product has machinery elsewhere that suggests it might
  once have been intended to be. **Needs David confirmation** on whether
  that's the intended, permanent behavior.
- **Removing an account's storage doesn't currently clean up every kind of
  media it created.** Photos you uploaded and AI images you generated are
  removed; the video files behind an AI video meme currently are not.
  **Needs David confirmation** on whether that's accepted, known debt or
  an oversight to fix.
- **An AI-generated image's visibility depends on how it was made, not on
  who made it.** One generated without a source photo follows the fact —
  expect other people making memes from the same fact to be able to use it
  too, the same way a moderator's Visual Concept is shared. One generated
  from your own source photo is yours alone; it never joins the shared
  gallery.

## Going deeper

- Spec: [`meme-and-video-studio.md`](../ai-context/meme-and-video-studio.md)
  — the exact routes, the recipe/`imageSource` shape, the AI video job's
  phase state machine, tier-gate specifics, and the storage layout.
- Related: [`visual-pipeline.md`](./visual-pipeline.md) (the shared image
  machinery), [`payments-and-membership.md`](./payments-and-membership.md)
  (what Legendary unlocks generally).
- Rationale: the studio/media entries in [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 7 — [`public-site-and-sharing.md`](./public-site-and-sharing.md),
home, search, [hashtags](../ai-context/glossary.md#hashtags), leaderboard,
profiles, OG cards, and [merch](../ai-context/glossary.md#merch) — the surfaces
the loop closes through.

*Verified against `e9669d2` (2026-08-09) · claim inventory in PR #371.*
