# PR #308 — Global rate-limit backstop for CodeQL js/missing-rate-limiting — UAT

Your in-app acceptance test, David. This one came out of the CodeQL triage
(213 `js/missing-rate-limiting` alerts) rather than something you reported —
here's the plain-English version of what changed.

**Why this exists.** CodeQL's automated scanner only recognizes a specific list
of rate-limiting npm packages — it can't see the real, database-backed rate
limiting this app already has, so it flagged 213 routes as "unprotected" even
though most of them weren't. This PR mounts one of the packages CodeQL
recognizes (`express-rate-limit`) as a genuine, API-wide backstop, so the
scanner is satisfied *and* the app gets a real additional layer of protection
— specifically for the 25 of 31 route files that had **no** rate limiting of
any kind before this.

**The honest limitation, stated up front:** this new layer counts per-server-
instance, not across the whole fleet. The existing narrow limiters (login
attempts, fact submission, AI suggestions) remain the fleet-correct
protection for the handful of routes they cover; this is a coarse backstop
everywhere else.

**There is no visual change anywhere.** This UAT is almost entirely about
confirming ordinary use is unaffected, plus one behavior change worth knowing
about: video/image generation is now more resilient to a burst of rate-limit
blocks than it was before this PR (which is also the fix for a problem this
PR itself would otherwise have introduced — see below).

## Before you start

- Nothing special — just use the app normally. There's no feature flag, no
  setting to toggle.
- You will not be able to actually trigger the rate limit by hand — the
  default threshold is 12,000 requests per minute from one address, which is
  far beyond anything a person clicking around can produce. That's
  deliberate: this check is about confirming normal use is untouched, not
  about reproducing the block.

## The main event

### 1. Ordinary browsing works exactly as before

- Use the app normally for a few minutes — browse facts, open a few pages,
  make a meme, whatever your usual click-through covers.
- ✅ Nothing looks or feels different. No new errors, no slowdowns, no
  unexpected redirects.

This is the case that matters most: the backstop is supposed to be invisible
under normal traffic.

### 2. A video or image generation completes normally

- Start a real video generation (or a PuLID image generation) and let it run
  to completion, the way you normally would.
- ✅ The loading screen behaves exactly as before — progress bar moves,
  stages transition, and it lands on the finished result.

This is the case worth actually running end-to-end, not just trusting the
description below: this PR mounts the *first-ever* rate limit on the little
background checks the app makes every half-second while your video or image
is being made (checking "is it done yet?"). Before this PR, those checks had
no limit at all, so this PR had to make sure a handful of "slow down" replies
from the new limiter can never be mistaken for the generation itself failing.
Under your normal, single-person use this should never actually come up —
this step is confirming it still works, not that you can trigger the edge
case.

### 3. Admin pages still load

- Open any admin screen (Taxonomy Health, moderation queue, whatever you'd
  normally check).
- ✅ Loads normally, no new errors.

Admin routes sit behind the same backstop as everything else — worth a quick
look since an admin who got rate-limited would have no easy way to fix the
throttle themselves.

## Regression smoke

| Check | Expected |
|---|---|
| Sign in | Works normally |
| Browse the facts feed | Works normally, no slowdown |
| Make a meme (image flow) | Completes normally |
| Make a meme (video flow) | Completes normally, including the "forging your likeness" and "setting you in motion" stages |
| Submit a fact | Works normally (still protected by its own stricter, pre-existing limit) |
| Admin: Taxonomy Health | Loads normally |
| Admin: Queue Health | Loads normally |
| Sharing a meme link (unfurl preview on iMessage/Slack/etc.) | Preview image still renders |

## Known non-bugs

- **You cannot make this trigger by clicking around, even deliberately.** The
  threshold (12,000 requests/minute from one address) is set from the app's
  real polling workload with margin, not from ordinary human click speed. If
  you *do* somehow see a "Too many requests. Please slow down." message during
  normal use, that's worth reporting — it should not be reachable by hand.
- **A blocked request gets a plain error message, not a fancy screen.** By
  design — this is meant to be a rare, coarse backstop, not a polished
  product surface.
- **This does not replace or change the existing login/fact-submission
  limits.** Those are unchanged; this is an additional, separate layer.
- **The fleet-wide gap described above is a known, accepted limitation** —
  not something this PR claims to have solved. It's recorded as a follow-up
  once the app's autoscale instance count is capped (a separate piece of
  work).

## If something's wrong

Please report it as:

```
Step number:
What I was doing:
What I expected:
What actually happened:
Device / browser:
```

The one to flag loudest is anything that looks like a video or image
generation failing partway through, or a "Too many requests" message showing
up during ordinary, single-person use — either would mean the backstop is
biting normal traffic, which it's specifically designed never to do.
