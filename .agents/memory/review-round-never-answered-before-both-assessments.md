---
name: A review round with findings is never answered before both assessments are in
description: Every Codex round that returns findings gets the Astra and Fable assessments posted before anything is pushed for it, with no exception for an "obvious" fix. The review gate (KITT #293) fails a PR while either assessment is missing; a push that came before them is a note on the gate and a disclosure in the round's review-action block, not a failure (2026-11-25). Also, a branch switch while an assessor runs silently changes the code it reads.
---

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

## Rule

David, 2026-11-11: *"Please don't skip reviewers! That's a critical part of
our process that should not be allowed."*

Every Codex round that returns findings on a standard-loop PR gets both
independent assessments posted on the PR **before anything is pushed for
it**:
- Astra, through `scripts/review-proxy.mjs`;
- the Fable assessor (`fable-review-assessor`), given the package from
  `--source fable --prompt-only`.

There is no exception for a finding that looks like a plain regression with
one obvious fix. "Obvious" is exactly the judgement the two assessments exist
to check, and the builder is worst placed to make it about its own code. If
Astra is signed out, the sign-in is the next step (a 🛑 to David), not a
reason to proceed on one assessment or none (`claude-core.md`, *Shared
judgement on a review round*).

The review gate (`scripts/review-gate.mjs`) checks the assessments from
GitHub's record: it fails a PR while a findings round lacks either one. A push
between a findings review and its two assessments is listed by the gate as a
note, not a failure (David, 2026-11-25), so nothing mechanical stops it: the
rule above is what does, and a push that lands early anyway is disclosed in
that round's `review-action` block (`claude-core.md`, *Shared judgement on a
review round*).

## What happened

Overhype.me PR #915 — Image tracing, increment 2, round 1. Codex returned two
P2s at 01:56. The builder pushed both fixes at 02:00 with no assessment
posted. The fixes were right and Codex passed the result, so nothing broke.
The independent build report caught the skip, and David ruled it must not
happen again. The assessments were run afterwards against the commit Codex
had reviewed (03:16), and both concurred with the fixes.

## A second thing the retroactive run taught

Both assessors read the *live* checkout, and `review-proxy.mjs` checks the
tree only when it starts. So switching branches while either assessor runs
silently changes the code it reads. A run that overlapped a checkout is
discarded and re-run, never trusted. Until both report, do other work in the
scratchpad, not the checkout.
