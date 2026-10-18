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
2. **Increment 2:**
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
