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
| 6 | [#279](https://github.com/TheAnswerManIsHere/Overhypeme/pull/279) | plan-review | 2 | 2711 | 1 | 32 | 166 | — | — | — | — | — | *not classified* | 23.7 | — | — | ✗ **not run** | Closed unmerged. **Mechanical columns only** — see *Rows whose judgment half is deferred* below. The largest loop this ledger has a script-derived `findings` count for: 166 is over 4× #268's 40, and its 32 rounds exceed the ~20-round soft cap in `CLAUDE.md`, which is supposed to trigger a pause-and-check-in with David rather than a silent continuation — whether that check-in happened is **not visible in the PR record**, so this row does not assert either way. (Row 14/#280 has fewer rounds — 18 — but a larger raw review-thread count — 180, against this row's 166 script-derived `findings`; its `findings` is deliberately left unmeasured rather than run through the same derivation this row got, so no ranking claim is made between the two on findings specifically — see row 14's note.) |
| 7 | [#282](https://github.com/TheAnswerManIsHere/Overhypeme/pull/282) | plan-review | 1 | 2317 | 0 | 9 | 86 | 24 | 24 | 38 | 0 | 0 | **72.1%** | 6.3 | — | none | ✓ **18.6%** (16/86, full population) | Closed unmerged. Densest loop with a measured `findings/round` in the ledger — 9.6 against #268's 2.2, on a 2317-line plan (row 14/#280 is excluded from this ranking; its `findings` is unmeasured, so no density figure exists for it to compare) — and the **highest self-inflicted share yet recorded**. 38 of 86 are wrong-fix: an earlier fix in the same loop corrected one site and left others, or did not achieve what it claimed. Round 1 is entirely new ground (11/11); from round 2 on, new ground is a minority in every single round. **The adjudication passed the gate but only just, and the margin should be read as a real caveat rather than a pass:** 16 disagreements, and the adjudicator flagged that for several findings the digest gave no way to date the offending text, so provenance was decided by the ambiguous default rather than by evidence. Most disagreements (11 of 16) were boundary crossings between new ground and self-inflicted rather than prop-vs-wrong-fix reshuffles, which is why the two shares differ by more than row 3's did: author 72.1%, adjudicator 61.6%. The author's is the more self-critical figure and is the one recorded, per row 3's precedent. |
| 8 | [#283](https://github.com/TheAnswerManIsHere/Overhypeme/pull/283) | prose/contract | 3 | 116 | 3 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | **0%** | 0.0 | — | none | ✓ **0%** (1/1, full population) | Merged. A bugfix by intent, but the script cohorts it `prose/contract` because the diff carries `docs/engineering/deferred-work.md` and that cohort includes mixed — the same leakage as row 5; see the cohort note below. `review hrs` is a **measured** 0.0 (2m52s from open to review), not an unmeasured blank. The single finding: a code comment cited a `docs/plans/` path that only ever existed on a never-merged plan-review branch — a recurrence of the retired mistake in [`plan-doc-path-never-cite-from-code.md`](../memory/plan-doc-path-never-cite-from-code.md), caught by review rather than by the guard that memory note was supposed to be. |
| 9 | [#284](https://github.com/TheAnswerManIsHere/Overhypeme/pull/284) | bugfix | 5 | 18 | 71 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | **n/a — clean loop** | 5.1 | — | none | ✓ **0%** (1/1, full population) | Merged. **The ledger's first `bugfix`-cohort row**, and the first to exercise the "every finding invalid" branch. The sole finding argued the route deletion was an intentional behavior change requiring Tier C ceremony and a plan; the author rebutted with a repo-wide grep showing no caller of the removed soft-phase PII-scrub path, and David — shown that nuance explicitly — confirmed Tier A stands. Invalid subcase (b) with (a) support, so the denominator is zero: `n/a`, never `0%`. |
| 10 | [#285](https://github.com/TheAnswerManIsHere/Overhypeme/pull/285) | plan-review | 1 | 1128 | 0 | 5 | 36 | 18 | 6 | 12 | 0 | 0 | **50.0%** | 3.4 | — | none | ✓ **8.3%** (3/36, full population) | Closed unmerged (documentation-backfill plan, approved 2026-07-30 for execution on a normal branch). `pre-open preflight` is blank, not zero: this loop rode the session's pre-existing designated branch (decision 8 in the plan) rather than a freshly cut `plan-review/*` branch, so "branch cut → PR open" has no clean start point to measure from. `breakers fired: none` — 5 rounds, well inside the ~20-round soft cap, no non-convergence escalation. 3 of 36 adjudication disagreements, all on the new-ground/self-inflicted boundary or a same-side prop↔wrong-fix reclassification (R4-11); two of the three (R3-4, R4-4) cross that boundary in opposite directions and net to the same total, so the author's 50.0% self-inflicted share and the adjudicator's independently-computed share are identical despite the per-finding disagreements. **These are the figures of record.** This row and #286's (row 11) were derived independently and concurrently by two different sessions that both cut a new row 10 from the same 9-row base — the resulting merge conflict is why this note exists. The other session (PR #290) initially folded #285 in mechanical-only under row 6's size-vs-scope reasoning, which Codex correctly flagged as unjustified (#285 was never in #279's size class, and had no David-authorized deferral), then classified it independently: two cold passes, no shared context with this row, agreeing with each other at 0% disagreement, landing at **44.4%** (20 new / 5 prop / 11 wrong). That's the figure of an external, no-stake adjudicator; this row's 50.0% is the loop's actual author (this session, which wrote and ran the #285 plan-review loop, per its own internal author-vs-adjudicator check above) — per this file's own convention (rows 3, 4, 7), the author's classification is canonical when it is the more self-critical of the two, which it is here. The 5.6-point spread between two independently-produced classifications is not reconciled finding-by-finding here (that would mean redoing the work a third time); it's disclosed so a future full reconciliation has both readings on record rather than one silently overwriting the other. |
| 11 | [#286](https://github.com/TheAnswerManIsHere/Overhypeme/pull/286) | prose/contract | 7 | 773 | 34 | 1 | 3 | 3 | 0 | 0 | 0 | 0 | **0%** | 0.1 | — | none | ✓ **0%** (3/3, full population) | Merged. This ledger's own PR — a genuine test of "does the obligation survive being about itself," and it did not survive cleanly: this row is late, added only after `check-ledger-coverage.mjs` (the guard row 11 itself shipped) failed a *later* PR for row 11's own absence. See *Rounds undercounted when a re-review is clean* below for a real gap in `rounds`/`review hrs` this row's derivation surfaced. Mechanical columns (`files`/`+lines`/`-lines`/`rounds`) were independently derived a second time, concurrently, by the session that produced rows 12–13 below and the #280 exemption — both derivations agree exactly, which is the first cross-session confirmation this pipeline's mechanical half has had. |
| 12 | [#289](https://github.com/TheAnswerManIsHere/Overhypeme/pull/289) | prose/contract | 8 | 146 | 45 | 2 | 9 | 6 | 2 | 1 | 0 | 0 | **33.3%** | 1.0 | — | none | ✓ **0%** (9/9, full population) | Merged. Backfilled from a different session than the one that ran this loop (found while unblocking PR #292 on the loop-ledger coverage gate) — `rounds`/`findings` are script-derived from a fully-paginated, attested MCP snapshot, not recalled, and the causal classification below was corrected after Codex review on PR #292 pointed out that deferring it under row 6's exemption was unjustified: row 6's deferral was earned by genuine scale (166 findings, 32 rounds), and 9 findings is not that. Round 1 (6 findings, all new ground): roadmap/README status conflict, missing next-chapter nav, a dead exclusion pointer, an undercounted ingestion-entrance claim, un-normalized citations, a missing meme-hearts row. Round 2 (3 findings, against round 1's own fix `1d94279`): two are propagation — a new "Health and route-stats endpoints" subsection round 1 added to close finding 3 contained its own factual errors (a false "indexed" claim, a conflated validation-behavior claim); one is wrong-fix — round 1 corrected the roadmap file's status but left an identical stale claim in README's charter section untouched. Blind adjudication (independent agent, full GitHub access, no visibility into this classification) agreed exactly: same 6/2/1 split, same 33.3%, 0% disagreement. `breakers fired: none` — 2 rounds, nowhere near either break threshold. |
| 13 | [#288](https://github.com/TheAnswerManIsHere/Overhypeme/pull/288) | prose/contract | 21 | 2749 | 15 | 5 | 20 | 12 | 3 | 5 | 0 | 0 | **40.0%** | 1.6 | — | none | ✓ **5%** (1/20, full population, scope note below) | Merged. Phase 1 of async-queue hardening, backfilled by a later session. `cohort` is the script's own first-match output (two `PR288_*` docs land it in `prose/contract` despite being a majority-code feature PR — the same leakage rows 5/8 already documented). `findings=20` deliberately excludes the 4 CodeQL (`github-advanced-security`) threads on this PR — `countFindings` filters to `REVIEWER_LOGINS` (`chatgpt-codex-connector` only) by the script's existing, pre-dating design, not a choice made for this row; this ledger measures the Codex review loop, not GitHub's separate automated scanning. Of those 4 CodeQL threads: 2 were genuine (missing rate limiting on two admin routes, fixed), 2 were a confirmed false-positive re-fire on the same lines after the fix already landed (`.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md`, same pattern as PR #256) — neither is in this row's counted 20. Classification: round 1 (5, all new ground); round 2 (5: 1 propagation — the sequence guard round 1's own fix added had its own starvation bug — plus 4 new); round 3 (5: 1 propagation — round 2's terminal-vs-exhausted fix resolved against *live*, mutable config, a defect only that fix's design enabled — plus 2 wrong-fix — the aggregate label and the UAT doc's stalled-lane step each left a sibling site/doc with the same defect round 2 fixed elsewhere — plus 2 new); round 4 (3: 1 propagation — the persisted-ceiling change broke an untouched, pre-existing retry route's invariant — 1 wrong-fix — legacy pre-migration rows left exposed to the config-drift bug the same fix closed for new rows — 1 new); round 5 (2, both wrong-fix — round 4's own legacy-row guard missed a sibling branch of the same condition, and its TTL-widening fix missed a sibling call site). Blind adjudication (independent agent, full GitHub access, no visibility into this classification) read all 24 threads including the 4 CodeQL ones (2 new, 2 invalid — evidence-based, same false-positive pattern) and, restricted to this row's 20-thread scope, differed from the above on exactly one finding: the UAT-doc stalled-lane step, which it called wrong-fix rather than new — the same "same defect, sibling file, one site fixed" reasoning row 12 (#289) already established, and adopted here in its favor. 19/20 agreement, 5% disagreement. **`rounds`/`review hrs` are undercounted, confirmed** — see *Rounds undercounted when a re-review is clean* above: two clean plain-comment re-reviews (2026-07-30T02:05:58Z, 2026-07-30T03:32:17Z) are invisible to `countRounds`/`reviewInterval`; the true reviewer-engagement count is 7, not 5, and `review hrs` runs to 1.8, not 1.6. `findings`/causal classification are unaffected — a clean round contributes no root comments either way. Left as the mechanical figures the script actually produced rather than hand-patched, per this section's own point that a re-derivation is a real task, not a footnote edit. |
| 14 | [#280](https://github.com/TheAnswerManIsHere/Overhypeme/pull/280) | plan-review | 2 | 3574 | 0 | 18 | — | — | — | — | — | — | *not classified* | 34.7 | — | none | ✗ **not run** | Closed unmerged (`[PLAN REVIEW]` NCMEC CyberTipline submission). Codex review on PR #292 correctly rejected an earlier version of this backfill that placed #280 in *Deliberately not measured* — that table is for genuine decisions not to measure a loop, and a tool-output limit hit mid-attempt is a punt, not a decision; a mechanical row (even causally deferred, like row 6) is the honest disposition and is what the coverage guard should actually track as owed-then-satisfied. `files`/`+lines`/`-lines` are clean (`get_files` returns only 2 files — the plan and a handoff doc — once isolated from a crowded parallel batch, where it had overflowed before). `rounds` is a full count, not an estimate: `get_reviews` fully paginates in 3 requests (100+100+0), 18 distinct `chatgpt-codex-connector[bot]` review events. **`findings` is left unmeasured (`—`), not 180.** A first pass reported the `get_review_comments` server-reported `totalCount` (180) directly, without running it through `loop-metrics.mjs`'s canonical derivation — which filters to `REVIEWER_LOGINS`-authored root comments rather than trusting every thread was Codex-initiated, exactly the distinction that gave row 13 (#288) its real `findings=20` against 24 raw threads. Codex review on PR #292 (round 5) correctly rejected treating the raw total as a completed mechanical figure. Running the real derivation needs the threads paginated and processed (~12 pages at this size) rather than one `totalCount` read, which this pass didn't do; recorded here as owed rather than asserted. For scale only, not as this row's `findings`: 180 total review threads is the largest raw count this ledger has ever pulled for any PR, well above #279's 166 script-derived findings — but that comparison is apples-to-oranges until #280 gets the same derivation #279 got, so no ranking claim is made from it (see rows 6/7's notes, corrected below). |
| 15 | [#290](https://github.com/TheAnswerManIsHere/Overhypeme/pull/290) | prose/contract | 7 | 217 | 36 | 7 | 20 | 9 | 10 | 1 | 0 | 0 | **55.0%** | 1.0 | — | none | ✓ **0%** (20/20, full population) | Merged. Backfilled by a later session, found when the coverage guard failed PR #300's branch. Mechanical columns script-derived from a fully-paginated, attested MCP snapshot. **`rounds`/`review hrs` are undercounted, confirmed** — one clean re-review posted as a plain issue comment ("Didn't find any major issues", 04:17:44Z, against the final fix `8ff39f2`) is invisible to `countRounds`; true reviewer engagement is 8 and `review hrs` runs to 1.1 (see *Rounds undercounted when a re-review is clean* above — this is the third confirmed loop with the gap). Round 3 (03:34:36Z) is the opposite shape and needs no correction: a formal review event with **zero root findings** (its only output was a "Review Result" reply on an existing thread), counted as a round while contributing nothing to `findings`. Classification: round 1 is 4/4 new ground (the harvest's own roadmap/memory-note defects); the remaining 16 split 5 new / 10 propagation / 1 wrong-fix, dominated by defects in analysis text the loop's own fixes kept adding or rewriting — the trend filter, the structural-floor reasoning, and a round-5 roadmap restructuring that regressed two earlier rounds' fixes. Blind adjudication (independent agent, full GitHub access, no visibility into this classification) agreed on **all 20 findings — same 9/10/1/0/0 split, same 55.0%, 0% disagreement**. Post-boundary (review window 03:15–04:12 on 2026-07-30). |
| 16 | [#292](https://github.com/TheAnswerManIsHere/Overhypeme/pull/292) | prose/contract | 14 | 770 | 72 | 7 | 19 | — | — | — | — | — | *unmeasured — adjudication gate* | 2.3 | — | none | ✗ **gate tripped: 31.6% disagreement (6/19)** | Merged. A bugfix-mode loop by intent (Tier B — the login-redirect open-redirect fix) cohorted `prose/contract` by the documented markdown leakage (rows 5/8/13). Backfilled by a later session; mechanical columns script-derived from a fully-paginated, attested MCP snapshot. **`rounds`/`review hrs` are undercounted, confirmed** — two clean re-reviews posted as plain issue comments (21:23:35Z against `6b2ae03`, 23:11:39Z against the final `02bdcac`) are invisible to `countRounds`; true reviewer engagement is 9 and `review hrs` runs to 2.4 (fourth confirmed loop with the gap). **The causal share is `unmeasured` because the >20% adjudication gate fired — the first time in this ledger's history.** The backfiller's independent classification (5 new / 6 propagation / 4 wrong-fix / 0 re-raised / 4 invalid → 66.7%) and the blind adjudicator's (5 / 8 / 2 / 4 / 0 → 52.6%) disagree on 6 of 19 findings. Four of the six are one rubric error on the backfiller's side: round 6 reviewed the stale commit `66c2780` after `8ab18f6` had already fixed its four findings, and the backfiller classified those re-fires `invalid` (refuted by the commit timeline) where the rubric's text is explicit that a restatement stays `re-raised` even when factually wrong *now* — `invalid` is for first occurrences only. The other two are same-side propagation↔wrong-fix calls on round 5's staleness findings. The adjudicator's 52.6% is therefore the better-grounded figure — but per the gate's own rule it is disclosed rather than recorded as measured, and this row is excluded from the trend pending a fresh classification. For the record the loop's shape was: round 1's P1 (dot-segment normalization bypass, exploitable on both the client validator and its pre-existing server twin) was the one code-level security finding; rounds 4–7 ran entirely on loop-ledger content added mid-loop (rows 12–14's backfill), the same mid-loop-material propagation shape as #270/#289/#290. |

### Rounds undercounted when a re-review is clean

**`rounds` and `review hrs` are understated for row 11 (#286), and the mechanism is now understood well enough to name.** After the round-1 fix (`6b04de2`), an explicit `@codex review` trigger drew a genuine second review from Codex against the fix commit — confirmed by its own "Reviewed commit: `6b04de28e6`" line — that found nothing further. That clean result posted as a **plain issue comment** ("Codex Review: Didn't find any major issues. Delightful!"), not as a formal `pull_request_review` submission. `countRounds` and `reviewInterval` only scan the `reviews` collection, so this real reviewer engagement is invisible to both: `rounds` reports 1 where the true reviewer-engagement count is 2, and `review hrs` reports 0.1 (PR-open → the round-1 review) where the true interval runs to the round-2 comment, roughly 2.8 hours.

This gap is **different** from the trigger-counting pitfall `countRounds`'s own docstring already documents and rejects (counting `@codex review` comments instead of formal reviews would miss the automatic on-open review — which is exactly why `countRounds` counts formal review records instead, not a live bias in the approach it actually takes). It lives in the approach `countRounds` *does* take: a re-review that finds **zero** new findings appears to route through the plain-comment reply path rather than the formal review-submission path on this repo's Codex transport.

`findings` and the causal classification are unaffected: `countFindings` reads root comments directly and a review with zero findings contributes zero root comments either way.

**Row 13 (#288) has the identical gap, confirmed — a second occurrence.** Checked directly against the PR's plain-comment history: a clean "Codex Review: Didn't find any major issues" landed at `2026-07-30T02:05:58Z` (reviewing `5800debd7d`, between what this row counted as round 1 and round 2) and a second at `2026-07-30T03:32:17Z` (reviewing `62d9e8ab5f`, after the last formal review this row's snapshot captured). Row 13's `rounds: 5` and `review hrs: 1.6` both undercount the true reviewer engagement — by at least one round each, and the true `review hrs` extends past `03:20:10Z` to `03:32:17Z`. Not re-derived here (that means rebuilding the row's snapshot with plain comments folded in, a task in its own right, not a footnote).

**Rows 15 (#290) and 16 (#292) are the third and fourth confirmed occurrences** — one and two plain-comment clean re-reviews respectively, each verified directly against the PR's issue-comment history and noted with true figures in their rows. Four loops across three sessions is a confirmed repo-wide bias of this Codex transport, not an observation: every clean re-review on this repo has posted as a plain comment, never as a formal review. The script-side fix (folding reviewer-authored plain-comment reviews into `countRounds`/`reviewInterval`) is owed and remains undesigned — until it lands, any row whose loop ended on a clean re-review understates `rounds` by at least one, and backfillers must check the issue comments, not just the reviews collection.

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

**Ten rows carry a real adjudicated self-inflicted-share percentage** —
every adjudicated row **with a computable share**, which excludes two: #284
(adjudicated but has none to report — its one finding is `invalid`, so the
denominator is zero; see its own row note) and #292 (adjudicated but
**unmeasured** — the >20% adjudication gate fired for the first time, so the
share is disclosed in the row rather than recorded; see row 16). Naming all
ten, not a subset, matters: #270 64.7%, #274 68.4%, #276 0%, #282 72.1%,
#283 0%, #285 50.0%, #286 0%, #289 33.3%, #288 40.0%, #290 55.0%. Both
exceptions are excluded from every trend below, counted neither way.

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
every one), #282 (9 rounds, findings in every one), #285 (5 rounds, findings
in every one), #289 (2 rounds, findings in every one), #288 (5 rounds,
findings in every one), and #290 (7 rounds, 6 finding-bearing — its round 3
posted zero root findings). #286 does not qualify despite its true two-round
engagement, because only round 1 produced findings.

**Of these seven, three are confirmed pre-boundary and four are confirmed
post-boundary — they are not one population, and averaging them into a
single seven-point trend would repeat the error this section already exists
to correct.** David enabled Codex "Exhaustive code review" shortly after 6:56 PM
on 2026-07-29 (the ChatGPT settings screenshot he sent is timestamped then,
and he confirmed the change in the same breath). #270, #274, and #282 all ran
their review rounds before that time and are confirmed pre-boundary. **#285,
#289, and #288 are confirmed post-boundary, not merely later-dated or
unverified** — #285's entire review window (2026-07-29T22:39 to
2026-07-30T02:09) falls after 6:56 PM that same day; #289's (2026-07-30T02:17
to 03:10), #288's (2026-07-30T02:03 to 03:20), and #290's (2026-07-30T03:15
to 04:12) all fall entirely the following day, well inside the new setting's
window. An earlier draft of this
section hedged the boundary claim as "unverified" and required an exact
toggle timestamp that the settled decision never asked for; that hedge was
itself the error, per Codex review on PR #290.

**The pre-boundary trend (n=3) stands as originally measured: 64.7% → 68.4%
→ 72.1%, not falling.** The post-boundary population has grown to n=4 —
#285 50.0%, #289 33.3%, #288 40.0%, #290 55.0%. All four sit below every
pre-boundary loop's share (the lowest pre-boundary figure is 64.7%), across
three different sessions, which is more suggestive of exhaustive review's
intended effect (fewer self-inflicted findings once a round looks harder
before stopping) than the original single point was — but n=4 is still not
enough to claim the effect, and the two populations are not compared
directly here, only each against its own history.

**Two structural observations, now checked against seven loops:**

- **Round 1 is where new ground lives — holds in all six with a round-1
  figure.** #282: 11/11; #274: 5/5; #285: 7/7; #289: 6/6; #288: 5/5;
  #290: 4/4 — every round-1 finding in every loop this ledger has broken
  down by round is new ground. **#270 remains excluded from this specific
  claim, not silently folded in** — it predates the ledger's finding-bearing-
  round tracking fine enough to isolate round 1 specifically (row 3 gives a
  16-round total, not a round-by-round breakdown), so it can neither confirm
  nor deny the pattern. This is now the least surprising, most-replicated
  pattern among the loops it can be checked on.
- **Wrong fix dominates propagation in four of the seven loops.**
  #274 (7 vs 6), #282 (38 vs 24), #285 (12 vs 6), and #288 (5 vs 3) all show
  it. **#270, #289, and #290 do not.** #270's reversal (18 propagation vs 4
  wrong-fix) is row 3's own explained case — its propagation findings
  concentrate in subsystems built *mid-loop* (the MCP adapter, the
  adjudication rubric itself), genuinely new code rather than "fixed one
  site, left another." **#289 is a new instance of the reversal** (2
  propagation vs 1 wrong-fix) with a different explanation: its round-2
  propagation findings are both defects in a documentation *subsection* round
  1's own fix newly added (the architecture-map.md "Health and route-stats
  endpoints" section), the same "new code introduced mid-loop" shape as
  #270's, just in prose rather than an adapter. **#290 is the strongest
  reversal yet** (10 propagation vs 1 wrong-fix): nearly all its propagation
  is defects in analysis prose its own fixes kept adding — the same
  mid-loop-material shape again. The dominance pattern holds
  specifically for loops whose propagation is a plan/doc edited in place
  repeatedly; it doesn't hold when a fix round adds genuinely new content
  that then has its own bugs.

This is a hypothesis at n=3 pre-boundary (not falling) and n=4 post-boundary
(lower than pre-boundary, still not falling within itself — 50.0% → 33.3% →
40.0% → 55.0% isn't monotonic either direction), not a finding. It is
recorded here so the next rows — on either side of the boundary — can
confirm or kill it rather than re-deriving it.

### The cohort rule leaks bugfix loops into prose/contract

Four of this file's rows (#276, #283, #292 — and #284 only narrowly escaping)
are bugfix-mode loops by intent. Three of them are cohorted `prose/contract`,
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
scale (180 raw review threads, the largest thread count this ledger has
pulled for any PR) rather than borrowed without it. Not "180 findings" —
row 14's `findings` is unmeasured, and this note doesn't get to smuggle back
in as fact what that row explicitly withdrew.

**Dependabot PRs are excluded by policy, not by entry** — they carry no plan,
fix tier, or review loop, and requiring a hand-written exemption for each
weekly bump would train this table to be noise. The guard reports how many it
skipped on every run so the exclusion is never silent. #271 is the only such
PR in the enforced range so far.
