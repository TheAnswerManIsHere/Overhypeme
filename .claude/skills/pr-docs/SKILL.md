---
name: pr-docs
description: Use right after opening a feature-mode PR with product-visible or testable behavior, before calling that PR done. Bugfix-mode PRs do NOT inherit this pairing — their docs are conditional per tier.
---

# Every PR ships post-merge verification + a UAT

Migrated out of `CLAUDE.md` so it loads when the docs are actually being
written. The rule that a product-visible feature PR is not complete until
both halves exist stays resident in `CLAUDE.md`.

### The pairing (David, 2026-08-15 — the standalone TEST_RUN file is retired)

**This section is the feature-mode default: paired by default, unconditionally.**
Bugfix mode does **not** inherit this pairing — its verification is
conditional per tier, and its infra-only fixes may ship neither half: see
[`working-modes.md`](../../../docs/ai-context/working-modes.md#tier-b--elevated-fix).
What follows describes the feature-mode default.

For **every** feature-mode PR that has product-visible or testable behavior,
I ship two things:

1. **The PR body's *Post-merge verification* section** — the
   engineering checks for Replit's live environment (the technical safety
   net). This replaced the old `docs/tests/Replit/PR<N>_..._TEST_RUN.md`
   file (David, 2026-08-15): the checks are written **with the diff and
   reviewed with it** in the same Codex pass, instead of shipping as a
   separate criticality-1 artifact with its own lifecycle.

   **Content and shape are governed by
   [`test-run-contract.md`](../../../docs/tests/test-run-contract.md)** —
   the section template, the read-only rule, "Replit owns the database
   connection," what earns a check and what to demote. I follow it rather
   than restating it. The short version, because I kept getting this
   wrong: **it verifies what only Replit's environment can verify** —
   live-DB migration state, post-merge repo-health gates, behavior against
   live config/data. Never a re-run of suites CI already ran. "none
   needed" is the correct content for a PR with nothing
   environment-specific.

   **Execution is part of close-out, not a separate ceremony.** After
   merge + sync, I drive the section through the Replit connector (the
   two-call sequence in `CLAUDE.md`'s connector policy, read-only scoping
   stated in the prompt), read the results back with `ask_question`, and
   report them — pass or fail — in the close-out merge report. A failure
   routes through the normal channel and the workstream stays at its
   verification stage until clean. A clearly-labeled mutating deploy step
   in the section (the contract's third permitted write shape) is mine to
   execute through the connector at the same point.

   **Legacy TEST_RUN files still in `docs/tests/Replit/` run out under the
   old pattern**: I drive each run, and on a full pass delete the doc (a
   tiny deletion PR, self-merged); its continued presence means not-run or
   not-clean. I do NOT create new TEST_RUN files, flag the absence of one,
   or "restore" a deleted one.

2. **`docs/tests/UAT/PR<N>_<FEATURE>_UAT.md`** — the in-app, click-through
   acceptance test for David. Written for the end user: where to click, what
   to expect vs. not expect, regression smoke table, a bug-report template,
   and known non-bug limitations. **This half is unchanged and deliberately
   file-based**: the UAT files are David's own to-do list, and **he deletes
   each one himself** when he completes it — I never delete a UAT doc.

   Because the PR number is in the filename, the UAT doc follows the
   **PR-first** flow: open the PR with a "Docs pending" placeholder note,
   read the assigned number, write and commit the UAT doc to the **same PR
   before merge**, then replace the note with the link. `<N>` is the GitHub
   PR number; `<FEATURE>` is a SCREAMING_SNAKE_CASE slug. The doc always
   lands on the same PR — never a separate later PR.

   **A UAT gets an Artifact page (David, 2026-07-22).** When I deliver a
   `docs/tests/UAT/PR<N>_*_UAT.md`, I also publish it as a private
   **Artifact web page** — David works through it on an iPad while clicking
   around the app, and a typeset page beats a raw `.md` for that. The
   committed markdown stays the canonical, durable copy; the Artifact is a
   reading surface, not a source of truth.

A product-visible PR is **not** complete — and I don't present it to David
as done — until the verification section has real content (or an explicit
"none needed") and the UAT doc exists and is linked, unless the
ship-the-UI-surface exception applies. For the UAT's structure, match the
most recent surviving `docs/tests/UAT/PR<N>_…_UAT.md` — that half is
durable, so there is always a live example. (Pure infra/refactor with zero
observable behavior can use a single short verification note in the PR body
instead, per the ship-the-UI-surface exception.)

**Workstream label.** Per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md),
this skill owns no `stage:`/`waiting:` transition of its own — `pr-watch`
already owns `stage:code-review` for the PR this pairing rides on. Just
confirm the workstream issue's `mode:` label is `feature` (this pairing is
feature-mode-only), and once the UAT doc is committed, add it to the
workstream issue's State of Play `Artifacts` field — the UAT link is
exactly the kind of thing a cold-resumed session needs and won't find by
re-deriving it from the PR alone.
