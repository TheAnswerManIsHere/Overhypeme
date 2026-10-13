---
name: Never cite a docs/plans/ path from code — a plan is a point-in-time record, not a tracker
description: A module docstring cited docs/plans/PLAN_ASYNC_QUEUE_HARDENING.md as the tracking location for a deferred decision; that file only ever existed on the never-merged plan-review branch, so the citation was dangling from the first commit. Plans are committed now, but a plan still records what was approved then, not where a deferral is tracked.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# A `docs/plans/PLAN_*.md` path is never a tracking citation from implementation code

**Where plans live has changed twice; the rule has not.** When both
occurrences below happened, the plan-review loop committed the plan to a
`plan-review/<slug>` branch on a draft PR that was never merged, so the path
did not exist on `main`. From 2026-09-09 to 2026-10-12 a plan was committed
nowhere. Since 2026-10-12 an approved plan is committed on its feature branch
and merges with the first increment's PR (`claude-core.md` Planning rule 3),
so the path does exist — and the rule still holds, for a different reason: a
plan is the text David approved on one date, amended by new files and digests
rather than kept current, so it is the wrong place to send a reader for where
a deferral is tracked *now*.

**What went wrong (PR #256):** while implementing a deliberately-deferred
decision David made during that PR's planning conversation, a module
docstring cited `docs/plans/PLAN_ASYNC_QUEUE_HARDENING.md` as "where this is
tracked." That plan was discussed but the file was never committed anywhere
reachable from the implementation branch — the citation was broken from the
moment it was written, not something that later rotted. Codex's review caught
it two rounds later ("cited path does not exist anywhere in the reviewed
tree").

**Rule:** when a code comment or docstring needs to reference "the deferred
work David decided on during planning," cite a **durable, routable doc** —
[`docs/engineering/deferred-work.md`](../../docs/engineering/deferred-work.md)
for engineering/security deferrals, or [`decisions.md`](../../docs/ai-context/decisions.md)
for a settled decision + rationale — never a `docs/plans/` path, even if that
plan file genuinely existed and was read during the review loop. If the
deferred item doesn't have a durable-doc entry yet, **add one in the same
commit** as the code that cites it, rather than pointing at the transient plan
artifact.

**Second confirmed occurrence (PR #308).** The same mistake recurred: a code
comment in `rateLimit.ts` cited `docs/plans/PLAN_CODEQL_RATE_LIMITER.md`
(the plan-review-only branch for PR #299), and — not caught by Codex, found
proactively while fixing the flagged instance — this memory doc's own
"Resolution" section made the identical error with a plain relative link to
the same nonexistent-on-`main` path. Both are fixed: the code comment now
cites this memory doc, and the memory doc's own citation of the plan is a
GitHub blob URL against the retained-but-never-merged branch, not a relative
path. The rule surviving in this file didn't prevent a second instance —
treat that as a standing reason to grep for `docs/plans/` citations in a new
PR's diff before it ships, not just react when review catches one.
