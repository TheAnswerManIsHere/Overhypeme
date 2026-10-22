# PR #308 — Global rate-limit backstop for CodeQL js/missing-rate-limiting — UAT

Your in-app acceptance test, David. This one came out of the CodeQL triage
(213 `js/missing-rate-limiting` alerts) rather than something you reported —
here's the plain-English version of what changed.

**Why this exists.** CodeQL's automated scanner only recognizes a specific
list of rate-limiting npm packages — it can't see the real, database-backed
rate limiting this app already has, so it flagged 213 routes as
"unprotected" even though most of them weren't. This PR mounts one of the
packages CodeQL recognizes (`express-rate-limit`) as a genuine, API-wide
backstop, so the scanner is satisfied *and* the app gets a real additional
layer of protection — specifically for the 25 of 31 route files that had
**no** rate limiting of any kind before this.

**The honest limitation, stated up front:** this new layer counts
per-server-instance, not across the whole fleet. The existing narrow
limiters (login attempts, fact submission, AI suggestions) remain the
fleet-correct protection for the handful of routes they cover; this is a
coarse backstop everywhere else.

There is no visual change anywhere — this is almost entirely about
confirming ordinary use is unaffected, plus one behavior change worth
knowing about: this PR mounts the *first-ever* rate limit on the little
background checks the app makes every half-second while a video or image is
being generated ("is it done yet?"), so it also had to make sure a handful
of "slow down" replies from the new limiter can never be mistaken for the
generation itself failing. You will not be able to actually trigger the
rate limit by hand — the default threshold is 12,000 requests per minute
from one address, far beyond anything a person clicking around can
produce. That's deliberate: this check is about confirming normal use is
untouched, not about reproducing the block.

## Setup

- [claude] Confirm the app is up before step 1. There's no feature flag and
  nothing to toggle.

## Steps

### 1. Ordinary browsing works exactly as before

**Do:** Use the app normally for a few minutes — browse facts, open a few
pages, make a meme, whatever your usual click-through covers.

**Expect:** The home page shows the top bar (logo, search box, Sign in),
the Facts, Top Facts and Library links, the hashtag rail with "For you",
the "About David Franklin" card with its name box, and the feed of fact
cards. Top Facts shows its heading, the This week / This month / All time
choices and the ranked facts. A fact page shows the fact, "Make a meme of
this" and "Memes from this fact". No error message shows and each page
stays on its own address. No API response is a 429, and an ordinary request
is not slowed by the limiter.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts:the documented concurrent-poller load receives zero 429s under the default ceiling`; `artifacts/overhype-me/e2e/publicScreens.spec.ts:home, Top Facts and a fact page show their usual layout and content`; `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts:an ordinary API request spends well under the bound inside the limiter itself`; `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts:logged out, the ordinary and feed routes load with no sign-in wall, no error and no redirect`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: making a meme, its save and its permalink read

### 2. A PuLID image generation completes normally

**Do:** Start a real PuLID image generation and let it run to completion,
the way you normally would. (Its video half retired with video, launch
Phase 4 removal 2.)

**Expect:** The loading screen behaves exactly as before — progress bar
moves, stages transition, and it lands on the finished result.

**Lane:** scripted

**Deferred:** #628 — Phase 4 (cut and prune; PuLID generation retired with the cut)

### 3. Admin pages still load

**Do:** Open any admin screen (Taxonomy Health, moderation queue, whatever
you'd normally check).

**Expect:** Loads normally, no new errors.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts`; `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts:the admin moderation and taxonomy-health screens load with no error and no API response answered 429`

## Regression

### R1. Sign in works

**Do:** Sign in.

**Expect:** Works normally.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/testAccounts.spec.ts:the free account signs in through the login form as registered`

### R2. The facts feed browses normally

**Do:** Browse the facts feed.

**Expect:** Works normally, no slowdown.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts`; `artifacts/api-server/src/__tests__/globalRateLimit.integration.test.ts:an ordinary API request spends well under the bound inside the limiter itself`; `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts:logged out, the ordinary and feed routes load with no sign-in wall, no error and no redirect`

### R3. A meme completes — image flow

**Do:** Make a meme using the image flow.

**Expect:** Completes normally.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: an ordinary free account uploads a photo and saves a public meme from it; its permalink and its composed image are readable, the image decoded

_Step R4 retired with video, which launch Phase 4 deleted (removal 2, #744; ledger: `docs/retired/README.md`)._

### R5. Fact submission is unaffected

**Do:** Submit a fact.

**Expect:** Works normally — still protected by its own stricter,
pre-existing limit.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 2: the ordinary free account's submission is accepted and listed in the admin queue; `artifacts/api-server/src/__tests__/routes.reviews.test.ts:PER-MINUTE LIMIT: a non-admin account's submission past the fact_submit window max gets 429 with the 'too quickly' message`

### R6. Admin Taxonomy Health loads

**Do:** Open Admin → Taxonomy Health.

**Expect:** Loads normally.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts`; `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts:the admin moderation and taxonomy-health screens load with no error and no API response answered 429`

### R7. Admin Queue Health loads

**Do:** Open Admin → Queue Health.

**Expect:** Loads normally.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts:renders inside the admin console for an admin`

### R8. A shared meme link still unfurls

**Do:** Share a meme link (unfurl preview on iMessage/Slack/etc.).

**Expect:** The preview image still renders.

**Lane:** scripted

**Check:** `artifacts/api-server/src/__tests__/phase5.og.routes.test.ts:returns 200 with full og:* tags and 1h cache`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: the unfurl page for the saved public meme names that meme's own image route as og:image, and the image it names decodes

## Not bugs

- **You cannot make this trigger by clicking around, even deliberately.**
  The threshold (12,000 requests/minute from one address) is set from the
  app's real polling workload with margin, not from ordinary human click
  speed. If you *do* somehow see a "Too many requests. Please slow down."
  message during normal use, that's worth reporting — it should not be
  reachable by hand.
- **A blocked request gets a plain error message, not a fancy screen.** By
  design — this is meant to be a rare, coarse backstop, not a polished
  product surface.
- **This does not replace or change the existing login/fact-submission
  limits.** Those are unchanged; this is an additional, separate layer.
- **The fleet-wide gap described above is a known, accepted limitation** —
  not something this PR claims to have solved. It's recorded as a
  follow-up once the app's autoscale instance count is capped (a separate
  piece of work).
