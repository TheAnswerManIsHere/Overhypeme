---
name: pr-docs
description: Use right after opening a feature-mode PR with product-visible or testable behavior, before calling that PR done. Bugfix-mode PRs do NOT inherit this pairing — their docs are conditional per tier.
---

# Every PR ships with a Replit test plan + a UAT

Migrated out of `CLAUDE.md` so it loads when the docs are actually being
written. The rule that a product-visible feature PR is not complete until both
docs exist and the PR body links them stays resident in `CLAUDE.md`.

### Every PR ships with a Replit test plan + a UAT (opened with the PR, named after its number)

**This section is the feature-mode default: paired by default, unconditionally.**
Bugfix mode does **not** inherit this pairing — its docs are conditional per
tier, not paired, and its infra-only fixes may ship neither: see
[`working-modes.md`](../../../docs/ai-context/working-modes.md#tier-b--elevated-fix)
(Tier A ships neither doc; Tier B ships a UAT only if the fix has
product-visible behavior, and a TEST_RUN only if something genuinely needs
Replit's live environment). What follows describes the feature-mode default.

For **every** feature-mode PR that has product-visible or testable behavior, I
ship two docs in `docs/` named after the PR's number. Because the GitHub PR
number doesn't exist until the PR is opened, the flow is **PR-first**:

1. Open the PR with the code (per CLAUDE.md's squash-merge workflow), giving
   the body a temporary placeholder note:
   > **Docs pending:** PR number acquired. I will add
   > `docs/PR<N>_<FEATURE>_TEST_RUN.md` and `docs/PR<N>_<FEATURE>_UAT.md` as
   > a follow-up commit to this same PR before merge, then replace this note
   > with links to both docs.
2. Read the assigned PR number, write both docs, and commit them to the
   **same PR** before merge.
3. Replace the "Docs pending" note in the PR body with links to both docs.

`<N>` is the GitHub PR number; `<FEATURE>` is a SCREAMING_SNAKE_CASE slug. A
product-visible PR is **not** complete — and I don't present it to David as
done — until both docs exist and the PR body links them (unless the
ship-the-UI-surface exception applies). The docs always land on the **same PR
before merge**; they are **never** a separate later PR.

The two docs:

1. **`docs/PR<N>_<FEATURE>_TEST_RUN.md`** — the engineering/automated checklist
   for Replit (the technical safety net).

   **Its content and shape are governed by
   [`test-run-contract.md`](../../../docs/tests/test-run-contract.md)** — the
   narrow, shared thing (a contract *Replit executes*), same pattern as the
   Codex plan-review contract. I follow it rather than restating it here. The
   short version, because I kept getting this wrong: **a TEST_RUN verifies what
   only Replit's environment can verify** — live-DB migration state, post-merge
   repo-health gates, behavior against live config/data, and a targeted test
   list scoped to the touched surfaces. Pre-merge gates (install, typecheck,
   codegen drift) compress to one line; the **full sharded suite is
   conditional**, not default — include it only when the PR touches shared
   infra, and say so explicitly. Replit's own feedback after executing several
   of these was that roughly half of each checklist was re-verification of
   things that already passed pre-merge.

   **Replit owns the database connection.** Don't include
   `DATABASE_URL=...` exports, test-DB env-var setup, or any other
   environment-specific DB config in this doc — Replit's database lives
   somewhere different than the local container and any DB config I write
   would be wrong or contradictory there. Instead, describe what should
   happen against the DB ("apply migrations", "run these test files",
   "confirm the new columns exist on `upload_image_metadata`") and let
   Replit handle the connection itself.

   **The TEST_RUN doc is transient — David deletes it once Replit has run
   it.** It only needs to exist long enough for Replit to execute the checklist
   and confirm it passes; after that David removes it. So a `*_TEST_RUN.md`
   that is missing from `main` (even one whose UAT sibling is still present) is
   **expected, not a bug** — I do NOT flag its absence, try to "restore" it, or
   re-add it. The UAT doc is the durable half of the pair.
2. **`docs/PR<N>_<FEATURE>_UAT.md`** — the in-app, click-through acceptance test
   for David. Written for the end user: where to click, what to expect vs.
   not expect, regression smoke table, a bug-report template, and known
   non-bug limitations.

   **A UAT gets an Artifact page (David, 2026-07-22).** When I deliver a
   `docs/PR<N>_*_UAT.md`, I also publish it as a private **Artifact web page** —
   David works through it on an iPad while clicking around the app, and a typeset
   page beats a raw `.md` for that. The committed markdown stays the canonical,
   durable copy; the Artifact is a reading surface, not a source of truth. This
   rule used to sit beside the now-retired plan-delivery ritual and is
   independent of it — a UAT is something David *works from*, not a specification
   under review, so dropping plan Artifacts did not drop these.

**Structure, depth, and tone:** the TEST_RUN follows
[`test-run-contract.md`](../../../docs/tests/test-run-contract.md) (which carries
the template verbatim); for the UAT, match the most recent surviving
`docs/PR<N>_…_UAT.md` — the UAT half is durable, so there is always a live
example to match, whereas TEST_RUN examples get deleted (which is why the
contract, not an example file, is the reference). Both docs cross-link each
other. (Pure infra/refactor with zero observable behavior can use a single
short verification note in the PR body instead, per the ship-the-UI-surface
exception.)

**Workstream label.** Per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md),
this skill owns no `stage:`/`waiting:` transition of its own — `pr-watch`
already owns `stage:code-review` for the PR this pairing rides on. Just
confirm the workstream issue's `mode:` label is `feature` (this pairing is
feature-mode-only), and once both docs are committed, add them to the
workstream issue's State of Play `Artifacts` field — the TEST_RUN/UAT links
are exactly the kind of thing a cold-resumed session needs and won't find
by re-deriving it from the PR alone.

