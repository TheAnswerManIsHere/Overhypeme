# Code Review Guide

> A consistent checklist for reviewing Overhype.me changes (Codex, Claude, or
> human). Priorities match the root [`AGENTS.md`](../../AGENTS.md). Reviewers use
> **review-status labels, not approval language** — only David approves.

## The review oracle: the PR body

A code diff can be internally sound — well-tested, correctly implemented,
sensibly scoped — and still be the wrong PR, because it quietly narrowed or
dropped part of what David actually approved. Reviewing the diff against
itself can't catch that; it needs an oracle outside the diff, same principle
as the [plan-review contract](../ai-context/plan-review-contract.md#the-review-oracle-the-pr-body).

For a PR built from a David-approved plan, the PR body's **Approved-plan
oracle** section (see the
[PR template](../../.github/pull_request_template.md)) carries that plan's
Product Intent / Must Not Change / Settled Decisions verbatim. Check the code
against that, not only against internal consistency: does it implement
everything the intent called for, does it touch anything the plan marked
must-not-change, does it match the settled decisions rather than a plausible
alternative. Flag a dropped or narrowed requirement even if the code itself
never mentions it — the absence is the finding.

If a PR has no plan (bugfix mode, a trivial change) the oracle section reads
"n/a — no plan," and this check doesn't apply; review the diff on its own
terms as usual.

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
- If this fixes a **recurring** pattern (a second occurrence of something
  already in [`known-failure-patterns.md`](../ai-context/known-failure-patterns.md)),
  did the fix add a deterministic CI guard
  (`.github/workflows/build.yml`) rather than just a one-off correction or a
  stronger doc warning? A doc reminder didn't stop the `api-zod` codegen-revert
  mistake from recurring once already; a mechanical check can't be skipped by
  not reading the doc. See
  [`decisions.md`](../ai-context/decisions.md) → "Recurring failure patterns
  become CI guards."

## Observability

- Failures reported (Sentry where appropriate)? Bulk operations expose what
  happened? Enough logging to debug a bad render/enrichment/job?

## Scope control

- Smallest coherent change for the approved plan? No speculative abstraction, no
  new external vendor, no scope creep beyond intent?

## Review output format

**Two delivery surfaces exist; they don't support the same shape** — same split
as the [plan-review contract's *Output*](../ai-context/plan-review-contract.md#output),
adapted for a code diff instead of a markdown plan.

### Full-document delivery (a human reviewer, or an agent free to post one document)

Produce concise, prioritized feedback. Label overall status (no approval
language) — e.g. *No major technical disagreement · Directionally good, revisions
needed · Substantive technical concerns · Strong disagreement on direction · Human
clarification required · Repo context required.* For each finding: what, why (tied
to a priority above), and a concrete suggestion. Separate **must-fix** from
**nice-to-have**. Escalate design/architecture/trade-off calls to David rather than
deciding them.

### GitHub structured review (the `@codex review` transport)

Same confirmed limitation as the plan-review contract: this surface has no
freestanding top-level write-up, only diff-anchored inline findings, and no
status-label or ledger channel. Don't ask this surface for the full-document
shape above — it can't post it. Each finding is its own inline comment,
anchored to the relevant line (or, for an oracle-driven finding with no single
line — a dropped requirement, a touched must-not-change area — the most
defensible nearby line). A clean round is an empty findings list; on a diff
this is stronger evidence than on a plan (compiling, passing tests, and CI back
it up), so — unlike the plan contract — silence here is a real, sufficient
result, not a transport limitation to work around.

(The `overhype-plan-review` skill defines the full plan-review format; this
section is the code-review analog.)
