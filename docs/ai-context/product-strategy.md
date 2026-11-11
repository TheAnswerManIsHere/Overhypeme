# Product strategy — approved 2026-11-11

> **Status:** approved by David on 2026-11-11 after a long strategy discussion
> recorded on #887 (comments of 2026-11-11). This is the current direction for
> what Overhype.me sells, to whom, and how. Where an older document disagrees,
> this one wins until that document is updated; the entry in
> [`decisions.md`](./decisions.md) of the same date lists what it supersedes.
> Prices and credit counts are **placeholders** until real bills at screen size
> are read.

## Direction

Overhype.me is something you make **about a friend** and send to them. Telling
a friend how awesome they are is the social act; the paid picture, and later
the video and the printed card, star the friend. Making one about yourself stays
possible but is not what the money is designed around.

David, 2026-11-11: *"It's socially awkward to promote yourself so strongly but
it's a strong social signal to tell a friend how awesome they are."*

Before launch, the one thing to prove is the loop: someone makes a fact or meme
about a friend, sends it, and the friend arrives and makes one.

## What is free

- Browsing and personalising any fact with any name, yours or a friend's.
- Your own uploaded photo behind a fact.
- One AI picture per verified account, from the best engine.
- One example picture per approved gag on every fact, showing its visual gag.

## What is paid

- **Credits** make AI pictures. One credit is one picture. Credits never
  expire, and there is one balance.
- **A credit pack**, bought once by anyone.
- **Membership**, monthly or annual: the perks (no watermark, private memes,
  photo avatar) plus credits added every month.
- AI pictures are no longer members-only: anyone holding credits can make one.

Placeholder prices: pack $4.99 for 30 credits; membership $4.99 a month with 40
credits, or $34.99 a year with 400.

## Pictures and engines

- Every AI picture is of a real person or thing from the user's life:
  themselves, a friend, a pet, a car. No pictures of generic people are sold or
  offered as meme backgrounds. David: *"The whole purpose of the site is that it
  is personalized TO YOU!"*
- **GPT Image 2.6** draws photoreal pictures; **Nano Banana 2.1** draws styled
  ones; the site picks by the look chosen. **Provisional** until a check scores
  scene fidelity, likeness and style separately (below).
- Pictures are made near screen size. Larger sizes can return later as a
  feature. David: *"I'd rather produce higher quality, lower resolution images
  than lower quality, higher resolution images."*
- Prompts are tuned to these two engines; a small check (a second face, screen
  size, the three styles) replaces a third judging round.
- FLUX 3 and Seedream 5.0 Pro are out; Muse Image is held in reserve as the
  low-cost option. No text-only winner is chosen.

## Quality

Quality is judged on four things (David, 2026-11-11):

1. **Scene fidelity.** Does the engine draw the scene as described: the
   details, the nuance, camera position, framing and where each character is
   placed?
2. **Likeness.** Does the star look like the person in the uploaded photo?
3. **Style.** For photoreal, does it look real, with consistent objects and
   physically plausible action? For styled pictures, does it capture the essence
   of the style?
4. **Video, when it comes.** All of the above, plus camera motion, framing,
   storytelling, timing and sound.

Whether a gag is funny is settled when the gag is approved at moderation; the
engine's job is to draw that gag faithfully.

## Gags and examples

- **A fact can have up to three approved gags.** One is required; the second
  and third are optional, added at a moderator's discretion. Where a fact has
  more than one, the user picks. Built before launch at David's direction (Claude
  recommended after launch).
- **Examples are stored per gag and per look**, so a fact can hold up to twelve
  (three gags × unstyled and three styles). Only one unstyled example per
  approved gag is required; styled examples are optional.
- **One site-wide sample per style** shows what each style looks like.
- Examples are not re-rendered across the catalogue and are not meme
  backgrounds.

## A friend's photo

The design lets a user upload a friend's photo for an AI picture. It stays
**switched off at launch until counsel answers**. When on:

- The picture goes to the friend **privately first**; it becomes public only if
  they agree, and they can remove it in one click without an account.
- The uploader confirms permission each time, and warrants it in the terms.
- Fixed gags only for friend pictures; no free-typed prompts.
- Styled looks by default for friends.
- Adults only; never a friend's picture in Overhype.me's own marketing.
- No face recognition or stored face templates; source photos are deleted soon
  after the picture is made.
- A visible AI label and a fast takedown route.
- United States only at first.

A friend's **name** on a fact needs no such gate.

Questions for counsel: whether sending a friend's photo to an image engine is
biometric collection under Illinois, Texas or Washington law; whether the
uploader's warranty plus the friend-approves-first flow is sufficient; what
changes for printed cards and merch; insurance.

## After launch, in order of intent

1. **Video:** "bring it to life" from a still, priced in credits.
2. **Several people in one picture:** each uploaded photo tagged to a character
   in the fact (David's example: a photo of David and one of his dad).
3. **Printed cards and merch**, the main revenue goal.
4. More gags on the facts that prove popular.
5. Advertising, only if scale makes it worthwhile.

## What must not change

Blind moderation and the legal-safety rules; faces only from photos a user
supplies; the existing membership payment system and its safeguards; no
spending by anyone without an account.

## Still to be decided with data or counsel

- Final prices and credit counts, from real bills at screen size.
- Counsel's view on a friend's photo in an AI picture.
- Which engine draws the per-fact examples.

## How it gets built

Each piece gets its own plan, reviewed and brought to David before building:

- **Phase 8, finishing the engine work:** adopt the two engines, screen-size
  pictures, prompt tuning and the three-factor check.
- **Phase 7, the paid layer and the friend flow:** credits, the pack,
  membership with credits, the free picture, the "who is this for?" flow,
  examples in place of hero backgrounds.
- **Up to three gags per fact**, with per-look examples.

## Evidence behind it

Engine evaluation rounds 1 and 2, pricing research and the legal survey are on
#887 (comments of 2026-11-10 and 2026-11-11).
