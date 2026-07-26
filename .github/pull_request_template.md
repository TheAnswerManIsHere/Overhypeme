<!--
  Fill in the sections below. The checklist is a self-audit against the agent
  working rules (docs/ai-context/agent-working-rules.md) — check what applies,
  strike through (~~…~~) what doesn't. Human and agent PRs both use this.
-->

## What & why

<!-- What changed and the intent it serves. Link the plan/issue if there is one. -->

## Approved-plan oracle

<!-- Every PR needs an oracle — something OUTSIDE the diff to check it against,
     so a reviewer can catch a PR that is internally sound but quietly narrowed
     its scope or broke a neighbor. Which form you fill in depends on the mode;
     see docs/engineering/code-review.md#the-review-oracle-the-pr-body.

     FEATURE MODE — paste the approved plan's Product Intent / Must Not Change /
     Settled Decisions verbatim, from the plan-review PR body or the final
     approved plan doc. Delete the bugfix block.

     Approved-plan source identifies the EXACT final revision these words came
     from — not a title or a mutable branch — so a reviewer can tell the
     approved plan apart from earlier review-round versions. Use:
       Plan-review PR #<N>, final plan commit `<sha>`, approved by David on `YYYY-MM-DD`.
     or, for the private/manual review path (plan never committed):
       `<final-plan-filename>.md`, sha256 `<hash>`, approved by David on `YYYY-MM-DD`.
     (`shasum -a 256 <file>` on the exact file delivered for approval.)

     BUGFIX MODE — fill the bugfix oracle instead; delete the feature block.
     See docs/ai-context/working-modes.md#the-bugfix-oracle-what-the-pr-body-must-carry.

     Only a genuinely trivial change with no plan and no bug behind it (a typo,
     a comment) writes "n/a — no plan" and deletes both blocks. -->

<!-- Feature mode -->
**Approved-plan source:**
**Product intent:**
**Must not change:**
**Settled decisions:**

<!-- Bugfix mode -->
**Fix tier:** <!-- A or B, PLUS the reason either way — for B, the specific Q1/Q2
     trigger that fired; for A, the triggers you actually checked and ruled out
     (not just "A (contained)" with no reasoning — A is the classification a
     reviewer most needs to be able to challenge). See
     docs/ai-context/working-modes.md#the-tier-is-chosen-after-diagnosis-never-at-intake. -->
**Reported symptom:** <!-- David's report, quoted verbatim -->
**Intended correct behavior:**
**Must not change:** <!-- adjacent behaviors sharing this code path -->
**Root cause:** <!-- the mechanism, not the instance -->
**Blast radius:** <!-- what else calls this / shares this path, and what you checked -->

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
