---
name: requesting-code-review
description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Requesting Code Review

Dispatch a code reviewer subagent to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history. This keeps the reviewer focused on the work product, not your thought process, and preserves your own context for continued work.

**Core principle:** Review early, review often.

**Local calibration (fleet, 2026-09-20): this skill sets no bound, and the
fleet does.** Upstream says review early and often, fix and continue. On
work that is internal **by consequence** — not by directory — autonomous
iteration here is bounded at two reviews by the
**two-review limit** ([`working-modes.md`](../../../docs/ai-context/working-modes.md#the-two-review-limit-on-autonomous-iteration-david-2026-09-19)):
review the head, make **one coherent batch** of corrections, review that
corrected head, and stop — only David reopens a loop beyond it. **A change
that governs approvals, publication, credentials or destructive operations is
weighed on those consequences and its recoverability, whatever directory it
sits in**, and that can put it outside the limit — the question is what this
change does, not what the file is for. Outside it, the loop is bounded by the
Worth rule per finding instead. This block said "on internal
tooling" flat until 2026-09-23, which is the limit's convenient default read
as its scope. Two upstream
habits are therefore wrong here: fixing findings one at a time as they arrive
rather than batching them, and applying fixes without a review of what was
written. A cap on further editing is never an exemption from reviewing what
was edited.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development
- After completing major feature
- Before merge to main

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## How to Request

**1. Get git SHAs:**
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

**2. Dispatch code reviewer subagent:**

Dispatch a `general-purpose` subagent, filling the template at [code-reviewer.md](code-reviewer.md)

**Placeholders:**
- `{DESCRIPTION}` - Brief summary of what you built
- `{PLAN_OR_REQUIREMENTS}` - What it should do
- `{BASE_SHA}` - Starting commit
- `{HEAD_SHA}` - Ending commit

**3. Act on feedback** — *on a pull-request review, as the Local calibration
block above bounds it: one coherent batch rather than one finding at a time,
and the corrected head gets its own review. Per-task reviews inside a session
keep their own flow below.*
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

```
[Just completed Task 2: Add verification function]

You: Let me request code review before proceeding.

BASE_SHA=$(git log --oneline | grep "Task 1" | head -1 | awk '{print $1}')
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch code reviewer subagent]
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types
  PLAN_OR_REQUIREMENTS: Task 2 from docs/superpowers/plans/deployment-plan.md
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready to proceed

You: [Fix progress indicators]
[Continue to Task 3]
```

## Integration with Workflows

*These two flows are per-task QA inside a session, not the pull-request loop.
The Local calibration block above bounds the loop that runs once the work
reaches a pull request; it does not cap the per-task reviews here.*

**Subagent-Driven Development:**
- Review after EACH task
- Catch issues before they compound
- Fix before moving to next task

**Executing Plans:**
- Review after each task or at natural checkpoints
- Get feedback, apply, continue

**Ad-Hoc Development:**
- Review before merge
- Review when stuck

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues — *except an **acceptable
  imperfection** left after the pull-request loop's cap, which is a recorded
  gap. A head that still violates an agreed requirement, fails a required
  check, or carries consequential harm David has not accepted does not merge:
  it goes to him with the shortfall and a choice*
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: [code-reviewer.md](code-reviewer.md)
