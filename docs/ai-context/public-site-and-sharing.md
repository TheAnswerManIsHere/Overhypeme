# Public Site and Sharing

> The surfaces where the core loop closes: home, search, hashtags,
> leaderboard, the profile/library split, OG cards, merch, and sharing
> mechanics. Primary code: `artifacts/overhype-me/src/pages/Home.tsx`,
> `Search.tsx`, `TopFacts.tsx`, `Profile.tsx`, `Library.tsx`;
> `artifacts/api-server/src/routes/facts.ts`, `hashtags.ts`, `og.ts`,
> `share.ts`, `shareCopy.ts`, `shareIntents.ts`; `cloudflare/og-router`.

## Home

Two independent surfaces, not a personalization-driven feed:

- **Hero billboard** (`Home.tsx:79-139`, `useHeroFact()`,
  `hooks/use-hero-fact.ts:63-113` → `GET /facts/hero`,
  `facts.ts:117-207`). Takes the top-50 facts by `wilsonScore`
  (`POOL_SIZE = 50`) and does a **weighted-random pick**,
  probability-proportional to `wilsonScore` with an epsilon floor
  (`facts.ts:179-190`) — not a plain top-1. "Next Random Fact"
  (`Home.tsx:115-123`) re-rolls, excluding the fact just shown.
- **Fact feed grid** (`Home.tsx:672-734`) — `useListFacts()` with a fixed
  `{sort:"newest", limit:20}` (or `sort:"top"` / hashtag-filtered per
  `filterMode`, `Home.tsx:508-514`).

**Personalization is entirely client-side and never changes which facts
are fetched.** `usePersonName()` (`hooks/use-person-name.ts`) reads/writes
`localStorage` (or seeds from a share link's `?displayName=&pronouns=`
params, `Home.tsx:26-36`) — neither `useListFacts` nor `useHeroFact` ever
sends name/pronouns to the server. Every visitor gets the same feed/hero
pool and ordering; only the rendered text substitutes tokens per-visitor.

**Cold vs. warm.** Cold = `!name && !SHARE_LINK_ACTIVE` (`Home.tsx:503`) —
shows a static placeholder teaser with a demo name, no `/facts/hero` call
at all while cold (`Home.tsx:644-650,660-669`). After a name is submitted,
a pronoun-onboarding sheet collects/infers pronouns before the visitor
flips warm and the real hero/feed calls fire.

**No pagination or infinite scroll anywhere on the public site.**
`useListFacts` is called once with a fixed `limit` — no offset increment,
"load more," or scroll observer in `Home.tsx` or `Search.tsx` (confirmed
by grep). The API supports `offset` (`ListFactsQueryParams`,
`lib/api-zod/src/generated/api.ts:97-112`); nothing on the public site
drives it.

A sticky hashtag rail and a "Trending Topics" strip (`Home.tsx:26-72,
713-733`) both call `GET /hashtags` — see below.

## Search

Frontend `Search.tsx` → `GET /facts` (`facts.ts:68-106`).

**Plain SQL substring match, not full-text search or pgvector.** Text
search is `ilike(factsTable.text, %${search}%)` (`facts.ts:75`) — a
case-insensitive `LIKE`. `pgvector` (`facts.embedding`,
`artifacts/api-server/src/lib/embeddings.ts`) exists in this codebase but is used **exclusively for
AI duplicate detection at moderation time** — the public search box never
touches it.

**A `#`-prefixed query routes to an exact hashtag match instead**
(`Search.tsx:20-23` detects the prefix, server does
`eq(hashtagsTable.name, hashtag)`, `facts.ts:88`) — this is also what a
hashtag pill on any `FactCard` links to (`/search?q=%23{tag}`,
`components/facts/FactCard.tsx:220-232`), making **Search the actual live
hashtag-browsing surface** (see the dead standalone page below).

**No relevance ranking** — `Search.tsx:28` hardcodes `sort:"newest"`,
always `desc(factsTable.createdAt)`. A `sort:"trending"` option exists
server-side (`desc(factsTable.commentCount)`, `facts.ts:103`) but no
frontend page ever requests it.

**Search history** (authenticated users only, silent no-op for anonymous,
`users.ts:410-423`) is recorded on debounced queries `POST
/users/me/search-history` but **not read back into `Search.tsx`** — it
surfaces only on `Library.tsx`'s own "Search History" tab, a separate flow
entirely.

## Hashtags

Enrichment produces the tags themselves — see
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md); not
re-derived here.

Two live browsing surfaces: `GET /hashtags` (`hashtags.ts:9-20`, ordered
`desc(hashtagsTable.factCount)`, optional `?search=` via `ilike`) feeds
Home's rail/trending strip, and `GET /facts?hashtag=X` (exact match,
`facts.ts:87-93`) feeds both those selections and every `FactCard`
hashtag pill.

**The standalone hashtag browse/detail page is dead code — unreachable in
production.** `pages/Hashtags.tsx` is a fully built listing + per-tag
detail view, but its route redirects to Home instead of rendering it:
`App.tsx:404` (`<Route path="/hashtags"><HashtagsRedirect /></Route>`),
`HashtagsRedirect` (`App.tsx:59-63`) immediately `setLocation("/")`. The
component exists in the repo; no user-facing link or route reaches it.
**`architecture-map.md` currently lists `Hashtags.tsx` as a live public
page — that's stale, corrected in the same PR that adds this spec.**

## Leaderboard

Route `/top-facts` → `TopFacts.tsx` (`/hall-of-fame` is a legacy alias
redirecting to the same page, `App.tsx:397`, `HallOfFameRedirect`).

**Ranks facts only, by `wilsonScore`** — `useListFacts({sort:"top",
limit:20})` → `desc(factsTable.wilsonScore)`. **There is no user/activity
leaderboard anywhere in the codebase** (repo-wide grep for "leaderboard"
turns up only this page and an unrelated ad-slot name,
`components/layout/Layout.tsx:95`).

**The time-window pills (This week / This month / All time) are
non-functional.** `TopFacts.tsx:8-17` defines the `period` state and pill
UI, but `period` is **never passed into the query**
(`useListFacts({sort:"top", limit:20})`, line 19, ignores it) — clicking a
pill only changes its own active styling; the ranking shown is always the
same all-time `wilsonScore` order. The three hashtag pills below it are
likewise static/unwired, no `onClick` at all.

No dedicated test asserts `GET /facts?sort=top` orders by `wilsonScore` —
the query is only exercised indirectly via unrelated related-facts tests.

## Profiles and Library — the self-view split

**There is no public-facing profile page.** No `/u/:id` or similar route
exists anywhere; the public `/facts` response's `submittedBy` field is
consumed only by the admin facts page, never by any public component.

`/profile` (`Profile.tsx`) is the **private account-settings surface**,
hard-gated to the signed-in owner (`Profile.tsx:748-754`) — identity,
sign-in methods/password, Stripe checkout confirmation, the subscription
panel. It is not a "what this user made" surface.

**"What's visible" — submitted facts, memes, activity — lives on a
separate page, `/library`** (`Library.tsx`), also hard-gated to the
signed-in owner. Tabs: Liked Facts, Submissions, My Memes, My Images,
Search History. **This is entirely self-view — there is no equivalent for
viewing another user's submissions or memes.**

**Dead code in `Profile.tsx`, worth knowing before touching it.**
`Profile.tsx` still declares `activeTab` state and fetches
`myMemesData` gated on `activeTab === "memes"`, but `setActiveTab` is
never called anywhere in the file (grepped — zero call sites beyond the
`useState` declaration). `activeTab` is permanently stuck at its initial
value, so the memes query never runs and the "Memes" stat block
(`Profile.tsx:1001-1008`) never renders — leftover from what looks like a
completed split of this tab UI out into `Library.tsx`, which has the live
working version of the identical query.

**Private-meme visibility doesn't affect any profile display** (there's
no public profile for it to leak through) — it gates `/library`'s "My
Memes" tab implicitly (a user only ever sees their own), and it's enforced
via one shared check, `canViewMeme()`
(`lib/memeVisibility.ts:27-33`), on every meme-resolving surface: the meme
detail JSON, the rendered image, the OG shell, share-copy/share-intents,
and the Zazzle export.

## OG cards

Two-part system: a Cloudflare Worker for bot routing, an Express shell
route for the actual HTML.

- **Worker** (`cloudflare/og-router/src/index.ts:56-101`) — for
  `GET/HEAD /m/:slug`, checks the UA (`isbot` package); non-bots pass
  through untouched to the SPA. Bot UAs get rewritten to
  `GET /api/og/m/:slug` on the same origin. Separately strips the
  `Set-Cookie: GAESA=...` header GCP injects (breaks Twitter/X's caching
  heuristics) from meme-image and OG responses.
- **Shell route** `GET /og/m/:slug` (`og.ts:130-265`) emits `og:*`/
  `twitter:*` meta tags plus a `<meta http-equiv="refresh">` redirect to
  `/m/:slug` for a human who lands there directly.

**The OG image is the meme's own rendered image, not a separate
asset** — `meme.imageUrl` is literally `/memes/${slug}/image`, the same
URL the SPA uses to display it (`app.ts:85-89`'s own comment: "the actual
og:image").

**Privacy is enforced before any OG content is built** —
`canViewMeme(meme, req)` is checked before the `deletedAt` branch
specifically so a private meme's existence can't be inferred from
404-vs-410, and the private-meme fallback is `Cache-Control: no-store` so
Cloudflare never publicly caches a should-be-private card. A soft-deleted
meme returns `410` with a generic card leaking none of the removed
content.

**Scope is meme permalinks only.** Neither the worker nor the shell route
handles `/facts/:id`, `/video/:id`, `/search`, `/hashtags`, or the
homepage — `index.html` has zero `og:*`/`twitter:*` tags of any kind, so
sharing any non-meme URL produces no rich preview at all, not even a
generic sitewide fallback.

## Merch (Zazzle)

**Purely an affiliate-link redirect — no order/fulfillment integration.**

- Frontend entry (`WearIt.tsx`, reached from the meme page and the
  post-create share screen) lets the user pick a product and layout, both
  cosmetic-preview-only — they don't affect what's actually sent to
  Zazzle. The "Open in Zazzle" click does a plain same-tab navigation
  (deliberately, to avoid Safari/iOS popup blocking), not a popup.
- Server flow, `GET /memes/:slug/zazzle-redirect` (`memes.ts:838-970`):
  visibility-checked via `canViewMeme` (same no-existence-disclosure
  pattern as OG) → logs an affiliate click (`affiliateClicksTable`,
  skipped on `?preview=true`) → re-exports the meme image to
  `meme-exports/${slug}.jpg` (public ACL; same export step as the
  standalone `POST /memes/:slug/zazzle-export`) → builds the Zazzle URL
  from affiliate params stored in `admin_config`
  (`lib/zazzle.ts:9-34`) → `302`s (or returns the URL as JSON on
  `?preview=true`). On any failure mid-flow, falls back to a bare Zazzle
  URL with no image rather than failing outright.
- An admin diagnostic sibling, `GET /memes/:slug/zazzle-redirect-raw`
  (`requireAdmin`), skips the export step to compare against the normal
  public image URL.
- `GET /affiliate/stats` (admin-only) aggregates click counts by
  day/source/destination. **There is no order, purchase, or fulfillment
  tracking anywhere** — Zazzle handles checkout, sizing, shipping, and
  payment entirely off-site; Overhype.me only ever knows a click happened.
- No dedicated automated tests exist for the export/redirect routes —
  `routes.memes.test.ts` explicitly notes those paths are out of scope for
  that batch (need sharp/canvas + external APIs).

## Sharing mechanics — three distinct surfaces

1. **Fact-level `ShareModal`** — captures the recipient's name/pronouns
   first, then builds a share URL that rewrites the personalization query
   params for whoever opens it (`buildShareUrl`,
   `${origin}${path}?displayName=...&pronouns=...`). Offers copy-link,
   social popups, and "Send via Email."

   **The email-invite path does not work in production.** `POST
   /share/invite` (`routes/share.ts:71-196`) validates the client-supplied
   `shareUrl` against an allowlist requiring the hostname to be
   `example.com`/`www.example.com` (`ALLOWED_SHARE_HOSTS`, line 18) and
   the path to match `/^\/share\/[A-Za-z0-9_-]+$/` (line 19). But
   `ShareModal`'s `buildShareUrl` always builds a URL on the real site
   origin with a path like `/` or `/facts/123` — never `/share/...` (no
   such route exists anywhere in the app). Every real share-invite request
   therefore 400s with "shareUrl host/path not allowed." The only place a
   URL matching the allowlist is ever constructed is the route's own test
   fixture. This reads as an unfinished placeholder-domain configuration,
   not a documented product limitation — **Needs David confirmation** on
   whether it's known and whether a fix is planned.

   Every share action also fires `POST /facts/:id/share` to bump
   `factsTable.shareCount` (rate-limited).

2. **Meme-level `MemeShareModal`** — architecturally separate by design
   (a meme is a fixed, already-rendered artifact; no name-swap needed).
   Uses native `navigator.share()` when supported, else a platform popup
   or `mailto:`. Copy/URLs are fetched server-side per-platform from
   `GET /share-copy/:memeId/:platform` (auth-required, rate-limited,
   template variables sourced from `admin_config`, Twitter-specific
   character-budget truncation). Every button click fires `POST
   /share-intents` — fire-and-forget logging of the *click*, never the
   actual downstream share (which app the OS share sheet opened is
   unobservable, per the route's own doc comment).

3. **`PostCreateShareScreen`** — the post-creation screen, widest platform
   list, plus a merch teaser and download. Most shares actually originate
   here rather than from the two modals above.

**Tracking summary:** `factsTable.shareCount`, `affiliateClicksTable`,
`shareIntentsTable` each log a different action; nothing tracks a share
all the way to "someone actually opened the link" — every surface stops
at intent/click.

## Files to inspect before public-site/sharing work

- `artifacts/overhype-me/src/pages/Home.tsx`, `Search.tsx`,
  `TopFacts.tsx`, `Profile.tsx`, `Library.tsx`, `Hashtags.tsx` (dead,
  unreachable), `WearIt.tsx`.
- `artifacts/overhype-me/src/components/ShareModal.tsx`,
  `components/share/MemeShareModal.tsx`,
  `components/PostCreateShareScreen.tsx`,
  `components/merch/GarmentPreview.tsx`.
- `artifacts/api-server/src/routes/facts.ts` (hero, list/search, share
  count), `hashtags.ts`, `og.ts`, `share.ts` (broken email invite),
  `shareCopy.ts`, `shareIntents.ts`, `memes.ts` (Zazzle
  export/redirect), `affiliate.ts`.
- `artifacts/api-server/src/lib/memeVisibility.ts` (`canViewMeme`, the
  one shared gate behind OG/share/Zazzle/library-memes),
  `artifacts/api-server/src/lib/zazzle.ts`.
- `cloudflare/og-router/src/index.ts` — bot routing, header handling.
- `App.tsx` — the redirect routes (`HashtagsRedirect`,
  `HallOfFameRedirect`) worth checking before assuming a page is live.
- Tests: `__tests__/routes.facts.test.ts`,
  `routes.facts.hero.test.ts`, `routes.hashtags.test.ts`,
  `phase5.og.routes.test.ts`, `memes.privacy-cache.test.ts`,
  `routes.shareCopy.test.ts`, `routes.shareIntents.test.ts`,
  `routes.share.test.ts`, `routes.affiliate.test.ts`.
- For what enrichment produces (hashtags, classification):
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).
