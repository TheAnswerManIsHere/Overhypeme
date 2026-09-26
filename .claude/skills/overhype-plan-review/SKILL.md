---
name: overhype-plan-review
description: The Overhype.me lens on a plan review. Use when David asks to review, critique, improve, sanity-check, or give feedback on a plan for this repo. It does not review anything itself — it supplies the product context the shared planning loop needs (what this repo's plans usually get wrong, which subsystems raise the stakes, what to read before judging) and hands that to `plan-review-loop`.
---

# Overhype plan review — the product lens

> **This skill reviews nothing.** Planning runs in one place for this repo: the
> shared loop in [`plan-review-loop`](../plan-review-loop/SKILL.md), against the
> contract at
> [`docs/ai-context/planning-contract.md`](../../../docs/ai-context/planning-contract.md).
> What this file adds is the part that loop cannot know: what a plan for
> *Overhype.me* has to get right.

**Why it is not a second reviewer.** It used to be — a standalone procedure with
its own status labels and a twenty-heading report, enacting a
`plan-review-contract.md` that the handbook cutover retired. The shared contract
supplies the roles, the output and the tie-break through the dispatch, and it
tells a reader who arrives without a role block to stop. A second procedure
beside it would be two live instructions for one job, and either could fire.

## What to do

**Invoke `plan-review-loop`**, and carry the three things below into its scope
exchange as the emphasis and the reading list. Everything else — how exchanges
run, who holds the plan, what happens to a disagreement, how David approves —
is the shared loop's, unchanged.

`overhype-implementation` names this skill as the step before it. That is still
correct: this is how a plan for this repo gets reviewed. It is the route, not
the destination.

## 1. Read before judging

A plan is judged against the repo, not against itself. At minimum:

- [`AGENTS.md`](../../../AGENTS.md) and [`.agents/PLANS.md`](../../../.agents/PLANS.md).
- [`docs/ai-context/overlay-declarations.md`](../../../docs/ai-context/overlay-declarations.md)
  — the sensitive subsystems, the schema modules, the async reference panel and
  the shared modules a reviewer should know.
- [`docs/ai-context/decisions.md`](../../../docs/ai-context/decisions.md) — a plan
  that re-opens a settled decision needs to say so.
- [`docs/ai-context/known-failure-patterns.md`](../../../docs/ai-context/known-failure-patterns.md)
  — what has already been paid for here.
- The subsystem docs the plan touches, and the product direction it serves.

**If the repository cannot be inspected, say "repo context required" and stop.**
A plan review that never read the code is an opinion about a document.

## 2. Where the stakes are higher

A plan landing in any subsystem `overlay-declarations.md` marks **sensitive**
carries the specialist review as well, and its plan is held to more: the
irreversibility, the migration and backfill shape, and what a subtly-wrong
result would look like before anyone noticed.

**The source-of-truth question is this repo's recurring one.** `facts.*` versus
the versions table, the Visual Concept as the authoritative scene, the
render-time plan as the prompt source of truth. A plan that creates a second
place claiming to define one concept is the failure this repo has hit most.

## 3. What Overhype plans get wrong

Carried from what the old procedure was actually catching, and worth naming in
the exchange rather than rediscovering:

- **A plan that might be a direction.** A universal quantifier in the intent
  sentence — "all", "every", "exclusively" — is worth *raising*: it can mean the
  sentence describes an end state rather than a bounded increment, which makes
  every later discovery in-scope by definition. Raise it; never split on the
  wording alone. What decides is the increment test in
  [`working-modes.md`](../../../docs/ai-context/working-modes.md) and section 3
  of the planning contract, not this bullet — which is why this one points
  rather than restates.
- **Enqueue treated as completion.** Async work is done when its *terminal*
  state says so. See
  [`docs/ai-context/async-ui-status.md`](../../../docs/ai-context/async-ui-status.md).
- **A generated file edited by hand.** `lib/api-zod/src/index.ts` is rewritten
  from the allowlist in `lib/api-spec/patch-generated.mjs`; an edit to it
  survives until the next codegen run and no longer.
- **Permission enforced in the client.** Server-side, always.
- **A migration plan that edits an already-merged migration.** Forward-only.

---

**Product decisions stay David's.** A plan that changes intended behaviour, the
agreed scope, or an accepted user-facing consequence goes to him as a numbered
question — never absorbed into a revision, and never decided by this skill or
the loop it feeds.
