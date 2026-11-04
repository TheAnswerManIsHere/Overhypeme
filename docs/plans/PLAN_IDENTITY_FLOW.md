# Plan — identity flow: one place decides when to ask for name and pronouns

```plan-oracle
# Oracle — identity flow (name and pronouns)

Agreed by David 2026-10-17 ("Agreed"), workstream #719. Fixes #705; replaces #713.

**Direction:** personalization is the front door. Until a visitor has a name and pronouns the site has nothing to give them, so asking for them is the product's first job on every path. One part of the code decides when to ask, so the paths can't drift apart.

David's own words (2026-10-17): "there's no value to someone using the site until the names and pronouns are set so if there's any situation where they're not set, we need to show the popup. However, if they're already set, we should never show the popup as changing the name is a function they can click, especially once they've created an account." And: "You should certainly build a single function that handles this rather than trying to create unique functions per flow... I don't want multiple areas in the code that try to handle this process individually which can drift from each other." On "doing anything" for a shared-meme visitor: "taking an action that either navigates away from the page or invokes some function to change the state of the page such as 'make it your own' and creating a new meme, resharing, etc. Pretty much any action a user would take. It's not like we need to watch their mouse... we want to use this moment where they're trying to do something useful to make sure we have their name captured." Prompt style: "Meme-style."

**What it should do when done:**
1. Visitor with no name, arriving directly: asked for name and pronouns before anything else, on any page except the sign-in, password, onboarding and admin pages.
2. Stored in the browser: kept across visits until they clear it.
3. Share link carrying name and pronouns: both are set and the visitor is never asked. If the link carries only one of them, it's set and they're asked for the other.
4. Shared meme or fact link, first visit: the content shows immediately, with no prompt. Their first real action (leaving the page, "make it your own", create, reshare) asks first, then carries on with what they were doing.
5. Creating an account, by email, Google or Apple: the stored name and pronouns go into the account without retyping.
6. Signed in: the account's name and pronouns win. A signed-in account with no name (every Google or Apple sign-up so far) is asked once, and the answer saves to the account. (David: "Yes, but we will be building a new database from scratch so this issue should not happen going forward. This seems like a safe backstop though.")
7. Logging out clears the browser copy; the next visit starts fresh.

**Must not change:**
- The share link's format, and links already out in the wild keep working.
- Names already stored in visitors' browsers are still read.
- How names render in facts and memes.

**Engineering requirement:** One module decides whether to ask, and every current place that handles names is rebuilt on it — the welcome pop-up, Home's first-visit box, the name tag's account sync, the sign-in sync, the sign-up form's prefill and the share-link seeding. Leftovers that would let the paths drift are deleted, not kept.

**Now / next / never:**
- Now: everything above.
- Next: a real "page not found" page; the fill colour for transparent uploads (#717); the photo-upload step in onboarding.
- Never: tracking anonymous visitors on the server; the name stays in their browser until they create an account.

**Process / tier:** feature, production phase. Written plan, Astra's review, David's approval, build in increments with reviews. Touches sign-in (accounts-auth, a sensitive subsystem) → specialist review added. #713 is replaced by the first increment.

**Defaults David accepted (vetoable, not vetoed):** sign-in/password/onboarding/admin pages don't ask; a half-filled share link asks only for the missing half; browser vs account disagreement → account wins; logout clears the browser copy.
```

## Preflight

**Increment test.** One capability, delivered in three increments. Each is independently shippable and leaves `main` no worse than today (today nobody is asked anywhere, #705).

- **Increment 1 — the module and the signed-out front door.**
  - *Makes true:*
    - A signed-out visitor with an incomplete identity is asked on every ordinary page.
    - A share link sets what it carries and asks only for the rest.
    - A shared meme, video or fact page shows its content on arrival, and the visitor is asked on the next page they reach.
    - A builder reached by a route (for example `/facts/:id/meme`) never starts from an incomplete signed-out identity.
    - Signed-out capture never sends the name off the browser.
    - Every signed-out read and write of the identity goes through one module.
  - *Bounded by:* no change to account sync (increment 2), and no in-page action continuation on a landing page (increment 3).
  - *Builder gates ship with the completion path they depend on.* Increment 1 gates signed-out builder arrivals that come through a route (for example `/facts/:id/meme`), where the sheet asks first. Signed-in gating arrives with account completion in increment 2. Builders opened in place on a landing page, such as fact-detail's "Make meme" (`FactDetail.tsx:181`, local state), are gated in increment 3 together with the action operation. Until then, each path stays as usable as it is today. Each increment shows that its gated entry paths reach a usable builder holding the completed identity. (Astra, round 2.)
  - *Recognised by:* rules 1, 2, 3 and 7 hold in a browser, and the inventory oracle below finds no signed-out identity handling outside the module.
- **Increment 2 — the account.**
  - *Makes true:* rules 5 and 6, for new, existing-nameless, existing-named and provider-linked accounts, with custom pronoun sets surviving every account write intact.
  - *Bounded by:*
    - the client's sign-in handling;
    - the auth context's distinction between "signed out" and "could not tell";
    - the server's pronoun validator and the OAuth callback's new-account signal.
  - No new endpoint, no anonymous server state.
  - *Recognised by:* the four account journeys and the auth-failure recovery, exercised from callback to browser.
- **Increment 3 — in-page actions on a shared-content page.**
  - *Makes true:* rule 4 in full. Every in-page action on a landing page asks first, then runs once with the completed identity.
  - *Recognised by:* each action family on the three landing pages, tested.

Order: increment 2 fixes data that is wrong today. Server-rendered memes for nameless accounts fall back to un-personalized text, and custom pronouns saved to an account lose their separators. Increment 3 refines a path that increment 1 already makes acceptable.

**Affected-surface inventory.** The class: code that reads or writes the visitor's identity outside the identity module.

- **Oracle run at `d7c608e`:**

  ```
  git grep -nE 'fact_db_name|fact_db_pronoun|STORAGE_KEY_(NAME|PRONOUNS)|SHARE_LINK_ACTIVE|syncFromProfile|usePersonName\(\)' -- 'artifacts/overhype-me/src' ':!*.test.*' ':!**/__tests__/**'
  ```

  Files hit: `App.tsx` (5), `MemeBuilder.tsx`, `MemeMagicVideo.tsx`, `MemeStudioVideoTab.tsx`, `NameTag.tsx`, `WelcomeModal.tsx` (5), `facts/FactCard.tsx`, `layout/Navbar.tsx`, `hooks/use-person-name.ts` (28), `FactDetail.tsx` (2), `Home.tsx` (3), `Login.tsx` (4), `Profile.tsx`, `memePage/BuilderOverlay.tsx`.

- **Writers** (second oracle, `git grep -nE '\b(setName|setPronouns|syncFromProfile|reset)\('`, filtered to the identity context):
  - `App.tsx` `AuthProfileSync`;
  - `NameTag.tsx`: its signed-out editor, and its account-sync effect;
  - `WelcomeModal.tsx`;
  - `Home.tsx`: inline box and mobile sheet;
  - `Profile.tsx`, after its account save.

  `Login.tsx` reads the storage keys directly, with its own copy of the key names.
- **Captures with no storage signature, found by reading:**
  - The shared-meme page's anonymous "See it with your name" form (`memePage/cta/CTABar.tsx:165`, `CTABarAnonOther`). It passes a name and pronouns to the builder without storing them.
  - The builders' draft initialization (`useWizardState.ts:169`). It copies the identity once at mount and persists it in its draft.
- **Identity readers outside the hook:** `BuilderOverlay.tsx:119` reads signed-in identity from `useAuth().user`, so increment 2 must refresh that too.
- **Identity leaving the browser:** `WelcomeModal.tsx:26` and `NameTag.tsx:22` post the typed name to `/api/ai/suggest-pronouns` (`routes/ai.ts:405`).

Not in the class, settled: the builders' per-meme name and pronoun fields, once a draft exists, name *who the meme is about*. That can be someone other than the visitor, so those fields are content and are never overwritten from the identity. Only the draft's *initial* value comes from the identity.

## Problem

The site's first job, learning who the visitor is, has no owner. Six places decide it separately, and they have drifted:

- The welcome pop-up never opens (#705).
- Home asks desktop visitors for a name but never for pronouns.
- Google and Apple accounts are created nameless, so server-rendered memes for them are un-personalized.
- The name tag copies the account column's `he/him` default over the visitor's choice.
- Custom pronoun sets lose their separators when saved to an account.
- Signing out does not clear the browser copy.
- A signed-in visitor opening a share link is signed out and sent to `/`, losing the page.

## Direction

Personalization is the front door (oracle). This plan makes it true that one module owns the identity and the decision to ask, and that every entry path consumes it: direct, share link, shared content, sign-up, sign-in and sign-out.

## Product Intent

- **Increment 1:** a signed-out visitor without a complete identity is asked once, on whatever ordinary page they are on, and never again once it is complete. A share link's identity is applied, and only a missing half is asked for. A shared meme, video or fact page shows its content on arrival.
- **Increment 2:** an account always ends up with the visitor's complete identity, without retyping, and the account wins thereafter.
- **Increment 3:** on a shared-content page, the first in-page action asks, then carries on.

## Must Not Change

- The share link's format (`?displayName=…&pronouns=…` on any path) and every link already in circulation.
- Identity already stored in a visitor's browser is still read. That covers the current keys, the legacy subject/object keys, the legacy-default migration, and custom pronoun strings.
- How names and pronouns render in facts and memes (`render-fact`, the token grammar, server personalization).
- The server still validates every account write of a name or pronouns. Increment 2 changes *which* pronoun representations it accepts, never *whether* it validates.
- No schema migration. No anonymous server state. Anonymous visitors' names are never sent to the server.

## Settled Decisions

- **One module owns the identity and the decision to ask.** Every identity read, write, share-link application, sign-out clear and account reconciliation goes through it. Capture and edit surfaces call it:
  - the welcome sheet;
  - the signed-out name tag;
  - Profile;
  - the sign-up form;
  - builder initialization.

  None of them touches the storage keys, or the account endpoint for identity, on its own. That nothing outside the module does so is *checked* by the inventory oracle, re-run in each increment's PR body; it is not enforced by a construct.
- **"Complete" is a predicate the module owns.**
  - *Signed out:* a non-empty stored name, and a pronoun value the visitor or a link actually supplied. A value that exists only as the rendering fallback does not count.
  - *Signed in:* the account has both a display name and pronouns. Email registration already permits null pronouns (`routes/localAuth.ts:157`). An account with a name and no pronouns is asked for pronouns only.
  - The `he/him` column default on accounts that already have a display name is treated as supplied. Distinguishing historical defaults is out of scope (Astra concurred: no reconstruction).
- **Unknown is not missing.**
  - Until the auth state has resolved *successfully*, the decision is "not yet".
  - Today the auth context collapses a failed fetch into "signed out" (`use-auth.ts:165-171`). Increment 2 makes the context distinguish the two and offer a retry, while a failure still grants nothing (fail-closed entitlements unchanged).
  - Increment 1 treats "loading" as "not yet" and inherits today's collapse until increment 2.
- **The prompt is the welcome sheet**, the single capture surface everywhere. It cannot be dismissed without saving, as it is built today. It is mounted where route policy, not page layout, decides coverage, so the existing not-found page is covered too (no new 404 page).
- **Signed-out capture never leaves the browser.** Pronoun suggestions while signed out come from the local `inferPronounsFromName` helper, not from `/api/ai/suggest-pronouns`. This is checked by a network assertion.
- **Pages where the sheet never opens:** `/login`, `/onboard`, `/forgot-password`, `/reset-password` and `/verify-email`, plus everything under `/admin`. Matching is by whole path segment, never by bare prefix (#705's defect).
- **Landing exception.** The first page of a visit, if it is `/m/:slug`, `/video/:id` or `/facts/:id` itself, shows its content without asking. A builder sub-route such as `/facts/:id/meme` is already an action and asks at once. Whether this covers typed and bookmarked arrivals is Question 3.
- **Leaving the landing page within the running app asks on the next page, before anything there can be used.** That covers in-app links, the mobile wordmark's `touchend`, an Enter-submitted search, and back/forward between the app's own pages. The deferral lapses when the location differs from the landing location, and the general rule takes over. The visitor sees the page they asked for with the sheet over it, which is "asks, then carries on" with the order of the two visible steps swapped.
  - *Departures the app controls* that the destination rule cannot see go through the action operation below. Examples are an outbound link to a shop, or a window the app opens itself.
  - *Departures the browser controls* proceed without asking: opening a link in a new tab or window (Wouter deliberately leaves modified clicks to the browser, `wouter/src/index.js:283`), Back or a typed URL leaving the site, closing the tab. No page of ours runs at the moment of departure, and the browser's unload prompt is a generic confirmation, not our sheet. A new tab is a fresh visit, so it gets the landing exception again.
  - The ordering and this boundary are Question 4. (Astra, round 2.)
- **In-page actions on a landing page** (increment 3) call one module operation: take an intended action, obtain a complete identity, then run the action exactly once with it. Each action site on the three landing pages is wired explicitly to that operation. The action sites include "make it your own", create, share/reshare, vote, comment, sort and gallery controls; the list is drawn from an inventory of their handlers at increment 3's head. A missed site is a coverage gap the increment's browser tests are written against. It never puts identity policy into the page. The generic click listener is dropped, because it cannot see `touchend`, Enter submits or `onChange` controls (Astra, round 1).
- **Native share after an asynchronous save.** If saving needed the network (a signed-in visitor), the browser's user-activation window may have lapsed, so the pending share is kept and offered as a **Continue sharing** button. A signed-out save is synchronous, so the share runs at once. Question 5.
- **Builders start from the complete identity** (end state; delivered per entry path with the completion path it depends on, see *Increment test*). A builder's draft initializes only once the identity is complete and resolved. A direct builder arrival asks first, then initializes. A restored draft and a subject the visitor deliberately edited are never overwritten.
- **Accounts.**
  - *New account:* the server's own new-account determination at the OAuth callback (`isNewUser`, `routes/auth.ts:162`) is carried to the client through the authenticated session that callback creates, never through a URL or client-writable storage. It works for popup and full-page returns, is bound to that account, and is consumed once. Only that signal authorizes writing a complete browser copy to the account silently. Reaching `/onboard` does not, since other pages send existing accounts there (`SubmitFact.tsx:722`).
  - *Email registration:* already sends both fields, which the module pre-fills.
  - *Existing nameless or pronoun-less account:* asked once, pre-filled from the browser, with the answer saved to the account.
  - *Named account, and provider linking:* never overwritten; the account wins and is mirrored to the browser.
- **Account writes go through the existing validated `PATCH /api/users/me`, followed by a canonical re-read whose success is observable.** The endpoint returns only flags (`users.ts:397`), so the module re-reads the account and mirrors *that* result to both the browser copy and `useAuth().user`, which `BuilderOverlay` reads. The existing `refreshUser()` swallows failures and returns nothing (`use-auth.ts:194-200`), so increment 2 makes its outcome visible to the caller. A write that fails, is rejected, or succeeds but whose re-read fails does three things: it keeps the typed answer and any pending action, offers a retry, and publishes nothing as confirmed.
- **The server accepts the site's structured custom pronoun format.** The site stores custom sets as five pipe-separated forms plus a plurality flag (`lib/pronouns.ts:28-33`). The validator strips the pipes today (`personalName.ts:162`), so `xe|xem|xyr|xyrs|xemself|s` is stored as `xexemxyrxyrsxemselfs`. Increment 2 validates each form of a structured value under the same character and length rules, and stores it with its structure intact. Slash forms keep today's rule. This applies to every pronoun write: registration, `PATCH`, and therefore Profile.
- **Sign-out clears the browser copy as part of the sign-out operation, before the redirect.** Today it does not: `logout()` reloads before `AuthProfileSync` observes the transition (`use-auth.ts:211-218`). Every sign-out control calls the module's sign-out. An expired session is not a sign-out, and the mirror stays.
- **A signed-in visitor opening a share link stays signed in, and the account wins.** `ShareLinkAutoLogout` is deleted. This is David's accepted "account wins" default applied; it is named in the approval ask so he can reverse it.
- **The signed-in name tag keeps navigating to Profile** (`NameTag.tsx:113-114, 231`). There is no new signed-in editor. Profile's identity save goes through the module.

## Repo Context Inspected

**Client:**
- `hooks/use-person-name.ts`;
- `App.tsx`: `ShareParamReader`, `AuthProfileSync`, `ShareLinkAutoLogout`, routes;
- `components/WelcomeModal.tsx` and #713's `lib/welcome-modal-gate.ts`;
- `components/NameTag.tsx`;
- `components/layout/Navbar.tsx`;
- `pages/Home.tsx`, `pages/Login.tsx`, `pages/Profile.tsx`, `pages/Onboard.tsx`, `pages/SubmitFact.tsx`, `pages/FactDetail.tsx`, `pages/VideoPage.tsx`;
- `components/ShareModal.tsx`;
- `pages/memePage/cta/CTABar.tsx`, `pages/memePage/BuilderOverlay.tsx`;
- `meme-builder/wizard/state/useWizardState.ts`;
- `lib/pronouns.ts`, `lib/infer-pronouns.ts`;
- `lib/replit-auth-web/src/use-auth.ts`.

**Server:**
- `routes/auth.ts`: `upsertUser` with `isNewUser`, and the callback redirects;
- `routes/localAuth.ts`: registration;
- `routes/users.ts`: `PATCH /users/me`;
- `routes/ai.ts`: suggest-pronouns;
- `lib/validators/personalName.ts`;
- `lib/db/src/schema/auth.ts`.

**Other:** the oracle, #705, #713's two assessments, and Astra's scope and round-1 assessments.

## Current Behavior

- **Storage.** Identity lives in `localStorage` under `fact_db_name`, `fact_db_pronouns` and `fact_db_name_explicit`. Pronouns read back as `he/him` when nothing is stored.
- **Share links.** Parameters are read at module load. The initial state prefers a stored value over the link, but the persisting effect writes the link's values over stored ones whenever the visitor never set their own explicitly (`use-person-name.ts:66-104` vs `:157-162`). The next load can therefore show a different identity from this one.
- **The welcome sheet** is mounted only in `Layout` and never opens (#705). It asks the server's AI to suggest pronouns from the typed name.
- **Home.** A cold visitor gets an inline name box on desktop, with no pronouns, or a name-then-pronouns flow on mobile.
- **Signing in.** `AuthProfileSync` copies an account's display name into the browser. On every mount, the name tag copies the auth user's name and pronouns, including the column's `he/him` default. Google and Apple accounts are created without a display name. Email registration can leave pronouns null.
- **Pronoun corruption.** A structured custom pronoun set loses its separators on any account write.
- **Signing out** does not clear the browser copy.
- **A signed-in visitor opening a share link** is signed out and redirected to `/`.
- **Builders** copy the identity into their draft once, at mount.

## Source-of-Truth Analysis

- **Signed-out identity:** the browser copy, owned by the module. No new store, and the keys are unchanged.
- **Signed-in identity:** the account row. The browser copy and `useAuth().user` are mirrors, refreshed from a canonical re-read after every write. Neither is a second source.
- **Share-link identity:** the page-load parameters, applied once by the module into empty halves. The module persists exactly what it applied.
- **New-account eligibility:** the server's callback determination, carried in that account's session. The client never infers it.
- **The decision to ask:** one function in the module. #713's gate is folded into it and deleted as a separate file.

## Proposed Design

**The module** replaces `use-person-name.ts`. Its hook keeps the existing read shape, so render-only consumers are untouched. It provides:

1. **State:** name and pronouns, whether each was supplied, and the resolution status of the auth state.
2. **One write.** Signed out, it writes the browser. Signed in, it writes `PATCH` and then reads back the canonical account, publishing the result to both mirrors.
3. **Share-link application:** once per load, into empty halves, persisting what it applied. A signed-in account wins.
4. **Sign-out:** clear the browser copy, then the auth sign-out.
5. **Reconciliation,** after a *successful* auth resolution:
   - a complete account is mirrored to the browser;
   - a new account (by the session's signal) with a complete browser copy receives it silently;
   - otherwise, the visitor is asked for whatever the account lacks, pre-filled from the browser.

   This replaces `AuthProfileSync`'s name handling and the name tag's sync effect, which are deleted.
6. **The decision:** ask when all of these hold:
   - auth has resolved successfully;
   - the identity is incomplete;
   - the location is not suppressed;
   - the location is not the landing page of a landing-exception visit, unless an in-page action has asked.
7. **The action operation** (increment 3): hold an intended action, obtain a complete identity, then run the action exactly once with it. Navigation is not routed through it; the decision handles navigation.

**The sheet** consumes the decision.
- It opens when the decision is true and closes when the decision turns false: another tab's save, a suppressed page, or sign-in.
- It pre-fills what is known and asks for what is missing.
- Its pronoun suggestions are local while signed out.
- On a failed account write, it keeps the answer and offers a retry.

**Home's own capture** (the inline box and the mobile two-step flow) is removed, and Home shows the sheet like every page. That is Question 1.

**The meme page's anonymous name form** is replaced by a "make it your own" action through the operation. That is Question 2.

**The sign-up form** pre-fills from the module, and its own key-reading code is deleted.

## Data Model and Migration Impact

No schema change and no backfill. Increment 2 writes existing columns through the existing endpoint, only at the account owner's own sign-in, and only for an account missing a name or pronouns.

Structured custom pronoun values are stored as the site already stores them in browsers. That is a new stored shape in `users.pronouns` (a `varchar(80)`), and the server-side consumers that read it need checking:

- server personalization in memes and videos;
- prompt construction.

Increment 2's plan of record includes an inventory of every server reader of `users.pronouns`, using `git grep -n 'pronouns'` across `artifacts/api-server/src` and `lib/`. Each reader is shown to handle the structured form the same way the client's renderer does, or is routed through the same parser. Values already corrupted by the old validator are left as they are; nothing reconstructs them.

## Runtime Behavior

| Arrival | Holds | Outcome |
|---|---|---|
| Direct, ordinary page | nothing | sheet asks both |
| Direct, ordinary page | name only | sheet asks pronouns only |
| Direct | complete | never asked |
| Share link, both params | nothing | both applied, never asked |
| Share link, one param | nothing | that half applied, the other asked |
| Share link | own complete identity | own kept, never asked |
| Landing `/m`, `/video`, `/facts/:id` | incomplete | content shows; asked on the next page, or on an in-page action (increment 3), which then runs once |
| Builder route `/facts/:id/meme` | incomplete | asked first; builder initializes after |
| Suppressed page | incomplete | not asked there |
| Auth loading or fetch failed | — | not asked yet; retry offered on failure (increment 2) |
| Sign-in, complete account | anything | account mirrored, never asked |
| First sign-in, new account (session signal) | complete | browser written to account, never asked |
| Sign-in, existing account missing name or pronouns | anything | asked for the missing part, pre-filled; saved to account |
| Signed in, share link | — | stays signed in; account wins |
| Account write fails, or succeeds but the re-read fails | — | answer and pending action kept, message shown, retry offered; nothing published as confirmed |
| Link opened in a new tab from a landing page | incomplete | new tab is a fresh landing: content shows (Q4) |
| Back or typed URL leaving the site | — | browser proceeds; nothing asked (Q4) |
| Sign-out control | — | browser cleared before the redirect |
| Session expired | — | mirror kept |
| Storage unavailable | — | identity held in memory for the page's life; asked on each full load |

## Admin/User UX Impact

- The sheet appears about 600 ms after first paint, only once auth has resolved. Its copy for a half-known identity names what is missing, written under the design skill.
- Home loses its inline capture (Q1).
- The meme page's name form becomes an action (Q2).
- A signed-in share-link visitor stays signed in.
- A slow signed-in save before a share may show **Continue sharing** (Q5).
- Admin pages never show the sheet.

## Security, Permissions, and Validation

- Every account write goes through `PATCH /api/users/me`, authenticated and validated server-side.
- The pronoun validator keeps its character and length rules, applied per form of a structured value.
- **New-account eligibility** is server-issued, account-bound, single-use, and carried only in the authenticated session. A share link, URL parameter or browser value can never cause a silent account write to an existing account.
- A signed-in visitor's account is never overwritten by browser or share-link values.
- No anonymous identity reaches the server, including the AI suggestion service.
- The accounts-auth specialist review applies to increment 2.

## Testing Plan

**Unit tests:**
- **The decision**, as a table over:
  - completeness: none, name only, pronouns only, complete;
  - auth: loading, failed, out, in-complete, in-missing-pronouns, in-nameless;
  - location: ordinary, each suppressed path and a near-miss sibling such as `/loginx`, a landing page at landing, after navigation, and a builder sub-route.

  Negative cases: never while auth is unresolved, never on a suppressed path, never for a complete identity.
- **The module:**
  - legacy keys are read;
  - share-link application touches only empty halves, persists exactly what it applied, and a reload agrees with the first load;
  - sign-out clears the copy before handing over;
  - a failed write keeps the answer, leaves the browser unchanged and allows a retry.
- **The server validator** (api-server tests): structured custom sets round-trip intact; slash forms unchanged; over-length and disallowed characters in any form are still refused.

**Browser tests (Playwright, CI's described-screens suite):**
- The sheet opens on a cold ordinary page and on Home, on the not-found page, but not on `/login`.
- A full share link never shows it; a half link pre-fills and asks.
- A second tab's save closes it.
- No request to `/api/ai/suggest-pronouns` during signed-out capture.
- A cold direct `/facts/:id/meme` asks first, and the builder's name and pronoun fields then hold the saved values.
- Landing on `/m/:slug` shows no sheet; navigating by link, by mobile wordmark and by Enter in search each shows it on the next page. A modified click (new tab) leaves the original tab unchanged and opens a fresh landing.
- Each increment's gated builder entry reaches a usable builder holding the completed identity: route-based in increment 1, signed-in in increment 2, in-place on landing pages in increment 3.
- Increment 3: on each landing page, each wired action asks and then runs once. "Make it your own" opens the builder holding the saved identity; a sort change applies after saving.
- Native share is tested with a delayed account save, separately from the immediate signed-out save.

**Increment 2 journeys,** callback to browser, against the test database: new account, existing nameless, existing named, and provider linking. Also:
- an initial auth-fetch failure, then recovery;
- a save that succeeds but whose re-read fails: answer kept, retry offered, nothing published as confirmed;
- the builder used immediately after an account save shows the saved identity;
- a custom pronoun set surviving registration, OAuth hand-over, reload and rendering.

**UAT doc per increment,** judgement residue only: whether the sheet's copy and timing feel right on a phone.

Runners: `pnpm --filter overhype-me test`, `pnpm --filter overhype-me e2e:screens`, and the api-server's `test`.

## Implementation Steps

1. **Increment 1,** on a fresh branch off `main`:
   - the module and the decision, with #713's gate folded in;
   - the sheet rebuilt on them and mounted at route level, with local suggestions;
   - Home's capture removed (Q1);
   - Login's pre-fill on the module;
   - share-link application;
   - the sign-out operation;
   - `ShareLinkAutoLogout` deleted;
   - route-based signed-out builder initialization waiting for a complete identity.

   The inventory oracle is re-run in the PR body. #713 is closed as replaced when this merges.
2. **Increment 2** *(superseded by the Phase 2 amendment below)*:
   - the auth context's resolved-versus-failed distinction, with retry;
   - the callback's new-account signal through the session;
   - reconciliation;
   - the canonical re-read and both mirrors;
   - the structured pronoun validator, with its server-reader inventory;
   - `AuthProfileSync`'s name handling and the name tag's sync deleted;
   - Profile's save through the module;
   - signed-in builder gating;
   - `refreshUser()`'s outcome made observable.
3. **Increment 3:**
   - the action operation;
   - explicit wiring of every in-page action on the three landing pages;
   - the meme page's name form replaced (Q2);
   - in-place builder gating on landing pages;
   - app-controlled departures through the operation;
   - **Continue sharing** (Q5).

## Amendment — Phase 2, the account (2026-11-01)

**Status:** approved by David, 2026-11-01 ("Plan is approved"). David answered Questions P2-1 and P2-2 on 2026-11-02 (below): English-script names only, no fallback fonts, no older-name path. Where this section and *Increment 2* elsewhere in this plan disagree, this section wins. Increment 1 shipped. Launch Phase 5's onboarding (#795, PR #801) has landed since the plan was written. That onboarding is settled and is built on, not re-decided. The Phase 2 oracle is `.agents/reviews/identity-flow-phase2/oracle-identity-flow-phase2.md`, quoted from #719. It adds two things to oracle items 5–7: the shared name rule (David, 2026-10-21) and #725 (David, 2026-10-18).

### What changed since the plan was written (premises re-read at `origin/main`, 2026-11-01)

- **An account cannot write its identity before onboarding.** `requireEligibleActor.ts:59-66` lets an un-onboarded account reach only recovery, the onboarding draft and completion, and deletion, so `PATCH /users/me` is refused until onboarding completes.
- **Onboarding owns the pronoun question, and has no name.** `GET /auth/onboarding` (`onboarding.ts:115-132`) returns `name: displayName ?? firstName`, but the draft and the completion (`:139`, `:160`) carry pronouns, date of birth and consent. They carry no name.
- **The validator already keeps custom pronoun sets.** The plan's "pipes are stripped" premise is gone: `personalName.ts` keeps six-part sets, capped at 80 (#801). Two readers still fail them:
  - `resolvedIdentityForms.ts:85` maps any `|` set to they/them.
  - `memeBuilder.ts:27` `PRONOUN_ALLOWLIST` accepts five slash presets only.
- **Sign-out already clears the browser copy before the network wait** (`use-sign-out.ts:10`). Late responses from the auth provider can still re-publish the account (`use-auth.ts:138`): its initial load, explicit refresh and entitlement-triggered refresh. That is #725.
- **Name rules in force today** (inventory, `git grep` 2026-11-01):
  - Server: `sanitizeAndValidatePersonalName` (`users.ts:278-300`, `localAuth.ts:134-177`, `auth.ts:202` for provider names, with the denylist skipped); `NameSchema` (`memeBuilder.ts:49`, 50 chars); `share.ts:94` (recipient name, a type check only); `admin.ts:257,1003` (display name as any string).
  - Client: WelcomeModal 100 chars, Login 100, Profile 80, builder fields 40, ShareModal's recipient name unbounded.
- **Fonts (measured 2026-11-01).**
  - *Source-level, this container:* a meme rendered through `generateMemeBuffer` with Anton registered draws Arabic, Persian with ZWNJ, Devanagari, CJK and Hangul as missing-glyph boxes: ink per glyph equals that of U+10FFFD. Astra measured Telugu, Georgian and Armenian the same way, with the same result. Latin and accented Latin render. Fontconfig here has Noto, FreeSerif and WenQuanYi, and `@napi-rs/canvas` uses them only when they are named in the font stack: Astra's `"Impact", "FreeSerif"` drew Arabic, Devanagari and Georgian.
  - *The built server ships no Anton at all.* The font is tracked at `src/lib/assets/fonts/`. The build (`build.mjs:151`) copies `src/assets`. The renderer's built-layout candidates (`memeGenerator.ts:24-27`) look in `dist/assets/fonts` and `assets/fonts`. The Repl's build, asked read-only: `ls: cannot access 'artifacts/api-server/dist/assets/fonts': No such file or directory`, and the same for `artifacts/api-server/assets/fonts`. So built memes today render in whatever face canvas falls back to, not Anton. Unable to verify on the published deployment itself, which builds the same way. This is a live defect independent of Phase 2, and it is fixed separately as a bugfix (see *Related*).

### Product intent (Phase 2)

1. Creating an account by email, Google or Apple puts the stored browser name and pronouns into the account without retyping. Onboarding shows them pre-filled, and confirming onboarding saves them.
2. Once signed in, the account's name and pronouns win everywhere a name or pronouns is shown or used. An onboarded account missing a name or pronouns is asked once, through the same welcome sheet, and the answer saves to the account.
3. Signing out clears the browser copy, and nothing that was in flight at sign-out puts the account's identity back (#725).
4. One name rule decides what a name may be, everywhere a name is typed, saved or rendered. It admits names that can be written in English (David, 2026-11-02), and every admitted name renders in the meme font.
5. A custom pronoun set the server stores renders as that set, not as they/them, in every server path that produces visitor-facing output.

### Must not change (adds to the plan's list)

- Onboarding stays the single place an un-onboarded account answers questions. Phase 2 adds no second pronoun ask and no second onboarding screen. The server's eligibility gate is not loosened.
- A meme's subject, and a share recipient's name, stay independent of the visitor's own identity. They follow the same name rule, but editing them never edits the visitor (the plan's settled builder decision).
- Already-baked memes are fixed artifacts (Launch Phase 5's settled decision); nothing re-renders them.
- Existing browser values and links in circulation are still read, unaltered on read (see Question P2-1 for what happens when such a value is written to an account).
- The memes' existing typography: the selected face (Anton by default) stays the face for every glyph it covers.

### Settled decisions (Phase 2)

- **Account completion rides onboarding, not a separate handover.** Every new account, by any method, reaches onboarding once verified. Two changes there:
  - Onboarding's draft and completion gain the display name, under the shared name rule, and it is required.
  - The name field initializes from, in order: its saved display-name draft (so a reload resumes an edit); the account's explicit `displayName`; the preserved browser name; blank. A provider's first or last name is never an existing display name. `GET /auth/onboarding`'s `displayName ?? firstName` is split so the client can tell them apart (Astra, round 1).
  - The browser candidate is kept until onboarding has initialized. The account identity is published to the browser only after completion succeeds and the canonical re-read succeeds.
  - Pronouns keep #801's order unchanged.
  - **Email registration drops its own pronoun question.** Login's `PronounEditor`, its suggestion state and its required-choice gate (`Login.tsx:116`) go. Registration still sends a browser pronoun choice that was actually supplied, and onboarding confirms or asks, so there is one pronoun question (#801's settled decision).
  - Verification, onboarding and identity readiness compose into one decision. An account not yet eligible never sees the profile-completion sheet, on `/check-email` included. The server's gate is unchanged.

  Confirming onboarding is the one explicit action that writes both fields. That is "without retyping", and it needs no silent write. It replaces the plan's OAuth new-account signal through the session (`isNewUser` carried to the client), which is dropped: there is now no path where a new account needs a silent write. Onboarding pre-fills from what email registration stored.
- **An account that has already been onboarded and is missing a name or pronouns** (accounts from before #801, or before this change) is asked through the welcome sheet. Its answer goes through the existing validated `PATCH /api/users/me`, followed by the canonical re-read. Both are kept from the plan, including the visible outcome of `refreshUser()`.
- **The account wins thereafter.** An account with both fields is mirrored to the browser and never overwritten from it; this covers provider linking. One module does the mirroring. These duplicate writers are deleted:
  - `AuthProfileSync`'s name handling;
  - the name tag's account-sync effect;
  - Profile's own publication of what it submitted;
  - Onboard's own `syncFromProfile` call.

  Each now goes through the module, and the module publishes only the canonical re-read.
- **Stale auth responses are discarded.** Every response from the auth provider (initial load, explicit refresh, entitlement refresh, the module's re-read) is tied to the auth state that issued it. Sign-out invalidates that state when it *starts*, before its network wait, and so does a change of account. A response belonging to an invalidated state publishes nothing. The mechanism (a generation counter, abort signals) is chosen at build.
- **Failed is not signed out.** The plan's resolved-versus-failed distinction in the auth context is kept: a failed read offers a retry and grants nothing, and fail-closed entitlements are unchanged.
- **One shared name rule, one module, used by browser and server.** It lives in a workspace library both import, so the two sides cannot drift.
  - **Admits (David, 2026-11-02, superseding "letters in any script"):** names that can be written in English: Latin letters (A–Z and the accented Latin-1 and Latin Extended-A letters), digits, space, `'`, `-` and `.`. Other scripts are refused until internationalization, after launch. Anton's charset covers U+0020–U+007E and U+00A0–U+0181, so every admitted name renders.
  - **Converts:** ’ (U+2019) and ‘ (U+2018) to `'`; runs of whitespace to one space; trims the ends.
  - **Limit:** 50 grapheme clusters, counted with `Intl.Segmenter`.
  - **No word-count limit**, and no denylist change: the account save keeps its denylist and provider names keep skipping it, as today.
  - **Normalization:** NFC before counting and storing.
  - **Where it applies:** at every write boundary in the inventory above, server side (account `PATCH`, registration, the provider callback, onboarding, admin create and edit, share recipient, meme render, download and save) and client side (the welcome sheet, the signed-out name tag's editor, Login, Profile, Onboard, the builder fields, ShareModal's recipient, the admin user create and edit inputs).
  - **How it behaves while typing:** inputs refuse a disallowed character as it is typed, pasted or committed from an IME, and show a short hint. During composition nothing is refused until the composition commits. The field also stops at 50 visible characters, typed or pasted, with a running count from 40 and a hint when a paste was cut, so no name is ever too long to save (David, 2026-11-02).
  - **Provider names:** a provider-supplied first or last name that fails the rule is cleaned to what the rule admits, or dropped if nothing is left. Never refusing the sign-in, because the visitor did not type it.
  - **Values already stored on accounts** are read as they are and are not migrated. They meet the rule only when next edited.
- **No fallback fonts (David, 2026-11-02).** The name rule admits only characters Anton draws, so nothing is bundled; the font-coverage tests become one assertion that every character the rule admits has a glyph in Anton.
- **Custom pronoun sets reach every server consumer intact.** `resolvedIdentityForms` parses a six-part set into its forms and its singular or plural marker; the client's `lib/pronouns.ts` is the reference. `memeBuilder.ts`'s `PronounsSchema` accepts any value `sanitizeAndValidatePronouns` accepts: the same rule as the account, not a second allowlist. Before anything changes, an inventory is taken of every server reader of `users.pronouns` and of the resolver (`git grep`, with shared helpers traced): meme render, bake and save, the legacy meme path, OG/share copy, the fact-of-the-day email, and image prompts. Each reader is either routed through the resolver or shown unreachable from a stored custom set. Image-prompt readers are checked for reachability first, because Phase 5 retired AI images of the visitor.

### Testing (Phase 2)

- **Journeys, callback to browser, against the test database:**
  - new email, Google and Apple accounts each reach onboarding with the browser name and pronouns pre-filled, and completing it stores both;
  - an existing onboarded nameless account is asked once by the sheet and saved;
  - a named account and a linked provider are never overwritten;
  - a provider first name that differs from the browser name: the browser name is what onboarding shows;
  - a name edited in onboarding survives a reload, from its draft;
  - an email sign-up with no prior pronoun choice is asked once, in onboarding;
  - an account not yet verified never sees the completion sheet, `/check-email` included;
  - a sign-out issued while each of the three auth reads is in flight leaves the browser copy empty (#725, one test per read);
  - a sign-out landing between a save's response and its follow-up re-read publishes nothing, and neither does a change of account while a read is pending.
- **The name rule:** a shared table of accepted and refused values, run by both the browser and the server suites, including accented Latin letters, a combining accent composed by NFC, a 50- versus 51-character pair, the curly apostrophe, an emoji and names in other scripts (refused). IME composition and paste are covered in a component test.
- **Rendering:**
  - a saved meme and a download, each with a custom pronoun set, show its forms;
  - all five custom forms and both plurality markers through saved and downloaded output;
  - every character the name rule admits draws a real glyph in Anton, not the missing-glyph box (the measurement above, turned into an assertion);
  - a pixel comparison shows Latin output unchanged, for the default face and for one explicit non-default selection.
- **Reader inventory:** the table goes in the PR body, each reader with its test or its unreachability evidence.

### Related

- **The built server ships no meme font** (found during this amendment, measured above). Fixed as its own bugfix, off `main`, before Phase 2: Issue #830 and PR #831. Phase 2's font work starts from a server that loads Anton.
- **Next, not Phase 2:** the server registers only Anton, under the names "Anton" and "Impact" (`memeGenerator.ts`). A meme saved with DM Sans or JetBrains Mono selected is drawn on the server in a generic fallback, so it does not match its preview. Bebas Neue's stack falls to Impact, which is Anton. Recorded here so Phase 2's derived stack does not hide it. Bundling those faces is its own change.

### Implementation steps (replaces *Implementation Steps* item 2)

Phase 2 is one increment, on a fresh branch off `main`. Its build order matches its dependencies:
1. The shared name rule and its table, then every write boundary and input.
2. *(Dropped, David 2026-11-02: no fallback fonts.)*
3. The pronoun resolver and validator, with the reader inventory.
4. The auth context's failed state and stale-response invalidation.
5. Onboarding gains the name.
6. The module's account mirroring, and the duplicate writers deleted.
7. The sheet's backstop for onboarded accounts missing identity.

A specialist accounts-auth review goes on the PR, and the inventory oracle is re-run in the PR body.

### Questions for David (Phase 2), answered 2026-11-02

- **P2-1 — Older names that fail the new rule.** *"We're starting from scratch. There will be no older names."* No compatibility path is built. A read-only count found no failing account name in development (26 accounts) or production (1), so nothing was fixed.
- **P2-2 — Font coverage versus size.** *"keep the site in English only and meant to support names that can be written in English. Internationalization will be a whole effort that we can take on after launch."* The rule admits English-script names only, and no fonts are bundled (`decisions.md`, 2026-11-02).

## Amendment — Phase 3, in-page actions on shared pages (2026-11-03)

**Status:** approved by David, 2026-11-04 ("Approve and option 1"), with P3-1 answered: actions that lead to sign-in go straight there. Where this section and *Increment 3* elsewhere in this plan disagree, this section wins. The Phase 3 oracle is `.agents/reviews/identity-flow-phase3/oracle-identity-flow-phase3.md`, quoted from #719 and this plan's oracle block: item 4, the plan's Increment 3 items, and #724 (David, 2026-10-18).

### What changed since the plan was written (premises re-read at `origin/main` `bb8cce30`, 2026-11-03)

- **Two landing pages, not three.** Video was cut for launch, so `isLandingExceptionPath` (`lib/identity.ts:30`) already matches only `/m/:slug` and `/facts/:id`.
- **The meme page's name form is gone (Q2 is delivered).** Launch Phase 4 replaced "See it with your name" with a sign-up card (`CTABarAnonOther`), and PR #852 sent "Make this fact about me" to the standard builder on `/facts/:id/meme`. Neither landing page holds a builder of its own except one: the fact page's alternate-phrasing cards open the wizard in place (`FactDetail.tsx:90-108`, `setShowStudio(true)` at `:144`), with no identity gate.
- **"Make it your own" already asks first.** Every remaining "make a meme" control navigates to `/facts/:id/meme` (`FactDetail.tsx:264-266`, `FactActionCluster.tsx:109-112`, `FactComments.tsx:437`, `MemePage.tsx` `openMakeAboutMe`). That route is not a landing page, so the decision asks there, and the builder waits on `builderReady` (`FactDetail.tsx:261-262`). Navigation within the app is covered the same way: the next page asks.
- **No share action opens the native share sheet directly.** Share opens a modal (`FactActionCluster.tsx:92-95`, `MemePage.tsx` `handleCustomShare`); the native share runs from a button inside it (`MemeShareModal.tsx:94`), on its own tap. So asking for identity before opening the modal adds no extra tap, which is what **Continue sharing** (Q5, #721) existed to pay for. That is the whole claim. It is not that sharing is activation-safe: the modal's own share button awaits `fetchShareCopy` before calling `navigator.share` (`MemeShareModal.tsx:88-94`), and its Twitter and clipboard buttons have the same shape, so a slow response can still exhaust the tap's activation ([Web Share](https://www.w3.org/TR/web-share/#share-method); Astra, round 1). That is an existing modal defect, unrelated to identity, and is recorded separately (*Related*).
- **#724 is reachable through a restored draft.** A fresh signed-out builder cannot save: it shows `GuestPhotoSignupPanel` in place of a photo source (`Step2Image.tsx:253-254`), and "Make my meme" is disabled until a source is selected (`:292`). But a draft restores before the image step mounts (`useWizardState.ts:123-129`) and can carry a selected photo, and drafts are cleared only on an observed signed-in-to-signed-out transition or a signed-in start (`App.tsx:119-130`), not on a load that starts signed out. So a creator whose session ended elsewhere, reloading within the draft's life, holds a selected photo while signed out, and save sends the identity before the 401 (`Step2Image.tsx:163-195`). Source availability does not establish sign-in (Astra, round 1).
- **#735's paths are gone.** The builder it names was deleted in PR #852; Phase 2 made the meme schema accept any pronoun value the account accepts, and the wizard reports a failed save in place (`Step2Image.tsx:205-211`).

### What remains: the in-page action inventory

The class is: **every action a visitor can take on either landing page, through every component the page renders, including the shared page chrome** (`Layout`, `Navbar`, the name tag), the gallery's cards and menus, and the comment section. Hover and passive scrolling are outside it. The inventory is taken through the rendered tree, not a directory list: starting from `MemePage.tsx` and `FactDetail.tsx`, follow each rendered component's imports and search each file for handlers and links (`git grep -nE "onClick=|onTouchEnd=|onChange=|onSubmit=|onSelect=|onKeyDown=|href=|window\.location|window\.open|navigator\.(share|clipboard)|setLocation\("`), then trace each hit's destination and effect. Each reachable action ends in exactly one disposition:
- **through the operation** (`askBefore`);
- **destination asks:** an in-app navigation to a page the decision asks on;
- **parent already asks:** it sits inside a menu or modal whose opener goes through the operation;
- **capture surface:** it is itself where identity is entered (the signed-out name tag's editor);
- **exception:** named in this plan: actions that lead to sign-in or sign-up go straight there, without asking (David, 2026-11-04, P3-1 option 1).

"Signed in only" describes who can reach an action, not its disposition: a set-up signed-in account missing identity is still asked (Phase 2), so those actions go through the operation too. The inventory is re-run at the increment's head and reconciled in the PR body. At `bb8cce30` it classifies as (round 1 of Astra's review supplied the gallery-card, comment, chrome and heart rows):

| Page | Action | Today | Phase 3 |
|---|---|---|---|
| fact | share (the fact card's cluster) | opens the share modal | through the operation |
| fact | comment button (scroll to comments) | scrolls | through the operation |
| fact | gallery tabs, sort select | change the gallery | through the operation |
| fact | vote, on the main and the alternate cards | signed out: to `/login` | exception (P3-1): straight to sign-in |
| fact | comment form submit, its sign-in link | signed out: to `/login` | exception (P3-1): straight to sign-in |
| fact | alternate card's "Make meme" | opens the wizard in place, ungated | navigates to `/facts/<alternate>/meme`, like every other "make a meme" |
| fact | "Make a meme of this" (×3), meme thumbnails, related facts, parent link | in-app navigation | none: the destination asks |
| fact | gallery card copy link, open full size, own delete: the menu and the desktop Copy link shortcut (`FactDetail.tsx:462`, `ImageCard.tsx:394, 578`) | clipboard, `window.open`, delete | through the operation, at the menu opener and at the shortcut; both are tested |
| fact | gallery meme hearts | signed out: to `/login` | exception (P3-1): straight to sign-in |
| fact | comment sort (`FactComments.tsx:466`) | changes the comment order | through the operation |
| fact | comment hearts (`CommentHeartButton.tsx:29`) | signed out: to `/login` | exception (P3-1): straight to sign-in |
| both | mobile search opener (`Navbar.tsx:144`) | opens the search field in place | through the operation |
| both | navbar sign-in (`Navbar.tsx:153, 229`) | to `/login` | exception (P3-1): straight to sign-in |
| both | logo, navbar links, a submitted search | in-app navigation | none: the destination asks |
| both | signed-out name tag | opens its own name editor | capture surface: none |
| both | account avatar (signed in) | to `/profile` | none: the destination asks |
| meme | heart | signed out: to `/login` | exception (P3-1): straight to sign-in |
| meme | signed-out "Sign up free", tier-ladder sign-in link | full-page or in-app to sign-up | exception (P3-1): straight to sign-in |
| meme | own download, own custom share | signed in only | through the operation |
| meme | "Make this fact about me", "Browse more facts", "View full fact", back links | in-app navigation | none: the destination asks |

A signed-in visitor on a landing page is asked only when the account is set up and incomplete (Phase 2's decision), so for most rows the signed-out visitor is the case that matters; the operation treats both the same.

### Product intent (Phase 3)

1. On `/m/:slug` and `/facts/:id`, the content shows on arrival with no prompt (unchanged).
2. A visitor without a complete identity who takes an in-page action there is asked first, through the same welcome sheet, and once they save, the action runs exactly once, as if they had just tapped it.
3. Every "make a meme" control on a landing page goes to the one builder's route, which asks first and then opens the builder with the saved identity.
4. No create request carrying a signed-out visitor's identity can leave the browser (#724).

### Must not change (adds to the plan's list)

- The landing exception itself: arrival never asks, and leaving within the app asks on the next page, as Phase 1 built.
- The welcome sheet stays the one capture surface and cannot be dismissed without saving.
- Signed in, the account wins; an account not yet set up is never asked by the sheet (Phase 2).
- One meme builder, reached by its route (David, 2026-11-03, #851).

### Settled decisions (Phase 3)

- **One operation in the identity module: `askBefore(action)`.** If the identity is complete, the action runs now. Otherwise the module holds it as the one pending action, the decision asks even on the landing page while it is pending, and when the identity becomes complete (signed out: the browser save; signed in: the canonical re-read Phase 2 built) the action runs exactly once. A newer action replaces a pending one. A location change discards it, since the visitor is no longer where the action made sense. A failed account save keeps it, with the sheet's retry (Phase 2). Pages call the operation; none of them decides whether to ask.
- **The decision gains one input:** an action is pending. `shouldAskForIdentity` lifts the landing exception while it holds, and nothing else changes in it.
- **Each wired site is explicit** (the plan's settled decision, kept): the handler wraps its own effect in `askBefore`. No generic click listener.
- **The alternate card's in-place builder is replaced by navigation** to `/facts/<alternate id>/meme`, so the landing page holds no builder and the in-place gating item has nothing left to gate. This follows the one-builder decision (#851).
- **Continue sharing is not built, and #721 closes when this merges,** on the narrow ground it was opened for: asking for identity adds no extra tap before sharing, because the deferred action opens the share modal and the visitor's next tap is inside it. The modal's own slow-network activation defect is separate (*Related*).
- **The builder checks sign-in before any create request that carries identity (#724, the issue's own fix).** Signed out, or auth not resolved, "Make my meme" sends nothing and goes to sign-in. Source availability is never taken as sign-in. #724 closes when this merges. #735 closes as resolved, with the evidence above quoted in the PR.
- **A deferred action that needs a browser gesture** (clipboard write, opening a window) is not assumed to keep the original tap's activation after an asynchronous save. Where it is deferred, the operation opens the menu or modal that holds it, so the gesture is the visitor's next tap; it never calls the gesture-gated API from a delayed callback.
- **App-controlled departures** on a landing page are the signed-out "Sign up free" (`MemePage.tsx` `handleAnonMake`, a full-page navigation), a P3-1 row, and the gallery card's "open full size" (`window.open`), which goes through the operation.

### Testing (Phase 3)

- **Unit, the operation:** a complete identity runs the action at once; an incomplete one holds it, and it runs exactly once on save; a newer action replaces it; a location change discards it; a failed account save keeps it until the retry succeeds; signed in, it runs after the canonical re-read, not before.
- **Unit, the decision:** the landing page asks while an action is pending and not otherwise (added rows in the existing table).
- **Component, per wired family:** share, comment scroll, gallery tab and sort, comment sort, gallery card menu (copy link, open full size, delete), mobile search opener, own download and own share each call `askBefore` and run once after a save; a gesture-gated action is reached through its menu or modal on the visitor's next tap, never from the delayed callback; the alternate card's "Make meme" navigates to its builder route.
- **Browser (described-screens suite), signed out with no identity:**
  - `/facts/:id` shows the fact with no sheet; tapping share shows the sheet; saving opens the share modal.
  - Changing the sort shows the sheet; saving applies the new sort.
  - An alternate card's "Make meme" lands on `/facts/<alternate>/meme`, which asks, and the builder then holds the saved name and pronouns.
  - `/m/:slug` shows the meme with no sheet; its heart and "Sign up free" go straight to sign-in or sign-up with no sheet (P3-1).
  - No request to `/api/memes` from a signed-out builder (#724): a fresh guest builder; a selected-photo draft restored on a load that starts signed out; and a mounted builder whose auth changes to signed out before save.
- **Inventory:** the oracle's hit list goes in the PR body, each hit classified as wired, navigation, or signed-in only.

### Implementation steps (replaces *Implementation Steps* item 3)

Phase 3 is one increment, on a fresh branch off `main`:
1. The operation and the decision's new input, with their unit tests.
2. The wiring, site by site from the inventory, with component tests.
3. The alternate card's navigation.
4. The builder's sign-in check before save, and its three tests (#724).
5. The browser tests, and the inventory re-run in the PR body.

### Related (Phase 3)

- **The share modal can lose the browser's tap on a slow network** (Astra, round 1): its share, Twitter and clipboard buttons await the share-copy request before calling the browser API (`MemeShareModal.tsx:88-94`). It predates and is independent of identity, so it is *next*, not Phase 3: Issue #854. The proportionate fix is to fetch the copy when the modal opens.

### Questions for David (Phase 3), answered 2026-11-04

- **P3-1 — An exception to "pretty much any action": actions that lead to sign-in.** Your agreed behaviour is that a visitor's first real action on a shared page asks first. Some actions on those pages send a signed-out visitor to sign-in or sign-up: vote (on the fact and its alternate phrasings), the meme's heart, gallery meme hearts, comment hearts, posting a comment and its sign-in link, the navbar's sign-in, and "Sign up free". Should these be an exception, going straight to sign-in without asking?

  **Answered: option 1** (David, 2026-11-04, "Approve and option 1"). They go straight to sign-in.
  1. **Make them an exception: go straight to sign-in** (recommended; Astra agrees). A returning visitor on a new device would otherwise be asked a name their account already has, and the account then overrides it. A new account is asked its name and pronouns once in onboarding anyway. Cost: for these taps the moment of capture moves to onboarding, so a visitor who abandons sign-in leaves without a name in the browser.
  2. **No exception: ask first, then go.** Matches your words literally, and onboarding then shows the name pre-filled. Cost: a returning account holder is asked for a name before signing in, and the answer is discarded when the account wins.

  Either way, a signed-in account's own actions still ask when the account is missing a name or pronouns.

## Amendment — Phase 4, fact pages ask first; the name tag shows no unchosen pronouns (2026-11-04)

**Status:** approved by David, 2026-11-04 ("Option 1 is fine", to the approval ask); P4-1 answered in his words (below). Where this section and anything earlier in this plan disagree, this section wins: it changes the *Landing exception* settled decision and David's 2026-10-17 answer to Question 3, for fact pages only. Workstream: Issue #856. The Phase 4 oracle is `.agents/reviews/identity-flow-phase4/oracle-identity-flow-phase4.md`, quoted from Issue #856's body:

> **What David saw (UAT of PR #855, 2026-11-04):** opening a fact link directly, with no name set, renders the fact as "__ can set ants on fire with a magnifying glass. At night." The name tag reads "AS: (he/him)", with pronouns nobody chose and no name.
>
> *"This is what a fact page with no name looks like. I feel like even this is wrong and because there is no name set, the name should be the first thing asked, before rendering the page."* — and of the meme page: *"Meme page feels right, content first works here."*
>
> **Decision (David, 2026-11-04).** This changes his 2026-10-17 answer to Question 3 (*"every first landing on a meme, video or fact page shows content first"*):
> - **Fact pages** (`/facts/:id`) leave the content-first exception. A visitor without a complete identity is asked before the page renders, as on every other page.
> - **Meme pages** (`/m/:slug`) keep content first, with the first action asking (Phase 3, PR #855).
>
> **Why the two differ:** a meme's image already carries its creator's name, so it is worth seeing as it is. A fact is a template with nothing to show until it has a name.
>
> **Also in scope:** the signed-out name tag never shows a pronoun fallback that wasn't supplied. With no identity it shows neither a name nor "(he/him)".
>
> **Done when:**
> - A cold visit to `/facts/:id` opens the welcome sheet before the fact renders.
> - A cold visit to `/m/:slug` still shows the meme first.
> - The name tag shows no unchosen pronouns.
> - `decisions.md` records the change to the 2026-10-17 answer.

### Premises (read at `origin/main` `0fe9d228`, 2026-11-04)

- **The exception is one predicate.** `isLandingExceptionPath` (`artifacts/overhype-me/src/lib/identity.ts:30-33`) returns true for a two-segment path under `m` or `facts`; `shouldAskForIdentity` (`:83-97`, the check at `:87`) skips asking only when that holds for the landing path, the visit has not lapsed, and no action is pending. Nothing else in the client tests for a fact path to decide whether to ask (`git grep -n "isLandingExceptionPath"`: the module, its test, and `mustWaitForIdentity` through `shouldAskForIdentity`).
- **The order matters for signed-in accounts.** The landing check runs before the signed-in branch (`identity.ts:87-95`), so today a set-up account missing a name or pronouns also sees a fact page's content first. After this change it is asked on arrival there too, as on every other page — the same rule, not a new one.
- **The sheet opens over the page, late.** `WelcomeModal` renders a fixed, full-screen dialog over a blurred backdrop (`components/WelcomeModal.tsx:306-307, 335-336`) that cannot be dismissed without saving. It opens only once auth has resolved (`identity.ts:85`: unknown auth never asks, and a failed auth read counts as unknown, `hooks/use-identity-gate.ts:111-114`) and then **600 ms after** the decision turns true (`WelcomeModal.tsx:87-98`). The fact page renders its fact the moment the fact fetch returns (`pages/FactDetail.tsx:259-262`), independently of both. So dropping the exception alone still shows the nameless "__" fact, unobscured, for the auth read plus 600 ms (Astra, round 1).
- **The page can already wait on the identity module without deciding anything.** `FactDetail` mounts the builder on `/facts/:id/meme` only when `useIdentityGate().builderReady` holds (`FactDetail.tsx:240-244`); the module computes it (`use-identity-gate.ts:136`). A second flag of the same kind needs no identity rule in the page.
- **The name tag guesses.** Signed out, it prints `displayPronouns(pronouns)` unconditionally (`components/NameTag.tsx:175, 188`), and `usePersonName()` returns `pronouns: DEFAULT_PRONOUNS` ("he/him") when nothing was supplied (`hooks/use-person-name.ts:113-114, 219-222`), so a cold visitor reads "AS: (he/him)". Signed in, it shows pronouns when the auth snapshot holds any or the context value differs from "he/him" (`NameTag.tsx:153-156`) — a guess at the same fact `pronounsSupplied` already records: `setPronouns` and `syncFromProfile` set it exactly (`use-person-name.ts:274-302`).
- **The account mirror does not make `pronounsSupplied` the account's.** `accountMirrorFor` mirrors nothing when the account has no display name, and keeps the browser's supplied pronouns when the account has none (`components/auth/AccountIdentityMirror.tsx:32-37`, tested at `AccountIdentityMirror.test.tsx:21-27`). So, signed in, the flag can describe the browser rather than the account (Astra, round 1). A Profile save refreshes the auth user (`pages/Profile.tsx:410, 629`), so the account's own `pronouns` is current after an edit.
- **The askBefore wiring on the fact page goes quiet but stays correct.** A fact-page action taken after the arrival ask finds a complete identity and runs at once; while auth is still loading it waits, as it does today (`mustWaitForIdentity`, `identity.ts:107-109`).

### Product intent (Phase 4)

1. A visitor without a complete identity arriving on `/facts/:id` — by a shared link, typed, bookmarked or opened in a new tab — sees the welcome sheet first, and never the fact without their name; once they save, the fact shows with their name (David, 2026-11-04: *"when someone clicks a link to a specific fact, but they don't have any name saved yet, the 'What's your name' modal pops up first. Once they've filled out their name and pronouns then they see the page rendered properly."*).
2. `/m/:slug` is unchanged: the meme shows first, and the first in-page action asks (Phase 3).
3. The name tag shows pronouns only when they were supplied: signed out, by the visitor or a share link; signed in, on the account. With no identity it shows no name and no pronouns.
4. `decisions.md` records the change to the 2026-10-17 Question 3 answer, with David's words and the reason the two pages differ.

### Must not change (adds to the plan's list)

- The meme page's landing exception and its lapse rules (Phase 1), and every Phase 3 behaviour on `/m/:slug`, P3-1 included.
- `askBefore`, `PendingActionRunner` and `mustWaitForIdentity` as built; the decision gains no input and loses none.
- The welcome sheet stays the one capture surface; no new prompt, banner or fact-page variant of it.
- How names and pronouns render in facts and memes: the renderer's he/him fallback (`DEFAULT_PRONOUNS`) is a rendering default and stays; only the name tag stops displaying it as a choice.

### Settled decisions (Phase 4)

- **The landing exception matches `/m/:slug` only.** `isLandingExceptionPath` drops `facts`; its doc comment and `IdentityDecisionInput`'s say so. That is the whole change to the decision. A fact page now asks exactly as Home or Search does, including for a set-up signed-in account missing either half (Phase 2's rule, reached by the same path).
- **The fact page holds its fact until the identity is ready (P4-1, answered).** The identity module exposes one more flag beside `builderReady`, true when the fact can render with a name: false while auth is unknown and the browser holds no complete identity, and while the sheet would ask; true otherwise — a complete identity, or an account onboarding has not finished, which the sheet never asks (Phase 2) and which renders as today. Until it holds, `/facts/:id` shows its existing loading surface (the spinner it shows while the fact loads) in place of the fact; the sheet opens over that. The page reads the flag and decides nothing, as with `builderReady`. A visitor whose browser already holds a complete identity sees no change in timing.
- **The hold is the fact page's only.** Other pages keep showing their content behind the sheet as today; the oracle names fact pages, and Home and Search are lists, not one fact waiting for its name.
- **The fact page's `askBefore` wiring stays.** It now runs at once for nearly every visitor, but it is still the correct behaviour while auth loads, and removing it is dead-code work for #853, not this change.
- **The name tag shows only supplied pronouns, from the source that owns them.** Signed out: pronouns show iff `pronounsSupplied`, and the `pronounSubject/pronounObject` fallback string goes. Signed in: the account's own `pronouns`, formatted with `displayPronouns`, and nothing when the account has none — replacing the guess `userPronounsRaw || pronouns !== DEFAULT_PRONOUNS`. Not `pronounsSupplied` there, because the mirror can leave it describing the browser (premises). The mirror and onboarding prefill are untouched. The name span renders whatever name is held, empty included, as today.

### Testing (Phase 4)

- **Unit, the decision** (`src/lib/identity.test.ts`): `/facts/7` is not a landing page and `/m/abc` still is; a cold `/facts/7` landing asks, signed out and for a set-up incomplete account; the existing landing rows (exception, lapse, `actionPending`, the incomplete-identity block at `:146`) move to `/m/` paths so they keep testing the exception rather than silently testing an ordinary page.
- **Unit, the operation** (`use-identity-gate.askBefore.test.tsx`, `__tests__/landingActions.askBefore.test.tsx`): re-run; any case that relies on `/facts/:id` being a landing page moves to `/m/:slug` or is rewritten against the new rule — each such case named in the PR body.
- **Unit, the hold flag:** false while auth is unknown (loading or failed) with an incomplete browser identity; true while auth is unknown with a complete one; false while the sheet would ask, signed out and for a set-up incomplete account; true for a complete identity and for an account not yet set up.
- **Component, the fact page:** with the flag false the fact text is absent and the loading surface shows; with it true the fact renders.
- **Component, the name tag** (new `NameTag.test.tsx`): signed out with no identity shows no "(he/him)" and no pronouns at all; a name with no pronouns shows the name alone; supplied "he/him" shows "(he/him)"; a custom set shows its display form. Signed in: an account with pronouns shows them; an account without pronouns shows none even when the browser holds supplied ones; a nameless account with saved pronouns shows them on a cold browser; an account and browser that disagree show the account's.
- **Browser** (`e2e/identityFlow.spec.ts`, signed out, no identity; names with a pronoun suggestion — Sarah, Emily, Grace):
  - **Order, not just eventual visibility:** with the fact stubbed to answer at once and the auth read held back, a cold `/facts/:id` never shows the fact text — not before the sheet, not while it is open — and after saving shows it with the saved name. A visitor with a seeded complete identity sees the fact with no sheet.
  - Phase 1's "a shared meme shows its content first…": the new-tab step on `/facts/551` now expects the sheet in the new tab and none in the original; its other steps are unchanged.
  - Phase 3's share and sort journeys on `/facts/571` and `/facts/573` are rewritten: the sheet on arrival, then share opens the modal and the sort applies at once, with no second sheet. The browser proof of `askBefore` on a landing page moves to `/m/:slug`, through the one in-page action a signed-out visitor has there: the phone's search opener (`Navbar.tsx:144`) asks, and after saving the search field opens.
  - A cold `/m/:slug` still shows the meme with no sheet, and its name tag reads no "(he/him)".
- **Sweep:** every browser test that lands cold on `/facts/:id` (`git grep -nE 'goto\(["\x60]/facts/' -- artifacts/overhype-me/e2e`, today in `identityFlow`, `publicScreens` and `adminPermissions`) is read, and any that interacts behind a now-open sheet seeds an identity first. The full browser suite runs locally before the PR opens.

### Implementation steps (Phase 4, one increment, one PR off `main`)

1. The predicate and its comments, with the decision's unit table.
2. The hold flag in the identity module, the fact page reading it, and their tests. When the hold releases, the page's below-fold observer and its idle fallback (`FactDetail.tsx:157-175`, which return early while their sentinel is absent and rerun only on `fact` or `belowFoldMounted`) initialize once their content mounts, so the gallery, comments, alternate phrasings and related facts appear; the cold-arrival → save → gallery-sort browser journey keeps its cold arrival to prove it (Astra, round 2).
3. The name tag's rule, with its component test.
4. The browser tests above, and the sweep.
5. `decisions.md`: the change to the 2026-10-17 Question 3 answer, fact pages only.
6. The prose sweep (`prose-sweep` skill) over the payload for the retired reading "fact pages show content first" — this plan's earlier sections stay as history under this section's precedence line; live code comments and test descriptions are fixed.

### Questions for David (Phase 4), answered 2026-11-04

- **P4-1 — What "before the page renders" means on a fact page.** Answered by David, 2026-11-04: *"when someone clicks a link to a specific fact, but they don't have any name saved yet, the 'What's your name' modal pops up first. Once they've filled out their name and pronouns then they see the page rendered properly."* Astra's round 1 showed that the sheet alone opens after the auth read and a further 600 ms, during which a fast fact shows as "__" in the clear, so the modal would not come first. The hold flag above is what delivers his description.

## Risks and Mitigations

- **The sheet blocks a visitor who arrived to do one thing.** Intended. Bounded by the suppressed pages and the landing exception.
- **An in-page action on a landing page left unwired in increment 3.** The visitor acts without being asked, then is asked on the next page. No identity policy leaks into the page. Mitigated by the handler inventory and the per-family browser tests.
- **Server readers mishandling structured pronouns.** Mitigated by the increment 2 reader inventory, with each reader shown to use the shared parser.
- **The new-account signal lost between callback and client** (popup closed early, session race). The account then falls to the "existing nameless" path: asked, pre-filled. One extra tap, never a wrong write.
- **Stale visitors asked again for pronouns.** Intended, and only once.

## Questions for David

1. **Home's first-visit box.** Remove it, so Home shows the same sheet as every page, or keep it as a second way in?
   - Recommendation: **remove**. Two capture designs drift, and today's box never asks for pronouns on desktop.
   - Astra agrees.
2. **The shared-meme page's "See it with your name" form.** Replace it with "make it your own" using the saved identity (asked first if missing)?
   - Recommendation: **replace**. A second name field there can disagree with the saved one.
   - Astra agrees.
3. **Typed and bookmarked links.** Does "show the content first" cover every first landing on a meme, video or fact page, not only ones arriving from a share?
   - A link can't say it was shared without changing the link format, which is fixed.
   - Recommendation: **yes, every first landing**. Astra agrees and asked that it come to you rather than be settled by us.
4. **Leaving a shared page.** Two parts:
   - (a) When a visitor with no name moves to another page *on the site*, that page opens with the sheet over it, rather than the sheet appearing first. Is that acceptable? It covers taps, the mobile logo, search and back/forward with one rule.
   - (b) When the *browser* takes them elsewhere, they go without being asked. That covers opening a link in a new tab (which then shows its content first, as a fresh visit), pressing Back off the site, or closing the tab. No site can show its own sheet at that moment; the most a browser allows is a generic "leave site?" box.
   - Recommendation: **yes to both**. Astra recommends the same, and asked that (b) come to you as a boundary rather than be assumed.
5. **Sharing after a slow save.** When a signed-in visitor with an incomplete account taps "share" on a shared page, saving goes to the server, and the phone may refuse to open its share sheet afterwards. Can they then see a **Continue sharing** button, one extra tap?
   - Signed-out visitors, the common case, never see it.
   - Recommendation: **yes**. Astra recommends the same.

**Applied from your accepted defaults, named so you can reverse them:**
- A signed-in visitor opening a share link now stays signed in, and their account wins. Today they are signed out and sent to the home page.
- Pronoun suggestions in the pop-up come from the browser, not the AI service, because the name stays in the browser until an account exists.

## Definition of Done

- [ ] Rules 1–7 hold in the product, exercised in a browser against a local stack and listed per increment in its UAT doc.
- [ ] The inventory oracle, re-run on the final head, finds identity reads and writes only in the module and in render-only consumers.
- [ ] No storage key is touched outside the module.
- [ ] No anonymous name leaves the browser.
- [ ] A custom pronoun set survives every account path intact.
- [ ] #705 is closed by increment 1, and #713 is closed as replaced.
- [ ] Each increment passed its Codex review loop, and increment 2 also passed the accounts-auth specialist review.
