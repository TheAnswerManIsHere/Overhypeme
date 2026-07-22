# Plan-review contract (for Codex and any AI reviewer)

> **Canonical, cross-agent contract for reviewing a *plan* — not code.** When an
> AI reviewer (Codex today) is asked to review a pull request that carries an
> implementation **plan**, this is the contract it applies. It is the shared,
> Codex-readable twin of Claude Code's [`overhype-plan-review`](../../.claude/skills/overhype-plan-review/SKILL.md)
> skill: same contract, reviewer-side. The root [`AGENTS.md`](../../AGENTS.md)
> points here.
>
> Claude Code drives the *mechanics* of the plan-review loop (opening the draft
> PR, subscribing, revising, closing) from its own `CLAUDE.md`; that ceremony is
> Claude-specific and deliberately **not** restated here. This file is only the
> **review contract** the reviewer executes.

## When this applies

Only to a PR whose title is prefixed **`[PLAN REVIEW]`** (equivalently, carrying
a `plan-review` label). For a normal code PR, ignore this file — it is not a
code-review checklist, and a code diff should not receive a plan audit.

## What you are reviewing

The changed markdown file is an **implementation specification**, not shippable
code and not documentation prose. Review it as a *plan*: does it correctly and
completely describe work that, if built as written, does the right thing safely.
Do **not** review it as a diff, and do **not** implement any of it.

## Non-negotiables

- **You do not approve plans. David does.** Use the review-status labels below —
  never "approved / LGTM / ship it." Only David approves a plan.
- **Inspect the repo before concluding.** Read the actual code and the relevant
  [`docs/ai-context/`](.) and [`docs/engineering/`](../engineering/) files for
  the subsystem the plan touches, plus the plan template in
  [`.agents/PLANS.md`](../../.agents/PLANS.md). Do not review from the plan text
  alone. If you lack the context to judge a claim, say so instead of guessing.
- **Produce a complete review even when nothing is critical.** Unlike a code
  review that may stay silent absent a serious defect, a plan review is expected
  to return a full assessment — strengths, required revisions, recommendations —
  every time. Silence on a broadly-sound plan is not an acceptable output; say
  what is strong and what could still be tightened.
- **Never implement anything on a plan-review PR.** No commits, no code, no
  "fixed it for you." The PR is a review channel that will be closed unmerged.

## The review oracle: the PR body

The PR body carries **Product Intent**, **Must Not Change**, and **Settled
Decisions** — the intent agreed *before* the plan, which is the source of truth
the plan is verified against (see
[`agent-working-rules.md`](./agent-working-rules.md#pre-plan-intent-is-the-source-of-truth)).
Compare the plan against that oracle: a plan can be internally coherent yet drop
a requirement the intent called for. Flag any such omission even if the plan
itself never mentions the missing piece.

## Review priority order

1. Runtime correctness
2. Data-model durability and source-of-truth boundaries
3. Repository fit
4. Migration and backfill safety
5. Security, permissions, validation, auditability
6. Admin and user UX clarity
7. Test coverage and regression protection (the plan must prove the *general*
   invariant, not just the reported example)
8. Simplicity and scope control
9. Observability and debuggability
10. Speed of implementation

## External claims

The plan author (Claude) is responsible for verifying external API / SDK / model
/ pricing / rate-limit / platform claims against current authoritative docs and
**recording what was checked** in the plan. Your job is to confirm that record
exists and is plausible — if the plan makes a material external claim with **no**
recorded verification, flag it as a required revision. Do not substitute your own
model memory for current documentation.

## Review-status labels (pick one)

```
No major technical disagreement
Directionally good, revisions needed
Substantive technical concerns
Strong disagreement on direction
Human clarification required
Repo context required
```

## Output

Post one complete top-level review comment. **Separate required revisions from
recommendations and safe-to-defer items.** Escalate a genuine product / design /
trade-off fork to David rather than deciding it yourself — a reviewer does not
settle product intent. Keep it specific and grounded in the repo you inspected.
