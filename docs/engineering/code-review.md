# Code Review Guide

> A consistent checklist for reviewing Overhype.me changes (Codex, Claude, or
> human). Priorities match the root [`AGENTS.md`](../../AGENTS.md). Reviewers use
> **review-status labels, not approval language** — only David approves.

## Review priorities (in order)

1. Runtime correctness
2. Durable data & source-of-truth boundaries
3. Repository fit
4. Migration & backfill safety
5. Security, validation, permissions, auditability
6. Admin/user UX clarity
7. Tests & regression protection
8. Simplicity & scope control
9. Observability & debuggability

Weight findings by this order — a correctness or source-of-truth issue outranks a
style nit.

## Runtime correctness

- Does it do what the plan/intent says, including edge cases?
- Async: is a job's **terminal** state used, not enqueue-as-done?
- Visual/enrichment: does runtime match the admin preview path?

## Source-of-truth & data durability

- Is there a **single** source of truth for each concept, or did this add a
  competing one? (See
  [`../ai-context/known-failure-patterns.md`](../ai-context/known-failure-patterns.md).)
- Are **human overrides preserved** across AI reprocessing?
- Is `facts.*` still the sole active enrichment truth (versions table = archive)?

## Repository fit

- Does it follow existing patterns (generated API hooks on the frontend, Drizzle
  schema conventions, the async job queue, the engines catalogue)?
- Does it reuse the right shared module rather than reimplementing (e.g.
  `resolveEnrichment`, `render-fact`, `compileForSubjectRenderMode`,
  `useTaxonomyHealthActions`)?

## Security & validation

- Every permission enforced **server-side** (`requireAdmin`/`requireRole`), not just
  in the client?
- Zod validation on inputs; no trust of client-sent roles/flags?
- Auditability: are moderation decisions/overrides recorded, not silently mutated?

## Migration / backfill safety

- Idempotent, hand-authored SQL (generator caveat)? Counts/failed/skipped
  observable? Human-edited rows preserved? Destructive ops have rollback? See
  [`migrations-and-backfills.md`](./migrations-and-backfills.md).

## Admin / user UX

- Async surfaces show **per-item + aggregate** status, with empty/loading/running/
  failed/partial/skipped/complete/no-op distinguished — no single global spinner,
  no UI timeout on long jobs?
- **Ship the surface with the behavior** — no dead UI, no invisible backend?

## Tests

- Do tests prove the **general invariant**, not just the reported example, with
  negative cases? Run via the repo runners (never raw `node --test`)?
- Regression fixtures added for the bug class?

## Observability

- Failures reported (Sentry where appropriate)? Bulk operations expose what
  happened? Enough logging to debug a bad render/enrichment/job?

## Scope control

- Smallest coherent change for the approved plan? No speculative abstraction, no
  new external vendor, no scope creep beyond intent?

## Review output format

Produce concise, prioritized feedback. Label overall status (no approval
language) — e.g. *No major technical disagreement · Directionally good, revisions
needed · Substantive technical concerns · Strong disagreement on direction · Human
clarification required · Repo context required.* For each finding: what, why (tied
to a priority above), and a concrete suggestion. Separate **must-fix** from
**nice-to-have**. Escalate design/architecture/trade-off calls to David rather than
deciding them. (The `overhype-plan-review` skill defines the full plan-review
format.)
