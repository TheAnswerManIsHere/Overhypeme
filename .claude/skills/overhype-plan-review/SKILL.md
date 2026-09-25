---
name: overhype-plan-review
description: Overhype.me's product lens over the shared planning loop. Use when planning Overhype.me work, or when David asks to review, critique or sanity-check a plan for this product. It adds only what is specific to Overhype.me (the subsystem docs a plan must be checked against, and a default --lens for the Astra exchange); the loop itself is the shared plan-review-loop skill.
---

# Overhype.me planning lens

> **A lens, not a loop.** The planning loop, the contract both parties read,
> the checks, the evidence rules and the approval handoff are shared:
> the `plan-review-loop` skill and
> [`planning-contract.md`](../../../docs/ai-context/planning-contract.md).
> This file adds only what a plan **for Overhype.me** has to be checked
> against. If the two ever disagree, the shared contract wins and this file
> gets fixed.

Only David approves a plan. Agreement between agents is not approval.

## The default lens

For an Overhype.me plan, pass this as `--lens` on an `assess` exchange unless
the plan calls for a sharper one. It is under the script's 500-character cap:

```
Overhype.me: check moderator decisions and admin overrides on facts survive AI enrichment and reprocessing; one source of truth for facts, enrichment and render plans; what the admin preview and debug surfaces show matches what renders at runtime; the tokenizer and render-fact handle every name and pronoun set. Read the subsystem docs the plan touches before concluding.
```

## What to read, by what the plan touches

The general routes are in [`AGENTS.md`](../../../AGENTS.md), *Project context*.
The ones a planning exchange most often skips:

- **The visual pipeline** (planner, compiler, render policy, Visual Concept):
  [`visual-pipeline.md`](../../../docs/ai-context/visual-pipeline.md), and
  the `overhype-visual-pipeline` skill.
- **Tokens, grammar and render-fact:**
  [`token-rendering-and-grammar.md`](../../../docs/ai-context/token-rendering-and-grammar.md),
  and the `overhype-token-rendering` skill.
- **Taxonomy, enrichment and moderation source of truth:**
  [`taxonomy-and-enrichment.md`](../../../docs/ai-context/taxonomy-and-enrichment.md),
  [`moderation-workflow.md`](../../../docs/ai-context/moderation-workflow.md).
- **Migrations or backfills:**
  [`migrations-and-backfills.md`](../../../docs/engineering/migrations-and-backfills.md),
  and the `overhype-migration-review` skill.
- **Anything touching `lib/api-zod/`:** the codegen allowlist trap in
  [`known-failure-patterns.md`](../../../docs/ai-context/known-failure-patterns.md).

Which subsystems are sensitive, and which shared modules a plan should reuse
rather than reimplement:
[`overlay-declarations.md`](../../../docs/ai-context/overlay-declarations.md).
