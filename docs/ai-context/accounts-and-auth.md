# Accounts and Authentication

> The operational shape of sign-in, account creation, and the account
> lifecycle. **This is not the security posture** — trust boundaries,
> CSRF, rate limits, and session-security properties live in
> [`security-model.md`](./security-model.md#authentication--sessions); read
> both for auth work. Primary code: `artifacts/api-server/src/routes/auth.ts`
> (OAuth), `artifacts/api-server/src/routes/localAuth.ts` (local
> email/password + verification + reset), `artifacts/api-server/src/lib/auth.ts`
> (session primitives, admin bootstrap), `artifacts/api-server/src/lib/userRole.ts`
> (role derivation), `lib/replit-auth-web/src/use-auth.ts` (client-side
> `useAuth()`).

## Sign-in methods

Three, all converging on the same server-side session:

1. **Google OAuth** (OIDC via `openid-client`) — `GET /login/google`
   (`auth.ts:466-515`; bare `/api/login` defaults to Google, `auth.ts:459-464`),
   callback `GET /callback/google` (`auth.ts:588-596`). PKCE + state persisted
   in `oauthPendingStatesTable` (`lib/db/src/schema/auth.ts:101-115`) so a
   server restart mid-flow doesn't loop.
2. **Apple OAuth** (OIDC, `response_mode=form_post` since Apple posts back
   in the request body, not the query string) — same `GET /login/apple`
   route, callback `POST /callback/apple` (`auth.ts:598-620`).
3. **Local email/password** — register `POST /auth/register`
   (`localAuth.ts:84-218`), login `POST /auth/local-login`
   (`localAuth.ts:220-311`).

Both OAuth providers share `handleOAuthCallback()` (`auth.ts:209-395`), which
upserts a `usersTable` row keyed by lowercased email (`upsertUser`,
`auth.ts:136-207`) and creates a session.

**There is no magic-link/passwordless sign-in.** The password-reset email
link is a *reset* mechanic (§ Password reset), not a login mechanic. Email
verification links do mint a session as a side effect for a fresh
registration (§ Email verification), but that's incidental, not a designed
"sign in via email" feature.

**Correcting a documentation drift found while writing this spec:**
[`threat-model.md`](../threat-model.md) and
[`architecture-map.md`](./architecture-map.md) both stated "Replit OIDC +
Google/Apple OAuth + local email/password" as the auth stack. No live Replit
OIDC integration exists anywhere in the runtime code (verified: no
`replit.com/oidc`, no issuer/client-ID wiring outside the unrelated
`@workspace/replit-auth-web` package name, which is a generic React
auth-context helper, not an OIDC client — `lib/replit-auth-web/src/use-auth.ts`).
The `users` and `sessions` schema comments (`lib/db/src/schema/auth.ts`) now
say what the tables are and that Replit Auth is retired; the starter
template's "mandatory for Replit Auth" boilerplate went in launch Phase 4,
removal 7, with the admin access screen's "your Replit user ID" setup tip.

There is also a **dev-only admin bootstrap login** (`GET`/`POST
/auth/dev-admin-login`, `localAuth.ts:735-836`), fail-closed and gated by
`isDevAdminLoginEnabled()`, never live in production — already fully
documented as security-model.md's C1 finding; this spec doesn't duplicate it.

## Account creation

`POST /auth/register` (`localAuth.ts:84-218`) requires `email`, `password`
(8–128 chars, `localAuth.ts:103-121`), `firstName`/`lastName`
(`localAuth.ts:156-171`), and a sanitized `displayName`
(`localAuth.ts:123-128`). **`pronouns` is optional at the API layer**
(`localAuth.ts:146-154`) — the frontend's requirement that a submitter pick
pronouns before registering (`Login.tsx:118-123`) is a client-side-only
gate; the server accepts a registration with no `pronouns` field and stores
`null`. Google/Apple signups present no pronoun selection at sign-up; since launch
Phase 5 (0114) the column has **no default**, so such an account's pronouns
are null — "not chosen yet" — until the onboarding screen asks. No account
is assigned pronouns without a screen having been shown (the admin user
editor sends pronouns only when it holds a value).

On success: the row is inserted `isActive: true`
(`localAuth.ts:173-185`); **a session is created and the cookie set
immediately** — the user is logged in before doing anything else
(`localAuth.ts:199-200`); a verification email fires asynchronously,
non-blocking (`localAuth.ts:203-207`).

**There is no separate anonymous/guest account type.** Every `usersTable`
row is a full account. Since launch Phase 5 (increment 3, #795) a signed-in
account moves through one order — **verify, then onboard, then act** — and
the server enforces it:

- **Eligibility** is derived from the row on every request
  (`artifacts/api-server/src/lib/eligibility.ts`, `eligibilityOf`), first
  reason wins: `suspended` while `suspended_at` is set (§ Suspension),
  `deletion_pending` while the account has an active deletion request
  (`userLeaving()`, § Account deletion), `unverified` while
  `email_verified_at` is null, `unonboarded` while
  `onboarding_completed_at` is null, else `eligible`.
  `authMiddleware` puts it on `req.user.eligibility`, with `is13Plus` and
  `is18Plus` derived from `date_of_birth` at read time, never stored.
  `identityFieldsOf(row)` is the one derivation, spread by `authMiddleware`
  and by the test app (`buildTestApp`), so a test double cannot drift from
  production.
- **The verified-actor gate** (`middlewares/requireEligibleActor.ts`,
  installed after `authMiddleware` in `app.ts`) refuses every unsafe-method
  request, and the inventoried GETs that write (`GET /link/:provider`), from
  a signed-in account that is not eligible: 403 with
  `ACCOUNT_SUSPENDED`, `DELETION_PENDING`, `EMAIL_VERIFICATION_REQUIRED` or
  `ONBOARDING_REQUIRED`. Its exported `GATE_EXCEPTIONS` table (state →
  routes) is the only statement of who may write in each state: the
  recovery routes (register, local login, forgot/reset password, resend
  verification, logout, the Apple callback, the dev-admin login) for an
  unverified or un-onboarded account, the two onboarding routes and a
  deletion request (a verified account that never finished set-up may still
  leave) for an un-onboarded one, "Keep my account" (`POST /users/me/deletion/cancel`)
  (beside the recovery routes) for a pending deletion, and only logout for
  a suspended account.
  `phase5.verifiedActorGate.test.ts` keeps a hand-written copy of that
  table from the plan and diffs it. The gate matches paths and methods the
  way Express does — case-insensitively, and HEAD as GET — because a gate
  that matches more strictly than the router lets the router's looser match
  through. Anonymous requests are untouched, so **an anonymous auth route
  (one that acts on an email, a token or a provider claim) is outside the
  gate and reads its target's state itself, before any write** — as
  forgot-password, reset-password and the OAuth callback do for
  suspension. Photo uploads
  (`POST /storage/upload-avatar`, `/storage/upload-meme`) also need
  `is18Plus` (`ADULT_REQUIRED`). `GET /facts/hero` answers an ineligible
  account as usual and skips its `user_fact_preferences` write. The test
  that drives every declared unsafe route through the real app is
  `phase5.verifiedActorGate.test.ts`.
  The browser journeys for every sign-in method run in production mode:
  `e2e/authJourney.spec.ts` (local sign-up) and `e2e/oauthJourney.spec.ts`
  (Google and Apple, vouched and not, through
  `artifacts/api-server/src/testing/fakeOAuthIssuer.ts`, a fake sign-in page
  the production-mode launcher serves only when given `E2E_FAKE_OAUTH_PORT`).
- **Onboarding** is one screen for every sign-in method (`pages/Onboard.tsx`,
  `routes/onboarding.ts`): `GET /auth/onboarding` (the draft, the account's
  stored pronouns and name, the marketing default — ticked when Cloudflare's
  `CF-IPCountry` is `US`, unticked otherwise or when absent — and the
  wording version), `PUT /users/me/onboarding/draft` (saves the
  half-finished form; a complete date under 13 is refused `UNDER_AGE` and
  nothing is written), and `POST /users/me/onboarding` (a fresh Turnstile
  token, then date of birth, pronouns, the consent record —
  `marketing_consent_at`, `_method` `default_checked`/`ticked`/`declined`,
  `_wording_version` — and `onboarding_completed_at` in one write, the draft
  cleared; under 13 refused with nothing stored and nothing destroyed;
  completing twice changes nothing). An adult is then offered the optional
  profile photo.
- **The web shell** (`App.tsx`'s `SetupRedirect`, rule in
  `artifacts/overhype-me/src/lib/setup-redirect.ts`) sends a suspended
  account to `/account/suspended`, one scheduled for deletion to
  `/account/deletion` ("Keep my account"), an unverified account to
  `/check-email` and an un-onboarded one to `/onboard`, the last two with
  `returnTo` (built from the raw `window.location.search`, because wouter's
  `useSearch` decodes it); the verification link lands on `/onboard`.
  Convenience only: the gate is the enforcement. Google/Apple sign-ups are
  still sent to `/onboard` on their first login (`isNewUser`), which the
  shell would do anyway.
- **The challenge is Cloudflare Turnstile** (launch Phase 5, increment 1,
  replacing hCaptcha): `artifacts/api-server/src/lib/captcha.ts` verifies the token server-side for
  every challenge-gated route — onboarding, a comment, tokenizing a fact
  for submission (an onboarded account skips that one, below), a share by
  email —
  with a 10-second siteverify timeout that fails closed. With no
  secret configured it fails closed in production and skips with a warning
  elsewhere. The comment challenge mounts only once someone starts writing.
  The live site needs `TURNSTILE_SECRET_KEY` and `VITE_TURNSTILE_SITE_KEY`;
  without them no account can finish onboarding.
- **`captcha_verified` is no longer read or written** (plan S23): the
  submit-review and tokenize-fact bypass reads `onboardingCompleted`
  instead, since every onboarded account passed a challenge at onboarding.
  Increment 7b removed it from the Drizzle model, and migration 0122
  (Increment 7c) dropped the column once that release was the published one
  — the expand, then contract rule. The declaration counts as a use:
  Drizzle names every declared column in a full-row `select()`, an `insert`
  and a `returning()`, so a release that still declares a column breaks the
  moment it is dropped. 0122 also dropped `nsfw_mode_enabled`
  (§ Age, audience and the NSFW opt-in).

## Email verification

`GET /auth/verify-email?token=...` (`localAuth.ts:442-529`), `GET
/auth/email-status` (`localAuth.ts:531-553`), `POST
/auth/resend-verification` (rate-limited, `localAuth.ts:555-608`), and an
admin override `POST /admin/users/:id/verify-email`
(`routes/admin.ts:2300-2313`).

Token: raw 32-byte random value, only its SHA-256 hash stored
(`emailVerificationTokensTable`, `lib/db/src/schema/auth.ts:72-84`), a fixed
expiry, single-use via `usedAt` (`localAuth.ts:463-466,487-490`). Verifying
a fresh registration mints/refreshes a session as a side effect
(`localAuth.ts:499-526`) — clicking the link from a cold browser logs the
user in.

**`emailVerifiedAt` gates every write** since launch Phase 5's Increment 3:
`authMiddleware` derives `req.user.eligibility` from it, and the
verified-actor gate refuses an unverified account's writes outside the
recovery routes (see *Account creation*, above).

**A provider's verified claim sets it** (launch Phase 5, increment 2).
`upsertUser` reads the ID token's `email_verified` — Google sends a boolean,
Apple the string `"true"`; anything else is unverified
(`providerEmailVerified`). A verified claim sets `email_verified_at` on a new
account, and on an existing one that was never verified, without moving an
earlier time. **An unverified claim that matches an existing account is
refused** (`UnverifiedProviderEmailError`, redirect
`/login?error=unverified_provider_email`, no session minted), because
matching by email alone would hand that account to whoever controls the
unverified claim; on a new account it is created unverified.

## Password reset

`POST /auth/forgot-password` (`localAuth.ts:315-365`) →
`POST /auth/reset-password` (`localAuth.ts:367-440`).

- Always returns the same generic confirmation regardless of whether the
  email matches an account (`GENERIC_RESET_MESSAGE`, `localAuth.ts:313`) —
  no account-existence disclosure. A suspended account is sent nothing,
  behind the same reply, and reset refuses a suspended owner's link before
  claiming it (§ Suspension).
- Rate-limited by IP (`localAuth.ts:34-35,319-327`).
- **An account with no password yet (made by Google or Apple sign-in) gets
  the link too**, and following it sets its first password (#800): the
  sign-in refusal for an unconfirmed provider email points here, and before
  the fix this route skipped such accounts, so the person was locked out. A
  signed-in account can also add a first password with
  `POST /auth/set-password` (below).
- Token: 32 random bytes, SHA-256 hash stored, fixed expiry
  (`localAuth.ts:348`), row in `passwordResetTokensTable`
  (`lib/db/src/schema/auth.ts:86-97`). The exact duration is already
  user-facing product copy on `ForgotPassword.tsx`, not just an internal
  config value.
- On successful reset: **atomically single-use** (launch Phase 5,
  increment 2). A cheap read refuses an unknown, used or expired token
  before any bcrypt work; then one transaction claims the token with a
  conditional `UPDATE … WHERE used_at IS NULL AND expires_at > now()
  RETURNING`, writes the new hash and **deletes every session of the
  user**, so of two concurrent requests exactly one changes the password
  and the other is told the link was used, and a failure after the claim
  rolls the claim back. The deletion is `revokeUserSessions` in
  `artifacts/api-server/src/lib/auth.ts`, covering the indexed `sessions.userId` column and the
  legacy `sess->'user'->>'id'` JSON path (also security-model.md's C8).

**`POST /auth/set-password`** (`localAuth.ts:613-670`) is a distinct,
authenticated in-session path: requires the *current* password only if one
already exists (`localAuth.ts:650-661`), so an OAuth-only user can set a
first local password with no current-password check — this is how a
Google/Apple user adds a local-login fallback. It **ends every other session
of the user** in the same transaction as the write and keeps the caller's
own (launch Phase 5, increment 2) — "the caller's own" being
`req.authSessionId`, the session the middleware actually authenticated, not
`getSessionId(req)`, which names a stale Bearer token even when the cookie
beside it is what signed the request in. The operator route
`POST /admin/users/set-password` ends all of the user's sessions the same
way.

## Account lifecycle: suspension and deletion

Two states for an account that stops being an ordinary one, kept apart since
launch Phase 5 (#795): **suspension** blocks the person and touches nothing
else; **deletion** is its own state machine, which ends with the account
gone. *"One state machine for leaving, one flag for being removed"* (the
Phase 5 plan's settled decisions).

**The admin soft delete and the set-inactive edit are retired** (Increment
7a, PR #837). `DELETE /admin/users/:id` without `?hard=true` answers 400
(*"Soft delete is retired: suspend the account, or delete it with
?hard=true."*), `PATCH /admin/users/:id` ignores `isActive`, and the
reinstatement path that flipped an account back to active went with them.
Nothing writes `users.is_active = false` any more. The column is still
read, though: `authMiddleware` and local sign-in resolve only
`is_active = true` rows, and `isReachableAdminSql` counts only those. The
legacy deactivated rows were moved to suspension by 0120 (there were none on
dev).

### Suspension

`POST /admin/users/:id/suspend` (body `{ reason }`, required, under 500
characters, seen only by admins) and `POST /admin/users/:id/unsuspend`
(`routes/accountSuspension.ts`; engine `artifacts/api-server/src/lib/accountSuspension.ts`).
Suspension has its own columns — `suspended_at`, `suspended_reason`,
`suspended_by` (0120) — and never writes `is_active`. It runs under the
admin population lock, then the user row `FOR UPDATE`. An admin can never
suspend their own account or the last administrator who can reach the
console: a suspended admin drops out of `isReachableAdminSql`. Every
session of the person ends in the same transaction. **It blocks the person,
never the catalogue**: their content stays live, and billing is not
cancelled.

The block has two layers:

- **Every sign-in door refuses a suspended account**: local sign-in (403
  `ACCOUNT_SUSPENDED`), Google and Apple sign-in (decided before the upsert
  writes anything; redirect `/login?error=account_suspended`), and provider
  linking. Every door creates its session through `createSignInSession`
  (`artifacts/api-server/src/lib/auth.ts`). That function reads `suspended_at` `FOR SHARE` and
  inserts the session in one transaction, so it serializes with
  `suspendAccount`'s `FOR UPDATE` and revoke-all. A sign-in and a suspension
  that overlap therefore leave no session. It uses `FOR SHARE` rather than
  `FOR KEY SHARE` because a plain `UPDATE` of the row conflicts only with
  `FOR SHARE`. **Never copy that helper into a transaction that writes the
  same users row**: that is a lock upgrade, and two concurrent resets of one
  link would deadlock. A write lock taken before the token claim is the
  shape there.
- **The gate refuses every write by a session it still holds**, logout
  aside. A held session may read: that is the approved design, and it
  leads the person to `/account/suspended`, which says only *"This account
  is suspended."* — never why.

**Recovery is closed while suspended.** Forgot-password silently issues
nothing and gives the same reply as for any address, so it tells nobody
which accounts are suspended. Reset-password refuses a suspended owner's
link before claiming it, so the link still works after an unsuspend.
**Recorded gap:** a stored-field write that lands in the instant a
suspension commits — a reset's new password, a verification, a provider
link. Its end state is the one a moment-earlier action would have left,
with no session and no capability (PR #835, round 3). Ruled out, so not
re-proposed: a request-time suspension check in `authMiddleware` or
`requireAdmin` (it would orphan the suspended screen and the held-session
design), and a lock-free re-check before creating a session (it only
narrows the race).

A member who asked to delete their account and is then suspended cannot
keep it: keeping it is a write the suspended state does not allow (by the
plan; from PR #835's build report).

### Account deletion

**One engine owns every account deletion**: `artifacts/api-server/src/lib/accountDeletion.ts`, with
one row per request in `account_deletion_requests` (0117). Its stages are
`accepted → subscription_cancelled → notified → (held) → purging → done`.
Each advances by compare-and-set, fenced to the request's generation
(`requested_at`), so a crash or a concurrent run resumes or no-ops rather
than repeating a destructive step. "Keep my account" and entering `purging`
are a compare-and-set on the same stage, so exactly one wins. The routes
only authenticate, rate-limit and answer. Who asked is recorded in
`requested_by`: `self`, `admin`, or `unonboarded`.

- **Accepting a request** writes the row and revokes every session in one
  transaction, under the admin population lock: removing access can never
  remove the last administrator. From that commit the person's own media —
  memes, uploads and generated images — is no longer live
  (`liveContent`/`ownerLeaving` in `artifacts/api-server/src/lib/contentVisibility.ts`,
  the only spellings of "this account is being deleted"); their facts and
  approved comments stay readable until the purge decides them, and a copy
  already in a browser or at the edge can be seen for up to a day (the
  residue David accepted, plan answer 5(b)). After the commit the engine
  kicks the non-destructive stages without awaiting them. **Cancelling every
  cancellable subscription starts at once** — a cancel Stripe does not
  confirm is recorded and retried, so acceptance does not prove billing has
  stopped (`active`, `trialing`, `past_due`, `unpaid`, `paused`,
  `incomplete`), and the remaining entitlements survive a cancel. The
  person is emailed. A billing dispute holds the purge (`held`). The hourly
  worker (`runAccountDeletionWorker`) is recovery for anything that kick
  did not finish, and — an admin's purge-now aside — the only path to the
  destructive stage.
- **Billing is fenced against crashes and races.** A refresh that did not
  apply throws, so the stage stays and the worker retries. A kept account is
  settled refresh-only. `billing_version` fences settlement against a cancel
  that returned during its observations, and `billing_cancel_started_at`
  stops settlement from trusting an observation within 10 minutes of a
  cancel whose return was never recorded. No lock is held across a Stripe
  call (`membershipLease.ts` forbids it).
- **The purge** runs at `purge_after` under the owner content lock
  (`lockOwnerContent`, shared with the content purger) and restates its
  premises — the deadline has passed, no open dispute — in the claim
  itself. Lock order: population lock → owner content lock → user row. Any
  other order deadlocks, because the purge holds the owner lock while it
  deletes the user row. It deletes the person's files through preserve (the
  7-day backup, `decisions.md` 2026-10-29), their memes and baked files,
  uploads (the profile photo included) and generations. A fact gallery's
  background is never destroyed with the account it was filed under
  (`aiImageIsOwnersOwn`). The user row goes last, and its cascades take
  sessions, tokens, entitlements and preferences. `ncmec_reports` and
  `quarantined_memes` keep their rows with the person set null. **Who
  asked is read under the owner lock, inside the final transaction**,
  never from the worker's earlier read, because an admin's takeover can
  land mid-purge.
- **What the purge keeps is split by who asked, not by data type** (David,
  2026-11-02; `decisions.md`). When the member left (`self`), or an
  unfinished sign-up was cleaned up (`unonboarded`), their votes and hearts
  stay in the totals without their name (`reactions.user_id` null). Their
  comments, submissions awaiting review and links stay too, credited to a
  former member. **An admin's removal (`admin`) deletes those instead**: the
  abuse case. The purge then recounts every surviving aggregate fed by the
  rows it removed — reactions through `refreshTargetCounts`, and
  `facts.comment_count` from the approved, unflagged comments. **Facts
  persist forever, whoever asked**, credited to a former member. Every
  kept contribution carries a former-member marker, never a bare null,
  because a null author also means "system import": `facts.submitter_deleted_at`,
  `comments.author_deleted_at`, and the pending review's
  `submitter_deleted_at` (0119), which `ensureStagingFact` carries onto the
  fact a later approval creates. A kept comment shows "Former member".

The callers:

- **Self-service** — `POST /users/me/deletion` (`routes/accountDeletion.ts`;
  the "Delete my account…" section on Profile) schedules the purge **14
  days out** (`DELETION_COOLING_OFF_DAYS`). It re-authenticates first,
  because *"it should be HARD to do without really meaning to"* (David): the
  password for an account that has one, or for a Google- or Apple-only
  account a provider sign-in from the last ten minutes
  (`FRESH_SIGN_IN_MS`). Deleting and keeping are rate-limited to 5 an hour
  per account. The request signs the account out everywhere and forgets it
  in this browser (`useForgetThisBrowser()`, the same hook Sign out uses).
  Signing back in lands on `/account/deletion`, where **"Keep my account"**
  (`POST /users/me/deletion/cancel`, the one write a pending deletion
  allows) cancels it until the purge has started (409
  `DELETION_IN_PROGRESS` after that). Keeping makes the content live
  again; what had been deleted by hand stays deleted, and sessions are not
  restored. `GET /users/me/deletion` reads the pending request.
- **An admin's removal** — the user editor's "Delete User", confirmed by
  "Confirm Hard Delete" (`DELETE /admin/users/:id?hard=true`) purges at once
  (`adminPurgeNow(id, { takeOver: true })`). It takes over a member's own
  pending request, so the admin rule applies to their contributions. A
  failed stage is recorded and answered with a 500 naming the stage, and
  the worker resumes it.
- **The deletion panel** on `/admin/users` (`GET /admin/account-deletions`,
  at most 200 rows) lists every request in progress — errored rows first,
  then the soonest purge — and every kept account whose billing clean-up is
  unfinished. Its **"Purge now"** (`POST /admin/users/:id/deletion/purge-now`)
  brings a request's date forward and keeps who asked; on a stuck purge it
  is also the retry. Its keep (`POST /admin/users/:id/deletion/cancel`)
  keeps the account on its owner's behalf and emails them.
- **Unfinished sign-ups** — a self-registration
  (`users.registered_under_onboarding`, set only by the two sign-up paths,
  0118, with **no column default**, so a publish that added the column
  before our migration ran marks nobody) still not onboarded 30 days after
  it was created is scheduled by the worker, at most 100 a run, with its
  own email. An account that has ever had a request is never scheduled
  again: it kept itself once. Admin-made accounts are never selected.

### Content a member deletes from My content

Separate from account deletion: deleting an upload, a generated image, a
derivative or a meme from the Library moves it to **Recently deleted** for
30 days, restorable in one click, after which an hourly purge removes it
(`decisions.md`, 2026-10-30; Increment 4b). `liveContent(table)` in
`artifacts/api-server/src/lib/contentVisibility.ts` is the only statement of "live", and
`byteAccess(row, viewerId)` decides the byte paths: a live item is served,
a not-live one goes only to its owner and is never cached (so Recently
deleted can show thumbnails), and anything else is 404. A class-guard test
fails if any file outside `contentVisibility.ts` spells `deleted_at IS
NULL`. The current profile photo cannot be deleted. A deleted meme's page
keeps its "removed" 410.

## Age, audience and the NSFW opt-in

- **Age is a date, derived at read** (`date_of_birth`, required at
  onboarding, no fallback). Under 13 is refused and nothing is stored or
  destroyed; 18+ (`is18Plus`) is required at every photo-upload route.
- **The data model is ready for adult content without shipping it**
  (Increment 6b, 0121). `facts`, `memes` and `user_ai_images` carry an
  `audience` marker (`general|adult`, CHECK, default `general`), and
  `users.adult_verified_at` is kept apart from the date-derived 18+. Nothing
  reads either yet. The `beta_overlay` feature-grid row exists and is off
  everywhere. It is a declared exception in the "every grid key is
  consulted" test rather than a `FEATURE_KEYS` entry, because nothing reads
  it; it stays editable at `/admin/features`.
- **The NSFW opt-in is withdrawn** (plan S13). `nsfwModeEnabled` left the
  profile PATCH, the admin editor, the API and the auth middleware; a body
  that still sends it is ignored. Both NSFW-classifier callers (photo
  upload and the AI meme pipeline) pass a literal `false`, so a photo over
  the threshold is rejected and quarantined for everyone. The classifier
  keeps the parameter for when adult content ships. The
  `users.nsfw_mode_enabled` column left the Drizzle model in Increment 7b
  and was dropped by migration 0122 once that release was published. Meme generation always passed "off", so the
  withdrawal changed photo uploads only. Scoring a baked meme as a whole is
  carried to Phase 9 (moderation).

## Session management

Server-side opaque tokens in a Postgres `sessions` table — not JWT, no
client-trusted claims (schema: `lib/db/src/schema/auth.ts:58-70`). `sid` =
32 random bytes hex-encoded (`auth.ts:139`). A fixed TTL applies to every
session with no "remember me" variant — the same constant is exported from
`auth.ts:9` and separately re-declared (not imported) inside
`localAuth.ts`'s `setSessionCookie()` at `localAuth.ts:73`; keep both in
sync if it ever changes. Cookie: `httpOnly, secure, sameSite: "none"`, name
`"sid"` — `SameSite=None` specifically because the app runs inside the
Replit preview iframe (`auth.ts:121-123`).

**Dual resolution: Bearer header, then cookie fallback**
(`getSessionId()`, `auth.ts:188-194`; `authMiddleware.ts:65-85`) — works
around third-party-iframe cookie partitioning (Chrome/Windows CHIPS drops
`Set-Cookie` in the Replit canvas preview). A global fetch interceptor
(`main.tsx`) sends `localStorage["auth_token"]` as a Bearer header on every
request when present, but **ordinary Google/Apple/local sign-ins never
write that key** — the only runtime path that does is the `GET` form of
dev-admin-login (`localAuth.ts:788-815`), a dev-only route. A stale Bearer
session **is** evicted server-side — `authMiddleware.ts:74-85` deletes its
DB row on the next request that presents it — but the server has no way to
clear the browser's `localStorage` copy itself (no `Set-Cookie`-equivalent
for that store), so the client keeps sending a token that will keep
resolving to nothing.

**`req.user` is rebuilt from the DB on every authenticated request** — role,
admin, and membership are never trusted from the session blob
(`authMiddleware.ts:88-141`; also security-model.md invariant #3).
There is no session-blob exception any more: the captcha flag that used to
be OR-ed in from the session was retired in launch Phase 5.
**No sliding expiration** — each session's `expire` is set once at creation
and only bumped by specific `updateSession()` callers (e.g. the admin-mode
toggle, an email-verification-triggered refresh), not on ordinary
authenticated requests. **Concurrent sessions are unlimited** — nothing
caps how many `sessions` rows one `userId` can hold; logging in on a new
device just inserts another row. **Every sign-in creates its session
through `createSignInSession`** (`artifacts/api-server/src/lib/auth.ts`; § Suspension), never by a
bare `createSession` after an unlocked read. The bulk-revocation paths all
go through `revokeUserSessions` in the transaction that makes the change:
a password reset and an admin set-password (all sessions), a member's own
set-password (all but the caller's), a suspension, and the acceptance of an
account deletion. The purge's deletion of the user row then cascades to any
that remain, via `sessions.userId`'s `ON DELETE CASCADE`. None of them
revokes selectively, and there is no list of sessions to review.

## Role derivation

`role` is never a stored column. It's derived from two independent
inputs — `usersTable.isAdmin` (a real stored boolean,
`lib/db/src/schema/auth.ts:22`) and `membershipTier` (itself computed; see
[`membership-entitlements.md`](./membership-entitlements.md)) — via
`deriveUserRole(membershipTier, isAdmin)` (`lib/userRole.ts:35-43`):
admin beats Legendary beats registered beats unregistered.

`authMiddleware` populates **two** role fields on `req.user`:
`userRole` (uses the admin-mode-aware `isAdmin`, i.e. respects a "view as
user" toggle) and `realUserRole` (uses `isRealAdmin`, ignoring that
toggle). **`requireRole()`/`requireAdmin` gate on `realUserRole`
specifically** (`tierMiddleware.ts:19-58`), never the toggle-able one, so
backend authorization can never be affected by an admin's own UI view-mode.
Client-side `useAuth()` mirrors this with `role`/`realRole`
(`use-auth.ts:20-34,88-89`); the client-only `UserRole` type additionally
has an `"anonymous"` value for the logged-out case, which the server-side
type doesn't need (no session ⇒ no `req.user` at all).

**Role is for PRIVILEGE; entitlements come from the grid.** Since the
permission chokepoint landed, `deriveUserRole`/`isAtLeastLegendary` govern
operational privilege only — console access, user management, moderation,
config. Product-feature permissions resolve through
`artifacts/api-server/src/lib/featureAccess.ts`'s `can(principal, key)` and never from the role, so a
new `isAtLeastLegendary(...)` gate on a product capability now fails CI. That
separation is what makes admin lockout impossible by configuration: nothing
that grants console access lives in the grid. See
[`membership-entitlements.md`](./membership-entitlements.md).

**`isAdmin` is granted three ways**, all checked in `authMiddleware.ts:122`:
a manually-set `usersTable.isAdmin` flag (via `PATCH /admin/users/:id`); an
env-var allowlist, `ADMIN_USER_IDS` (`auth.ts:27-30`); and one hardcoded
bootstrap email, `BOOTSTRAP_ADMIN_EMAIL` (`auth.ts:19-22`), which
guarantees at least one account can always reach the admin panel to grant
access to others.

All three are honoured together by `artifacts/api-server/src/lib/adminIdentity.ts`, which is the single
definition used anywhere the question is asked outside a request — the
active-admin count that prevents lockout, alert-recipient selection, and the
admin listing. Asking only the stored column (which several sites did) makes
env- and bootstrap-granted admins invisible to those queries: they could pass
every gate in the request path and still receive no fraud or dispute alerts,
and the last-admin guard could approve zeroing the real population.

## Files to inspect before accounts/auth work

- `artifacts/api-server/src/routes/auth.ts` — OAuth login/callback, session
  cookie helpers, admin-mode toggle.
- `artifacts/api-server/src/routes/localAuth.ts` — register, local login,
  forgot/reset password, email verification, set-password, dev-admin-login.
- `artifacts/api-server/src/lib/auth.ts` — session primitives
  (create/get/update/delete), admin-flag helpers.
- `artifacts/api-server/src/middlewares/authMiddleware.ts` — `req.user`
  rebuild, Bearer/cookie resolution.
- `artifacts/api-server/src/lib/userRole.ts` — role derivation.
- `artifacts/api-server/src/middlewares/tierMiddleware.ts` —
  `requireRole`/`requireAdmin`.
- `artifacts/api-server/src/routes/admin.ts` — user PATCH, the hard
  DELETE (the engine's admin removal), verify-email override.
- `artifacts/api-server/src/lib/eligibility.ts` and
  `middlewares/requireEligibleActor.ts` — the account states and the gate.
- `artifacts/api-server/src/routes/onboarding.ts`, `artifacts/api-server/src/lib/captcha.ts` —
  onboarding and the Turnstile check.
- `artifacts/api-server/src/lib/accountSuspension.ts`,
  `routes/accountSuspension.ts` — suspension.
- `artifacts/api-server/src/lib/accountDeletion.ts`,
  `routes/accountDeletion.ts`, `lib/db/src/schema/accountDeletion.ts` — the
  deletion engine, its routes and its table.
- `artifacts/api-server/src/lib/contentVisibility.ts` — the live rule, the
  owner content lock, "the account is being deleted".
- `artifacts/api-server/src/lib/dataLifecycle.ts` — admin data export,
  scheduled retention-window cleanup (stale invites, expired tokens, old
  search history).
- `lib/db/src/schema/auth.ts` — `usersTable`, `sessionsTable`,
  `emailVerificationTokensTable`, `passwordResetTokensTable`,
  `oauthPendingStatesTable`.
- `lib/replit-auth-web/src/use-auth.ts` — client `useAuth()`, role
  derivation, `AuthProvider`.
- Frontend: `pages/Login.tsx`, `pages/Onboard.tsx`,
  `pages/ForgotPassword.tsx`, `pages/ResetPassword.tsx`,
  `pages/VerifyEmail.tsx`, `pages/AccountDeletion.tsx`,
  `pages/AccountSuspended.tsx`, `components/account/DeleteAccountSection.tsx`,
  `components/admin/AccountDeletionsPanel.tsx`, `artifacts/overhype-me/src/lib/setup-redirect.ts`.
- For everything about *what a session/role is trusted for* rather than
  *how it's produced*: [`security-model.md`](./security-model.md#authentication--sessions).
