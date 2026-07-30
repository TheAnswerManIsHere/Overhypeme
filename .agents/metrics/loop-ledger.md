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
| 7 | [#282](https://github.com/TheAnswerManIsHere/Overhypeme/pull/282) | plan-review | 1 | 2317 | 0 | 9 | 86 | 24 | 24 | 38 | 0 | 0 | **72.1%** | 6.3 | — | none | ✓ **18.6%** (16/86, full population) | Closed unmerged. Densest loop in the ledger — 9.6 findings/round against #268's 2.2, on a 2317-line plan — and the **highest self-inflicted share yet recorded**. 38 of 86 are wrong-fix: an earlier fix in the same loop corrected one site and left others, or did not achieve what it claimed. Round 1 is entirely new ground (11/11); from round 2 on, new ground is a minority in every single round. **The adjudication passed the gate but only just, and the margin should be read as a real caveat rather than a pass:** 16 disagreements, and the adjudicator flagged that for several findings the digest gave no way to date the offending text, so provenance was decided by the ambiguous default rather than by evidence. Most disagreements (11 of 16) were boundary crossings between new ground and self-inflicted rather than prop-vs-wrong-fix reshuffles, which is why the two shares differ by more than row 3's did: author 72.1%, adjudicator 61.6%. The author's is the more self-critical figure and is the one recorded, per row 3's precedent. |
| 8 | [#283](https://github.com/TheAnswerManIsHere/Overhypeme/pull/283) | prose/contract | 3 | 116 | 3 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | **0%** | 0.0 | — | none | ✓ **0%** (1/1, full population) | Merged. A bugfix by intent, but the script cohorts it `prose/contract` because the diff carries `docs/engineering/deferred-work.md` and that cohort includes mixed — the same leakage as row 5; see the cohort note below. `review hrs` is a **measured** 0.0 (2m52s from open to review), not an unmeasured blank. The single finding: a code comment cited a `docs/plans/` path that only ever existed on a never-merged plan-review branch — a recurrence of the retired mistake in [`plan-doc-path-never-cite-from-code.md`](../memory/plan-doc-path-never-cite-from-code.md), caught by review rather than by the guard that memory note was supposed to be. |
| 9 | [#284](https://github.com/TheAnswerManIsHere/Overhypeme/pull/284) | bugfix | 5 | 18 | 71 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | **n/a — clean loop** | 5.1 | — | none | ✓ **0%** (1/1, full population) | Merged. **The ledger's first `bugfix`-cohort row**, and the first to exercise the "every finding invalid" branch. The sole finding argued the route deletion was an intentional behavior change requiring Tier C ceremony and a plan; the author rebutted with a repo-wide grep showing no caller of the removed soft-phase PII-scrub path, and David — shown that nuance explicitly — confirmed Tier A stands. Invalid subcase (b) with (a) support, so the denominator is zero: `n/a`, never `0%`. |
| 10 | [#285](https://github.com/TheAnswerManIsHere/Overhypeme/pull/285) | plan-review | 1 | 1128 | 0 | 5 | 36 | 18 | 6 | 12 | 0 | 0 | **50.0%** | 3.4 | — | none | ✓ **8.3%** (3/36, full population) | Closed unmerged (documentation-backfill plan, approved 2026-07-30 for execution on a normal branch). `pre-open preflight` is blank, not zero: this loop rode the session's pre-existing designated branch (decision 8 in the plan) rather than a freshly cut `plan-review/*` branch, so "branch cut → PR open" has no clean start point to measure from. `breakers fired: none` — 5 rounds, well inside the ~20-round soft cap, no non-convergence escalation. 3 of 36 adjudication disagreements, all on the new-ground/self-inflicted boundary or a same-side prop↔wrong-fix reclassification (R4-11); two of the three (R3-4, R4-4) cross that boundary in opposite directions and net to the same total, so the author's 50.0% self-inflicted share and the adjudicator's independently-computed share are identical despite the per-finding disagreements. **These are the figures of record.** This row and #286's (row 11) were derived independently and concurrently by two different sessions that both cut a new row 10 from the same 9-row base — the resulting merge conflict is why this note exists. The other session (PR #290) initially folded #285 in mechanical-only under row 6's size-vs-scope reasoning, which Codex correctly flagged as unjustified (#285 was never in #279's size class, and had no David-authorized deferral), then classified it independently: two cold passes, no shared context with this row, agreeing with each other at 0% disagreement, landing at **44.4%** (20 new / 5 prop / 11 wrong). That's the figure of an external, no-stake adjudicator; this row's 50.0% is the loop's actual author (this session, which wrote and ran the #285 plan-review loop, per its own internal author-vs-adjudicator check above) — per this file's own convention (rows 3, 4, 7), the author's classification is canonical when it is the more self-critical of the two, which it is here. The 5.6-point spread between two independently-produced classifications is not reconciled finding-by-finding here (that would mean redoing the work a third time); it's disclosed so a future full reconciliation has both readings on record rather than one silently overwriting the other. |
| 11 | [#286](https://github.com/TheAnswerManIsHere/Overhypeme/pull/286) | prose/contract | 7 | 773 | 34 | 1 | 3 | 3 | 0 | 0 | 0 | 0 | **0%** | 0.1 | — | none | ✓ **0%** (3/3, full population) | Merged. This ledger's own PR — a genuine test of "does the obligation survive being about itself," and it did not survive cleanly: this row is late, added only after `check-ledger-coverage.mjs` (the guard row 11 itself shipped) failed a *later* PR for row 11's own absence. See *Rounds undercounted when a re-review is clean* below for a real gap in `rounds`/`review hrs` this row's derivation surfaced. Mechanical columns (`files`/`+lines`/`-lines`/`rounds`) were independently derived a second time, concurrently, by the session that produced rows 12–13 below and the #280 exemption — both derivations agree exactly, which is the first cross-session confirmation this pipeline's mechanical half has had. |
| 12 | [#289](https://github.com/TheAnswerManIsHere/Overhypeme/pull/289) | prose/contract | 8 | 146 | 45 | 2 | 9 | 6 | 2 | 1 | 0 | 0 | **33.3%** | 1.0 | — | none | ✓ **0%** (9/9, full population) | Merged. Backfilled from a different session than the one that ran this loop (found while unblocking PR #292 on the loop-ledger coverage gate) — `rounds`/`findings` are script-derived from a fully-paginated, attested MCP snapshot, not recalled, and the causal classification below was corrected after Codex review on PR #292 pointed out that deferring it under row 6's exemption was unjustified: row 6's deferral was earned by genuine scale (166 findings, 32 rounds), and 9 findings is not that. Round 1 (6 findings, all new ground): roadmap/README status conflict, missing next-chapter nav, a dead exclusion pointer, an undercounted ingestion-entrance claim, un-normalized citations, a missing meme-hearts row. Round 2 (3 findings, against round 1's own fix `1d94279`): two are propagation — a new "Health and route-stats endpoints" subsection round 1 added to close finding 3 contained its own factual errors (a false "indexed" claim, a conflated validation-behavior claim); one is wrong-fix — round 1 corrected the roadmap file's status but left an identical stale claim in README's charter section untouched. Blind adjudication (independent agent, full GitHub access, no visibility into this classification) agreed exactly: same 6/2/1 split, same 33.3%, 0% disagreement. `breakers fired: none` — 2 rounds, nowhere near either break threshold. |
| 13 | [#288](https://github.com/TheAnswerManIsHere/Overhypeme/pull/288) | prose/contract | 21 | 2749 | 15 | 5 | 20 | — | — | — | — | — | *not classified* | 1.6 | — | none | ✗ **not run** | Merged. **Mechanical columns only**, same deferral reason as row 12 — Phase 1 of async-queue hardening, backfilled by a later session. `cohort` is the script's own first-match output (two `PR288_*` docs land it in `prose/contract` despite being a majority-code feature PR — the same leakage rows 5/8 already documented). Per the PR's own round-by-round narration, all 20 findings Resolved: round 1 was 2 CodeQL `js/missing-rate-limiting` alerts (fixed, then confirmed false-positive on re-fire — `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md`) plus round-1 Codex findings; a genuine architecture question mid-loop (queueHealth.ts:274, whether to touch the finalize path) was escalated to David rather than decided unilaterally, per the PR body's *Amendment to Must Not Change*. **`rounds`/`review hrs` are undercounted, confirmed** — see *Rounds undercounted when a re-review is clean* above: two clean plain-comment re-reviews (2026-07-30T02:05:58Z, 2026-07-30T03:32:17Z) are invisible to `countRounds`/`reviewInterval`; the true reviewer-engagement count is 7, not 5, and `review hrs` runs to 1.8, not 1.6. Left as the mechanical figures the script actually produced rather than hand-patched, per this section's own point that a re-derivation is a real task, not a footnote edit — but not silently trusted either. |
| 14 | [#280](https://github.com/TheAnswerManIsHere/Overhypeme/pull/280) | plan-review | 2 | 3574 | 0 | 18 | 180 | — | — | — | — | — | *not classified* | 34.7 | — | none | ✗ **not run** | Closed unmerged (`[PLAN REVIEW]` NCMEC CyberTipline submission). Codex review on PR #292 correctly rejected an earlier version of this backfill that placed #280 in *Deliberately not measured* — that table is for genuine decisions not to measure a loop, and a tool-output limit hit mid-attempt is a punt, not a decision; a mechanical row (even causally deferred, like row 6) is the honest disposition and is what the coverage guard should actually track as owed-then-satisfied. `files`/`+lines`/`-lines` are clean (`get_files` returns only 2 files — the plan and a handoff doc — once isolated from a crowded parallel batch, where it had overflowed before). `rounds` is a full count, not an estimate: `get_reviews` fully paginates in 3 requests (100+100+0), 18 distinct `chatgpt-codex-connector[bot]` review events. `findings` uses `get_review_comments`'s server-reported `totalCount` (180) directly rather than a script run over a fully assembled snapshot — a threads-processing step this size wasn't attempted, so this figure is one level less independently verified than a `loop-metrics.mjs`-derived one, though it comes from the same API the script itself would page through. **180, not the PR's own self-reported 158** — the PR body's per-round findings table and its linked handoff doc's running total disagree with each other by 15 findings, and neither matches the actual count; recorded as a data point for the "never recalled by hand" principle this whole file exists to enforce, not a criticism of that PR's own bookkeeping. By a wide margin the largest loop this ledger has seen — 180 findings against the prior worst case of 166 (#279) — so *not classified* here is earned by the same scale reasoning row 6 documents, not borrowed from it without justification the way rows 12–13 originally were. |

### Rounds undercounted when a re-review is clean

**`rounds` and `review hrs` are understated for row 11 (#286), and the mechanism is now understood well enough to name.** After the round-1 fix (`6b04de2`), an explicit `@codex review` trigger drew a genuine second review from Codex against the fix commit — confirmed by its own "Reviewed commit: `6b04de28e6`" line — that found nothing further. That clean result posted as a **plain issue comment** ("Codex Review: Didn't find any major issues. Delightful!"), not as a formal `pull_request_review` submission. `countRounds` and `reviewInterval` only scan the `reviews` collection, so this real reviewer engagement is invisible to both: `rounds` reports 1 where the true reviewer-engagement count is 2, and `review hrs` reports 0.1 (PR-open → the round-1 review) where the true interval runs to the round-2 comment, roughly 2.8 hours.

This is a **different** gap than the trigger-counting pitfall `countRounds`'s own docstring already documents and rejects (counting `@codex review` comments instead of formal reviews would miss the automatic on-open review — which is exactly why `countRounds` counts formal review records instead, not a live bias in the approach it actually takes). This is new, and lives in the approach `countRounds` *does* take: a re-review that finds **zero** new findings appears to route through the plain-comment reply path rather than the formal review-submission path on this repo's Codex transport — at least in this one observed instance. Not yet promoted to a documented, repo-wide bias in `loop-metrics.mjs`'s own comments (one observation is a data point, not a confirmed pattern, and no prior row is known to be short a round from it) — flagged here so the next clean-re-review loop is checked for the same gap rather than trusted at face value, and promoted properly once it recurs.

`findings` and the causal classification are unaffected: `countFindings` reads root comments directly and a review with zero findings contributes zero root comments either way.

**Row 13 (#288) has the identical gap, confirmed — a second occurrence, not a hypothetical one.** Checked directly against the PR's plain-comment history: a clean "Codex Review: Didn't find any major issues" landed at `2026-07-30T02:05:58Z` (reviewing `5800debd7d`, between what this row counted as round 1 and round 2) and a second at `2026-07-30T03:32:17Z` (reviewing `62d9e8ab5f`, after the last formal review this row's snapshot captured). Row 13's `rounds: 5` and `review hrs: 1.6` both undercount the true reviewer engagement — by at least one round each, and the true `review hrs` extends past `03:20:10Z` to `03:32:17Z`. Not re-derived here (that means rebuilding the row's snapshot with plain comments folded in, a task in its own right, not a footnote); recorded so this counts as the second instance the paragraph above says would justify promoting the gap to a documented, repo-wide bias in `loop-metrics.mjs` rather than leaving it a one-off observation.

### Row 6 (#279): judgment half deferred by decision

**Row 6 carries mechanical columns and no causal classification.** This is a
*deliberate, dated* deferral, recorded here rather than left as five
em-dashes for a reader to interpret.

The 2026-07-29 backfill was scoped on an estimate that the plan-review loops
were comparable in size to what the ledger already held. They were not: #279
alone produced 166 findings and #282 produced 86, against a prior worst case
of 40. Presented with that, David scoped the classification work to #282 —
the more representative loop, converged normally at 9 rounds — and left #279
mechanical. The reasoning was that #279's 32 rounds of interdependent fixes
make it both the most expensive loop to classify and the one most likely to
exceed the 20% disagreement gate and yield `unmeasured` anyway. #282's
adjudication then landed at 18.6%, just inside the gate, which supports that
call: the harder loop would very likely have fallen outside it.

**`not classified` is distinct from both of the file's other absence
values.** It is not `unmeasured` — that is reserved for a loop whose blind
adjudication disagreed beyond 20%, and using it here would corrupt the one
signal it carries. It is not `n/a — clean loop` — #279 has 166 findings,
which is the opposite of nothing to measure. Row 6 is excluded from the
self-inflicted-share trend and must not be read as either a pass or a
failure. Its **mechanical** columns are fully derived and sound on their own.

### What the ledger's adjudicated rows now show

**Seven rows carry a real adjudicated self-inflicted-share percentage** —
every adjudicated row except #284, which is adjudicated but has none to
report (its one finding is `invalid`, so the denominator is zero; see its own
row note). Naming all seven, not a subset, matters: #270 64.7%, #274 68.4%,
#276 0%, #282 72.1%, #283 0%, #285 50.0%, #286 0%.

**The three 0% rows are not evidence the workflow is clean — they are a
structural floor, not a measurement.** The precise criterion is **rounds that
surfaced findings**, not raw round count — that distinction matters
specifically for #286, whose true engagement was two rounds (see *Rounds
undercounted when a re-review is clean* above) but whose second round found
**nothing**. #276 and #283 each had exactly one round, full stop. All three
had exactly one round that raised any finding at all, and none of the three
self-inflicted categories can occur on a loop's first finding-bearing round —
for two distinct reasons, not one shared one. **Propagation and wrong fix**
require an **earlier fix within the same loop** that the later finding
responds to; a loop with only one finding-bearing round has no earlier fix to
respond to. **Re-raised** requires something different: an **earlier
finding** to restate (with no fix attempted in between — a fix attempt
between the original and the restatement makes it wrong fix instead, always,
per the rubric's own precedence). A loop with only one finding-bearing round
has no earlier finding either, for the same reason it has no earlier fix —
round 1 is the first round, full stop — but that is a second, independent
gap, not a consequence of the first. Both gaps happen to coincide in a
one-finding-round loop, which is why all three categories are unreachable
there, but they are unreachable for different reasons and the ledger should
say so rather than imply propagation/wrong-fix/re-raised share one
precondition when only two of them do. **Every valid finding** on a
one-finding-round loop is new ground by construction, every time — "valid"
matters here: `invalid` remains possible on a first occurrence regardless of
round count, and row 9 (#284) is exactly that case, which is why it's
recorded as `n/a` rather than folded into this 0% group at all. For the three
loops that do have a real 0% (#276, #283, #286), that share is independent of
the loop's real quality. Mixing these into a trend with multi-finding-round
loops would understate the real number, exactly the failure mode this
backfill exists to prevent in the other direction.

**The self-inflicted-share trend is only informative for loops with more
than one finding-bearing round** — where propagation and wrong-fix are
structurally possible — which is #270 (16 rounds, 15 finding-bearing — row 3
notes one review event with zero findings), #274 (4 rounds, findings in
every one), #282 (9 rounds, findings in every one), and #285 (5 rounds,
findings in every one). #286 does not qualify
despite its true two-round engagement, because only round 1 produced
findings.

**Of these four, three are confirmed pre-boundary and one is confirmed
post-boundary — they are not one population, and averaging them into a
single four-point trend was the error to correct here, not the direction of
any single point.** David enabled Codex "Exhaustive code review" shortly
after 6:56 PM on 2026-07-29 (the ChatGPT settings screenshot he sent is
timestamped then, and he confirmed the change in the same breath). #270,
#274, and #282 all ran their review rounds before that time and are
confirmed pre-boundary. **#285 is confirmed post-boundary, not merely
later-dated or unverified** — its entire review window (2026-07-29T22:39 to
2026-07-30T02:09) falls after 6:56 PM that same day, so it was reviewed under
the new setting throughout. An earlier draft of this section hedged this as
"unverified" and required an exact toggle timestamp that the settled decision
never asked for; that hedge was itself the error, per Codex review on
PR #290.

**The pre-boundary trend (n=3) stands as originally measured: 64.7% → 68.4%
→ 72.1%, not falling.** #285 is a separate, single post-boundary data point
at 50.0% — lower than every pre-boundary loop's share, which is suggestive of
exhaustive review's intended effect (fewer self-inflicted findings once a
round looks harder before stopping) but is one loop, run by a different
session, and nowhere near enough to claim the effect. It is recorded as this
ledger's **first post-boundary multi-round data point**, to be confirmed or
killed by the rows that follow it — not folded into the pre-boundary trend,
and not treated as an early confirmation of anything.

**Two structural observations from the pre-boundary loops, both from counted
data rather than impression:**

- **Round 1 is where new ground lives.** In #282, round 1 was 11/11 new
  ground; in #274, 5/5. #285 — post-boundary, so not part of this trend's
  population, but worth noting as a separate replication — shows the same
  shape (7/7 new ground in round 1), suggesting this pattern isn't an
  artifact of the pre-boundary reviewer specifically.
- **Wrong fix dominates propagation in three of the four loops, not all
  four.** #274 (7 wrong-fix vs 6 propagation), #282 (38 vs 24), and #285 (12
  vs 6) all show it. **#270 does not** — row 3's own figures are 18
  propagation against 4 wrong-fix, the reverse. That is not a contradiction
  to gloss over: row 3 already explains it — #270 was this ledger's own
  bootstrapping loop, and its propagation findings concentrate in subsystems
  built *mid-loop* (the MCP adapter, the adjudication rubric itself),
  defects in genuinely new code rather than "fixed one site, left another."
  That is a different failure shape than #274/#282/#285's plan-editing
  loops, where propagation and wrong-fix both apply to a single, mostly
  fixed document. The dominance pattern holds for loops of that shape; #270
  isn't one of them.

This is a hypothesis at n=3 pre-boundary (not falling) plus n=1 post-boundary
(lower, unconfirmed), not a finding. It is recorded here so the next rows —
on either side of the boundary — can confirm or kill it rather than
re-deriving it.

### The cohort rule leaks bugfix loops into prose/contract

Three of this file's rows (#276, #283 — and #284 only narrowly escaping)
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
cohort that already had measured rows (#268, #270, #276) when the 2026-07-29
backfill was scoped. Backfilling them would have re-confirmed a cohort we can
already characterise while the two cohorts that could not be characterised at
all stayed empty. That is a defensible trade, but it is a trade: the
prose/contract sample stays smaller than it could be, and no claim about
prose-loop trend should be made as though these five were measured and clean.

**#280 is not in this table.** An earlier version of this backfill placed it
here with a "deferred to a dedicated pass" reason — Codex review on PR #292
correctly rejected that: this table is for a genuine decision not to measure
a loop, and a session hitting a tool-output limit mid-attempt is a punt, not
a decision. #280 has a real row instead (row 14 above), mechanical-only,
causal classification deferred the same way row 6 defers #279's — earned by
scale (180 findings, the largest on record) rather than borrowed without it.

**Dependabot PRs are excluded by policy, not by entry** — they carry no plan,
fix tier, or review loop, and requiring a hand-written exemption for each
weekly bump would train this table to be noise. The guard reports how many it
skipped on every run so the exclusion is never silent. #271 is the only such
PR in the enforced range so far.
