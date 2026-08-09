# Community and Engagement

> How people react to what's on Overhype.me — rating a fact, hearting a
> meme or a comment, leaving a comment of your own — and how you find out
> what happened to the things you submitted.
>
> Deep spec: [`community-and-engagement.md`](../ai-context/community-and-engagement.md).
> Related: [`moderation.md`](./moderation.md) (fact moderation — a
> separate, more involved pipeline than comment moderation),
> [`public-site-and-sharing.md`](./public-site-and-sharing.md) (where a
> fact's rating feeds into search and the leaderboard).

## What it does

Once a fact exists, this is how people respond to it: rating it up or
down, leaving a comment, and hearting a meme or a comment someone else
made. It's also where you find out what happened to your own submitted
facts and comments — approved, rejected, or still waiting — through a
personal activity feed.

## How it works

### Rating a fact

Rating is a simple up or down, not a star scale — and it's a toggle:
tapping your existing rating again removes it, tapping the other one
flips it. You can only have one active rating on a given fact at a time.
Ratings feed directly into that fact's overall standing the moment you
cast one — there's no waiting for a batch process — which is what
determines where it lands on the leaderboard and how often it turns up
in the rotating spotlight on the home page. Search doesn't currently
factor rating in at all — it's always newest-first, regardless of how a
fact is rated (see [`public-site-and-sharing.md`](./public-site-and-sharing.md)).

### Leaving a comment

Writing a comment asks you to prove you're a person (a quick
verification step) before it's accepted, unless your account is
exempted from that. Every comment goes into a review queue and only
becomes visible to other readers once a human moderator approves it —
there's no way to skip that step, and once a comment is posted you can't
edit or take it back yourself.

### Hearting something

Hearting a meme and hearting a comment are the exact same action under
the hood, just pointed at different things — one mechanism handles both.
Tap to heart, tap again to un-heart.

### Your activity feed

Signed-in users have a personal activity feed that tracks what happened
to things *they* submitted — a fact getting approved or rejected, a
comment getting approved or rejected. It only ever shows you the status
of your own submissions; it doesn't tell you when someone else reacts to
something of yours (a heart or a rating you received doesn't show up
there). Unlike most of the public site, this page has real
next-page/previous-page navigation rather than a single fixed list.

## Why it works this way

- **A rating updates a fact's standing instantly because a delay would
  make ratings feel disconnected from what they're for.** The whole
  point of rating something is to move it up or down in what other
  people see next — if that took a while to take effect, the connection
  between casting a vote and its visible impact would be lost.
- **Comments get a lighter review process than facts, but still always a
  human one.** A comment doesn't carry the same weight as a whole new
  fact entering the product — it doesn't need the fuller review a
  submitted fact goes through (see [`moderation.md`](./moderation.md))
  — but it's still text anyone can write and everyone can read, so it
  still gets a person's eyes on it before it's public.
- **Hearting a meme and hearting a comment share one mechanism because
  they're the same underlying act** — approving of something with a
  single tap — aimed at two different kinds of content. Building that
  once and reusing it means an improvement to how hearting works applies
  everywhere it's used, instead of two versions quietly drifting apart.
- **The activity feed is about your own stuff on purpose, not a general
  social feed.** Its job is answering "what happened to what I
  submitted," which is a narrower and more useful question than trying
  to also surface everything anyone else did anywhere on the site.

## Boundaries & known limitations

- **You can't edit or delete your own comment once it's posted.** If you
  need to correct or remove one, there's currently no self-service way.
- **Hearting a meme doesn't currently check whether you're allowed to
  see it first** — a private meme's heart button isn't gated the way
  every other private-meme surface is. Already filed as a known bug
  ([#375](https://github.com/TheAnswerManIsHere/Overhypeme/issues/375)),
  not something to rely on as a real access boundary today.
- **There's no notification for reactions you receive.** Your activity
  feed tells you about your own submissions' review status, never about
  a rating or heart someone else gave your content.
- **Comments don't get any automated pre-screening** — every approval or
  rejection is a human admin decision, with no AI assist in the loop the
  way fact submissions have.

## Going deeper

- Spec: [`community-and-engagement.md`](../ai-context/community-and-engagement.md)
  — the exact routes, the shared reaction mechanism behind ratings and
  hearts, the comment-moderation queue, and the activity feed's event
  types.
- Related: [`moderation.md`](./moderation.md) (the separate, fuller fact
  moderation pipeline), [`public-site-and-sharing.md`](./public-site-and-sharing.md)
  (how a fact's rating feeds the leaderboard and the home spotlight —
  not search).

**Next:** chapter 9 — [`accounts-and-auth.md`](./accounts-and-auth.md),
sign-in methods, the account lifecycle, verification and password
journeys.

*Verified against `1c11569` (2026-08-09) · claim inventory in PR #378.*
