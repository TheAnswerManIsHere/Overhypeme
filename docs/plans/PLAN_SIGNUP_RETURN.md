# Plan — an email-and-password sign-up returns to the page it started from (Issue #1203, Q6)

```plan-oracle
# Oracle — Issue #1203: an email-and-password sign-up returns to the page it started from

## David's decision (Q6, wave-2 backlog plan approved 2026-11-21, recorded on Issue #628)
> Q6 (#1132): every sign-in returns to the page you were on.

## The gap (Issue #1203, raised by PR #1199's build report)
PR #1199 made every sign-in link carry the page. Someone who registers with an email and password confirms the address from an email link, often in another browser, and lands on their profile after set-up instead of the page they came from (VerifyEmail.tsx sends `/onboard?returnTo=/profile?emailVerified=1`).

## Product intent
- A visitor who starts on a page (a friend's meme, a fact), goes to sign in, registers with email and password, confirms their email and finishes set-up, lands back on that page.
- A visitor who registered with no page to return to lands where they do today (their profile).

## Must not change
- The return destination is only ever a same-site path: the existing open-redirect rule (server `getSafeReturnTo`, client `getSafeReturnTo`) decides it; an unsafe value becomes the default.
- Email verification still requires the token, which is unchanged in strength and lifetime; an email-change confirmation behaves as today.
- Set-up (onboarding) still comes before the return, as today.

## Settled decisions
Q6 above; PR #1199's sign-in-flow pages are never a return destination (`SIGN_IN_FLOW_ROOTS`).
Ceremony: production phase, feature mode, accounts (sensitive).
```

## Problem

The destination is lost in two places. Registration (`Login.tsx:136-155`, `POST /auth/register`)
never sends the page the visitor came `from`. The verification link (`localAuth.ts:77`) carries
only the token, and `VerifyEmail.tsx:42` hard-codes `/profile?emailVerified=1`. Onboarding
already finishes on whatever `returnTo` it is handed (`Onboard.tsx:174`), so only the middle of
the journey is missing.

## Repo Context Inspected

- `Login.tsx`: `getFromParam()` is the safe `from`, and the register body has no destination.
- `localAuth.ts`:
  - `POST /auth/register` creates the account and a session, then sends the verification email
    without waiting (`sendVerificationEmail`, token and email in one transaction).
  - `GET /auth/verify-email` returns JSON with no destination.
  - `POST /auth/resend-verification` has three branches: if-none-out, pending email change, and
    normal.
- `email_verification_tokens`: no destination column. The latest migration is `0164`.
- `safeReturnTo.ts` (server): `getSafeReturnTo` returns `/` on a miss. `safe-return-to.ts`
  (client): `getSafeReturnTo` returns `null` on a miss, and `SIGN_IN_FLOW_ROOTS` is used only by
  `loginHrefFrom`.
- `Onboard.tsx` and `CheckEmail.tsx` carry `returnTo` between themselves.
- `e2e/authJourney.spec.ts` drives real registration and verification emails through the mail sink.

## Source-of-Truth Analysis

**The destination belongs to the registration, so it is stored on the new account** (Astra, scope
exchange S1). It is kept in a nullable `users.signup_return_to` (text) column, written once at
registration.

That covers every way the confirming link can arrive:
- the first email;
- a resend from the "check your email" screen;
- `CheckEmail`'s automatic send;
- a later resend after the first send failed.

Any registration token resolves to the same stored page. Putting it in the link alone would lose
it on every resend whose screen no longer knows the page, and on a first send that failed.

**It is read once and then cleared.** The verify endpoint clears the column in the same
transaction that marks the email verified. A second click on the link reads "already verified",
as today.

## Proposed Design

1. **Migration `0165_signup_return_to`.** Adds a nullable `signup_return_to text`
   column, idempotently (`IF NOT EXISTS`), matching the existing OAuth `returnTo` storage, so
   no destination the validators accept can make registration fail (Astra C1). No backfill: an existing account has no captured page
   and gets the profile default.
2. **Registration accepts `returnTo`.** `Login.tsx` sends `getFromParam()` with the register
   body. The server keeps it only if it is a safe same-site path and not a sign-in-flow page. The
   check uses a new server helper, `getSafeSignupReturnTo(value): string | null`, which shares a nullable parse beneath
   `getSafeReturnTo` (so a valid `/` and a rejection stay distinct, and `getSafeReturnTo`'s
   other callers keep their `/` default) and adds the `SIGN_IN_FLOW_ROOTS` exclusion mirrored from the client. It
   returns null on any miss, so nothing is stored. It is written to `signup_return_to` in the same
   insert that creates the account.
3. **Verification hands it back.** When `GET /auth/verify-email` verifies a registration email,
   not a pending email change, it reads `signup_return_to`, clears it in the same update, and
   returns it as `returnTo` (null when absent). An email change neither reads nor clears it.
4. **The verify page uses it.** `VerifyEmail.tsx` sends the account to
   `/onboard?returnTo=<returnTo or /profile?emailVerified=1>&verified=1`, re-checking it with the
   client `getSafeReturnTo`. The profile default stays exactly as today for no destination
   (scope S2).
5. **Nothing else changes.** Resend keeps its body. Onboarding and `CheckEmail` keep carrying
   `returnTo` as they do now.
6. **Registers and docs.**
   - The legacy-fixture allowlist classifies the new column (`drop`, like the other per-account
     state).
   - The data-lifecycle and privacy inventories add it if they list `users` columns.
   - `accounts-and-auth.md` § registration and verification, and Manual chapter 9 with the help
     regenerated.

## Data Model and Migration Impact

(Ceremony adds migration review: `overhype-migration-review`.)


One nullable column on `users`, with no backfill, so every existing row is in the "absent"
state. Roll back by restoring the previous application code and leaving the additive column in
place: the previous verification flow resumes its profile destination. Any later column removal
follows removal of its application and ORM uses (Astra C2). The migration
review skill's row-state matrix covers it: existing rows absent, new rows set or absent, and
cleared after verification.

## Security, Permissions, and Validation

The destination is validated twice: by the server before it is stored, and by the client before
navigation. Both use the existing open-redirect rule, so the column can only ever hold a
same-site path. It is never part of the token. The token's strength, lifetime and single use are
unchanged. The column is cleared on use, and it is per-account data deleted with the account.

## Testing Plan

API tests, in `routes.localAuth.test.ts`:
- **A registration with a safe `returnTo`:** verifying its token returns it once, and the column
  is then empty.
- **An unsafe value** (an absolute URL, `//evil`, `/login?…`, `/onboard`) is not stored, and
  verification returns null.
- **A resent link** (normal resend) returns the same stored page.
- **No first link:** with the first send failed and no token, an if-none-out send produces a
  link that returns the stored page.
- **An expired link** leaves the stored page in place for its replacement.
- **A destination over 2,048 characters** (a long search) survives registration and
  verification intact.
- **An email-change confirmation** returns no `returnTo` and leaves the column untouched.
- **A second click** reads "already verified".

Frontend:
- `VerifyEmail` routes to `/onboard?returnTo=<page>&verified=1`, or to the profile default when
  `returnTo` is null.
- `Login` sends `from` with the register body.

E2E, extending `authJourney.spec.ts`, keeping its existing no-destination journey: register from a content page, confirm in a fresh browser
context, finish set-up, and land on that page with its query intact.

The migration test is `migration0165.signupReturnTo.test.ts`: it is idempotent, and existing
rows stay null.

## UAT (for the PR)

- **T1 (human):** from a friend's meme while signed out, register by email. Confirm on your
  phone, finish set-up, and judge that landing back on the meme feels right.
- **R1 (ci):** an unsafe destination never redirects off-site.
- **R2 (ci):** registering with no page still lands on the profile.

## Questions for David

None. Q6 settles the behaviour, and the profile default and the sign-in-flow exclusion are
settled already.

## Definition of Done

The journey above passes end to end in CI. The API and frontend tests pass. The migration is
idempotent. Docs and help are updated. PR merged and synced.
