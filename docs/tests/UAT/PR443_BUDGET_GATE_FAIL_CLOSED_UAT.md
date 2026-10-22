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
- Every step below is retired, so nothing else is set up. The budget and
  account setup, the reference-photo instruction and the matching restore
  line went with the last two steps they served, which PuLID's deletion
  retired (launch Phase 4, removal 3, #744; ledger: `docs/retired/README.md`).

## Steps

_Step 1 retired with the legacy meme studio, which launch Phase 4 deleted (removal 1, #744; ledger: `docs/retired/README.md`)._

_Step 2 retired with PuLID, which launch Phase 4 deleted (removal 3, #744; ledger: `docs/retired/README.md`)._

_Step 3 retired with video, which launch Phase 4 deleted (removal 2, #744; ledger: `docs/retired/README.md`)._

_Step 4 retired with PuLID, which launch Phase 4 deleted (removal 3, #744; ledger: `docs/retired/README.md`). The budget gate itself is rebuilt in #628 Phase 11 (spend controls)._

_Step 5 retired with video, which launch Phase 4 deleted (removal 2, #744; ledger: `docs/retired/README.md`)._

_Step 6 retired with PuLID, which launch Phase 4 deleted (removal 3, #744; ledger: `docs/retired/README.md`). Its automated check, `budgetGate.test.ts:admins are exempt and always allowed with infinite limit`, still runs; the admin exemption is reworked in #628 Phase 11._

## Regression

None. Steps 1 and 2 are the regression sweep for this PR — they exercise the
two generation paths at a normal limit before anything is lowered, which is
exactly what a budget-gate change could break. Both now name #628 Phase 4: step 1
with the legacy meme studio (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*), step 2 with the
PuLID cut, so no runnable regression step remains here.

## Not bugs

- **The standard no-reference "AI meme image" path never had a budget gate
  to fail closed.** Found while writing this doc, not by this PR's
  original scope — a separate, unlimited-spend gap, not another instance of
  the fail-open bug this PR fixes. It is closed: the route was called only
  by the legacy meme studio, and launch Phase 4 deleted it (removal 1 refused
  the no-photo path; removal 3 deleted the route with PuLID; ledger:
  `docs/retired/README.md`).
