<!--
  Fill in the sections below. The checklist is a self-audit against the agent
  working rules (docs/ai-context/agent-working-rules.md) — check what applies,
  strike through (~~…~~) what doesn't. Human and agent PRs both use this.
-->

Workstream: #<!-- issue number — every feature, bugfix, and doc harvest is
     tracked (see docs/ai-context/workstream-tracking.md; AGENTS.md's
     workstream-tracking contract). Never "Closes #N" for THIS workstream —
     that auto-closes it at merge and skips Test run/UAT. A different gap,
     backlog or bug issue this PR completes outright, and that owes no UAT of
     its own, is the opposite case: name it with "Closes #N" so it closes on
     merge. Use "Refs #N" for one the PR only advances, or one still owing a
     UAT. The ONLY exemption to the Workstream line is a
     sensitive/disclosure-carve-out workstream, tracked as a private draft
     Project item instead of a public issue — leave this line blank/deleted
     only for that case. Keep "Workstream: #N" as the very first thing on its
     own line, plain text, no markdown bold, nothing before it on that line —
     /status-all and the /status skill both parse
     it with the anchored regex `^Workstream:[ \t]*#(\d+)` (multiline,
     line-start only), which bold formatting (`**Workstream:**`), leading
     text, or a line break between the colon and the number all break. -->

## What & why

<!-- What changed and the intent it serves. Link the plan/issue if there is one. -->

## Approved-plan oracle

<!-- Every PR needs an oracle — something OUTSIDE the diff to check it against,
     so a reviewer can catch a PR that is internally sound but quietly narrowed
     its scope or broke a neighbor. See
     docs/engineering/code-review.md#the-review-oracle-the-pr-body.

     TWO PARTS, and they are different things.

     PART 1 — THE SOURCE, one plain line. Nothing parses it; it points a
     reviewer at where the oracle was agreed (claude-core.md Pull requests
     rule 4, and docs/engineering/code-review.md#the-review-oracle-the-pr-body).
     Write it as the first live line below, replacing the placeholder, with
     exactly one of:
       - a planned feature: the approved plan's filename and its full sha256
         digest (`shasum -a 256` on the exact file approved — an in-session
         plan is never committed, so the digest is what pins it);
       - work agreed in conversation: the issue where the scope was agreed;
       - a bugfix: its tier letter, A, B or C (a Tier C database schema fix
         names C, and its Tier rationale below says why);
       - `no plan`, for a genuinely trivial change with no plan and no bug
         behind it.
     (Until 2026-09-25 this was a fenced `plan-provenance` block with a fixed
     key set per kind. It was retired, AI-Handbook #103; do not write one.)

     PART 2 — THE ORACLE PROSE, which the source line does not replace. Fill in the
     live fields for your mode below and delete the other mode's fields.

     FEATURE MODE — paste the approved plan's Product Intent / Must Not Change /
     Settled Decisions verbatim, from the final approved plan.

     BUGFIX MODE — fill the bugfix fields instead. See
     docs/ai-context/working-modes.md#the-bugfix-oracle-what-the-pr-body-must-carry.
     A *database* schema/migration/backfill fix (not the generated Zod schemas
     under lib/api-zod / lib/api-spec, which are a Q1 Tier B trigger) is always
     Tier C: out of bugfix mode's fast path, but a genuinely trivial one may run
     migration ceremony directly with David's go-ahead. It still has a bug
     behind it, so its source line names tier C — never `no plan`. See
     docs/ai-context/working-modes.md#tier-c--this-is-not-a-bug-fix-leave-bugfix-mode. -->

Oracle source: <!-- see PART 1 above -->

<!-- Feature mode -->
**Direction:** <!-- the direction this plan cited, linked, if any — carries the
     product decisions constraining every increment beneath it. A plan whose
     Product Intent is deliberately narrower than the direction (see
     docs/ai-context/working-modes.md#the-increment-test) still owes the code
     review every applicable direction constraint, not just the plan's own
     Settled Decisions. "n/a" only if the plan itself said no direction applied. -->
**Product intent:**
**Must not change:**
**Settled decisions:**

<!-- Bugfix mode -->
**Tier rationale:** <!-- why this tier, either way — for B, the specific Q1/Q2
     trigger that fired; for A, the triggers you actually checked and ruled out
     (not just "contained" with no reasoning — A is the classification a
     reviewer most needs to be able to challenge); for C, why it is trivial
     enough to skip a full plan, and how/when David gave the go-ahead. See
     docs/ai-context/working-modes.md#the-tier-is-chosen-after-diagnosis-never-at-intake. -->
**Reported symptom:** <!-- David's report, quoted verbatim -->
**Intended correct behavior:**
**Must not change:** <!-- adjacent behaviors sharing this code path -->
**Root cause:** <!-- the mechanism, not the instance -->
**Blast radius:** <!-- what else calls this / shares this path, and what you checked -->
**Migration ceremony checklist:** <!-- Tier C schema fixes only: idempotency,
     observable counts, human-edited-row preservation, rollback for destructive
     ops — see docs/engineering/migrations-and-backfills.md -->

## Verification

<!-- Exact commands run + results. Separate valid failures from environment/
     deferred-to-CI ones. For product-visible behavior, name the manual steps to
     observe it. -->

## Post-merge verification (live environment)

<!-- What only Replit's live environment can verify — executed by the driving
     agent through the Replit connector after merge + sync, results reported
     in the close-out report. Content rules and the section template live in
     docs/tests/test-run-contract.md: read-only by default (migration state,
     read-only SQL, live-config behavior checks, post-merge repo-health
     gates); never re-run suites CI already ran; any mutating one-time deploy
     step is clearly labeled as such with its credential and ordering
     prerequisites. Write "none needed" for PRs with nothing
     environment-specific (pure docs, pure infra). This section replaced the
     standalone TEST_RUN doc (David, 2026-08-15). -->

none needed

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
