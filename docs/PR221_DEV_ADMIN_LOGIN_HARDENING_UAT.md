# PR221 — dev-admin-login Hardening (C1) — UAT

In-app acceptance test for David. This closes the **highest-severity** finding
from the security review: the "triple-tap the wordmark to become admin" backdoor
used to work for **anyone, anywhere** (including on the live site once launched).
It's now **off by default and always off in production**, and only works in a
preview when you explicitly turn it on.

Sibling doc (for Replit): [`PR221_DEV_ADMIN_LOGIN_HARDENING_TEST_RUN.md`](./PR221_DEV_ADMIN_LOGIN_HARDENING_TEST_RUN.md).

## What changed, in plain terms

The secret triple-tap admin login is now gated behind a switch:

- **On the live/deployed site: permanently off.** No switch can turn it on in
  production — this is the whole point (it was an unauthenticated "become admin"
  button).
- **In a Replit preview: off unless you flip the switch.** Set an environment
  variable `ENABLE_DEV_ADMIN_LOGIN=true` in that preview's secrets and the
  triple-tap works exactly as before. Leave it unset and the triple-tap does
  nothing.

There's also some under-the-hood hardening (it now gives you a *fresh* admin
session instead of reusing your current one, and it won't follow a tampered
redirect) — invisible in normal use.

## One-time setup to keep using it while testing

In your **Replit preview** environment's Secrets, add:

```
ENABLE_DEV_ADMIN_LOGIN = true
```

That's it — the triple-tap admin login works again in the preview. (You do
**not** set this in the deployed/production environment — and even if it were
set there, the code ignores it.)

## How to check it

**In the Replit preview, WITH the secret set:**

1. Triple-tap the **wordmark** (the "overhype.me" logo in the top bar).
2. You land in **/admin** as the admin, exactly like before. ✅

**In the Replit preview, WITHOUT the secret (delete it, or before you add it):**

3. Triple-tap the wordmark → **nothing happens** (you stay where you are, no
   admin). ✅ That's the fail-closed default.

**On the deployed/production site:**

4. Triple-tap the wordmark → **nothing happens**, no matter what. The endpoint
   isn't reachable there. ✅ (If you want to be admin in production, use a real
   admin login.)

## What you should NOT see

- The triple-tap granting admin on the **live/deployed** site.
- The triple-tap granting admin in a preview where you **haven't** set
  `ENABLE_DEV_ADMIN_LOGIN=true`.
- Any change to **normal** login (email/password, Google, Apple) — those are
  untouched.

## Regression smoke table

| Where | `ENABLE_DEV_ADMIN_LOGIN` | Triple-tap wordmark |
|-------|--------------------------|---------------------|
| Replit preview | `true` | Logs in as admin (as before) |
| Replit preview | unset | Does nothing (fail-closed) |
| Production deploy | anything | Does nothing (always off) |
| Any | — | Normal email/Google/Apple login unaffected |

## Known non-bugs / limitations

- **You must set the secret to keep the shortcut in preview.** That's
  intentional — the default is off so a forgotten setting can never leave the
  backdoor open.
- **The wordmark still works as a normal logo everywhere** — only the *secret
  admin behavior* is gated; tapping/clicking it for navigation is unchanged.
- **This is the last item of the security review.** With it closed, the backdoor
  that was the review's top finding is no longer exploitable on a live site.

## If something's wrong

Tell me which environment, whether the secret was set, and what the triple-tap
did — and if a *normal* login broke (it shouldn't have), that's unrelated to
this change and I'll look separately.
