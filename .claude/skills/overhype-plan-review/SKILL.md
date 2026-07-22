---
name: overhype-plan-review
description: Review a software-development plan (usually Claude Code's) for Overhype.me on David's behalf. Use when David asks to review, critique, improve, sanity-check, or give feedback on a plan. Produces prioritized feedback + a markdown review using review-status labels — never approval language (only David approves). Inspects repo context before finalizing; stops and says "repo context required" if it can't.
---

# Overhype plan review

> **Thin enactment.** The review *substance* — non-negotiables, priority order,
> required checks, the failure-pattern watchlist, external-claims handling,
> status labels, finding structure — is the single canonical contract in
> [`docs/ai-context/plan-review-contract.md`](../../../docs/ai-context/plan-review-contract.md),
> shared with Codex (on the automated draft-PR loop) and ChatGPT (manual
> upload). Apply that contract in full. This file adds only the delivery
> mechanics specific to reviewing inside Claude Code — same relationship as the
> `bugfix` skill ↔ `working-modes.md`. If the two ever disagree, the shared
> contract wins and this file gets fixed.

Review an Overhype.me implementation plan and give David an independent, technical
opinion, per the shared contract. **Assume the plan is from Claude Code** unless
David says otherwise.

## Output

```markdown
# Plan Review: <Plan Title>

## Review Status
<one status label — no approval language>

## Context Checked
- Repository files inspected:
- External docs checked:
- Product clarifications needed from David before plan revision:

## Executive Summary

## What Is Strong in the Plan

## Required Plan Revisions

## Strong Disagreements or Glaring Mistakes

## Recommended Improvements

## Implementation Sequencing Guidance

## Testing Requirements

## Production Impact Note

## Safe to Defer / Future Considerations

## Required Response from Claude
Claude should revise the plan to address the required revisions above and ask David
for approval before implementation. Claude should not begin implementation from the
current plan until David explicitly approves the revised plan.
```

Escalate design/architecture/trade-off calls to David — don't decide them yourself.
