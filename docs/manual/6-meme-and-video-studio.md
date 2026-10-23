# Chapter 6 · Meme Studio

> How you actually turn a fact into a meme — with your own photo as its
> background — and what's true underneath.
>
> Deep spec: [`meme-and-video-studio.md`](../ai-context/meme-and-video-studio.md).
> Related: [`5-visual-pipeline.md`](./5-visual-pipeline.md) (the image
> machinery moderation uses), [`10-payments-and-membership.md`](./10-payments-and-membership.md)
> (what [Legendary](../ai-context/glossary.md#legendary) unlocks).

## What it does

Once you've found a fact you want to make into a meme, the [studio](../ai-context/glossary.md#studio) is where
you actually build it. You build a meme from your own photo: the studio
composes that [background](../ai-context/glossary.md#background) with the fact's text and
saves it as your meme.

## How it works

### Building a background

Upload a photo, or pick one you uploaded before. This is available to anyone
signed in — no paid plan required — and it needs an account, so a visitor
who isn't signed in is asked to sign up first. The built-in gradient
backgrounds and the [stock images](../ai-context/glossary.md#stock-image) from Pexels were deleted
before launch (the record is in [`docs/retired/`](../retired/README.md));
until a free background the site supplies comes back, there is nothing a
signed-out visitor can build on.

There are no AI-generated memes and no video memes. Both were deleted before
launch, to be rebuilt later on stronger models: the AI image of you in the
fact's scene (PuLID) and video
([decisions](../ai-context/decisions.md#2026-10-05--launch-scope-video-deferred-the-share-loop-and-open-graph-previews-launch-critical-and-the-rest-of-the-feature-walk); the record is in
[`docs/retired/`](../retired/README.md)).

You build memes in one of two places. On a fact's page, the builder opens
straight onto the image you'll make. On a shared meme's page, "make this about me" opens a
single-screen builder that remakes that meme for you; a visitor who isn't signed in sees a
card asking them to sign up first, which brings them back to the meme. An older studio that used to
sit behind the fact page was deleted before launch
([decisions](../ai-context/decisions.md#2026-10-22--the-legacy-meme-studio-is-deleted-the-user-generate-route-survives-photo-only-until-pulid-goes)).

### What actually gets saved

A meme you build from your own photo isn't
stored as a finished picture — it's saved as a **[recipe](../ai-context/glossary.md#recipe)**: which
background you chose and what text goes with it. The actual image is
composed fresh every time someone views it, not generated once and stored.
Like any meme, it's public unless you turn the privacy option on yourself.

### Where your media lives

A photo you uploaded is a real file, stored the same way any other user
content on Overhype.me is stored, and the recipe points at it.

## Why it works this way

- **Saving a recipe instead of a picture keeps a meme current.** If Overhype.me improves how memes are composed — better text
  placement, a rendering fix — a recipe-based meme picks that improvement
  up automatically the next time anyone views it, instead of being frozen
  at whatever quality existed the moment it was made.
- **Making a meme is free for everyone signed in.** Building from your own
  photo costs Overhype.me nothing extra per meme. What Legendary adds here is keeping a meme private
  ([chapter 10](./10-payments-and-membership.md)).

## Boundaries & known limitations

- **Uploading your own photo to build a meme isn't currently paywalled**,
  even though the product has machinery elsewhere that suggests it might
  once have been intended to be. **Needs David confirmation** on whether
  that's the intended, permanent behavior.

## Going deeper

- Spec: [`meme-and-video-studio.md`](../ai-context/meme-and-video-studio.md)
  — the exact routes, the recipe/`imageSource` shape, tier-gate specifics,
  and the storage layout.
- Related: [`5-visual-pipeline.md`](./5-visual-pipeline.md) (the image
  machinery moderation uses), [`10-payments-and-membership.md`](./10-payments-and-membership.md)
  (what Legendary unlocks generally).
- Rationale: the studio/media entries in [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 7 — [`7-public-site-and-sharing.md`](./7-public-site-and-sharing.md),
home, search, [hashtags](../ai-context/glossary.md#hashtags), leaderboard,
profiles, OG cards, and sharing — the surfaces
the loop closes through.

*Verified against `e9669d2` (2026-08-09) · claim inventory in PR #371.*
