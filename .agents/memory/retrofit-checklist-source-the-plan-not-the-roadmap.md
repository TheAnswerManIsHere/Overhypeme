# Retrofitting durable, mechanically-read state: source the plan, not the roadmap summary

`current-roadmap.md` is deliberately a *short, current* summary — its own
header says so. That makes it the wrong source when writing something a
machine will parse and act on later (a Phases checklist, a dependency
marker), because summarizing necessarily loses structure that mechanical
parsing needs back.

**Concrete instance:** retrofitting a Phases checklist onto NCMEC's
workstream issue (#310, PR #453's post-merge follow-up), the roadmap's own
"Phases 4–8" bullet read: *"provenance capture in `quarantine.ts`, the
submission worker + reconciler, admin routes, the `/admin/safety` page,
alerting, and the production-activation gate"* — six work items narrated
for five phase slots (4 through 8). Writing the checklist directly from that
sentence would have forced an arbitrary, unverifiable split. The actual
approved plan (`docs/plans/PLAN_NCMEC_CYBERTIPLINE_SUBMISSION.md`, on the
closed `[PLAN REVIEW]` PR #280 — never merged, so only reachable via
`ref: refs/pull/280/head`) has a precise, unambiguous 8-phase table in its
own §6b ("Implementation order"), including per-phase dependencies and
verification commands. "Alerting" turned out to be part of phase 5's scope,
not its own phase; "the production-activation gate" is part of §7's
deployment procedure, not one of the 8 build phases at all.

**Avoid:** reconstructing durable, structured state (a checklist, a phase
count, a dependency graph) from the roadmap's prose summary when the actual
source document — a `[PLAN REVIEW]` PR's plan file, even one closed unmerged
— is one `get_file_contents` call away. The roadmap is the right source for
"what shipped, in general terms, and why"; it is the wrong source for
anything that needs to be exactly right.
