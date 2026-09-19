---
name: The machinery's threat model is my own mistakes, not an adversary — a local script is not a security boundary
description: Ten review rounds on AI-Handbook PR #7 hardened repository identity against an attacker who can edit the working tree, commit to the branch, or substitute another repository's receipts. That attacker is me. The controls against deliberate action are GitHub's server-side ruleset and the human working alongside, who reads the one line every authority-widening PR carries naming what latitude it grants; the scripts exist to catch mistakes, and designing them to resist their own operator produced three trust anchors, eleven findings, and no additional safety.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# The machinery's threat model is my own mistakes, not an adversary — a local script is not a security boundary

## What happened

Making the review-budget guard and the readiness gate portable (both since removed, #89) meant
replacing two hardcoded literals — the repository's `owner/name` and the
list of required CI jobs — with configuration. That is a configuration
problem. It was treated as a security problem, and it grew into one.

Each round of review asked "what if the working tree is edited before this
read?", "what if a same-numbered PR from another repository supplies its
snapshot?", "what if the branch commits a weaker policy than `main`?" — and
each answer moved the read somewhere harder to reach: from the working tree
to the durable ref, from the durable ref to the base commit, from a config
value to the budget receipt beside it. By round ten there were three
different trust anchors for one identity, a classification file ranking
their trustworthiness, and Codex was correctly finding the gaps *between*
the anchors, which is a combinatorial space. Every finding was real under
its own premise. The premise was wrong.

The premise was that the scripts must resist the person running them. In
this environment there is exactly one actor: the agent that edits the
working tree, commits to the branch, captures the snapshot, runs the gate
and posts the review request. Whatever it can "attack" it can also simply
not run. The controls that exist against deliberate action are outside the
scripts entirely — the server-side ruleset on `main`, and the human working
alongside, who reads the one line every authority-widening PR carries naming
what latitude it grants — and no local hook can add to them, because the
hook's operator is the party being controlled. (That second control was a
mandatory human merge until 2026-09-14; the click was never once withheld
and cost a round trip every time, so it was replaced by the visibility rule.
The argument here does not depend on which form it takes.)

## What worked instead

State the job plainly and design for it: **the identity checks catch
mistakes.** Declaring a budget in the wrong checkout. Capturing the wrong
PR's snapshot because every repository has a #7. Running a gate in a
consumer that still carries the seed placeholder. Those are the failures
that actually happen, and every one is caught by the same simple shape:

1. **One reader.** `.agents/machinery.json` is read from the working tree,
   because it is configuration and that is where configuration lives. One
   function reads it; it fails closed on absent, malformed, or placeholder.
2. **Stamp on mint, compare on consume.** Every artifact the machinery
   writes carries `repo` from that config. Every artifact it reads is
   compared to it. A mismatch refuses with "minted for X, you are in Y."
3. **GitHub's word is compared to config too.** A snapshot naming another
   repository is refused: you captured the wrong PR.
4. **No trust hierarchy.** Not "base commit beats durable ref beats working
   tree." One source, compared everywhere. (Receipts are still read from
   the durable ref — for *durability*, so a decision survives the container,
   which is a different concern that predates this one.)
5. **The guard path reads no config**, for an operational reason, not a
   trust one: an exception escaping the hook exits 1 and the tool call
   proceeds. There, the budget receipt is the anchor.

A finding of the shape "an edit to the working tree could…" is declined by
pointing here. It is not a defect in a mistake-catcher that its operator can
disable it.

## Takeaway

Before hardening a check, name the actor it is hardening against. If the
answer is "the person who runs it," stop: you are designing a lock whose key
is on the same ring, and every layer you add is a place for two copies of
the same value to disagree. Ask instead what mistake the check catches, make
it catch that mistake in one obvious way, and put the real control — a
server-side rule, a human reading what the change grants — where a local
script cannot reach it.
