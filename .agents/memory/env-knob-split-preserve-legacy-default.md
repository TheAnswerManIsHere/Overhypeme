---
name: Splitting a shared env knob into several must preserve the old knob's resolved value as the new default
description: A new lane-specific concurrency env var defaulted to a fresh literal instead of falling back to the legacy shared knob, silently discarding a deploy's tuned rate-limit cap on upgrade
---

## The rule
When one shared config env var is split into several more granular ones (e.g.
a single worker's concurrency knob becomes per-lane knobs), each new knob's
*default* (used when the new var is unset) must fall back to the **resolved
value of the old shared knob** — not a fresh hardcoded literal. Otherwise a
deploy that had already tuned the old knob for a real constraint (a provider
rate limit, a connection-pool ceiling) silently loses that constraint the
moment the split ships, unless the deploy also adds every new env var in the
same release.

**Why:** in the async-jobs worker lane split (PR #216), `image_prompt_generation`
and `image_generation` moved from being governed by the shared
`ASYNC_JOBS_MAX_CONCURRENCY` (whose own doc comment says it exists specifically
to bound LLM-planner/fal fan-out) to a new, independent
`ASYNC_JOBS_RENDER_MAX_CONCURRENCY`. The first draft defaulted the new var to a
bare literal `3`. A bot-review comment caught it before merge: any deploy that
had lowered `ASYNC_JOBS_MAX_CONCURRENCY` below 3 specifically to avoid
stampeding an external provider would silently jump back up to 3 on upgrade,
with no error or warning — a real, quiet regression, not a hypothetical one.

**How to apply:**
- When splitting `SHARED_KNOB` into `SHARED_KNOB` (kept, now scoped narrower)
  + `NEW_KNOB_A`, `NEW_KNOB_B`, …: give each new knob's fallback as the
  **already-resolved** value of the old knob (i.e. `positiveIntEnv("NEW_KNOB_A",
  RESOLVED_SHARED_KNOB_VALUE)`), not a fresh number.
  `artifacts/api-server/src/lib/asyncJobs.ts` (the `render` lane's
  `maxConcurrency`) is the reference example.
  See [`decisions.md`](../../docs/ai-context/decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes).
- Only default to a genuinely fresh literal for the narrower knob(s) that
  *keep* the old name/scope (here: `bulk` kept `ASYNC_JOBS_MAX_CONCURRENCY`
  itself, trimmed 4→3 — that's a deliberate, documented, reviewed change to the
  knob's own default, not a silent fallback gap).
- Bot review is a real safety net for exactly this class of bug — it's easy to
  reason correctly about the new architecture and still miss that an existing
  deploy's tuning silently stops applying.
