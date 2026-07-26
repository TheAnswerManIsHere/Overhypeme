<!--
  Fill in the sections below. The checklist is a self-audit against the agent
  working rules (docs/ai-context/agent-working-rules.md) — check what applies,
  strike through (~~…~~) what doesn't. Human and agent PRs both use this.
-->

## What & why

<!-- What changed and the intent it serves. Link the plan/issue if there is one. -->

## Approved-plan oracle

<!-- If this PR implements a plan David approved (feature mode), paste that
     plan's Product Intent / Must Not Change / Settled Decisions verbatim —
     from the plan-review PR body or the final approved plan doc — so the
     reviewer can check this diff against what was actually approved, not
     just against itself (see docs/engineering/code-review.md#the-review-oracle-the-pr-body).
     For bugfix mode or a trivial change with no plan, write "n/a — no plan."

     Approved-plan source identifies the EXACT final revision these words came
     from — not a title or a mutable branch — so a reviewer can tell the
     approved plan apart from earlier review-round versions. Use:
       Plan-review PR #<N>, final plan commit `<sha>`, approved by David on `YYYY-MM-DD`.
     or, for the private/manual review path (plan never committed):
       `<final-plan-filename>.md`, sha256 `<hash>`, approved by David on `YYYY-MM-DD`.
     (`shasum -a 256 <file>` on the exact file delivered for approval.) -->

**Approved-plan source:**
**Product intent:**
**Must not change:**
**Settled decisions:**

## Verification

<!-- Exact commands run + results. Separate valid failures from environment/
     deferred-to-CI ones. For product-visible behavior, name the manual steps to
     observe it. -->

## Checklist

- [ ] **Docs stay true** — if this changed product/architecture/principle truth,
      the shared docs were updated in this PR (`docs/ai-context/`, `AGENTS.md`),
      not a private copy. `pnpm run check:docs` passes.
- [ ] **Build gate reproduced when relevant** — frontend, package config,
      Vite/build config, or workspace-script changes were verified with
      `pnpm run build` (or the PR explains why this was deferred to CI).
- [ ] **General fix, not one example** — tests prove the invariant with negative
      cases, not just the reported input. (or ~~n/a~~)
- [ ] **Ship the surface** — user/admin/tester-visible behavior ships with the UI
      to exercise it; no dead UI, no invisible backend. (or ~~n/a~~)
- [ ] **Async shows status** — queued/bulk/long work reports per-item + aggregate
      status (see `docs/ai-context/async-ui-status.md`). (or ~~n/a~~)
- [ ] **Human decisions preserved** — no silent AI/backfill overwrite of moderator
      overrides; moderation/override changes stay auditable. (or ~~n/a~~)
- [ ] **Migration safety** — idempotent, observable counts, human-edited rows
      preserved, rollback for destructive ops
      (see `docs/engineering/migrations-and-backfills.md`). (or ~~n/a~~)
- [ ] **In scope** — smallest coherent change; no new external vendor or
      speculative abstraction without sign-off.
