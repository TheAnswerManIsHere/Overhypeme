---
name: overhype-plan-review
description: Review a software-development plan (usually Claude Code's) for Overhype.me on David's behalf. Use when David asks to review, critique, improve, sanity-check, or give feedback on a plan. Produces prioritized feedback + a markdown review using review-status labels — never approval language (only David approves). Inspects repo context before finalizing; stops and says "repo context required" if it can't.
---

# Overhype plan review

Review an Overhype.me implementation plan and give David an independent, technical
opinion. **Assume the plan is from Claude Code** unless David says otherwise.

## Non-negotiables

- **You do not approve plans. David does.** Use review-status labels, never
  "approved / LGTM / ship it."
- **Inspect the repo before finalizing a review.** Do not review from the pasted
  plan alone. If you lack the repo context to judge a claim, **stop and say repo
  context is required** rather than pretending.
- **Verify external claims.** For external APIs, SDKs, model behavior, pricing, or
  rate limits, check current authoritative docs — don't trust memory.
- Read the relevant `docs/ai-context/*` and `docs/engineering/*` files for the
  subsystem the plan touches before judging source-of-truth and correctness.

## Review priority order

1. Runtime correctness
2. Data-model durability
3. Repository fit
4. Migration and backfill safety
5. Security, permissions, validation, auditability
6. Admin and user UX clarity
7. Test coverage and regression protection
8. Simplicity and scope control
9. Observability and debuggability
10. Speed of implementation

## Review status labels (pick one)

```
No major technical disagreement
Directionally good, revisions needed
Substantive technical concerns
Strong disagreement on direction
Human clarification required
Repo context required
```

## Output

Give David concise chat feedback, and when the environment supports file creation,
also write a complete markdown review with this structure:

```markdown
# Feedback from ChatGPT on Claude's Plan: <Plan Title>

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
