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

**Expect:** Nothing looks or feels different. No new errors, no slowdowns,
no unexpected redirects.

### 2. A video or image generation completes normally

**Do:** Start a real video generation (or a PuLID image generation) and let
it run to completion, the way you normally would.

**Expect:** The loading screen behaves exactly as before — progress bar
moves, stages transition, and it lands on the finished result.

### 3. Admin pages still load

**Do:** Open any admin screen (Taxonomy Health, moderation queue, whatever
you'd normally check).

**Expect:** Loads normally, no new errors.

## Regression

### R1. Sign in works

**Do:** Sign in.

**Expect:** Works normally.

### R2. The facts feed browses normally

**Do:** Browse the facts feed.

**Expect:** Works normally, no slowdown.

### R3. A meme completes — image flow

**Do:** Make a meme using the image flow.

**Expect:** Completes normally.

### R4. A meme completes — video flow

**Do:** Make a meme using the video flow.

**Expect:** Completes normally, including the "forging your likeness" and
"setting you in motion" stages.

### R5. Fact submission is unaffected

**Do:** Submit a fact.

**Expect:** Works normally — still protected by its own stricter,
pre-existing limit.

### R6. Admin Taxonomy Health loads

**Do:** Open Admin → Taxonomy Health.

**Expect:** Loads normally.

### R7. Admin Queue Health loads

**Do:** Open Admin → Queue Health.

**Expect:** Loads normally.

### R8. A shared meme link still unfurls

**Do:** Share a meme link (unfurl preview on iMessage/Slack/etc.).

**Expect:** The preview image still renders.

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
