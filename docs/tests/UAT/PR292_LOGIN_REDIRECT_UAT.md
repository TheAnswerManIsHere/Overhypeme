# PR #292 — Login can't be used to bounce you off the site — UAT

Your in-app acceptance test, David. This one came out of the CodeQL triage
rather than from something you reported, so here's the plain-English
version of what it was.

**The bug.** The login page reads a `?from=` value out of its own URL and
sends you there once you've signed in. It never checked what that value
was. So a link like `overhype.me/login?from=https://not-us.example` would
sign you in perfectly normally and then drop you on somebody else's site —
a convincing setup for a fake "your session expired, sign in again" page,
because the user really did just log in to the real site a second earlier.
The nastier version used `?from=javascript:…`, which ran the attacker's
code on our own domain, at the exact moment you were freshly logged in.

**Why it mattered here specifically:** your ordinary session cookie isn't
readable by that injected code — it's locked down (HttpOnly) precisely so
script on the page can't touch it. But that code still runs *as you*, on
our own site, at the exact moment you're freshly logged in — so it can
still take any action the page itself could take while you're signed in.
And our Content-Security-Policy is still in report-only mode — it watches
and reports, it doesn't block. So there was nothing sitting behind this to
catch it.

**What changed.** The server already had a check for "only send people to
a page on our own site," and the Google/Apple buttons on the login page
already went through it — but that check turned out to have the same gap
this fix closes (a value like `/a/..//evil.com` slipped past it too), so
it's fixed everywhere, not just on the email-and-password path that
skipped it entirely. The check is now applied once, at the source, so all
four places on the login page that use `?from=` are covered.

There is **no visual change anywhere.** This UAT is entirely about where
you end up after signing in. You'll be typing URLs directly into the
address bar throughout — on iPad, tap the address bar and type the whole
thing.

## Setup

- [david] Sign out first — every step below starts logged out.
- [david] Replace `overhype.me` in each URL below with whichever host
  you're testing (the Replit preview URL works fine).

## Steps

### 1. A normal login still goes where it should

**Do:** Go to `overhype.me/login?from=/profile` and sign in with email
and password.

**Expect:** You land on your profile page. This is the case that must
keep working — the whole point of `?from=` is returning you to where you
were.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:honours a legitimate same-origin path`; `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:honours /profile exactly: submitting the login form at /login?from=/profile assigns location.href /profile`

### 2. A fact page's back link shows before sign-in

**Do:** Find any fact, note its URL (e.g. `/facts/123`), and go to
`overhype.me/login?from=/facts/123`.

**Expect:** Before signing in, the back link at the top reads "BACK TO
FACT" (not "GO BACK"), and tapping it takes you to that fact.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:reads BACK TO FACT and points at the fact for a ?from=/facts/ value`

### 3. A fact page still round-trips after sign-in

**Do:** Sign in from the page loaded in the previous step.

**Expect:** You land on that fact's page.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:honours a legitimate same-origin path`

### 4. It can no longer send you to another site — the main event

**Do:** Go to `overhype.me/login?from=https://example.com` and sign in.

**Expect:** You land on the Overhype home page. You do **not** go to
example.com. Before this PR you'd have ended up on example.com, freshly
logged in.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:falls back to / for an absolute URL on another origin`

### 5. The protocol-relative variant is also blocked

**Do:** Go to `overhype.me/login?from=//example.com` and sign in.

**Expect:** Home page again. Not example.com. That leading double-slash is
a URL shorthand meaning "another site, same protocol" — the version people
forget to check for.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:falls back to / for a protocol-relative URL`

### 6. The script variant is blocked and does not execute

**Do:** Go to `overhype.me/login?from=javascript:alert(document.domain)`
and sign in.

**Expect:** You land on the home page, and no alert box appears. If a
popup showing the domain name appears, that's the bug still live — report
it immediately.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:never assigns a javascript: URL to location.href`

### 7. The backslash-disguised variant is blocked

**Do:** Go to `overhype.me/login?from=/\example.com` — a forward slash,
then a backslash — and sign in.

**Expect:** Home page. Browsers quietly treat that backslash as a forward
slash, so it's really `//example.com` in disguise, and it slips past the
obvious check. The old onboarding-page code, also fixed here, would have
missed exactly this.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:falls back to / for a backslash-smuggled foreign host`

### 8. No `from` at all still lands on the home page

**Do:** Go to `overhype.me/login` — nothing after "login" — and sign in.

**Expect:** Home page, as always.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:falls back to / when no from param is present`

## Regression

### R1. Onboarding's `returnTo` still round-trips

**Do:** Complete an onboarding flow that arrives with a `returnTo` (the
normal path from a signup).

**Expect:** You finish onboarding and land where you were heading, exactly
as before. The same weaker check lived on the onboarding screen and now
uses the shared one — it wasn't exploitable there, so this is confirming
nothing broke, not observing a fix.

**Lane:** scripted

**Deferred:** #628 — Phase 5 (account and identity) — Onboard.tsx returnTo hand-off is unasserted and Phase 5 rebuilds the onboarding path (B10, one path for every sign-in method)

### R2. Google sign-in on desktop is unchanged

**Do:** Sign in with Google on desktop.

**Expect:** Opens a popup, completes, and returns you to where you
started.

**Lane:** human

**Judgement:** a real Google sign-in on your own account, on your own desktop browser; no test identity can complete the real provider's flow, so only you can perform the Do.

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.test.ts:Google button opens popup on macOS Chrome with maxTouchPoints 0`

**Deferred:** #628 — Phase 5 (account and identity) — a real Google sign-in completing and returning the visitor needs the real provider, verified end to end on the real domain

### R3. Google sign-in on iPad is unchanged

**Do:** Sign in with Google on iPad.

**Expect:** Full-page redirect (no popup), completes, and returns you.

**Lane:** human

**Judgement:** a real Google sign-in on your own account, on your own iPad; no test identity can complete the real provider's flow, so only you can perform the Do.

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.test.ts:Google button triggers a full-page redirect, not a popup`

**Deferred:** #628 — Phase 5 (account and identity) — completing a real Google sign-in on an iPad and returning needs the real provider, verified on the real domain

### R4. Apple sign-in is unchanged

**Do:** Sign in with Apple, on both desktop and iPad.

**Expect:** Same as Google in R2/R3.

**Lane:** human

**Judgement:** a real Apple sign-in on your own account, on your own desktop and iPad; no test identity can complete the real provider's flow, so only you can perform the Do.

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.test.ts:Apple button opens popup on Windows Chrome`; `artifacts/overhype-me/src/__tests__/loginRedirect.test.ts:Apple button triggers a full-page redirect, not a popup` (the iPad half)

**Deferred:** #628 — Phase 5 (account and identity) — a real Apple sign-in completing and returning on desktop and iPad needs the real provider, the flow most likely to break on the real domain

### R5. A wrong password still shows an error

**Do:** Sign in with a wrong password.

**Expect:** An error message appears on the page; you stay on `/login`.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/testAccounts.spec.ts:a wrong password is refused and leaves no session`

### R6. Registering a new account is unchanged

**Do:** Register a new account.

**Expect:** A verification-notice screen appears; no redirect.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/authJourney.spec.ts` (per-PR E2E job, production-mode stack: after registering, the "CHECK YOUR EMAIL" notice is shown and the page is still /login)

### R7. "BACK TO FACTS" with no `?from=` goes to the facts list

**Do:** Click the "BACK TO FACTS" link with no `?from=` present.

**Expect:** Goes to the facts list.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/__tests__/loginRedirect.security.test.ts:reads BACK TO FACTS and points at / when no from value is present`

### R8. Sign out still returns you home

**Do:** Sign out.

**Expect:** Returns you to the home page.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/authJourney.spec.ts` (per-PR E2E job, production-mode stack: signing out from the profile page ends the session and returns the browser to the home page /)

## Not bugs

- **`?from=/evil.com` sends you to a 404 on our site, not to evil.com.**
  That's correct — it's a path on *our* domain that happens to be named
  that way. The rule is "must stay on our site", not "must be a page that
  exists."
- **A rejected `?from=` is silent.** You land on the home page with no
  "that redirect was blocked" message. Deliberate: the only people who'd
  ever see it are attackers testing whether the block works.
- **The back link says "GO BACK" for an unusual path.** Pre-existing
  labelling behavior, unchanged by this PR.
- **CSP is still report-only.** Separate from this PR. Worth scheduling,
  and it's why this fix mattered as much as it did.
