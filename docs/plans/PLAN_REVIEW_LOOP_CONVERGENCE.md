# Plan — Make review loops converge in a handful of rounds

## Problem

PR #268 (an 8-file prose/contract change) took **18 Codex review rounds and 40
findings** to converge. Classifying every finding by cause:

| Cause | Rounds | Share |
|---|---|---|
| Legitimate design discovery | 1–6 | ~35% |
| **Propagation** — a fix landed in one file, missing 4–5 restatements of the same rule | 7, 8, 13, 14, 17 | ~40% |
| **My fix was itself wrong** — the fix created the next round's finding | 9, 10, 12, 16 | ~25% |

**Two thirds of the rounds were self-inflicted.** The artifact also grew
`108 → 373` lines in `working-modes.md`; each fix added qualifying prose, and
each clause added new surface for the next inconsistency.

Round 11 came back clean and round 12 then found three issues including two P1s
— so a clean round was not evidence of convergence.

Concrete symptom for David: every loop we run — plan review, code review,
bugfix — currently risks this, and he has to sit through it.

## Product Intent

Bugfix, code review, and plan review each converge in a handful of rounds —
target ~4–5, not 20 — **without reducing review rigor.** The manual
paste-to-ChatGPT flow reached consensus in ~4 rounds on plans; we want that
efficiency from the automated loop.

## Must Not Change

- **Review rigor.** We are removing self-inflicted churn, not lowering the bar.
  A loop that converges fast by finding less has failed.
- **Only David approves.** No change to approval semantics on any loop.
- **Codex remains the independent reviewer.** This is not a proposal to
  self-review instead.
- **The plan-review loop's existing depth requirements** — minimum 3 rounds, a
  fresh lens each round, the findings ledger. A plan review that legitimately
  runs long on genuinely narrowing findings (PR #252 hit round 23 and was still
  finding real bugs) is working as designed and is explicitly not the target.
- The `[PLAN REVIEW]` PR stays never-merged; plan files stay off `main`.

## Settled Decisions

1. **Diagnosis is causal, not difficulty-based.** 18 rounds was not the
   inherent cost of the work; ~2/3 was rework.
2. **Model tier is a third-order factor.** The duplication that drove ~40% of
   the churn was authored on Opus in round 1. Sonnet contributed the four wrong
   fixes. Structure is the primary cause; tier is real but minor.
3. **De-duplicating the existing tier/oracle text is out of scope here** and
   gets its own PR — bundling a 6-file refactor into the PR meant to fix
   over-scoped prose changes would repeat #268's mistake.
4. **This plan is its own dogfood test** — it runs through the plan-review loop
   whose rules it proposes to change.

## Repo Context Inspected

- `docs/ai-context/plan-review-contract.md` — read in full (515 lines).
- `docs/engineering/code-review.md` — read in full, esp. *Re-reviews (round 2
  onward)* and *Review output format*.
- `docs/ai-context/working-modes.md`, `CLAUDE.md` (*Automated plan review*,
  *Watching the PRs I open*, *Token / cost discipline*), `.agents/PLANS.md`.
- `git diff --name-only origin/main...HEAD` on #268 → confirmed the exact 8-file
  set that PR touched.
- PR #268's own 40 findings and 18 trigger comments, read round by round.

## Current Behavior

Three loops exist, and they are **not** symmetric on the question that caused
#268:

**Plan review** — `plan-review-contract.md` already solves diff-blindness,
explicitly and forcefully:

> *"Do **not** review it as a diff… That holds on **every** round, including
> re-reviews where GitHub shows you only a markdown diff."*
> *"**The diff is not the scope.** … Re-read the complete current plan and
> re-verify it against the repository each round."*

Also note round 1 of a plan review is a *newly added file*, so its diff **is**
the whole document. Plan review is structurally the least exposed of the three.

**Code review** — `code-review.md`'s re-review invariant 5 says:

> *"After more than one fix round, review the cumulative branch **diff** against
> the base branch."*

That is still a diff. **There is no whole-file instruction anywhere in
`code-review.md`.** For code that is correct — compilation, tests and CI
independently back up silence. For prose nothing does.

**#268 ran through the code-review flow**, because a multi-file prose/contract
refactor is neither a single-document plan nor a code diff. It fell into the gap
and got the wrong contract.

**Critically — the transport is not the blocker.** Codex demonstrably reads
files outside the diff when asked: on #268 round 16 it produced a finding whose
evidence came from `docs/CODEX_GITHUB_REVIEW_WORKFLOW.md:5-8` and
`docs/ai-context/documentation-workflow.md:166-174` — **neither file is in
#268's diff** (verified above). Round 15 flagged pre-existing untouched text in
`CLAUDE.md`. The connector's constraint is on *where a finding can be anchored*,
not on *what can be read*.

Empirically: rounds 1–10 used diff-shaped triggers and produced mostly
propagation findings inside changed regions. From round 11 I began asking for
whole-file reads; rounds 12–17 then produced deeper, structurally different
findings (two P1 logic contradictions, a pre-existing bug, a cross-file
terminology collision).

## Source-of-Truth Analysis

| Concept | Source of truth today | After this plan |
|---|---|---|
| Plan-review substance | `plan-review-contract.md` | unchanged |
| Code-review substance | `code-review.md` | unchanged (gains a prose-artifact rule) |
| Feature/bugfix mode definitions | `working-modes.md` | unchanged |
| Claude's loop mechanics (triggers, git, tiers) | `CLAUDE.md` | unchanged |
| **Round-count discipline / stopping rules** | **nowhere** | `code-review.md` + `plan-review-contract.md`, one owner each |

The stopping rule is currently split: `CLAUDE.md` has "break after ~2
non-converging rounds" (implementation PRs) and "~20-round check-in" (plan
review). Both are **loop-driver ceremony**, so they stay in `CLAUDE.md`; what
moves into the shared contracts is only the *reviewer-facing* whole-artifact
obligation. **No new source of truth is created** — each change edits the file
that already owns that concept.

Note the irony this plan must avoid: `known-failure-patterns.md` lists
*duplicate source of truth* as failure #1, and our own contract docs violate it
(the bugfix oracle fields are restated in 4 files). That is the C2 refactor,
deliberately deferred to its own PR.

## Proposed Design

Seven changes. C1/C5/C6 are the substantive ones; C3/C4 are discipline; C7 is a
one-line tier correction.

### C1 — Fresh-context self-review before requesting any review

Before triggering a reviewer on a plan, a contract change, or any PR touching
more than ~3 files of prose, dispatch a **subagent with no context of my edits**
to read the complete artifact set cold and report contradictions, stale
cross-references, and gaps. Fix those, *then* trigger the reviewer.

Why: this mechanically reproduces what the manual paste was doing — fresh eyes,
whole document, before a round is spent. On #268 it would have caught the
`decisions.md` staleness, the paired-doc conflict and the maintenance-skill
reference pre-PR.

**Owner:** `CLAUDE.md` (my ceremony).

### C2 — Normative rules live in exactly one file *(deferred to its own PR)*

Never restate a rule; link to it. Recorded here for completeness; **not
implemented by this plan.**

### C3 — Fix the concept, not the line

When a finding names a rule that appears anywhere else, the fix updates **every**
instance in the same commit. Grep the concept across the PR's file set before
pushing. Never push a fix that only addresses the flagged line.

**Owner:** `CLAUDE.md` (*Watching the PRs I open*).

### C4 — Verify before writing

Before drafting any fix to a rule: re-read (a) the canonical statement of that
rule and (b) any document the finding cites. Every #268 round where I did this
(6, 15, 17) was substantively clean; all four wrong fixes skipped it.

**Owner:** `CLAUDE.md`.

### C5 — Provenance-based circuit breaker

Classify each round's findings as **new ground** or **self-inflicted** (caused by
my prior fix, or its incompleteness).

- 2 consecutive rounds majority self-inflicted → stop patching; do one coherent
  rewrite of the artifact, or restructure it.
- 5 rounds without convergence → stop and bring David a decision.

Why this and not a round cap: the existing "break after ~2 non-converging
rounds" **never fired on #268**, because every round did produce real findings.
The rule cannot distinguish finding new ground from cleaning up its own mess.
Provenance closes that loophole, and it preserves the legitimate long plan review
(#252-style rounds are all new-ground).

**Owner:** `CLAUDE.md` for the driver's obligation; a one-line pointer in
`code-review.md`'s re-review section so a reviewer knows the loop has a breaker.

### C6 — Give `code-review.md` a prose-artifact rule

Add to *Re-reviews (round 2 onward)*, alongside the existing cumulative-diff
invariant:

> **For a change whose artifact is prose** (contracts, docs, skills, templates)
> **the diff is not the scope — read the complete current files.** In prose the
> defects live in text that did not change: the untouched paragraph that now
> contradicts the edited one. Nothing compiles to catch it. This mirrors
> `plan-review-contract.md`'s *Re-reviews* invariant 1.

And in `CLAUDE.md`, the trigger-comment rule: for a prose PR, every
`@codex review` names the files and asks for a whole-file read, from round 1 —
not from round 11 as happened on #268.

**Owner:** `code-review.md` (reviewer standard) + `CLAUDE.md` (trigger
mechanics).

### C7 — Tier carve-out

`CLAUDE.md` routes PR-watching to Sonnet as "ops-shaped." Revising a
cross-agent contract is not ops — it is the same judgment as authoring it. Carve
it out: a review loop revising contract/architecture/design prose stays on the
authoring tier.

**Owner:** `CLAUDE.md` (*Token / cost discipline*).

## Data Model and Migration Impact

**None.** Documentation and skill files only. No schema, no stored data, no
migration, no backfill.

## Runtime Behavior

No product runtime change. The behavioral change is to how a loop runs:

1. Work completes → **C1 fresh-context pre-check** → fix findings → open PR.
2. Trigger names the artifact type; prose PRs request whole-file reads (C6).
3. Each finding: **C4 verify** → **C3 fix every instance** → one commit.
4. After each round, classify findings by provenance (C5); breaker fires on 2
   consecutive self-inflicted rounds or 5 rounds total.

Edge cases: a PR mixing code and prose gets the prose rule (stricter wins). A
one-file docs typo does not trigger C1 (threshold is >3 prose files or any
plan/contract change).

## Admin/User UX Impact

None — no product surface. The visible change is to David: fewer rounds, and
when the breaker fires he gets a decision request instead of silent churn.

## Security, Permissions, and Validation

None. No routes, permissions, validation, or auditability touched. Public-repo
disclosure: this plan contains no vulnerability detail, secrets, customer data,
or embargoed material.

## Testing Plan

A process change cannot be unit-tested; it is verified by instrumented use.

- **`pnpm run check:docs`** must pass (the docs-accuracy gate CI also runs) —
  all links resolve, all cited repo paths exist.
- **Instrumented metric, per loop, going forward:** total rounds, and the
  **self-inflicted share** of findings. Targets: bugfix ≤2 rounds, code review
  ≤3, prose/contract ≤3 after the C1 pre-check, plan review ≤5 rounds of
  new-ground findings.
- **The general invariant, not the example:** the fix must hold for all three
  loops, not just the multi-file prose case that produced #268. Verify by
  checking each change lands in the contract that owns the loop it governs
  (table in *Source-of-Truth Analysis*).
- **Self-inflicted share is the real diagnostic.** If it exceeds ~25% on any
  loop, the process failed regardless of round count.
- **This plan's own review is the first datapoint** — it runs the plan-review
  loop it proposes to amend.

## Implementation Steps

1. `CLAUDE.md` — add C1 (pre-check), C3, C4, C5 (breaker) to *Watching the PRs I
   open*; add C6's trigger-comment rule; amend the tier table for C7.
2. `docs/engineering/code-review.md` — add C6's prose-artifact invariant to
   *Re-reviews*; one-line C5 pointer.
3. `docs/ai-context/plan-review-contract.md` — add the C1 pre-check
   expectation; confirm no change needed to *Re-reviews* invariant 1 (already
   correct).
4. Run `pnpm run check:docs`.
5. Open the implementation PR with the approved-plan oracle.

Ordered smallest-coherent-first: step 2 is the single highest-value change and
could ship alone if David wants it narrower.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **C1 adds a subagent dispatch to every prose PR** — cost, and it delays the first review. | Thresholded (>3 prose files, or any plan/contract change). On #268 it would have replaced ~5 rounds; net saving. |
| **C5's provenance classification is my own judgment** — I could rationalize a self-inflicted round as new ground. | The classification is recorded in the round's trigger comment, so it's visible to David and to Codex. Miscounting is auditable after the fact. |
| **Faster convergence could mean shallower review.** | Explicitly in *Must Not Change*; the self-inflicted-share metric distinguishes "fewer rounds because less churn" from "fewer rounds because less rigor." |
| **This plan adds prose to the very docs that are already over-long.** | Each change lands in the file that owns the concept; C2 (de-duplication) is queued to reduce net volume. |
| **The transport's permanent limitation is unfixed** — Codex cannot post a status label, verification report, or clean-round confirmation. | Accepted and already documented in both contracts. C1 partially compensates by producing a full assessment *before* the round. Not solvable; do not re-engineer. |

## Questions for David

1. **Approve C1–C7 as scoped**, with C2 deferred to its own PR?
2. **Are the round targets right** (bugfix ≤2, code review ≤3, prose ≤3, plan
   review ≤5 new-ground)? These are my proposal, not derived from your stated
   preference beyond "a handful, not 20."
3. **Should the C1 pre-check apply to code PRs too**, or prose only? My
   recommendation is prose only — for code, tests and CI already provide the
   independent check that prose lacks — but that is a judgment call about how
   much you want to spend per PR.

## Definition of Done

- [ ] C1, C3, C4, C5, C6-trigger, C7 land in `CLAUDE.md`; C6-invariant and the
      C5 pointer land in `code-review.md`; C1 expectation lands in
      `plan-review-contract.md`.
- [ ] Each change lives in exactly one owning file; no rule restated across
      files (verified by grep before the PR opens).
- [ ] `pnpm run check:docs` passes.
- [ ] The implementation PR carries the approved-plan oracle and converges in
      **≤3 rounds** — if it does not, the plan itself is disproven and we stop
      and reassess rather than grinding.
- [ ] David can point at each of his three questions above and see it answered
      in the merged docs.
