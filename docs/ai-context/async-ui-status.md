# Async Work Must SHOW Its Status

> **Canonical, cross-agent principle** (applies to Codex, Claude, and any agent
> building UI). This is the single source of truth for how asynchronous work must
> report status; other docs link here rather than restating it. The **Taxonomy
> Health panel is the reference implementation**
> (`useTaxonomyHealthActions.ts`).

We built the async job queue (`async_jobs`) so requests to external systems are
robust — but the human watching the screen still needs to know exactly what's
happening, **visually and in text**, at all times. Robust delivery is only half
the job; legible status is the other half.

## The two altitudes

Whenever you build or touch anything asynchronous — a queued job, a batch/bulk
action, a long external call, a poll-style request — the surface that triggers it
must report status at **two altitudes**:

- **Per item, in place.** Every individual thing being worked (each fact, each
  row, each recipient) shows its own live state right where the user is looking:
  `queued → working → done / failed / skipped / still-running`, with a spinner
  while active and a clear terminal icon when finished. A bulk action is **NOT**
  "fire and forget with one spinner" — it must light up each affected item exactly
  as if the user had triggered them one by one.
- **Aggregate summary.** A running tally the user can follow without counting rows
  — "Enriched 7 of 25 · 2 failed · 3 still running" — updated every time an item
  completes.

## Supporting rules

- A single global spinner with no per-item detail is a **bug**, not a loading
  state.
- **"Skipped" and "still running" are first-class states**, distinct from success
  and failure — never collapse them into a checkmark or an error.
- Don't yank items out from under the user mid-run. Keep them visible (showing
  their result) until the operation completes, then reconcile.
- **Never impose a UI timeout on a legitimately long-running job.** The whole point
  of the async queue is that work can be long and robust — enriching 1000 facts may
  take an hour, and that's fine. Poll at a steady cadence (~1s) and keep showing
  live per-line status until every item is terminal, no matter how long it takes. A
  page refresh must **never** be required to see current status.
- The backend's retry/`maxAttempts` is what fails a crash-looping job; the UI just
  reflects `done`/`failed`. The only reason the *frontend* stops polling early is an
  extreme stall (~24h of zero progress = a dead/stuck worker) — and then it says so
  loudly ("something went wrong"); it does not silently give up or pretend success.
- **Prefer the existing polling helpers** (`async_jobs` job-status by id;
  `useTaxonomyHealthActions` on the frontend) over inventing a new status channel.

## Enqueue is not completion

Never report a job "done" when it was only *queued*. Report the **terminal** state
(`done | failed`), and reflect per-item terminal state in the UI. (This is also a
[known failure pattern](./known-failure-patterns.md#async-enqueue-treated-as-completion).)

## Admin state legibility

Admin surfaces that run work must let the operator tell **what is planned, what is
happening, what worked, what failed, what was skipped, and what action is needed
next** — empty / loading / running / failed / partial / retryable / skipped /
complete / no-op are distinct states, not one spinner.

A corollary that's easy to get wrong: a **required** step whose status is `null`
does **not** automatically mean "working." Distinguish "job in flight" from "never
ran / not generated yet" — rendering an actionable *not-generated* state as a
spinner masks it as in-progress work and hides the action the operator needs to
take. (Overhype: the moderation Visual-ideas prep pill renders `null` as amber
"not generated" for a required gate, never a spinner — an old Step-3 row bounced
back to Visual Concept before ideas existed is a real source of that `null`.)
