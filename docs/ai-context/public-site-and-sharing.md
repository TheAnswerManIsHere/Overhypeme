# Public Site and Sharing

> The surfaces where the core loop closes: home, search, hashtags,
> leaderboard, the profile/library split, OG cards, and sharing
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
`localStorage` (or seeds the halves the browser lacks from a share link's
`?displayName=&pronouns=` params, `resolveInitialIdentity`) — neither `useListFacts` nor `useHeroFact` ever
sends name/pronouns to the server; only the rendered text substitutes
tokens per-visitor. **The feed pool is identical for everyone, but the
hero pool is not** — `GET /facts/hero` (`facts.ts:117-207`) accepts a
client-tracked `exclude` list of recently-shown ids, and for an
authenticated caller additionally excludes every fact already recorded as
shown-as-hero to that user (`userFactPreferencesTable`, `facts.ts:127-139`)
— so two visitors (or the same visitor across sessions) can draw from
different-sized hero pools, even though the ranking/weighting logic
itself is identical.

**Cold vs. warm.** Cold = no name yet (`isCold = !name` in `Home.tsx`) —
shows a static placeholder teaser with a demo name instead of the real
hero result. **The `/facts/hero` request still fires while cold** —
`useHeroFact()` is called unconditionally, regardless of `isCold`; the
cold UI only hides the response behind the teaser, it doesn't suppress
the request. Home has no capture of its own: the identity sheet
(`WelcomeModal`, mounted once at route level) asks for the name and
pronouns on every ordinary page, and its decision of when to ask lives in
`artifacts/overhype-me/src/lib/identity.ts`, read through `artifacts/overhype-me/src/hooks/use-identity-gate.ts` (#719).

**No pagination or infinite scroll on the fact-discovery surfaces
(Home, Search).** `useListFacts` is called once with a fixed `limit` — no
offset increment, "load more," or scroll observer in `Home.tsx` or
`Search.tsx` (confirmed by grep). The API supports `offset`
(`ListFactsQueryParams`, `lib/api-zod/src/generated/api.ts:97-112`);
neither page drives it. **This is not true site-wide** — the private
Activity Feed (`ActivityFeed.tsx`) has its own real page-based pagination
(`page` state, `GET /activity-feed?page=...`, prev/next controls,
`ActivityFeed.tsx:142-147,235-246`), outside this chapter's scope.

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
hashtag-browsing surface** (there is no standalone hashtag page; see below).

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

There is no standalone hashtag page. `pages/Hashtags.tsx`, a listing and
per-tag view whose `/hashtags` route only redirected to Home, was deleted in
launch Phase 4, removal 7 with its redirect, so `/hashtags` is now the
not-found page (ledger [`docs/retired/README.md`](../retired/README.md); tag `pre-cut/dead-surfaces`).

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
exists anywhere. This is not the same as "no one can see another user's
memes" — `GET /facts/:factId/memes?visibility=community` returns every
public meme for a fact to anyone, and a public meme's permalink is
viewable by anyone who has it. What doesn't exist is a **per-user
aggregated view** — nowhere can you see "everything user X has made,"
public or not, the way you can see your own via `/library`.

`/profile` (`Profile.tsx`) is the **private account-settings surface**,
hard-gated to the signed-in owner (`Profile.tsx:748-754`) — identity,
sign-in methods/password, Stripe checkout confirmation, the subscription
panel. It is not a "what this user made" surface.

**"What's visible" — submitted facts, memes, activity — lives on a
separate page, `/library`** (`Library.tsx`), also hard-gated to the
signed-in owner. Tabs: Liked Facts, Submissions, My Memes, My Images,
Search History. **This is entirely self-view — there is no equivalent for
viewing another user's submissions or memes.**

**`Profile.tsx` has no tabs.** The tab UI moved to `Library.tsx`; the
dead tab state, the Images, AI-images and Memes queries it left behind and
the never-shown Memes count were deleted in launch Phase 4, removal 7
(ledger [`docs/retired/README.md`](../retired/README.md)).

**Private-meme visibility doesn't affect any profile display** (there's
no public profile for it to leak through) — it gates `/library`'s "My
Memes" tab implicitly (a user only ever sees their own), and it's enforced
via one shared check, `canViewMeme()`
(`lib/memeVisibility.ts:27-33`), on every meme-resolving surface: the meme
detail JSON, the rendered image, the OG shell, and share-copy/share-intents.
**One exception, not yet using that check:**
`POST /memes/:id/heart` (`memes.ts:532-546`) only verifies the meme
exists and isn't soft-deleted — it never calls `canViewMeme()` — so an
authenticated non-owner who has (or guesses) a private meme's numeric id
can toggle a heart on it despite not being able to view it anywhere else.
Worth fixing to match the settled owner/admin-only contract for private
memes; flagged here rather than fixed, since this spec is documentation.

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
handles `/facts/:id`, `/search`, or the
homepage — `index.html` has zero `og:*`/`twitter:*` tags of any kind, so
sharing any non-meme URL produces no rich preview at all, not even a
generic sitewide fallback.

## Merch

There is none. The Zazzle affiliate flow (the `/wear` page, the export and
redirect routes, click logging, the admin Affiliate screen and the
`zazzle_*` settings) was deleted in launch Phase 4, removal 4 (ledger:
[`docs/retired/README.md`](../retired/README.md); the flow as it stood is at
the tag `pre-cut/merch`). The `affiliate_clicks` table and its rows remain
with no writer, a removal-11 orphan candidate.

## Sharing mechanics — two live surfaces (a third was deleted)

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
   character-budget truncation). **`POST /share-intents` logs a
   successful share action, not every button click** — the Web Share
   button only logs after `navigator.share()` resolves (dismissing the OS
   sheet, an `AbortError`, logs nothing, `MemeShareModal.tsx:97-100`), and
   Copy Link only logs after the clipboard write actually succeeds
   (`MemeShareModal.tsx:120-139`). Even a logged "share," though, is still
   only the local action (share sheet opened / link copied) — which app
   the OS share sheet was ultimately used with is unobservable, per the
   route's own doc comment.

3. **`PostCreateShareScreen`** — deleted in launch Phase 4 with the legacy
   meme studio, its only mounter
   ([`decisions.md`](./decisions.md#2026-10-22--the-legacy-meme-studio-is-deleted-the-user-generate-route-survives-photo-only-until-pulid-goes)). The
   wizard sends a saved meme to its permalink, where `MemeShareModal` is the
   share surface.

**Tracking summary:** `factsTable.shareCount` and `shareIntentsTable` each
log a different local action (a fact share, a successful meme-share
action) — neither of them, and nothing
else on the site, tracks a share all the way to "someone actually opened
the link."

## Files to inspect before public-site/sharing work

- `artifacts/overhype-me/src/pages/Home.tsx`, `Search.tsx`,
  `TopFacts.tsx`, `Profile.tsx`, `Library.tsx`.
- `artifacts/overhype-me/src/components/ShareModal.tsx`,
  `components/share/MemeShareModal.tsx`.
- `artifacts/api-server/src/routes/facts.ts` (hero, list/search, share
  count), `hashtags.ts`, `og.ts`, `share.ts` (broken email invite),
  `shareCopy.ts`, `shareIntents.ts`.
- `artifacts/api-server/src/lib/memeVisibility.ts` (`canViewMeme`, the
  one shared gate behind OG/share/library-memes).
- `cloudflare/og-router/src/index.ts` — bot routing, header handling.
- `App.tsx` — the redirect routes (`HallOfFameRedirect` and the admin
  redirects) worth checking before assuming a page is live.
- Tests: `__tests__/routes.facts.test.ts`,
  `routes.facts.hero.test.ts`, `routes.hashtags.test.ts`,
  `phase5.og.routes.test.ts`, `memes.privacy-cache.test.ts`,
  `routes.shareCopy.test.ts`, `routes.shareIntents.test.ts`,
  `routes.share.test.ts`.
- For what enrichment produces (hashtags, classification):
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).
