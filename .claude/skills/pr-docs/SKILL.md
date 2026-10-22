---
name: pr-docs
description: Use while composing the body of a feature-mode PR with product-visible or testable behavior — its Post-merge verification and `## UAT` sections are in the body when the PR opens — and before calling that PR done. Bugfix-mode PRs do NOT inherit this pairing — their docs are conditional per tier — and a prototype-phase PR ships no UAT section — its Post-merge verification section carries only its version's `live` check, or "none needed".
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Every production-phase feature PR ships post-merge verification + a UAT

Migrated out of `CLAUDE.md` so it loads when the docs are actually being
written. The rule that a product-visible feature PR is not complete until
both halves exist stays resident in `CLAUDE.md`.

### The pairing (David, 2026-08-15 — the standalone TEST_RUN file is retired)

**This section is the feature-mode default: paired by default, for a feature in production phase.**
Bugfix mode does **not** inherit this pairing — its verification is
conditional per tier, and its infra-only fixes may ship neither half: see
[`working-modes.md`](../../../docs/ai-context/working-modes.md#tier-b--elevated-fix).
What follows describes the feature-mode default.

For **every** feature-mode PR that has product-visible or testable behavior
**and is in production phase**, I ship two things, both in the PR body. A
prototype-phase PR ships no UAT section — that is the documentation bar the
phase removes — and its
*Post-merge verification* section carries exactly one thing: the version's
`live` check, when its claim depends on the deployed environment or a real
vendor, as the command and pass criterion I run after the merge's sync and
before the owner is asked — one that would start a paid AI run runs within David's paid-run budget — $5 a run, $25 a week across every product — and on his go-ahead only above it (`uat-doc-format.md`, *Lanes*); otherwise
"none needed". Its scaled `ci` and
`scripted` lanes run before the merge (a check that would start a paid AI run is never `ci`; as `scripted` it runs within his paid-run budget and asks above it, as above) and its feedback rail is the only human
lane (working-modes.md, *The prototype phase, per feature*, and *What
prototype phase keeps of verification*; Codex, DojoOS #8: without that record
the mandatory live check had no recorded command for close-out to run).

1. **The PR body's *Post-merge verification* section** — the
   engineering checks for Replit's live environment (the technical safety
   net). This replaced the old `docs/tests/Replit/PR<N>_..._TEST_RUN.md`
   file (David, 2026-08-15): the checks are written **with the diff and
   reviewed with it** in the same Codex pass, instead of shipping as a
   separate near-zero-stakes artifact with its own lifecycle.

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
   report them — pass or fail — in the close-out merge report. A step that
   would start a paid AI run is not read-only: it runs within David's paid-run budget — $5 a run, $25 a week across every product — and on his go-ahead only above it (`uat-doc-format.md`, *Lanes*). A failure
   routes through the normal channel and the workstream stays at its
   verification stage until clean. A clearly-labeled mutating deploy step
   in the section (the contract's third permitted write shape) is mine to
   execute through the connector at the same point.

   **Legacy TEST_RUN files still in `docs/tests/Replit/` run out under the
   old pattern**: I drive each run, and on a full pass delete the doc (a
   tiny deletion PR, self-merged); its continued presence means not-run or
   not-clean. I do NOT create new TEST_RUN files, flag the absence of one,
   or "restore" a deleted one.

2. **The PR body's `## UAT` section** — the in-app acceptance script,
   written to [`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md)
   and its lane rules, so David's share of it is the judgement residue.
   **That format is mandatory and it is not a style preference**: `/uat`
   drives the run by enumerating `#### ` headings inside `### Steps` and
   `### Regression` of that section, so a section outside the format is one
   that cannot be driven. Setup lines, step shape (`Do:` / `Expect:`),
   regression IDs and the deliberate omissions all live there rather than
   being restated here.

   **It is a section of the body, not a file (David, 2026-10-21)** — the
   same move the TEST_RUN file made above, for the same reason: written with
   the diff and reviewed with it, with no lifecycle of its own. Until then
   the script was `docs/tests/UAT/PR<N>_<FEATURE>_UAT.md`, which needed the
   PR number for its name (so the PR opened with a "Docs pending"
   placeholder and the file followed in a second commit), a deletion PR
   when the run completed, and a correction PR when an `Expect` was wrong.
   Now the section is in the body when the PR opens, like the oracle; a
   wrong `Expect` is an edit of the body, quoted into the run record; and
   nothing is deleted at close-out — the workstream's `stage:uat` label is
   what says a run is owed, and `/uat` discovers runs from it. **A legacy
   doc still in `docs/tests/UAT/` on `main` runs out under the old
   pattern**: `/uat` drives it from the file and deletes it when David
   confirms the run complete (harvesting into the Manual first any
   behaviour it is the only written record of). I do NOT create new UAT
   files, flag the absence of one, or "restore" a deleted one.

   **The section is a script I drive, not a page he reads (David, 2026-08-21).**
   David works through it with me step by step via [`/uat`](../uat/SKILL.md),
   so write it for that: **setup is mine to execute** — the `[claude]` lines
   in the format — and `[david]` is reserved for what only his own session or
   device can do, admin-gated setup on the deployed build included (there
   the connector reads and does not click; on a local stack at the commit
   under test the test identity the consumer's per-PR browser job signs in
   with is mine, Overhype.me's dev-admin login for one — `/uat` section 2
   and *Where the browser automation lives*). The section is the canonical
   script; the run record on the workstream issue is where its results live.

   **Every step gets a lane, and the default is a machine** (David,
   2026-10-07; the lanes are defined in
   [`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md#lanes-where-each-step-is-verified-david-2026-10-07)).
   A step is `human` only when no machine can answer it — taste, legibility,
   whether a result reads right, what an AI-generated image shows beyond what
   anyone would verify the same way, or something only his own account or
   device can do — and it says which, in its `**Judgement:**` line. Everything else
   is `ci`, `scripted`, `live` or `capture`, and **the check it cites is
   written in this same PR**, so the UAT he runs is the human residue and
   nothing more. `capture` is for an answer only pixels hold — the words
   the product draws onto an image, a canvas preview, the verifiable facts
   of a real AI render (a bubble appears and reads a given text; never
   likeness, scene, humour, quality, whether it shows a person or any
   particular thing, or whether it is acceptable, unless as plain and
   checkable as a bubble's text — those are a `human` step's:
   `uat-doc-format.md`, *Lanes*, *An image an AI model generated*) — with
   its `Expect` written as the screen it should show, never "as before"
   (`uat-doc-format.md`, *Lanes*). A step whose check would start a paid AI
   run is never `ci`, and in any other lane runs within David's paid-run budget — $5 a run, $25 a week across every product — and on his go-ahead only above it (the same section), so a clause the product's own code draws cites a local
   capture where the consumer declares one. **The lane is read from the `Expect`'s clauses and
   from who can perform the `Do`, never from the heading or the verb**
   (David, 2026-10-15; the rule's home is the `uat` skill, *Where the
   browser automation lives*, which also says what `/uat` does with a step
   labelled wrong): "the refusal reads well" over an `Expect` naming the
   sentence, the status and that nothing overflows is a machine-lane step
   with a browser or component assertion for those clauses, plus a
   one-clause `human` step for "it is readable" — never one `human` step
   carrying both; a `Do` only his own account or device can perform keeps
   its step `human`, screen facts and all. **A behaviour a later PR delivers has no step
   here** — it belongs in the oracle's scope line (below). A behaviour
   **this** PR claims
   whose machine check cannot exist yet, because the double or fixture it
   needs lands later, keeps its machine step `**Deferred:** #N` to that
   owner, and **the owed check is recorded on issue #N when the line is
   written** (one comment naming the PR, the step and the check), so whoever
   lands #N knows it. **The PR that lands #N pays that debt in the same PR**:
   it writes the check and, in every merged PR's `## UAT` section that
   defers to #N, replaces the `**Deferred:**` line with the runnable
   `**Check:**` — an edit of that PR's body (`update_pull_request`), said
   on #N; the guard cannot see an edit to a merged body, which is why the
   resumed `/uat` runs the check rather than trusting the line. A legacy doc
   gets the same edit in its file.
   The deferred step is **never** turned into a `human` step to get past
   the wait: David's share is judgement only. Such a run is Blocked until #N
   lands, which is the honest state of a behaviour nothing has yet checked.
   `node scripts/check-uat-format.mjs` reads the body from the
   `pull_request` event in CI and refuses a step without a lane, a
   machine-lane step whose cited check does not exist, a `human` step
   without its `**Judgement:**` line, and that line on any other lane.

   **No Artifact page (David, 2026-08-21 — retiring the 2026-07-22 rule).**
   The Artifact existed as a reading surface for working through the script
   alone on an iPad; the `/uat` session replaced that job. Publish one only
   if he asks for a solo run.

A product-visible PR is **not** complete — and I don't present it to David
as done — until the verification section has real content (or an explicit
"none needed") and the body carries its `## UAT` section, unless the
ship-the-UI-surface exception applies or the PR is in prototype phase (above). For the UAT's structure, follow
[`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md) — **not** the
nearest merged PR's section, which is how six competing conventions
accumulated in the first place. (Pure infra/refactor with zero
observable behavior can use a single short verification note in the PR body
instead, per the ship-the-UI-surface exception.)

**A phase PR gets its own UAT, and an added scope line.** When this PR is
one phase of a phased feature (see
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)'s
*Phased features*), two things change:

- **UAT is per-phase, not deferred to the last phase.** If *this phase* is
  product-visible, its PR body carries its own `## UAT` section — the same
  rule as any other PR. Deferring every phase's UAT to the end would
  leave David with nothing to verify for weeks and would pile the whole
  feature's risk into one session. A phase with no product-visible surface
  of its own ships a verification note instead, same exception as always.
- **The oracle section gets a scope line** naming which of the parent
  plan's sections this phase *delivers* and which it *defers* to a later
  phase. Without it a reviewer can't tell an out-of-scope-for-this-phase
  gap from a silently dropped requirement — and the whole point of the
  oracle is catching a PR that quietly narrowed the approved scope. Cite
  the parent issue and the committed plan file — or, for a plan that failed
  the disclosure check, the private item holding it, with the scope line
  under the same sanitizing (`claude-core.md` Pull requests rule 3); the body's `Oracle source:` line
  (`claude-core.md` Pull requests rule 4) names the approved plan and its
  digest (marked `private path` for a plan that failed the check), and the scope line stays beside it in prose.
  Before the PR opens, the whole body — summary, scope, verification, UAT
  prose — passes the canonical disclosure check or is written sanitized
  (`workstream-tracking.md`).

**Workstream label.** Per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md),
this skill owns no `stage:`/`waiting:` transition of its own — `pr-watch`
already owns `stage:code-review` for the PR this pairing rides on. Just
confirm the workstream issue's `mode:` label is `feature` (this pairing is
feature-mode-only), and make sure the PR is named in the workstream issue's
State of Play `Artifacts` field with a note that it carries the UAT — the
PR is where a cold-resumed `/uat` reads the script from, and it won't find
it by re-deriving which PR the issue belongs to.
