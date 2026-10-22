# Chapter 6 · Meme and Video Studio

> How you actually turn a fact into a meme — with your own photo, an
> [AI-generated image](../ai-context/glossary.md#ai-image-meme), or an AI-generated video — and what's true about each
> path underneath.
>
> Deep spec: [`meme-and-video-studio.md`](../ai-context/meme-and-video-studio.md).
> Related: [`5-visual-pipeline.md`](./5-visual-pipeline.md) (the shared machinery
> behind AI image generation), [`10-payments-and-membership.md`](./10-payments-and-membership.md)
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
- **An AI-generated image.** Legendary members can style a source photo
  into the fact's scene. Every AI image starts from a photo of yours; there
  is no generating from a description alone, and no shared per-fact gallery
  of AI images to pick from (that picker went with the older studio).
- **An AI-generated video.** Legendary members can also generate a short
  video meme, built the same way — starting from a source photo, styling
  it, then animating it. This runs as a background job with real progress
  you can watch, rather than something that finishes instantly.

You build memes in one of two places. On a fact's page, the guided builder
walks you through it. On a shared meme's page, "make this about me" opens a
single-screen builder that remakes that meme for you, and Legendary members
can style their own photo into it there too. An older studio that used to
sit behind the fact page was deleted before launch
([decisions](../ai-context/decisions.md#2026-10-22--the-legacy-meme-studio-is-deleted-the-user-generate-route-survives-photo-only-until-pulid-goes)).

### What actually gets saved

A meme you build from your own photo, a stock image, or a template isn't
stored as a finished picture — it's saved as a **[recipe](../ai-context/glossary.md#recipe)**: which
background you chose and what text goes with it. The actual image is
composed fresh every time someone views it, not generated once and stored.
An AI-generated image or video, by contrast, *is* a real file, since
generating it is the expensive part — the meme recipe just points at that
already-generated file.

An AI-generated image or video is tied to the meme you made with it. That's a
storage fact, not a privacy one: like any other meme, it's public unless you
turn the privacy option on yourself.

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

## Boundaries & known limitations

- **Uploading your own photo to build a meme isn't currently paywalled**,
  even though the product has machinery elsewhere that suggests it might
  once have been intended to be. **Needs David confirmation** on whether
  that's the intended, permanent behavior.
- **Removing an account's storage doesn't currently clean up every kind of
  media it created.** Photos you uploaded and AI images you generated are
  removed; the video files behind an AI video meme currently are not.
  **Needs David confirmation** on whether that's accepted, known debt or
  an oversight to fix.

## Going deeper

- Spec: [`meme-and-video-studio.md`](../ai-context/meme-and-video-studio.md)
  — the exact routes, the recipe/`imageSource` shape, the AI video job's
  phase state machine, tier-gate specifics, and the storage layout.
- Related: [`5-visual-pipeline.md`](./5-visual-pipeline.md) (the shared image
  machinery), [`10-payments-and-membership.md`](./10-payments-and-membership.md)
  (what Legendary unlocks generally).
- Rationale: the studio/media entries in [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 7 — [`7-public-site-and-sharing.md`](./7-public-site-and-sharing.md),
home, search, [hashtags](../ai-context/glossary.md#hashtags), leaderboard,
profiles, OG cards, and [merch](../ai-context/glossary.md#merch) — the surfaces
the loop closes through.

*Verified against `e9669d2` (2026-08-09) · claim inventory in PR #371.*
