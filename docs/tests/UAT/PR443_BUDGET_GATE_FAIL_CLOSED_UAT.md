# PR #443 — Fail closed when the spend gate itself errors — UAT

Your in-app acceptance test, David.

**Why this exists.** The budget gate decides how much a user may spend on
fal.ai generation. If the gate's *own lookup* failed — a transient database
hiccup while reading the limit or summing what the user had already spent
— it answered **"allowed, with an infinite limit"** and let the generation
through. Not a delay, not a retry: the spend ceiling simply stopped
existing for as long as the failure lasted, silently, with only a warning
in the logs.

It was the only permission check in the codebase that behaved this way.
Every other gate in the system denies when it can't get an answer. This
one granted.

**The fix in one line:** a gate that cannot determine your spend now
refuses the generation and says "try again", instead of quietly waving it
through.

**What this is NOT:** it does not change anyone's budget, limit, or what
they can generate normally. If nothing is broken, nobody should notice any
difference — which is most of what this UAT is checking.

**What isn't testable by clicking:** the failure this PR actually fixes
isn't reachable from the app — reproducing it means making the database
fail *during* the budget lookup, and deliberately breaking the database on
the Repl to see it would be a worse idea than the bug. That half is
covered by automated tests instead, and I verified they genuinely detect
it: I temporarily put the old fail-open behavior back and re-ran the
suite — three of the new tests failed and the rest passed — then restored
the fix and they all passed again. What steps 1–6 below check is the part
automated tests can't fully speak for: that the ordinary paid paths still
behave normally for real users, and that the two different refusals say
the right thing to the person reading them.

## Setup

- [claude] Confirm the app is up before you start. There's no feature
  flag — it's live everywhere once merged and synced.
- [david] In Admin → Config, note the current value of
  `budget_limit_legendary_usd` (the **real** Legendary spend limit), then
  set it to `0.01` for steps 4 and 5. This is admin-gated setup: I hold no
  admin session, so it's yours to do, not mine.
- [david] Have ready a **Legendary** account and your **admin** account.
  **Not a plain registered account** — image and video generation are both
  switched off for `registered` in the current permission grid, entirely
  unrelated to this PR. A registered account would get blocked before ever
  reaching the code below, and you'd wrongly read that as a regression.
- [david] For steps 4 and 5, generate using a reference photo, not the
  standard no-reference "AI meme image" flow. The standard flow doesn't go
  through the budget gate at all — a separate, pre-existing gap this PR
  didn't touch (found while building this UAT, tracked separately) — so it
  won't respond to the tiny limit set above, and step 1 already covers it
  for the "nothing regressed" check.
- [restore] `budget_limit_legendary_usd` — restore to the value noted in
  the setup step above. This is the **real** Legendary spend limit, so
  that captured number is the only correct one; do not restore to a
  default or a remembered value. Admin-gated like the setup above, so
  David's to execute.

## Steps

### 1. The standard AI meme image path is unaffected

**Do:** Log in as your Legendary account with budget remaining, and
generate an **AI meme image** (the standard, no-reference path).

**Expect:** It generates exactly as before — no new error, no new delay.

### 2. Reference-photo (PuLID) generation still works

**Do:** Generate a meme image using a **reference photo** (the PuLID /
face path).

**Expect:** Generates normally, same as before.

### 3. Video generation still works

**Do:** Generate a **video**.

**Expect:** Starts and completes normally. If any of steps 1–3 now fails
where it used to work, that's the one way this fix could do real
harm — the gate denying when it should allow.

### 4. Being genuinely out of budget still says "out of budget" — image

**Do:** In another browser/incognito, as your Legendary account (with
`budget_limit_legendary_usd` set to `0.01` from Setup), try to generate an
AI meme image **using a reference photo**.

**Expect:** You're refused, and the message is about **being over
budget** — the usual out-of-budget wording, pointing you at upgrading.
It is *not* a "try again" message, and *not* a generic server error.

### 5. Being genuinely out of budget still says "out of budget" — video

**Do:** With the limit still at `0.01`, try a **video** generation too.

**Expect:** Same as step 4: refused as over budget, with the upgrade path.

### 6. Admins are still exempt

**Do:** With `budget_limit_legendary_usd` still set low, log in as
**admin** and generate an AI meme image **using a reference photo**.

**Expect:** It generates. Admins are exempt from budget limits, and still
are.

## Regression

None. Steps 1 and 2 are the regression sweep for this PR — they exercise the
two generation paths at a normal limit before anything is lowered, which is
exactly what a budget-gate change could break.

## Not bugs

- **The standard no-reference "AI meme image" path never had a budget gate
  to fail closed.** Found while writing this doc, not by this PR's
  original scope — it's a separate, live, unlimited-spend gap, not another
  instance of the fail-open bug this PR fixes, so fixing it belongs to its
  own issue rather than growing this one.
