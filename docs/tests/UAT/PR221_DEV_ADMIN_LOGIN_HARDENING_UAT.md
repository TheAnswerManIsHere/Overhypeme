# PR #221 — dev-admin-login Hardening — UAT

This closes the **highest-severity** finding from the security review:
the "triple-tap the wordmark to become admin" backdoor used to work for
**anyone, anywhere** (including on the live site once launched). It's now
**off by default and always off in production**, and only works in a
preview when you explicitly turn it on.

The secret triple-tap admin login is now gated behind a switch:

- **On the live/deployed site: permanently off.** No switch can turn it
  on in production — this is the whole point (it was an unauthenticated
  "become admin" button).
- **In a Replit preview: off unless you flip the switch.** Set an
  environment variable `ENABLE_DEV_ADMIN_LOGIN=true` in that preview's
  secrets and the triple-tap works exactly as before. Leave it unset and
  the triple-tap does nothing.

There's also some under-the-hood hardening (it now gives you a *fresh*
admin session instead of reusing your current one, and it won't follow a
tampered redirect) — invisible in normal use.

## Setup

- [claude] Confirm the Replit preview has `ENABLE_DEV_ADMIN_LOGIN=true`
  set — the dev startup script `dev-run.sh` sets this automatically, so
  normally nothing to do.
- [restore] After step 2, `ENABLE_DEV_ADMIN_LOGIN` must be reset to
  `true` in the preview's secrets — the dev workflow and the Playwright
  e2e admin flows depend on it being set.

## Steps

### 1. Triple-tap works when the secret is set

**Do:** In the Replit preview, with `ENABLE_DEV_ADMIN_LOGIN=true` set,
triple-tap the **wordmark** (the "overhype.me" logo in the top bar).

**Expect:** you land in `/admin` as the admin, exactly like before.

### 2. Triple-tap does nothing when the secret is unset

**Do:** Remove `ENABLE_DEV_ADMIN_LOGIN` from the preview's secrets (or
use a preview where it was never set), then triple-tap the wordmark.

**Expect:** nothing happens — you stay where you are, no admin. That's
the fail-closed default.

### 3. Triple-tap does nothing in production, regardless

**Do:** On the deployed/production site, triple-tap the wordmark.

**Expect:** nothing happens, no matter what — the endpoint isn't
reachable there. (To be admin in production, use a real admin login.)

## Regression

### R1. Preview with the secret set logs in as admin

**Do:** In a Replit preview with `ENABLE_DEV_ADMIN_LOGIN=true`,
triple-tap the wordmark.

**Expect:** logs in as admin, as before.

### R2. Preview with the secret unset does nothing

**Do:** In a Replit preview with `ENABLE_DEV_ADMIN_LOGIN` unset,
triple-tap the wordmark.

**Expect:** does nothing (fail-closed).

### R3. Production deploy does nothing regardless of the variable

**Do:** On a production deploy, triple-tap the wordmark, whatever the
env var is set to.

**Expect:** does nothing (always off).

### R4. Normal login is unaffected

**Do:** Log in with normal email/password, Google, and Apple.

**Expect:** all unaffected by this change.

## Not bugs

- **You must set the secret to keep the shortcut in preview.** That's
  intentional — the default is off so a forgotten setting can never
  leave the backdoor open.
- **The wordmark still works as a normal logo everywhere** — only the
  *secret admin behavior* is gated; tapping/clicking it for navigation is
  unchanged.
- **This is the last item of the security review.** With it closed, the
  backdoor that was the review's top finding is no longer exploitable on
  a live site.
