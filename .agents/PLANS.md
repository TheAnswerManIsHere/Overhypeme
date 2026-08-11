# Implementation Plan Template

> Use this template for **non-trivial** implementation work on Overhype.me. **Do
> not begin implementation until David approves the plan** (explicitly, in words —
> see [`../docs/ai-context/agent-working-rules.md`](../docs/ai-context/agent-working-rules.md)).
> Trivial, well-scoped fixes don't need the full template; a "bug fix" that is
> really a behavior change does.
>
> *(Path note: this lives under the repo's existing `.agents/` agent-facing
> directory, alongside `.agents/memory/`.)*

---

## Preflight: is this a plan, or a direction?

**Run the increment test before filling in anything below** —
[`../docs/ai-context/working-modes.md`](../docs/ai-context/working-modes.md#the-increment-test)
defines it (universal quantifier ⇒ direction; a *Phases* section separating
independently-shippable pieces ⇒ each phase was its own plan) and where a
direction lives once you write one. If either check trips, stop and split
before filling in anything below. Scope that arrives *later* — during planning
or during review — is framed **now vs. next**, defaulting to **next** unless
this plan cannot be *correct* without it. Adding it because the end state
needs it is what the direction is for.

## Problem
What problem are we solving? Include the concrete user/admin/runtime symptom.

## Direction
Which direction does this plan serve? Link it, and say in one sentence what
this increment makes true that wasn't true before. If there genuinely is no
direction — some work stands alone — say so explicitly rather than leaving
this blank.

## Product Intent
What outcome does David want? (If you're unsure of the intent, ask David before
planning further — don't guess.) State it as what **this increment** makes
true. The end state belongs in the Direction above, not here.

## Must Not Change
Invariants and out-of-scope behavior — what should explicitly stay the same.

## Settled Decisions
Decisions already made during the pre-plan conversation, and why (design
choices, trade-offs resolved before writing this plan). These three sections
— Product Intent, Must Not Change, Settled Decisions — are the oracle a
reviewer checks the eventual implementation PR against, verbatim (see
[`docs/engineering/code-review.md`](../docs/engineering/code-review.md#the-review-oracle-the-pr-body)).

## Repo Context Inspected
List the actual files, modules, routes, schemas, tests, and docs you inspected.
Reference the relevant `docs/ai-context/*` files you read.

## Current Behavior
Describe what the repo does today (grounded in the code you inspected).

## Source-of-Truth Analysis
Identify the source of truth for **every** affected concept. Call out any duplicate
or conflicting sources of truth, and confirm you won't create a new one. (E.g.
`facts.*` is active enrichment truth; the Visual Concept is the authoritative
scene; the render-time plan/compiler is the prompt source of truth.)

## Proposed Design
Describe the target architecture and why it fits the existing repo.

## Data Model and Migration Impact
Does schema or stored data change? If yes, include migration/backfill/idempotency/
rollback/observability and the old/new/partial/failed/skipped/no-op row-state
matrix. (See `docs/engineering/migrations-and-backfills.md`.)

## Runtime Behavior
Describe behavior after the change, including edge cases.

## Admin/User UX Impact
Describe UI states, copy, and loading/empty/error/partial/skipped states. For
async work, specify the per-item + aggregate status surface. Note any moderation
implications.

## Security, Permissions, and Validation
Server-side checks, route protection (`requireAdmin`/`requireRole`), validation
schemas, and audit needs.

## Testing Plan
Automated tests + manual QA. Tests must prove the **general invariant**, not only
the reported example, with negative cases. Name the runner commands (see
`docs/tests/testing-guide.md`).

## Implementation Steps
Break into small, ordered steps — the smallest coherent change that satisfies the
intent.

## Risks and Mitigations
Technical/product risks and how the implementation reduces them.

## Questions for David
Only questions that require product-owner judgment. Do **not** ask David questions
the repo can answer (resolve those yourself and note the resolution).

## Definition of Done
A concrete pass/fail checklist — including "the intended behavior can be exercised
in the product."
