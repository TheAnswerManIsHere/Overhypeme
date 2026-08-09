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
The `usersTable` schema comment referencing "Replit Auth" (`lib/db/src/schema/auth.ts:6,55`)
is leftover boilerplate from the original starter template. Both docs are
corrected in the same PR that adds this spec.

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
`null`. Google/Apple signups never present pronoun selection at all — and
because the OAuth insert (`auth.ts:189-199`) omits the `pronouns` key
entirely rather than explicitly writing `null`, Postgres applies the
column's own default (`lib/db/src/schema/auth.ts:41`, `"he/him"`). A fresh
OAuth account is **not** pronoun-unset — it starts on that default until
the user visits their profile and changes it.

On success: the row is inserted `isActive: true, captchaVerified: false`
(`localAuth.ts:173-185`); **a session is created and the cookie set
immediately** — the user is logged in before doing anything else
(`localAuth.ts:199-200`); a verification email fires asynchronously,
non-blocking (`localAuth.ts:203-207`).

**There is no separate anonymous/guest account type.** Every `usersTable`
row is a full account. What functions like a lighter tier is a two-stage
gate layered on top of a normal session:

1. Being authenticated at all (`req.isAuthenticated()`).
2. Having completed **onboarding** — a one-time hCaptcha challenge, tracked
   by `usersTable.captchaVerified` (schema: `lib/db/src/schema/auth.ts:21`),
   completed via `POST /users/me/complete-onboarding`
   (`routes/users.ts:713-744`).

Google/Apple sign-ups are redirected to `/onboard?returnTo=...` on their
first login only (`isNewUser` branch, `auth.ts:380-394`). Local
registrations are **not** auto-redirected there — nothing routes a fresh
local account to onboarding proactively.

**Gate that actually blocks a first fact submission is `captchaVerified`,
not email verification.** `POST /facts/submit-review`
(`routes/reviews.ts:131-146`) 403s with `ONBOARDING_REQUIRED` unless the
caller is admin, Legendary, or already `captchaVerified` — those three skip
the gate entirely. So a signed-in, unverified-email user can still attempt
a submission; they're bounced to `/onboard` only if they also haven't
passed the captcha step.

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

**`emailVerifiedAt` gates nothing.** Checked directly: every server read of
it (`routes/users.ts:98,184`; `routes/admin.ts:2306`; `localAuth.ts:477,483,538,550-551,593`)
is display/audit-only — it never appears in `authMiddleware.ts`,
`reviews.ts`, `facts.ts`, `ai.ts`, or `tierMiddleware.ts`. Google/Apple
accounts never get it set at all by the OAuth flow (no such field write in
`upsertUser`) — it stays `null` indefinitely for a pure-OAuth user unless an
admin sets it manually. An unverified user can do everything a verified one
can; verification status is a trust signal, not an access gate, as the
system stands today.

## Password reset

`POST /auth/forgot-password` (`localAuth.ts:315-365`) →
`POST /auth/reset-password` (`localAuth.ts:367-440`).

- Always returns the same generic confirmation regardless of whether the
  email matches an account (`GENERIC_RESET_MESSAGE`, `localAuth.ts:313`) —
  no account-existence disclosure.
- Rate-limited by IP (`localAuth.ts:34-35,319-327`).
- **Silently no-ops for an OAuth-only account** (no `passwordHash`) —
  `localAuth.ts:340-344` — Google/Apple-only users can't reset a password
  that doesn't exist; they'd use `POST /auth/set-password` instead (below).
- Token: 32 random bytes, SHA-256 hash stored, fixed expiry
  (`localAuth.ts:348`), row in `passwordResetTokensTable`
  (`lib/db/src/schema/auth.ts:86-97`). The exact duration is already
  user-facing product copy on `ForgotPassword.tsx`, not just an internal
  config value.
- On successful reset: new bcrypt hash written, token marked `usedAt`
  (`localAuth.ts:403-423`). **Not atomically single-use** — the
  password-write and the `usedAt`-write are two separate unconditional
  statements with no transaction, row lock, or `WHERE used_at IS NULL`
  claim, so two concurrent requests against the same still-valid token can
  both pass the `usedAt === null` check before either writes it; both
  succeed and the later write wins. And — this is the part
  worth flagging to anyone touching this path — **every existing session
  for that user is deleted in one query**, covering both the indexed
  `sessions.userId` column and a legacy fallback matching the embedded
  `sess->'user'->>'id'` JSON path for pre-migration rows
  (`localAuth.ts:425-437`; also security-model.md's C8).

**`POST /auth/set-password`** (`localAuth.ts:613-670`) is a distinct,
authenticated in-session path: requires the *current* password only if one
already exists (`localAuth.ts:650-661`), so an OAuth-only user can set a
first local password with no current-password check — this is how a
Google/Apple user adds a local-login fallback. Unlike forgot-password, it
does **not** force-logout other sessions.

## Account lifecycle: deactivation and deletion

**No self-service deactivation or deletion route exists.** All
lifecycle-changing routes are admin-only, on `DELETE /admin/users/:id`
(`routes/admin.ts:462-653`), branching on `?hard=true`:

**Soft delete (default).** Cancels any active/trialing Stripe subscription
(non-fatal on failure, `admin.ts:588-632`), deletes all of that user's
`sessions` rows (force-logout everywhere, `admin.ts:635-637`), sets
`usersTable.isActive = false` (`admin.ts:640-645`). **Content is untouched**
— facts, comments, memes stay exactly as they are, still attributed to the
now-inactive user id.

**Hard delete (`?hard=true`).** Staged, not wrapped in a single transaction
(`currentStage` tracks progress for error reporting, so a mid-flight
failure is diagnosable but not automatically rolled back):

1. Deletes the user's object-storage files (AI images, uploads) —
   non-fatal per-file (`admin.ts:480-511`).
2. Cancels active Stripe subscriptions (`admin.ts:513-547`).
3. Explicitly deletes rows with non-cascading NOT-NULL FKs:
   `stripeCheckoutRequestLedgerTable`, `membershipHistoryTable`,
   `activityFeedTable`, `affiliate_clicks` (`admin.ts:550-559`).
   `membershipEntitlementsTable` is deliberately **not** deleted here — its
   FK is `ON DELETE CASCADE`, so it goes with the user row in step 5;
   deleting it early would also destroy anything cascaded off disputes tied
   to it (`admin.ts:552-555`).
4. **Nullifies, never deletes, content the user created** — memes, facts,
   comments, external links, pending reviews (`submittedById` and
   `reviewedById`), video jobs (`admin.ts:563-569`). Content is orphaned
   (FK set NULL), not cascaded away and not literally anonymized (no
   author-name scrubbing).
5. Deletes the user row (`admin.ts:574`); DB-level `ON DELETE CASCADE` FKs
   then clean up `sessions`, `user_ai_images`, `user_fact_preferences`,
   ratings, search history, and the email/password token tables.

`ncmec_reports.user_id` is `ON DELETE SET NULL`
(`lib/moderation/ncmecXml.ts:10`) — legal/moderation evidence deliberately
survives a hard delete.

**Reactivation** ("reinstating a deactivated user") happens via the general
`PATCH /admin/users/:id` (`admin.ts:260-444`), not a dedicated endpoint,
when `isActive: true` is set on a currently-inactive user (`reinstating`
flag, `admin.ts:298-306`). `membershipTier` is explicitly excluded from
this PATCH's accepted body (`admin.ts:273-277`) — accepting a
client-supplied tier here would let a write get silently reverted by the
next recompute; that's `grant-lifetime`'s job instead. Before touching the
DB it refreshes every Stripe-backed entitlement source
(`refreshSourcesForReinstatement()`, `admin.ts:173-191`, deliberately
returning no tier — an earlier revision derived one outside the
transaction and a race could stomp it). Inside one transaction
(`admin.ts:320-436`): `isActive` flips, and `recomputeMembership(tx, id)`
runs under a row lock — the normal, shared derivation path. **Only if the
pre-transaction Stripe refresh came back incomplete** does it take a second
pass: comparing per-source version numbers before/after the refresh to
find sources that are genuinely stale (unverified *and* unchanged by any
other writer meanwhile, `admin.ts:366-372`), and — only if such sources
exist — re-derives the tier from the trusted subset
(`deriveEffectiveMembership`, `admin.ts:393-396`) and writes it directly,
bypassing `recomputeMembership` (`admin.ts:404-414`), explicitly refusing
to promote an `unregistered` user out of that state even here
(`admin.ts:398-409`). If every source turns out trustworthy after all, it
writes nothing further — `recomputeMembership`'s result stands
(`admin.ts:425-431`). **This is the mechanism
[`payments-and-membership.md`](../manual/payments-and-membership.md)
describes as "writes the tier directly" — precisely: it re-derives over
only the sources it can trust and writes that, rather than copying a
stale or arbitrary prior value.**

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
**Captcha state is the one exception**: `authMiddleware.ts:124` computes it
as `dbUser.captchaVerified || session.captchaVerified`, so a session that
recorded captcha completion keeps granting it even if the DB column
somehow lagged — role/admin/membership have no equivalent session-blob
fallback, but captcha does.
**No sliding expiration** — each session's `expire` is set once at creation
and only bumped by specific `updateSession()` callers (e.g. the admin-mode
toggle, an email-verification-triggered refresh), not on ordinary
authenticated requests. **Concurrent sessions are unlimited** — nothing
caps how many `sessions` rows one `userId` can hold; logging in on a new
device just inserts another row. The bulk-revocation paths are password
reset and admin soft-delete (both explicit, immediate bulk deletes,
`localAuth.ts:425-437` / `admin.ts:635-637`), plus admin hard-delete as a
third, implicit one — deleting the user row (`admin.ts:574`) cascades to
every session via `sessions.userId`'s `ON DELETE CASCADE`
(`lib/db/src/schema/auth.ts:64`). All three revoke *all* of a user's
sessions at once, never selectively.

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

**`isAdmin` is granted three ways**, all checked in `authMiddleware.ts:122`:
a manually-set `usersTable.isAdmin` flag (via `PATCH /admin/users/:id`); an
env-var allowlist, `ADMIN_USER_IDS` (`auth.ts:27-30`); and one hardcoded
bootstrap email, `BOOTSTRAP_ADMIN_EMAIL` (`auth.ts:19-22`), which
guarantees at least one account can always reach the admin panel to grant
access to others.

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
- `artifacts/api-server/src/routes/admin.ts` — user PATCH (incl.
  reinstatement), soft/hard DELETE, verify-email override.
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
  `pages/VerifyEmail.tsx`.
- For everything about *what a session/role is trusted for* rather than
  *how it's produced*: [`security-model.md`](./security-model.md#authentication--sessions).
