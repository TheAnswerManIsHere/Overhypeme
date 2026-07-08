# PR210 — Auth Hardening (C4/C7/C8) — UAT

In-app acceptance test for David. This PR hardens the login/signup/reset/admin-
password paths against abuse. It is mostly backend behavior, so the checks below
are about what you should (and should not) see when you exercise those flows.

## What changed, in plain terms

1. **Login and sign-up now throttle repeated attempts.** After ~10 rapid tries
   from the same device/network (or ~30 against one email account), further
   attempts get a polite "Too many attempts, try again in a few minutes" for a
   short window. This blocks password-guessing and signup-spam bots.
2. **Resetting your password now logs out all your other sessions.** After a
   reset, any device that was signed in with the old session is signed out.
3. **The admin "set a user's password" tool now requires 8+ characters** (was
   6).

## How to check it (happy paths still work)

1. **Normal login still works.** Sign in with a correct email + password →
   succeeds as before. A normal person will never hit the throttle.
2. **Normal sign-up still works.** Register a new account → succeeds as before.
3. **Throttle kicks in on abuse (optional).** Deliberately fail login ~10–12
   times in quick succession with the same account from the same browser → you
   should start seeing "Too many attempts. Please try again in a few minutes."
   Wait a few minutes and it clears.
4. **Password reset signs out old sessions.** Sign in on two browsers/devices
   with the same account. Run the "forgot password" flow and complete the reset
   on one. The **other** device should be signed out (its next action bounces to
   login).
5. **Admin set-password minimum.** In the admin users tool, try setting a user's
   password to something 7 characters or shorter → you should get an
   "at least 8 characters" error. 8+ works.

## What you should NOT see

- Legitimate single logins/sign-ups being blocked. The thresholds are generous;
  if you (or a real user) ever get throttled during normal use, that's a bug —
  report it.
- Your **current** session being killed when you reset your own password from
  the same device — only *other* sessions should drop. (The reset flow itself
  ends with you able to log in with the new password.)

## Regression smoke table

| Flow | Expect |
|------|--------|
| Email/password login (correct) | Signs in |
| Email/password login (wrong, a few times) | 401 "Invalid email or password" |
| Email/password login (wrong, ~10+ fast) | 429 "Too many attempts…" for a few min |
| Register new account | Succeeds |
| Register spam (~10+ fast from one network) | 429 for a while |
| Forgot → reset password | Succeeds; other devices logged out |
| Google / Apple sign-in | Unchanged, works |
| Admin set user password (8+) | Works |
| Admin set user password (≤7) | Rejected, "at least 8 characters" |

## Known non-bugs / limitations

- **The wordmark triple-tap admin login still works and is still wide open.**
  That is intentional for now (your call, pre-launch). It is flagged in the code
  with a `SECURITY TODO` and tracked to be closed before public launch — it is
  *not* part of this PR.
- Throttle windows are per-IP and per-email. Behind Cloudflare, "IP" is your
  real client IP; the app-level limit is a second layer under Cloudflare's own
  edge limits.
- The email-change confirmation flow was intentionally left as-is (it doesn't
  change who you are or your permissions, so it doesn't force a re-login).

## Bug report template

```
Flow: (login / register / reset / admin set-password)
Steps: (what you did)
Expected: (from the table above)
Actual: (what happened)
Account/role: (registered / legendary / admin)
Environment: (production / Replit preview)
```
