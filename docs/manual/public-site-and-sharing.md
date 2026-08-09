# Public Site and Sharing

> Home, search, the leaderboard, your own library, sharing, and merch —
> the surfaces where the loop actually closes: a visitor becomes a reader,
> a reader becomes a sharer, and a share pulls the next visitor in.
>
> Deep spec: [`public-site-and-sharing.md`](../ai-context/public-site-and-sharing.md).
> Related: [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md)
> (where hashtags come from), [`meme-and-video-studio.md`](./meme-and-video-studio.md)
> (where a shareable meme comes from).

## What it does

Once a fact exists, these are the surfaces that let anyone actually find
it, read it personalized to them, rank it against others, and pass it
along. None of this requires an account — browsing, searching, and
sharing all work for a signed-out visitor; only saving something to your
own library requires being signed in.

## How it works

### Home

The home page shows two things: one fact at a time in a rotating
spotlight, and a scrolling grid of the newest facts underneath. Both are
drawn from the same shared pool every visitor sees — nobody gets a
different set of facts because of who they are. What *does* change per
visitor is purely cosmetic: once you've typed a name (and Overhype.me has
inferred or you've picked pronouns for it), every fact on the page
re-renders with that name and those pronouns substituted in. The
underlying set of facts you're looking at never changes based on that.

The spotlight isn't a strict "best fact first" — it favors facts with a
better rating, but leans random rather than always showing the single
top-rated fact, so repeat visits (and hitting "next") don't just show the
same handful of facts over and over. There's no infinite scroll or "load
more" anywhere on the public site — what loads on first visit is what you
get.

### Search

Typing into search looks for those words anywhere in a fact's text — a
straightforward text match, not a smarter relevance search, so results
always come back newest-first rather than "best match first." Typing a
hashtag (with a `#`) searches for exactly that tag instead, and this is
actually how hashtag browsing works day to day — clicking a hashtag
anywhere on the site lands you on a search for that tag, not a dedicated
hashtag directory page.

### Top Facts (the leaderboard)

The Top Facts page ranks facts by their rating — always the same
all-time ranking, regardless of which time-range button you click on the
page. **The week/month/all-time buttons don't currently change what's
shown** — see Boundaries below. There's no ranking of *people* anywhere
on the site — no user leaderboard, only a fact leaderboard.

### Your library, not a public profile

There's no page where you can browse someone else's submissions or memes
— Overhype.me doesn't have public profile pages. What exists instead is
your own private library: the facts you've submitted or liked, the memes
and images you've made, and your search history — visible only to you,
when you're signed in. Your account settings (name, sign-in method,
membership) live on a separate page from that library.

### Sharing a meme makes a rich preview everywhere else

When you share a meme's link — dropping it into a text, a social post, a
chat app — the app on the other end shows a real preview: the meme's own
image, a title, a description, not just a bare link. That's true
specifically for meme links; sharing a link to a fact, a search, or the
home page itself doesn't currently produce a rich preview the same way.

Sharing itself works a few ways depending on where you start: copying a
link, tapping a platform's share button, or (on a fact specifically)
sending an invite by email. **The email-invite option doesn't currently
work** — see Boundaries below. Sharing a meme is deliberately different
from sharing a fact: a meme is a finished, already-rendered thing you're
passing along as-is, while sharing a *fact* rewrites the link so the
person who opens it sees it personalized with the name you typed for
them.

### Turning a meme into merch

From a meme, you can open a product picker — a shirt, a mug, a sticker,
and similar — preview roughly how the meme would look on it, and get
redirected out to Zazzle to actually order it. Overhype.me doesn't handle
the order itself: it hands off to Zazzle for checkout, sizing, shipping,
and payment, and only knows that a click happened, not whether anyone
went on to buy anything.

## Why it works this way

- **The feed is the same for everyone on purpose.** If different visitors
  saw different facts, "the fact everyone's talking about right now" would
  stop being a shared thing — the spotlight and the leaderboard only work
  as social objects because everyone is looking at the same pool, just
  reading it with their own name in it.
- **Search stays simple because it's a way to jump straight to something
  you already have in mind**, not a discovery tool competing with the
  home feed and the leaderboard for that job — so a plain text match is
  enough, and a smarter relevance ranking hasn't been worth building yet.
- **A meme is treated as a finished object when you share it, and a fact
  is treated as something to hand to a specific person.** Those are
  genuinely different sharing intents — "look at this exact thing" versus
  "this one's about you now" — so they get separate share flows instead of
  one generic "share" button trying to do both.
- **Overhype.me doesn't run its own storefront for merch** because
  building real order fulfillment, payment, and shipping is a wholly
  different business than making memes — handing that off to an existing
  print-on-demand platform gets the feature to users without Overhype.me
  taking on all of that.

## Boundaries & known limitations

- **The Top Facts time-range buttons (week/month/all-time) are currently
  decorative** — clicking one changes which button looks selected, but
  the ranking underneath never changes; it's always all-time. Not a
  documented product decision, just not wired up yet.
- **There's no dedicated hashtag browsing page**, even though the idea of
  one exists in the codebase — clicking a hashtag routes you into a search
  instead. If you're expecting a page that lists every hashtag with its
  own dedicated view, that page currently isn't reachable.
- **The "Send via Email" share option doesn't currently work.** The
  button is there and looks functional, but the request behind it fails
  every time in production due to a configuration mismatch — this reads
  like unfinished setup rather than an intentional limitation. **Needs
  David confirmation** on whether this is known and whether fixing it is
  planned.
- **There's no public profile page for any user** — you can see only your
  own submissions, memes, and library, never anyone else's, and no one
  can see yours either.
- **Rich link previews only exist for meme links.** Sharing a fact page,
  a search result, or the home page itself doesn't produce a preview
  image/description the way sharing a meme does.
- **Merch has no order or fulfillment tracking on Overhype.me's side** —
  once you're redirected to Zazzle, everything after that (whether you
  actually bought anything, sizing, shipping) is invisible to Overhype.me.

## Going deeper

- Spec: [`public-site-and-sharing.md`](../ai-context/public-site-and-sharing.md)
  — the exact routes, ranking logic, the OG-card pipeline, the Zazzle
  redirect flow, and the specific share/tracking endpoints.
- Related: [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md)
  (where a fact's hashtags come from), [`meme-and-video-studio.md`](./meme-and-video-studio.md)
  (how a shareable meme gets made in the first place).
- Rationale: the public-site and sharing entries in
  [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 8 — *community and engagement*, ratings, comments,
comment hearts, meme hearts, and the activity feed.
[Not yet written](./README.md#contents).

*Verified against `d7a6847` (2026-08-09) · claim inventory in PR #373.*
