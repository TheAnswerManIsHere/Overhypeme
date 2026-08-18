# PR #292 — Login can't be used to bounce you off the site — UAT

Your in-app acceptance test, David. This one came out of the CodeQL triage
rather than from something you reported, so here's the plain-English version of
what it was.

**The bug.** The login page reads a `?from=` value out of its own URL and sends
you there once you've signed in. It never checked what that value was. So a
link like `overhype.me/login?from=https://not-us.example` would sign you in
perfectly normally and then drop you on somebody else's site — a convincing
setup for a fake "your session expired, sign in again" page, because the user
really did just log in to the real site a second earlier.

The nastier version used `?from=javascript:…`, which ran the attacker's code on
our own domain, at the exact moment you were freshly logged in.

**Why it mattered here specifically:** your ordinary session cookie isn't
readable by that injected code — it's locked down (HttpOnly) precisely so
script on the page can't touch it. But that code still runs *as you*, on our
own site, at the exact moment you're freshly logged in — so it can still take
any action the page itself could take while you're signed in. And our
Content-Security-Policy is still in report-only mode — it watches and reports,
it doesn't block. So there was nothing sitting behind this to catch it.

**What changed.** The server already had a check for "only send people to a
page on our own site," and the Google/Apple buttons on the login page already
went through it — but that check turned out to have the same gap this fix
closes (a value like `/a/..//evil.com` slipped past it too), so it's fixed
everywhere, not just on the email-and-password path that skipped it entirely.
The check is now applied once, at the source, so all four places on the login
page that use `?from=` are covered.

There is **no visual change anywhere.** This UAT is entirely about where you
end up after signing in.

## Before you start

- Sign out first — every test below starts logged out.
- You'll be typing URLs directly into the address bar. On iPad, tap the address
  bar and type the whole thing.
- Replace `overhype.me` with whatever host you're testing (the Replit preview
  URL works fine).

## The main event

### 1. A normal login still goes where it should

- Go to `overhype.me/login?from=/profile`
- Sign in with email and password.
- ✅ You land on **your profile page**.

This is the case that must keep working — the whole point of `?from=` is
returning you to where you were.

### 2. A fact page still round-trips

- Find any fact and note its URL, e.g. `/facts/123`.
- Go to `overhype.me/login?from=/facts/123`
- ✅ Before signing in, the back link at the top reads **"BACK TO FACT"** (not
  "GO BACK"), and tapping it takes you to that fact.
- Sign in.
- ✅ You land on **that fact's page**.

### 3. It can no longer send you to another site — the main event

- Go to `overhype.me/login?from=https://example.com`
- Sign in.
- ✅ You land on the **Overhype home page**. You do **not** go to example.com.

Before this PR you'd have ended up on example.com, freshly logged in.

### 4. The protocol-relative variant

- Go to `overhype.me/login?from=//example.com`
- Sign in.
- ✅ Home page again. Not example.com.

(That leading double-slash is a URL shorthand meaning "another site, same
protocol." It's the version people forget to check for.)

### 5. The script version

- Go to `overhype.me/login?from=javascript:alert(document.domain)`
- Sign in.
- ✅ You land on the **home page**, and **no alert box appears.**

If a popup showing the domain name appears, that's the bug still live — report
it immediately.

### 6. The sneaky one

- Go to `overhype.me/login?from=/\example.com` — that's a forward slash, then a
  **backslash**.
- Sign in.
- ✅ Home page.

This one's worth doing even though it looks like nonsense: browsers quietly
treat that backslash as a forward slash, so it's really `//example.com` in
disguise, and it slips past the obvious check. The old code in the onboarding
page (also fixed here) would have missed exactly this.

### 7. No `from` at all

- Go to `overhype.me/login` — nothing after "login".
- Sign in.
- ✅ Home page, as always.

## Onboarding page

The same weaker check lived on the onboarding screen, and it's now using the
shared one. It wasn't exploitable there, so this is a regression check, not a
fix to observe:

- Complete an onboarding flow that arrives with a `returnTo` (the normal path
  from a signup).
- ✅ You finish onboarding and land where you were heading, exactly as before.

## Regression smoke

| Check | Expected |
|---|---|
| Google sign-in, desktop | Opens a **popup**, completes, returns you to where you started |
| Google sign-in, iPad | **Full-page redirect** (no popup), completes, returns you |
| Apple sign-in, both | Same as Google |
| Sign in with a wrong password | Error message on the page; you stay on `/login` |
| Register a new account | Verification-notice screen appears; no redirect |
| "BACK TO FACTS" link with no `?from=` | Goes to the facts list |
| Sign out | Returns you to the home page |

## Known non-bugs

- **`?from=/evil.com` sends you to a 404 on our site, not to evil.com.** That's
  correct — it's a path on *our* domain that happens to be named that way. The
  rule is "must stay on our site", not "must be a page that exists."
- **A rejected `?from=` is silent.** You land on the home page with no "that
  redirect was blocked" message. Deliberate: the only people who'd ever see it
  are attackers testing whether the block works.
- **The back link says "GO BACK" for an unusual path.** Pre-existing labelling
  behavior, unchanged by this PR.
- **CSP is still report-only.** Separate from this PR. Worth scheduling, and
  it's why this fix mattered as much as it did — see the security triage notes.

## If something's wrong

Please report it as:

```
Step number:
URL I typed:
What I expected:
What actually happened:
Device / browser:
```

The one to flag loudest is any case where you end up on a site that isn't ours,
or any alert box appearing in step 5.
