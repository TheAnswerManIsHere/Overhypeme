---
name: Never cite a docs/plans/ path from code — it won't exist on the merged branch
description: A module docstring cited docs/plans/PLAN_ASYNC_QUEUE_HARDENING.md as the tracking location for a deferred decision; that file only ever existed on the never-merged plan-review branch, so the citation was dangling from the first commit.
---

# A `docs/plans/PLAN_*.md` path is never a valid citation from implementation code

The Codex plan-review loop (the `plan-review-loop` skill) commits the plan
markdown to a dedicated `plan-review/<slug>` branch on a
**draft PR that is never merged**. That branch — and the plan file on it — is
the review channel only. It is not reachable from `main`, and a
`docs/plans/PLAN_*.md` file lands on `main` **only if David explicitly asks to
keep it as a doc** (rare — the default is that it lives only on the
never-merged review branch).

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
