# PR #443 — Fail closed when the spend gate itself errors — UAT

Your in-app acceptance test, David.

**Why this exists.** The budget gate decides how much a user may spend on
fal.ai generation. If the gate's *own lookup* failed — a transient database
hiccup while reading the limit or summing what the user had already spent —
it answered **"allowed, with an infinite limit"** and let the generation
through. Not a delay, not a retry: the spend ceiling simply stopped existing
for as long as the failure lasted, silently, with only a warning in the logs.

It was the only permission check in the codebase that behaved this way. Every
other gate in the system denies when it can't get an answer. This one granted.

**The fix in one line:** a gate that cannot determine your spend now refuses
the generation and says "try again", instead of quietly waving it through.

**What this is NOT:** it does not change anyone's budget, limit, or what they
can generate normally. If nothing is broken, nobody should notice any
difference — which is most of what this UAT is checking.

## Before you start

- No feature flag. It's live everywhere once merged and synced.
- You'll want a **Legendary** account and your **admin** account. **Not a plain
  registered account** — image and video generation are both switched off for
  `registered` in the current permission grid, entirely unrelated to this PR.
  A registered account would get blocked before ever reaching the code below,
  and you'd wrongly read that as a regression.
- A couple of checks use **Admin → Config** to set a deliberately tiny budget
  limit. **Note the starting values before you change them, and put them back
  when you're done** — these are the real limits.
- The key involved is `budget_limit_legendary_usd`.
- **For sections 2 and 3, generate using a reference photo, not the standard
  no-reference "AI meme image" flow.** The standard flow doesn't go through
  the budget gate at all — a separate, pre-existing gap this PR didn't touch
  (found while building this UAT, tracked separately) — so it won't respond
  to the tiny limit you set below, and section 1 already covers it for the
  "nothing regressed" check.

## The main event

### 1. Normal generation is completely unaffected

This is the most important section, and the most boring. The fix touches the
code path in front of *every* paid generation, so the first thing to establish
is that the ordinary path still works.

- Log in as your **Legendary** account with budget remaining.
- Generate an **AI meme image** (the standard path).
  - ✅ It generates exactly as before. No new error, no new delay.
- Generate one using a **reference photo** (the PuLID / face path).
  - ✅ Same — generates normally.
- Generate a **video**.
  - ✅ Same — starts and completes normally.

If any of these now fails where it used to work, stop and report it. That would
mean the gate is denying when it should be allowing, which is the one way this
fix could do real harm.

### 2. Being genuinely out of budget still says "out of budget"

The fix introduces a second, different failure ("I couldn't check") next to the
existing one ("you're over your limit"). They must not get confused with each
other — telling someone to go buy more credit when the database hiccuped would
be worse than the bug being fixed.

- As **admin**, go to **Admin → Config**. Note the current value of
  `budget_limit_legendary_usd`, then set it to something tiny — `0.01`.
- In another browser/incognito, as your **Legendary** account, try to generate
  an AI meme image **using a reference photo**.
  - ✅ You're refused, and the message is about **being over budget** — the
    usual out-of-budget wording, pointing you at upgrading.
  - ✅ It is *not* a "try again" message, and *not* a generic server error.
- Try a **video** generation too.
  - ✅ Same: refused as over budget, with the upgrade path.
- **Put `budget_limit_legendary_usd` back to its original value.**
  - ✅ Generation works again.

### 3. Admins are still exempt

Admins bypass the spend ceiling deliberately. Worth one pass to confirm the fix
didn't catch them in it.

- With `budget_limit_legendary_usd` still set low (or set it low again), log
  in as **admin** and generate an AI meme image **using a reference photo**.
  - ✅ It generates. Admins are exempt from budget limits, and still are.
- **Put the limit back** when you're done.

## What is not in this UAT, and why

**The failure this PR actually fixes is not clickable.** Reproducing it means
making the database fail *during* the budget lookup — there's no way to trigger
that from the app, and deliberately breaking the database on the Repl to see it
would be a worse idea than the bug.

So that half is covered by automated tests instead, and I verified they
genuinely detect it: I temporarily put the old fail-open behavior back and
re-ran the suite — three of the new tests failed and the rest passed, then I
restored the fix and they all passed again. That's the evidence that the gate
now denies rather than grants, that no permissive fallback can creep back in,
and that a gate failure isn't swallowed by the pricing error handler the way it
would have been before.

What *you're* checking in sections 1–3 is the part automated tests can't fully
speak for: that the ordinary paid paths still behave normally for real users,
and that the two different refusals say the right thing to the person reading
them.

**Also not in this UAT: the standard no-reference "AI meme image" path never
had a budget gate to fail closed.** Found while writing this doc, not by this
PR's original scope — it's a separate gap (a live, unlimited-spend path), not
another instance of the fail-open bug this PR fixes, so fixing it belongs to
its own issue rather than growing this one.

## If something fails

Tell me what you saw and which section. A failure here is a **follow-up
bugfix**, not a reason to revert the merge — and production is untouched either
way, since publishing is a separate step we haven't started using.
