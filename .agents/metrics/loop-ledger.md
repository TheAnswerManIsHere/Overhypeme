# Loop ledger

Every review loop this repository runs, one row each, permanently.

**Why this exists.** Until 2026-07-27 nothing here recorded a single review
round, so every claim about whether our workflow was working — including the
claim that it was getting worse — was unfalsifiable. Two attempts to
characterise our own history by recollection produced numbers that were later
withdrawn as wrong. This file exists so that the next such claim can be
checked.

**Who appends.** Both Claude Code and Codex, at every loop close. The normative
obligation is in
[`docs/ai-context/working-modes.md`](../../docs/ai-context/working-modes.md#the-loop-ledger)
— shared, because both agents run feature and bugfix loops independently and a
ledger missing one agent's work would look complete while being wrong.

---

## The two halves of a row, and why they are separated

**Mechanical columns are produced by `scripts/loop-metrics.mjs` and are never
typed by hand.** Run `node scripts/loop-metrics.mjs --pr <number>`.

**Judgment columns are typed by hand and are marked as such**, because no
script can infer them. Keeping the halves visually distinct is the point: a
number that looks derived but was recalled is worse than an obvious estimate,
since it borrows credibility it has not earned.

| Column | Half | Definition |
|---|---|---|
| `pr`, `cohort`, `files`, `+lines`, `-lines` | mechanical | Cohort is first-match top-down: `plan-review` → `prose/contract` (incl. mixed) → `bugfix` → `feature/code`, keyed primarily on the bugfix PR body's required `**Fix tier:**` field, not title wording. **Both `+lines` and `-lines` are kept** — `artifactSize()` derives both because neither alone is size, and a table that drops `-lines` on paste would make a large deletion-heavy change look trivial. |
| `rounds` | mechanical | **Completed reviewer review events** — not `@codex review` comments. The connector auto-reviews non-draft PRs on open, so counting triggers undercounts implementation PRs by one and draft plan-review PRs by zero: a bias present in one cohort and absent in the other. |
| `findings` | mechanical | **Reviewer-authored root comments**, one per thread. Author replies are excluded — our workflow mandates a reply per thread, which roughly doubles a raw comment count. |
| `review hrs` | mechanical | PR open → final reviewer event. **One interval, never a sum.** Preflight time occurring after the PR opens is already inside it. |
| `new / prop / wrong / re-raised / invalid` | **judgment** | Cause per finding, per `working-modes.md`'s rubric; the five counts must sum exactly to `findings`. Ambiguous *causes* default to self-inflicted, biasing the metric *against* the workflow so drift cannot quietly flatter it — but `invalid` (a first-occurrence finding refuted with repository evidence, **or settled by an explicit product/scope decision from David**) requires proof or an explicit decision, not doubt, and is excluded from both sides of the share so neither false positives nor David-overruled findings distort it. |
| `pre-open preflight` | **judgment** | Minutes of preflight *before* the PR existed — the only preflight cost outside `review hrs`. Add this to `review hrs` for total; never add post-open passes. |
| `breakers fired` | **judgment** | Which of this repo's break-the-loop rules fired during the loop (e.g. the ~2-round non-converging-fix break, the plan-review ~20-round soft cap), or `none`. Required at loop close per `working-modes.md` step 2; recorded here because a required field with nowhere to persist it gets silently dropped or improvised into `notes`. |
| `adjudicated` | **judgment** | **Every finding** re-classified blind by a fresh-context reader — an agent, so full coverage costs tokens rather than anyone's time, and there is no sampling machinery left to bias the result (see `working-modes.md`'s *Why the full population, not a sample*; the earlier 30% design produced two confirmed selection-bias defects before being removed). At `findings = 0` there is nothing to adjudicate — record `n/a — clean loop`, per the note below. `>20%` disagreement ⇒ that loop's causal figure is **`unmeasured`** and is excluded from the trend, not counted as good news. |

**`re-raised` is a judgment column on purpose.** A re-raised prior finding is
not newly surfaced ground, but "Reconciliation" has no machine-readable
marker — `plan-review-contract.md` names it only in prose and
`code-review.md` does not define the category at all. Excluding it by regex
would be a guess wearing the costume of a measurement, so the script counts
these and a human separates them.

**The primary metric is the self-inflicted *finding* share** —
`(prop + wrong) / (findings − invalid)` — trending toward zero. Invalid
findings sit outside both sides of the fraction: a reviewer's false positives
are not the workflow's fault (numerator) and are not real defects to measure
against (denominator). **A loop with no valid findings has no share to
compute** (zero findings, or every finding invalid — either way the
denominator is zero): record it as `n/a — clean loop`, never `0%` — `0%`
reads as a *measured* perfect score, which a loop with nothing to measure has
not earned. The row still counts toward the ledger's round/PR coverage; it is
simply excluded from the self-inflicted-share trend line, the same way an
`unmeasured` adjudication result is. **Round count is recorded, never
targeted.** A long loop that is nearly all new ground is the loop working; a
short loop with a high self-inflicted share is worse than a long clean one,
and a round target would score both backwards.

---

## Rows

| # | pr | cohort | files | +lines | -lines | rounds | findings | new | prop | wrong | re-raised | invalid | self-infl. | review hrs | pre-open preflight | breakers fired | adjudicated | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | [#268](https://github.com/TheAnswerManIsHere/Overhypeme/pull/268) | prose/contract | 8 | 744 | 214 | 18 | 40 | 16 | 19 | 5 | 0 | — | **60%** | — | none | — | ✗ **unadjudicated** | Baseline. Bugfix-mode rework. |
| 2 | [#269](https://github.com/TheAnswerManIsHere/Overhypeme/pull/269) | plan-review | 1 | 1111 | 0 | 7 | 40 | 28 | 6 | 5 | 1 | — | **27.5%** | — | none | — | ✗ **unadjudicated** | Closed unmerged. Artifact grew 315→1111 lines (corrected from an earlier 1092 — that was a mid-review `wc -l`, not the file's state at its actual final commit `57ae1148`). `-lines` is genuinely 0: the file was new to `main`, so the base→head diff cannot show a removal of pre-existing content, even though the loop itself rewrote large sections in place across its revisions. |
| 3 | [#270](https://github.com/TheAnswerManIsHere/Overhypeme/pull/270) | prose/contract | 6 | 1959 | 0 | 16 | 34 | 12 | 18 | 4 | 0 | 0 | **64.7%** | 2.2 | none | none | ✓ **14.7%** (5/34, full population) | First row produced by the mechanism (script over a fully-paginated, attested MCP snapshot), not recalled — the acceptance test for the whole pipeline. `rounds` is 16, not 15: it includes one review event with zero findings that the author's own round-by-round narration missed, exactly the recall-vs-count gap this file exists to close. High propagation share is dominated by defects in subsystems *added mid-loop* (the MCP adapter, the adjudication rubric itself) — the causal test charges those to propagation by design, not because fixes broke pre-existing code. 4 of 5 adjudication disagreements were prop-vs-wrong-fix (both self-inflicted, no effect on the share); the one boundary-crossing disagreement (author: propagation, adjudicator: new ground) makes the author's 64.7% the more self-critical of the two figures (adjudicator's independent share: 61.8%). |
| 4 | [#274](https://github.com/TheAnswerManIsHere/Overhypeme/pull/274) | plan-review | 1 | 817 | 0 | 4 | 19 | 6 | 6 | 7 | 0 | 0 | **68.4%** | 3.0 | — | none | ✓ **5.3%** (1/19, full population) | Backfilled 2026-07-29; this is the row the file previously recorded as owed. Closed unmerged when David cut the scope to §1.1 (row 5) and re-planned the rest — so this loop **did not converge**, it was stopped at round 4 by a product decision, and its numbers describe an interrupted loop rather than a finished one. Highest self-inflicted share in the ledger, and the cause is legible rather than mysterious: seven of nineteen findings are Still-Open Reconciliations (a fix that didn't take, not new ground), and the author's own round-3 restructuring into phases accounts for three more by their own account. The one adjudication disagreement was 274-13 — author: propagation (the plan introduced JPY two rounds earlier and never followed it to display), adjudicator: new ground (the divide-by-100 formatters pre-exist in `Pricing.tsx`, so the fix exposed the defect rather than creating it). The author's 68.4% is the more self-critical of the two and is the figure recorded, per row 3's precedent; the adjudicator's independent share is 63.2%. |
| 5 | [#276](https://github.com/TheAnswerManIsHere/Overhypeme/pull/276) | prose/contract | 6 | 683 | 35 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | **0%** | 0.1 | ~6 | none | ✓ **0%** (1/1, full population) | Merged. §1.1 of the plan reviewed on #274, shipped alone after David cut the rest. Cohort is the script's own first-match output — the diff is majority code but carries two `PR276_*` docs, and `prose/contract` includes mixed. The single finding was against the original diff on the auto-review round, so no in-loop fix could have caused it: an empty Stripe catalog completes a sync with every `last_synced_at` still NULL (the pinned library writes that column only in `updateSyncCursor`), and the new module read a missing stamp as "never synced". `pre-open preflight` is wall-clock branch-cut→PR-open, not an estimate of effort. |

| 6 | [#279](https://github.com/TheAnswerManIsHere/Overhypeme/pull/279) | plan-review | 2 | 2711 | 1 | 32 | 166 | — | — | — | — | — | *not classified* | 23.7 | — | — | ✗ **not run** | Closed unmerged. **Mechanical columns only** — see *Rows whose judgment half is deferred* below. By far the largest loop this ledger has seen: 166 findings is over 4× #268's 40, and its 32 rounds exceed the ~20-round soft cap in `CLAUDE.md`, which is supposed to trigger a pause-and-check-in with David rather than a silent continuation. Whether that check-in happened is **not visible in the PR record**, so this row does not assert either way. |
| 7 | [#282](https://github.com/TheAnswerManIsHere/Overhypeme/pull/282) | plan-review | 1 | 2317 | 0 | 9 | 86 | — | — | — | — | — | *not classified* | 6.3 | — | — | ✗ **not run** | Closed unmerged. **Mechanical columns only** — see below. 86 findings across 9 rounds is the densest per-round rate in the ledger (9.6/round against #268's 2.2), on a 2317-line plan artifact. |
| 8 | [#283](https://github.com/TheAnswerManIsHere/Overhypeme/pull/283) | prose/contract | 3 | 116 | 3 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | **0%** | 0.0 | — | none | ✓ **0%** (1/1, full population) | Merged. A bugfix by intent, but the script cohorts it `prose/contract` because the diff carries `docs/engineering/deferred-work.md` and that cohort includes mixed — the same leakage as row 5; see the cohort note below. `review hrs` is a **measured** 0.0 (2m52s from open to review), not an unmeasured blank. The single finding: a code comment cited a `docs/plans/` path that only ever existed on a never-merged plan-review branch — a recurrence of the retired mistake in [`plan-doc-path-never-cite-from-code.md`](../memory/plan-doc-path-never-cite-from-code.md), caught by review rather than by the guard that memory note was supposed to be. |
| 9 | [#284](https://github.com/TheAnswerManIsHere/Overhypeme/pull/284) | bugfix | 5 | 18 | 71 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | **n/a — clean loop** | 5.1 | — | none | ✓ **0%** (1/1, full population) | Merged. **The ledger's first `bugfix`-cohort row**, and the first to exercise the "every finding invalid" branch. The sole finding argued the route deletion was an intentional behavior change requiring Tier C ceremony and a plan; the author rebutted with a repo-wide grep showing no caller of the removed soft-phase PII-scrub path, and David — shown that nuance explicitly — confirmed Tier A stands. Invalid subcase (b) with (a) support, so the denominator is zero: `n/a`, never `0%`. |

### Rows whose judgment half is deferred

**Rows 6 (#279) and 7 (#282) carry mechanical columns and no causal
classification.** This is a *deliberate, dated* deferral, recorded here rather
than left as five em-dashes for a reader to interpret.

The 2026-07-29 backfill was scoped on an estimate that the plan-review loops
were comparable in size to what the ledger already held. They were not: #279
alone produced 166 findings and #282 produced 86, against a prior worst case
of 40. Full-population blind adjudication of 252 additional findings is a
materially larger job than the backfill David authorised, and the choice of
whether to spend it is his, not something to absorb silently.

**These are `not classified`, which is distinct from both of the file's other
absence values.** It is not `unmeasured` — that is reserved for a loop whose
blind adjudication disagreed beyond 20%, and using it here would corrupt the
one signal it carries. It is not `n/a — clean loop` — these loops have 252
findings between them, which is the opposite of nothing to measure. They are
excluded from the self-inflicted-share trend and must not be read as either a
pass or a failure. Their **mechanical** columns are fully derived and are
sound on their own.

### The cohort rule leaks bugfix loops into prose/contract

Three of this file's nine rows (#276, #283 — and #284 only narrowly escaping)
are bugfix-mode loops by intent. Two of them are cohorted `prose/contract`,
because `classifyCohort` checks for any `.md` file **before** it checks the
PR body's `**Fix tier:**` field, and a bugfix PR routinely carries a doc — a
UAT, a deferred-work entry. The rule is doing exactly what it was written to
do (mixed diffs land in the cohort with the stricter obligations), and that
was the right call when the question was "where is the measured risk."

It is the wrong call for the question David actually asked on 2026-07-29 —
*how effective is bugfix review?* — because it drains the bugfix cohort into
prose/contract and leaves the ledger unable to answer. Recorded, not fixed:
changing cohort assignment retroactively re-labels existing rows, which is a
decision about the metric itself and belongs to David rather than to a
backfill pass.

### Row provenance — read before using these numbers

Both rows are **retrospective and were entered by hand**, because the script
did not exist while these loops ran. They are the baseline the ledger measures
against, not output of the mechanism it describes.

- **#268's** rounds and findings are corroborated: counted independently from
  the squash-merge commit history by both Claude and Codex, who agreed on 18
  and 40. The causal split is Claude's classification, and an earlier estimate
  of it (35/40/25) was **wrong and withdrawn** — the figures here are the
  per-finding recount.
- **#269's** columns were tracked live in the PR body's findings ledger as the
  loop ran. The causal split is Claude's own classification of Claude's own
  errors, which is exactly the conflict the adjudication column exists to
  check.
- **Neither row is adjudicated.** The 27.5% and 60% figures should be read as
  the author's account, not as measurements, until a blind re-classification
  runs. **#268 is the designated acceptance replay**: if blind adjudication of
  its 40 findings disagrees beyond 20%, the causal metric is not yet
  trustworthy and must be reported as such rather than reported at all.
- **`review hrs` is absent** for both: it needs API timestamps the script now
  derives but that were never captured for these loops. Blank means *not
  measured*, never *zero*.
- **`breakers fired` is absent** for both, for the same reason: the column
  didn't exist while these loops ran, so whether either one tripped a
  break-the-loop rule was never recorded at the time. Blank means *not
  measured*, never *none*.
- **`invalid` is absent** for both, likewise: the category didn't exist when
  these rows were classified, so any refuted-with-evidence findings are
  buried inside the four causal counts rather than separated out. Their
  `self-infl.` figures therefore use the old `(prop + wrong) / findings`
  denominator; the blind adjudication pass (which classifies against the
  current five-category rubric) is what will produce the corrected split.

**Row 3 is that first row.** PR #270 (this ledger's own implementation PR)
closed, its row was computed by the mechanism end to end — MCP snapshot →
`loop-metrics.mjs` → blind adjudication — and folded into the `/document`
PR that followed, per `working-modes.md`'s *"a row is never its own
dedicated PR"* rather than as a dedicated ledger-only PR (which would need
its own review, whose own close would owe another row, forever).

**#268 remains the designated acceptance replay** for the *retrospective*
rows: if blind adjudication of its 40 findings disagrees with the
hand-entered classification above beyond 20%, that causal figure gets
recorded as `unmeasured`, not silently trusted. Row 3's own adjudication
(14.7% disagreement, well under the gate) is a first proof the pipeline
works — it is not a substitute for running the replay on rows 1 and 2,
whose classifications predate the current five-category rubric.

---

## Deliberately not measured

Loops that closed without a row **by decision**, not by omission. An entry here
is a recorded choice not to measure a loop; it is **never** a pass, and these
PRs are excluded from every count and trend in this file exactly the way an
absent row is. The distinction the table preserves is *why* the row is missing
— a decision leaves a reason, a lapse leaves nothing — which is the whole
difference between a gap you can reason about and the silent kind that let
coverage fall to 2 rows in 13 loops before anyone noticed.

`scripts/check-ledger-coverage.mjs` reads this table: a closed loop needs
either a row above or an entry here, or CI fails.

| pr | cohort | reason |
|---|---|---|
| [#272](https://github.com/TheAnswerManIsHere/Overhypeme/pull/272) | prose/contract | Docs-only `/document` harvest. Scoped out of the 2026-07-29 backfill, which David limited to the two cohorts with zero coverage (bugfix, plan-review). |
| [#273](https://github.com/TheAnswerManIsHere/Overhypeme/pull/273) | prose/contract | Docs-only `/document` harvest. Same scoping decision as #272. |
| [#275](https://github.com/TheAnswerManIsHere/Overhypeme/pull/275) | prose/contract | Docs-only `CLAUDE.md` change. Same scoping decision as #272. |
| [#277](https://github.com/TheAnswerManIsHere/Overhypeme/pull/277) | prose/contract | Docs-only audit brief. Same scoping decision as #272. |
| [#278](https://github.com/TheAnswerManIsHere/Overhypeme/pull/278) | prose/contract | Docs-only audit findings. Same scoping decision as #272. |

**Why these five and not others.** All five are prose/contract loops, the one
cohort that already had measured rows (#268, #270, #276) when the backfill was
scoped. Backfilling them would have re-confirmed a cohort we can already
characterise while the two cohorts that could not be characterised at all
stayed empty. That is a defensible trade, but it is a trade: the
prose/contract sample stays smaller than it could be, and no claim about
prose-loop trend should be made as though these five were measured and clean.

**Dependabot PRs are excluded by policy, not by entry** — they carry no plan,
fix tier, or review loop, and requiring a hand-written exemption for each
weekly bump would train this table to be noise. The guard reports how many it
skipped on every run so the exclusion is never silent. #271 is the only such
PR in the enforced range so far.
