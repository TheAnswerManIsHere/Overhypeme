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
| 6 | [#279](https://github.com/TheAnswerManIsHere/Overhypeme/pull/279) | plan-review | 2 | 2711 | 1 | 32 | 166 | — | — | — | — | — | *not classified* | 23.7 | — | — | ✗ **not run** | Closed unmerged. **Mechanical columns only** — see *Rows whose judgment half is deferred* below. At the time this row was written, by far the largest loop this ledger had seen: 166 findings is over 4× #268's 40, and its 32 rounds exceed the `plan-review-loop` skill's ~20-round soft cap, which is supposed to trigger a pause-and-check-in with David rather than a silent continuation. Whether that check-in happened is **not visible in the PR record**, so this row does not assert either way. **Superseded on findings, not rounds, by row 14 (#280, 2026-07-30): 180 findings against this row's 166** — #279 remains the ledger's largest by round count (32 vs. #280's 18). A concurrent PR (#292) independently backfilled #280 and left its `findings` deliberately unmeasured (`—`) rather than accept the 180 figure, on the grounds that it was a raw `get_review_comments` `totalCount` never run through `loop-metrics.mjs`'s `REVIEWER_LOGINS`-filtered derivation; row 14's own note re-confirms 180 against a live re-check of that same `totalCount` during this merge and explains why it's treated as sound here despite that objection. |
| 7 | [#282](https://github.com/TheAnswerManIsHere/Overhypeme/pull/282) | plan-review | 1 | 2317 | 0 | 9 | 86 | 24 | 24 | 38 | 0 | 0 | **72.1%** | 6.3 | — | none | ✓ **18.6%** (16/86, full population) | Closed unmerged. Densest loop in the ledger — 9.6 findings/round against #268's 2.2, on a 2317-line plan — and the **highest self-inflicted share yet recorded**. 38 of 86 are wrong-fix: an earlier fix in the same loop corrected one site and left others, or did not achieve what it claimed. Round 1 is entirely new ground (11/11); from round 2 on, new ground is a minority in every single round. **The adjudication passed the gate but only just, and the margin should be read as a real caveat rather than a pass:** 16 disagreements, and the adjudicator flagged that for several findings the digest gave no way to date the offending text, so provenance was decided by the ambiguous default rather than by evidence. Most disagreements (11 of 16) were boundary crossings between new ground and self-inflicted rather than prop-vs-wrong-fix reshuffles, which is why the two shares differ by more than row 3's did: author 72.1%, adjudicator 61.6%. The author's is the more self-critical figure and is the one recorded, per row 3's precedent. |
| 8 | [#283](https://github.com/TheAnswerManIsHere/Overhypeme/pull/283) | prose/contract | 3 | 116 | 3 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | **0%** | 0.0 | — | none | ✓ **0%** (1/1, full population) | Merged. A bugfix by intent, but the script cohorts it `prose/contract` because the diff carries `docs/engineering/deferred-work.md` and that cohort includes mixed — the same leakage as row 5; see the cohort note below. `review hrs` is a **measured** 0.0 (2m52s from open to review), not an unmeasured blank. The single finding: a code comment cited a `docs/plans/` path that only ever existed on a never-merged plan-review branch — a recurrence of the retired mistake in [`plan-doc-path-never-cite-from-code.md`](../memory/plan-doc-path-never-cite-from-code.md), caught by review rather than by the guard that memory note was supposed to be. |
| 9 | [#284](https://github.com/TheAnswerManIsHere/Overhypeme/pull/284) | bugfix | 5 | 18 | 71 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | **n/a — clean loop** | 5.1 | — | none | ✓ **0%** (1/1, full population) | Merged. **The ledger's first `bugfix`-cohort row**, and the first to exercise the "every finding invalid" branch. The sole finding argued the route deletion was an intentional behavior change requiring Tier C ceremony and a plan; the author rebutted with a repo-wide grep showing no caller of the removed soft-phase PII-scrub path, and David — shown that nuance explicitly — confirmed Tier A stands. Invalid subcase (b) with (a) support, so the denominator is zero: `n/a`, never `0%`. |
| 10 | [#285](https://github.com/TheAnswerManIsHere/Overhypeme/pull/285) | plan-review | 1 | 1128 | 0 | 5 | 36 | 18 | 6 | 12 | 0 | 0 | **50.0%** | 3.4 | — | none | ✓ **8.3%** (3/36, full population) | Closed unmerged (documentation-backfill plan, approved 2026-07-30 for execution on a normal branch). `pre-open preflight` is blank, not zero: this loop rode the session's pre-existing designated branch (decision 8 in the plan) rather than a freshly cut `plan-review/*` branch, so "branch cut → PR open" has no clean start point to measure from. `breakers fired: none` — 5 rounds, well inside the ~20-round soft cap, no non-convergence escalation. 3 of 36 adjudication disagreements, all on the new-ground/self-inflicted boundary or a same-side prop↔wrong-fix reclassification (R4-11); two of the three (R3-4, R4-4) cross that boundary in opposite directions and net to the same total, so the author's 50.0% self-inflicted share and the adjudicator's independently-computed share are identical despite the per-finding disagreements. **These are the figures of record.** This row and #286's (row 11) were derived independently and concurrently by two different sessions that both cut a new row 10 from the same 9-row base — the resulting merge conflict is why this note exists. The other session (PR #290) initially folded #285 in mechanical-only under row 6's size-vs-scope reasoning, which Codex correctly flagged as unjustified (#285 was never in #279's size class, and had no David-authorized deferral), then classified it independently: two cold passes, no shared context with this row, agreeing with each other at 0% disagreement, landing at **44.4%** (20 new / 5 prop / 11 wrong). That's the figure of an external, no-stake adjudicator; this row's 50.0% is the loop's actual author (this session, which wrote and ran the #285 plan-review loop, per its own internal author-vs-adjudicator check above) — per this file's own convention (rows 3, 4, 7), the author's classification is canonical when it is the more self-critical of the two, which it is here. The 5.6-point spread between two independently-produced classifications is not reconciled finding-by-finding here (that would mean redoing the work a third time); it's disclosed so a future full reconciliation has both readings on record rather than one silently overwriting the other. |
| 11 | [#286](https://github.com/TheAnswerManIsHere/Overhypeme/pull/286) | prose/contract | 7 | 773 | 34 | 1 | 3 | 3 | 0 | 0 | 0 | 0 | **0%** | 0.1 | — | none | ✓ **0%** (3/3, full population) | Merged. This ledger's own PR — a genuine test of "does the obligation survive being about itself," and it did not survive cleanly: this row is late, added only after `check-ledger-coverage.mjs` (the guard row 11 itself shipped) failed a *later* PR for row 11's own absence. See *Rounds undercounted when a re-review is clean* below for a real gap in `rounds`/`review hrs` this row's derivation surfaced. Mechanical columns (`files`/`+lines`/`-lines`/`rounds`) were independently derived a second time, concurrently, by the session that produced rows 12–14 below (PR #292's own loop-ledger fold-in) — both derivations agree exactly, the first cross-session confirmation this pipeline's mechanical half has had. |
| 12 | [#288](https://github.com/TheAnswerManIsHere/Overhypeme/pull/288) | prose/contract | 21 | 2749 | 15 | 5 | 20 | 13 | 3 | 4 | 0 | 0 | **35.0%** | 1.6 | 171 | none | ✓ **5.0%** (1/20, full population) | Merged. Phase 1 of the approved async-queue hardening plan (plan-review PR #282). Cohort is `prose/contract` (mixed) because the diff carries the paired TEST_RUN/UAT docs alongside code — same leakage as rows 5/8. `pre-open preflight` is measured wall-clock, first commit (`53349fa`, 2026-07-29T22:54:00Z) → PR open (2026-07-30T01:44:33Z) = 171 minutes across three pre-open commits (heartbeat foundation, endpoints+page, docs). `rounds` is 5, not the 7 the PR body's own round-by-round narration used — that narration counted the two GitHub Advanced Security CodeQL alerts as "round 1" (a confirmed `js/missing-rate-limiting` false positive, same as PR #256, not authored by `chatgpt-codex-connector[bot]` so excluded from `REVIEWER_LOGINS`) and appears to have expected a final clean review as "round 7"; no seventh review object exists in `get_reviews` — a **confirmed** second instance of row 11 (#286)'s "clean re-review has no review object" gap below, verified directly against PR #288's own comment history: two plain "Codex Review: Didn't find any major issues" issue comments exist (`2026-07-30T02:05:58Z`, `2026-07-30T03:32:17Z`), neither a formal review object nor visible to `get_reviews` — see the note below for the full check. One genuine architecture/scope decision (whether to touch `processClaimedJob`'s finalize path, explicitly on the PR's own Must Not Change list) was escalated to David via `AskUserQuestion` rather than decided unilaterally; David chose "touch finalize minimally" and the resulting one-field addition is exactly what shipped — this produced a real fix, not an invalid/out-of-scope ruling, so it does not enter the `invalid` column. The clearest wrong-fix chain in the ledger so far: round 4's own stated reasoning ("a ceiling of one has no partial-retry state to be ambiguous about") was itself wrong, and it took two more rounds (5 and 6) to fully close, both landing as `wrong_fix` against the same original finding. Sole adjudication disagreement (1/20, R3's "relabel the aggregate terminal-failure count" finding) was a propagation-vs-wrong-fix boundary call — both self-inflicted categories, so it does not move the self-inflicted share: author and adjudicator both land at 35.0%. **A second, independent backfill of this same PR exists** (PR #292, concurrent with this row): `new=12/prop=3/wrong=5`, landing at **40.0%**, also citing a sole 1/20 disagreement on the same UAT-doc stalled-lane finding, just resolved the other way (its adjudicator's own read is adopted there; the row-13/#289 "same defect, sibling file, one site fixed" reasoning was the basis). Two independent full passes over the same 20 findings converging on the same disagreement location but opposite resolutions is itself informative — this row's 35.0% is recorded as the figure of record (this session's own derivation, produced across the 14-round review this very PR went through), with #292's 40.0% disclosed rather than silently dropped, per row 10's precedent for exactly this situation. #292's row also flags `rounds`/`review hrs` as undercounted (7 true engagements vs. 5 counted, 1.8h vs. 1.6h) via two clean plain-comment re-reviews at 2026-07-30T02:05:58Z and 03:32:17Z — worth folding into a future re-derivation of this row's mechanical columns too. |
| 13 | [#289](https://github.com/TheAnswerManIsHere/Overhypeme/pull/289) | prose/contract | 8 | 146 | 45 | 2 | 9 | 6 | 2 | 1 | 0 | 0 | **33.3%** | 1.0 | 0 | none | ✓ **11.1%** (1/9, full population) | Merged. PR 0 of the documentation-backfill pass (plan-review PR #285, row 10) — closed without a ledger row at merge time; `check-ledger-coverage.mjs` caught the gap on a later PR (#294), folded in per the standing "a row is never its own dedicated PR" rule. `findings` is 9, not the 10 the round-2 fix commit's own title implies ("address Codex round 2 on PR 0 (4 findings)") — only 3 round-2 threads actually exist in the PR record; the mechanical count is the figure of record, not the commit message's self-reported tally (row 3's precedent). `pre-open preflight` is 0 (25 seconds: first commit `e2e1a05` at 02:10:42Z, PR opened 02:11:07Z) — this loop rode a session already positioned to commit and open immediately. Round 1 (6/6) is entirely new ground against the original diff, matching the "round 1 is where new ground lives" pattern rows 4/7/10 establish. Round 2's 3 findings: 2 propagation (defects inside the `architecture-map.md` "Health and route-stats endpoints" subsection that round 1's own fix created from nothing — a wrong "indexed" claim, a blanket unknown-route-key-dropping claim only true for one of two payload shapes) and 1 wrong-fix (README's stale "is tracked as deferred work" wording surviving because round 1's fix updated `current-roadmap.md`'s status but never touched README's identical claim — the same symptom persisting, not a new defect). Sole adjudication disagreement (1/9) was this same finding: the author classified it propagation, the blind adjudicator wrong_fix — both self-inflicted, so the share is identical either way (33.3%), and the adjudicator's classification (wrong_fix) is the one recorded above as the more rubric-precise of the two. **A second, independent backfill of this same PR exists** (PR #292, concurrent with this row): identical `6/2/1` split and 33.3% share, but reports 0% disagreement (9/9 agreement) against this row's 1/9 — a difference in how each adjudication reported its own single boundary call, not in the final classification, which both land on identically. `pre-open preflight` differs too (this row: 0 minutes measured; #292's: left unmeasured, `—`). |
| 14 | [#280](https://github.com/TheAnswerManIsHere/Overhypeme/pull/280) | plan-review | 2 | 3574 | 0 | 18 | 180 | — | — | — | — | — | *not classified* | 34.7 | — | **fired** | ✗ **not run** | Closed unmerged (`[PLAN REVIEW] NCMEC CyberTipline submission + safety admin surface`). **Mechanical columns only** — same deferral as row 6 (#279), per David's precedent decision: full causal classification and blind adjudication of a loop this size is expensive and out of scope for a fold-in. This loop is now the ledger's **largest by findings** (180, surpassing #279's 166) and second only to #279 by round count (18 vs. 32). Both the PR's own body ("Sixteen rounds, 138 findings... round 17 requested") and its committed hand-off doc ("17 closed, 18 requested... 158 findings addressed") understate the mechanical count — neither hand-narrated figure matches `get_reviews`/`get_review_comments`'s fully-paginated totals, another instance of this file's core reason to exist. `breakers fired` is recorded rather than deferred (unlike row 6) since it's a single stated fact, not a per-finding judgment call: round 16's findings-per-round trend (12→18→22, not narrowing) triggered the plan-review contract's stop-and-check rule before the literal ~20-round cap, and David's resulting decision (cut incident-alert aggregation into its own plan) let the loop continue two more rounds rather than halting it. Public-disclosure check passed per the PR's own attestation; no operational security detail from the plan is repeated here. `pre-open preflight` is `—`, unmeasured, matching row 6's convention. **A concurrent, independent backfill of this same PR** (PR #292) left `findings` unmeasured (`—`) rather than 180, arguing the 180 figure is `get_review_comments`'s raw `totalCount` and was never run through `loop-metrics.mjs`'s `REVIEWER_LOGINS`-filtered derivation the way row 12/#288's 20 was. Re-checked live during this merge (2026-08-01): the GraphQL `totalCount` for #280's review threads is still exactly 180, and — unlike #288 — this is a plan-review PR against a markdown-only diff with no code change, so there is no CodeQL-scanning contamination risk to filter out the way #288's 4 CodeQL threads needed excluding; every thread here originates from a `chatgpt-codex-connector[bot]`-authored root comment. 180 is kept as this row's figure on that basis, but PR #292's objection is recorded because it identifies a real methodological gap (no full per-thread author verification was run, only a spot-check of the first thread plus the aggregate `totalCount`) that a future full re-derivation should close properly rather than repeat this shortcut. |
| 15 | [#290](https://github.com/TheAnswerManIsHere/Overhypeme/pull/290) | prose/contract | 7 | 217 | 36 | 7 | 20 | 7 | 11 | 2 | 0 | 0 | **unmeasured** | 1.0 | ~0.5 | none | ✗ **unmeasured** (25.0%, 5/20 disagreement, exceeds the 20% gate) | Merged. This ledger's **second** self-referential PR (after #286/row 11) to close without its own row — the CI guard didn't catch it because it closed while another PR (#294) was already in flight, exactly the next-PR enforcement gap this PR's own review rounds forced it to document. The loop is unusually self-referential: it edits the ledger's own analysis prose about *other* rows (#270/#274/#282/#285/#286), and it is the **first row whose causal figure lands `unmeasured`** rather than a measured percentage — 5 of 20 findings (R2-F1, R2-F3, R2-F4, R4-F3, R5-F3) disagree between the author (this session) and an independent blind adjudicator, and every one of the five crosses the new-ground/self-inflicted boundary — a real, checkable fact about this row alone; row 7 (#282) already shows a prior row where boundary crossings were the majority (11 of 16), so this is not being contrasted against "every prior row stayed within-category," only stated as this row's own shape — the two readings land at 65.0% (author: 7 new/11 prop/2 wrong) and 50.0% (adjudicator: 10 new/8 prop/2 wrong), a 15-point spread neither this file nor `working-modes.md`'s gate design intends to paper over. The disagreement clusters on findings whose causal chain requires distinguishing "content present since the original diff, only discovered several review rounds later" (new ground) from "content an intervening round's fix actually touched or introduced" (self-inflicted) — exactly the class of judgment call the rubric's causal test is hardest to apply retroactively to once several rounds of edits have layered on the same passage. The counts recorded above are the **author's** (this session's, per the "author's classification is canonical" precedent from rows 3/4/7/10) — but per the rubric, an `unmeasured` result is excluded from the self-inflicted-share trend, not reported as 65.0%. Two things this row's causal-count columns don't capture, worth stating plainly: round 6's restructuring fix (trimming duplicated ledger analysis out of the roadmap, per an earlier finding) regressed two already-fixed facts back out of the text, requiring round 7 to re-fix them — a real "fix that undoes a prior fix" pattern; and round 3 (03:34:36) was a genuinely clean confirmation round that **did** post as a formal review object (unlike row 11/#286's and row 12/#288's confirmed clean-reaction gaps — both directly verified, see the note above), so `rounds`/`review hrs` here are not subject to that same undercount. **A third, independent backfill of this same PR exists** (from PR #295's branch, found while resolving that branch's merge against `main`): `new=10/prop=2/wrong=8`, also landing `unmeasured` (its own author-vs-adjudicator disagreement exceeded the 20% gate too), and differing substantially from both readings already on record here — a third source of classification disagreeing with the first two is itself evidence that this loop's retroactive causal judgment is genuinely hard, not that any single reading is wrong; disclosed per this file's standing practice rather than reconciled by picking one. |
| 16 | [#292](https://github.com/TheAnswerManIsHere/Overhypeme/pull/292) | prose/contract | 14 | 770 | 72 | 7 | 19 | 4 | 3 | 8 | 0 | 4 | *unmeasured* (>20% disagreement) | 2.3 | — | none | ✗ **unmeasured** (21.1% disagreement, 4/19) | Merged (login-redirect XSS/open-redirect fix). `rounds` is mechanically undercounted by 1 (true 8): round 8, against the final commit `02bdcac`, came back clean and posted as a plain issue comment rather than a formal review — the same `countRounds` gap confirmed on row 11 (#286) and row 12 (#288), now observed a third time. `review hrs` (2.3, open→round 7) is undercounted the same way. Author classification (this row's recorded new/prop/wrong/invalid cells): round 1 (1, new ground). Round 2 (4: 3 new ground, 1 wrong-fix — round 1's fix didn't test encoded dot-segment spellings). Round 3 (1, wrong-fix — round 2's fix didn't wire the parity script into CI). Round 4 (4, wrong-fix — this PR's own ledger-obligation edits, made in an earlier commit of this same PR, left stale content). Round 5 (4: 3 propagation — including "Report #280 as excluded from the arithmetic check," omitted from an earlier draft of this narration, same shape as its round-5 siblings: a gap in row 14/#280's arithmetic-check treatment, material this loop's own round 4 added — plus 1 wrong-fix). Round 6 (4, invalid — reviewed the stale pre-fix commit `66c2780`, already superseded by `8ab18f6`; see below). Round 7 (1, wrong-fix). **Independent blind adjudication (fresh-context agent, no visibility into this classification) disagreed on 4 of 19 findings (21.1%) — over the ledger's 20% gate, so the self-inflicted share is `unmeasured` and this row is excluded from the trend, per this file's own rule.** All 4 mismatches are round 4's findings, all in the same direction: this classification called them `wrong_fix` (reasoning: they critique ledger content this same PR had written in an earlier commit), the adjudicator called them `new_ground` (reasoning: `wrong_fix` requires an earlier fix that *responded to a prior round's finding* — round 4 was the first time any reviewer saw that ledger content, regardless of which of this PR's own commits wrote it, so by the rubric's letter it's new ground). **The adjudicator's reading is very plausibly the more correct one** — recorded as a disagreement rather than silently adopted, because overriding my own classification with the adjudicator's on sight would defeat the purpose of an independent check; a future reconciliation pass can resolve it properly. The other disagreement candidates the adjudicator's report might suggest at first glance (round 4's internal wrong-fix-vs-propagation split) turned out, on direct finding-by-finding comparison, to already agree — the 4/19 count is exact, not estimated. Round 6's 4 findings are `invalid` by both readings: this session initially misjudged them as duplicate webhook deliveries with no action needed — genuinely wrong, caught only because David asked directly why comments were unanswered — but on investigation they were a real re-review that simply evaluated a stale, already-superseded commit; the underlying claims were moot against the PR's actual state at review time, not live defects, and the adjudicator's independent report confirms the same stale-commit read from the formal review's own "Reviewed commit" field. |
| 17 | [#294](https://github.com/TheAnswerManIsHere/Overhypeme/pull/294) | prose/contract | 13 | 613 | 142 | 13 | 56 | 17 | 22 | 16 | 1 | 0 | *unmeasured* (see note) | 31.4 | 23 | **fired** (late) | ✗ **unmeasured** (exact disagreement not counted — see note) | Merged. Own row owed and missing at merge time (caught by the coverage guard on a later PR's Build check) — the ledger's third self-referential PR to close without a row of its own (after #286/row 11 and #290/row 15), and the most consequential instance: this is the PR that *wrote* rows 12–15 (#288, #289, #280, #290) and then owed a fourth for itself. `rounds`/`findings` are script-derived from a fully-paginated, attested MCP snapshot (75 reviews / 13 files / 56 threads / 15 issue comments). **Round 1 is 9/9 new ground**, a further replication of that pattern. **Propagation dominates wrong-fix here, 22 to 16** — joining #270 and #289 as a third counter-example to the wrong-fix-dominance pattern, and for the same reason row 3 gives for #270: a large share of findings land on material this loop itself added mid-flight (its own backfilled rows 12–15 and the analysis prose around them), not on "fixed one site, left another." `pre-open preflight` is measured wall-clock, first commit (`b60a0f7`, the #288 ledger row itself) → PR open = 23 minutes. `review hrs` 31.4 is real wall-clock but mostly idle: mechanical rounds 1–8 ran in 1.8h on 2026-07-30, then a ~28.9-hour pause, then rounds 9–13 in 40 minutes on 2026-08-01. **`breakers fired`, late:** the widened-heartbeat-pruning point ran three rounds without converging — past the ~2-round non-converging-fix break — because the author twice defended an incorrect rebuttal before conceding; escalation only happened after David posted "@claude please respond" directly on two threads. That chain is also the ledger's clearest re-raised/wrong-fix precedence illustration: one finding (propagation — text an earlier fix wrote *at the reviewer's own instruction*, which the same fix's rationale later needed reversing) → a restatement disposed of by rebuttal with no fix attempt in between (**re-raised**, the only one in this row) → a third occurrence where a fix *was* attempted and failed (**wrong fix**, per the rubric's precedence: attempted-and-failed always outranks re-raised). **This row's causal share is `unmeasured`, not a reconciled estimate.** Two independent classifications exist over closely but not identically matched populations — the author's 17 new / 22 propagation / 16 wrong-fix / 1 re-raised (67.9%) over the script-derived 56 findings, and a blind adjudicator's 20 new / 18 propagation / 17 wrong-fix / 1 re-raised (62.5%) over the same 56 after excluding a 57th finding it separately surfaced (a Codex finding delivered as review-body prose with no discussion thread at all — a third delivery shape `countFindings` cannot currently see). The two readings both trace their disagreement to findings critiquing row/analysis material this PR's own commit `3f23d7a` added mid-loop — the identical rubric-boundary ambiguity row 16 (#292) already disclosed — and a rough recomputation under the adjudicator's reading of that boundary (21/18/16, 60.7%) lands close to its independent figure. But **rough is the operative word**: per this ledger's own gate design, `unmeasured` requires an exact finding-by-finding comparison across the full population, and this row has only an aggregate-category approximation — the two classifications were never paired finding-by-finding against a shared, agreed population of exactly 56 IDs (Codex review, PR #301, correctly rejected an earlier version of this row that reported a specific "~8%" figure on that basis). Both readings are disclosed above rather than either being asserted as the figure of record; a full pairwise reconciliation is owed before this row can report a real percentage. `loop-metrics.mjs` correctly folded a clean final round (round 13, a plain issue comment) into `rounds` here — the *Rounds undercounted when a re-review is clean* gap this very PR's own harvest left open is confirmed fixed on this row, the first to benefit from it. |
| 18 | [#297](https://github.com/TheAnswerManIsHere/Overhypeme/pull/297) | prose/contract | 6 | 794 | 58 | 2 | 3 | 3 | 0 | 0 | 0 | 0 | **0%** | 0.3 | ~1 | none | ✗ **unadjudicated** | Merged. This PR fixed two defects in `loop-metrics.mjs`'s own round-counting (`reviewerPasses`) and added the post-merge ledger-debt audit to `check-ledger-coverage.mjs` — the loop-ledger tooling reviewing itself. All 3 findings landed in round 1 against the original diff (`8683bfde34`) with no earlier in-loop fix to respond to and no earlier finding to restate, so by the rubric's own construction none can be propagation/wrong-fix/re-raised — new=3, 0% self-inflicted, the same structural floor as rows #276/#283/#286. Round 2 was a clean re-review posted as a plain issue comment (`chatgpt-codex-connector[bot]`, 04:32:25Z, carrying the `**Reviewed commit:**` marker) — correctly counted rather than lost, per this PR's own fix. `pre-open preflight` is ~1 minute: fix commit `8683bfde34` landed 04:16:22Z, PR opened 04:17:15Z. Cohort is `prose/contract` per `classifyCohort`'s top-down rule — the diff carries `docs/ai-context/working-modes.md` alongside code, the same doc-leakage this ledger already documents ("The cohort rule leaks bugfix loops into prose/contract"); no `**Fix tier:**` field exists in the PR body (dev-infra, not product bugfix mode), so the bugfix fallback never triggers. The PR body's own 84/84 and 25/25 test-count claims are not ledger data — the mechanical columns above come only from `loop-metrics.mjs` against a fully-paginated MCP snapshot. Adjudication not run; marked `unadjudicated` rather than `n/a`, since findings > 0. |
| 19 | [#287](https://github.com/TheAnswerManIsHere/Overhypeme/pull/287) | prose/contract | 52 | 9918 | 3089 | 7 | 101 | — | — | — | — | — | *not classified* | 55.0 | — | — | ✗ **not run** | Merged. **Mechanical columns only** — same deferral as row 6 (#279) and row 14 (#280), per David's precedent decision that full causal classification and blind adjudication of a loop this size is out of scope for a fold-in. This is the major payments/entitlement-model PR: approved via plan-review PR #279 (32 Codex review rounds per this PR's own oracle section). Script-derived figures, from a fully-paginated MCP snapshot (124 reviews, 52 files, 103 review threads, 18 issue comments), are **rounds: 7, findings: 101** — both diverge sharply from this PR body's own round-by-round self-narration ("Four Codex rounds did not converge: 15 → 13 → 7 → 15 findings"), which implies ~4 rounds and roughly 50 findings total. The real per-round finding counts (28, 30, 19, 8, 7, 4, 5 — 101 total across 7 reviewer passes) show more rounds and roughly double the findings the narrative describes — the same recall-vs-count gap rows 6 and 14 already document for #279/#280, not adopted on faith here either. Declared scope narrowing after round 4, quoted from the PR body: "Scope narrowed after review round 4 — reconciliation is deferred... David's call (2026-07-30): ship the settled core, pull reconciliation into its own PR, and accept the gap." `membershipReconcile.ts`, the reconciliation table, migration `0096`, and the admin reconciliation-runs endpoint were removed from scope as a result; the accepted gap (a webhook that never successfully delivers is no longer auto-repaired) is stated in the PR body as a deliberate, smaller guarantee than the approved plan's Settled Decision 5. Cohort is the script's own `prose/contract` output — same docs-leak pattern as rows 5/8/12: the diff carries the paired `PR287_*_TEST_RUN`/`UAT` docs alongside a 52-file backend implementation. `breakers fired` and `pre-open preflight` are left unmeasured (`—`), matching row 6's convention. Scale matching the #279/#280 precedent that justifies mechanical-only treatment: 52 files, 34 commits, 9918/3089 lines, 101 findings across 7 rounds. |
| 20 | [#299](https://github.com/TheAnswerManIsHere/Overhypeme/pull/299) | plan-review | 3 | 738 | 5 | 16 | 146 | — | — | — | — | — | *not classified* | 70.9 | — | **fired** | ✗ **not run** | Closed unmerged (`[PLAN REVIEW] Global rate limiter for CodeQL`). **Mechanical columns only** — same deferral as row 6 (#279) and row 14 (#280), per David's precedent decision: full causal classification and blind adjudication is out of scope at this scale (16 rounds, 146 findings). `rounds` is 16, exactly matching the PR body's own round-by-round findings-ledger narration — a rare case where the hand-narrated count agrees with the script-derived one. `breakers fired` is recorded rather than deferred (per row 14's precedent: a single stated fact, not a per-finding judgment) — the PR body's own **Design decision** section states the same finding recurred on the DB-backed `Store`'s failure-handling boundary across rounds 9, 11, 12, 13, and 14, with P1 counts going 8→6→6→10 (worsening, not converging), which David's 2026-08-04 decision resolved by rewriting the plan around the built-in `MemoryStore` rather than patching the DB-backed design further. `pre-open preflight` is `—`, unmeasured, matching rows 6/14's convention. Converged after review and approved by David on 2026-08-04; this plan-review PR is never merged (closed unmerged, base `main`, head `plan-review/codeql-rate-limiter`) and implementation ships as PR #308. |
| 21 | [#298](https://github.com/TheAnswerManIsHere/Overhypeme/pull/298) | prose/contract | 10 | 773 | 21 | 6 | 17 | 11 | 4 | 2 | 0 | 0 | **35.3%** (6/17) | 65.9 | — | none | ✗ **unadjudicated** | Merged. Full causal classification done (not deferred): 17 findings/6 rounds is well inside the range this ledger already classifies in full (e.g. row 10/#285 at 36/5, row 12/#288 at 20/5) — nowhere near row 6/#279 (166/32) or row 14/#280 (180/18), the two loops David scoped as too expensive to classify. Round 1 (5/5 new ground) matches the established "round 1 is where new ground lives" pattern. Cohort is `prose/contract` only because 6 of 10 files are `.md` — a further instance of the leak this file already documents: this is neither docs nor a bugfix, it's a CI-guard feature whose two new script files (`check-manual-tuning-language.mjs` + its test) carry 686 of the PR's 773 added lines (89%). Propagation (4) is concentrated in round 3, all against round-2's own newly-added code: `config-kv`'s missing snake_case support, the new line-joining logic ignoring suppression markers, and `stripEmphasis` not handling single-asterisk italics or links are defects that could not have existed before round 2 wrote that code. Round 4's sole finding (a number-word gap in a list round 3 had just centralized) is propagation for the same reason. The two wrong-fix findings: round 2 found round 1's "remove the fence exemption" fix didn't actually add config-value detection (its own test passed for the wrong reason); round 6 found round 5's fix re-worded a lane count as the ordinal "third" instead of removing the value — the same quantitative claim persisting in new clothes. No `re-raised` or `invalid` findings. `breakers fired: none` — the lane-count item took 2 fix attempts, inside the ~2-round non-converging-fix threshold. `pre-open preflight` is `—`, unmeasured: this PR is stacked on #291 and later retargeted against `main`, so its own pre-open commit history isn't cleanly isolable from the branch it rode — same shape as row 10/#285's blank. |
| 22 | [#308](https://github.com/TheAnswerManIsHere/Overhypeme/pull/308) | prose/contract | 22 | 1694 | 264 | 3 | 7 | 7 | 0 | 0 | 0 | 0 | **0%** | 1.1 | ~95 | none | ✓ **0%** (0/7, full population) | Merged. This is the loop's own implementation-review row, distinct from the 16-round plan-review already captured in row 20 (#299) — three reviewer passes, clean by round 3 ("Codex Review: Didn't find any major issues. Chef's kiss."). All 7 findings land new_ground, verified against each fix commit's actual diff rather than assumed from topical similarity: round 1 (3) critiqued gaps the initial two-commit state exposed (log-suppression keyed on shared `RateLimit-*` headers, a render poller with no 429 classification, stage-one decision actions with no 429 handling). Round 2 (4) found three MORE pre-existing 429-handling gaps in sibling call sites — a second poller (`SourceImageConfirmModal`), a video-cancel handler, and an eager `createApp()` singleton — plus a dangling plan-file citation; round 1's own fix commit (`f888358d`) was checked file-by-file and touches none of round 2's four target sites, so none are propagation despite the surface-level "more 429 handling" overlap with round 1's own fixes — the closest call this row has, resolved by the rubric's causal test rather than by topic. `breakers fired: none` — every finding converged in its own round with no repeated non-convergence. `pre-open preflight` ~95 minutes: first commit `aab549e9` (20:14:15Z) → PR opened (21:49:02Z). Cohort is `prose/contract` only because the diff carries prose docs (`PR308_*_TEST_RUN`/`UAT`, a `.agents/memory/` note) alongside a 22-file backend+frontend implementation — the same doc-leak pattern this ledger already documents. This PR also carried a large loop-ledger fold-in of its own (rows 18/19/20/21 above plus four exemption-table entries below), entirely unrelated to the rate-limiter feature and excluded from this row's own findings/rounds count. Blind adjudication (fresh-context agent, `get_commit` full-patch verification, no visibility into this classification) landed on the identical 7/0/0/0/0 split — 0% disagreement, the cleanest agreement on record. |
| 23 | [#304](https://github.com/TheAnswerManIsHere/Overhypeme/pull/304) | prose/contract | 7 | 1284 | 129 | 7 | 22 | 6 | 9 | 2 | 1 | 4 | **61.1%** (see note) | 24.5 | — | none | ✓ **13.6%** (3/22, full population) | Merged. This is the PR that designed and hardened the `[LEDGER]`-PR contract itself (`working-modes.md` → "A row ships in a dedicated `[LEDGER]` PR") — the mechanism rows 22 and above now ship through. **Canonical counts above are the blind adjudicator's** (6 new / 9 prop / 2 wrong / 1 re-raised / 4 invalid, 61.1%), not the author's own first-pass classification (8 new / 7 prop / 3 wrong / 0 re-raised / 4 invalid, 55.6%) — per this ledger's standing bias-against-flattery principle (ambiguous causes default to self-inflicted so drift can't quietly flatter the workflow), the more self-critical of two disagreeing readings is what the table itself shows, not just what the prose narrates (a correction made after Codex review on this same row — an earlier draft here put the author's lower figure in the canonical columns and only *mentioned* the adjudicated one, which strands the higher figure in prose text nobody scanning the table would see). Round 1 (2 new ground, 1 invalid — the missing-approved-plan finding, below) has zero self-inflicted findings, matching the established "round 1 is where new ground lives" pattern (an `invalid` finding doesn't count toward either side of the share, so it doesn't break the pattern, but it does mean round 1 here is not a clean 3/3 new-ground round the way #274/#282/#285/#288/#289's round 1s are). One finding (missing approved plan, P1) was escalated to David directly rather than fixed in code; his explicit decision ("hold position," quoted in the PR body's oracle section) settles it as `invalid` (subcase b) on its first occurrence — its round-2 restatement, after an attempted response (a PR-body oracle rewrite) that round 2 judged insufficient, both readings agree is self-inflicted rather than a second `invalid` (invalid is for first occurrences only), but disagree on which self-inflicted category — see the disagreement note below. Three further findings were rebutted with repository evidence rather than fixed (unbounded historical API requests, carrier-identity loss on a post-merge retitle, an equal-second timestamp tie-break with no clean fix) — all `invalid` (subcase a) on both readings, none re-raised in the four subsequent rounds. **Propagation dominates this row on both readings:** `openLedgerPrCarries`, `confirmedLedgerPrNumbers`, and `fetchFileAtRef` were all *created mid-loop* (round 1's and round 2's own fixes, verified against each commit's actual diff, not assumed from commit messages) and then hardened across rounds 2–6 as each pass found another gap in that same new code — arithmetic validation, base-branch filtering, permanence-checking, draft exclusion, and the Contents API's 1MB cutoff all land as defects in code the loop itself wrote, not the original diff. **Adjudication disagreement (3/22, 13.6% — under the 20% gate, so this row is measured, not `unmeasured`):** a blind adjudicator (fresh-context agent, full-patch `get_commit` verification of every fix commit) independently classified 6 new / 9 prop / 2 wrong / **1 re-raised** / 4 invalid (61.1%) against the author's first-pass 8/7/3/0/4 (55.6%). One of four original disagreement candidates was resolved as a factual correction during reconciliation, not left as a judgment-call split: whether `fetchFileAtRef` predated round 2 was checked directly against `git show` on each fix commit and confirmed created in round 2 (`7a6a52c`), not the original diff — the author's first-pass `new_ground` call on that specific finding was wrong and is folded into the propagation count above, in both readings, and no longer counts toward the final disagreement tally. The remaining three are genuine rubric judgment calls, not factual errors on either side, and together account for the full 3/22: (1) the plan-oracle re-raise — the adjudicator classifies it `re_raised`, reasoning that a finding ultimately settled as invalid can only ever produce re-raised restatements, never wrong-fix ones; the author's dissenting reading classifies it `wrong_fix` instead, since a fix attempt (the oracle rewrite) sat between the two occurrences and the rubric's own precedence text says an attempted-and-failed resolution outranks re-raised whenever one intervenes; (2) the incomplete-open-carrier finding (round 2) — the adjudicator classifies it `propagation`, reading the finding as targeting the *new* per-loop timing mechanism round 1's fix specifically introduced; the author's dissenting reading calls it `new_ground`, since the *specific* defect (an open ledger PR deferring debt without containing the relevant row) already existed, undiminished, in the original diff's even-cruder repo-wide `ledgerPrIsOpen` boolean (verified: that boolean checked neither timing nor content), so round 1's fix to the timing dimension didn't cause it; (3) the review-merge-gate/staleness finding (round 6) — same two readings as (2), applied to the backstop-deferral concept as a whole, which the original diff already had in its cruder form. `breakers fired: none` — the plan-oracle disagreement escalated to David after 2 occurrences (raise, reject), within the ~2-round threshold, not past it; no other single point recurred without converging. `pre-open preflight` is `—`, unmeasured: this branch carried unrelated prior-session commits (its oldest commit predates this feature by several days), so the feature's own pre-open history isn't cleanly isolable — same shape as row 10/#285's and row 21/#298's blanks. Cohort is `prose/contract` per the same doc-leak pattern already documented (the diff carries `CLAUDE.md`/`working-modes.md`/`current-roadmap.md` alongside the guard script). |
| 24 | [#319](https://github.com/TheAnswerManIsHere/Overhypeme/pull/319) | prose/contract | 9 | 682 | 18 | 13 | 43 | 14 | 28 | 1 | 0 | 0 | *unmeasured* (see note) | 3.3 | 0 | none | ✗ **unmeasured** (30.2% disagreement, 13/43, exceeds the 20% gate) | Merged. The `/document` harvest for #308 (row 22) itself — an unusually large loop for a docs-only PR: 11 finding-bearing rounds (13 mechanical, including 2 clean passes) and 43 findings, on the same order as this ledger's biggest fully-classified feature/plan-review loops rather than a typical docs harvest. **Counts above are the author's own first-pass classification** (14 new / 28 prop / 1 wrong / 0 re-raised / 0 invalid, 67.4%) — recorded per row 15/#290's precedent for a genuinely `unmeasured` result (>20% gate), not reconciled toward either reading. Round 1 (4/4 new ground) matches the established "round 1 is where new ground lives" pattern. Every one of the 43 findings was fixed in the round it was raised — none rejected, none re-raised with no fix attempt in between, so `re-raised`/`invalid` are both 0 on both readings. **Adjudication disagreement (13/43, 30.2% — over the 20% gate):** an independent blind adjudicator (fresh-context agent, `git show`/`git diff` verification of every fix commit against every finding, no visibility into the author's labels) landed on 18 new / 17 prop / 8 wrong / 0 re-raised / 0 invalid (58.1%). All 13 disagreements are boundary calls, not factual errors either side found and conceded (unlike row 23/#304's one resolved factual correction) — 7 are propagation-vs-wrong-fix splits on a recurring shape this row's loop hit four separate times: a fix explicitly claims to have closed a gap completely (the docs/plans CI-guard scope, the CORS-preflight-bypass characterization, the rate_limit_counters retention scope, the exemption-list finalization), and a later round finds the claim still incomplete on a new specific case. The adjudicator treats every such re-litigation of an explicit completeness claim as `wrong_fix` (same question, fix attempted and wrong, per the rubric's own precedence for this exact shape); the author's first pass treated only the *first* re-litigation in each such chain as the boundary case and called the later ones propagation (a new specific case each time). The other 6 disagreements are new-ground-vs-propagation splits, all on findings citing a *genuinely new*, previously-unnamed pre-existing code fact (`videoJobs.ts`, `enforceGovernance()`, `FACT_SUBMIT_PENDING_CAP`, etc.) inside prose a prior round's fix had *also* touched for an unrelated reason — the adjudicator read these as new ground (the specific fact was never named before, regardless of which round last edited the surrounding paragraph), the author's first pass read the same finding as propagation (attached to prose an earlier fix owns). Both patterns are genuine, defensible rubric judgment calls under real time pressure to verify 43 findings against 11 fix-commit diffs, not carelessness on either side — disclosed per this ledger's standing practice rather than picked. `breakers fired: none` — several topics recurred across non-adjacent rounds (the count-methodology saga spans rounds 2/3/4/5/8/9/10/11; the docs/plans-guard-scope saga spans rounds 3/6/7/9/10), but every individual finding was fixed in the same round it was raised, so no single fix attempt failed twice in a row — the rubric's non-converging-fix breaker never fired even though the *topic* took many rounds to fully cover. `pre-open preflight` is 0: first commit (`de2f7071`, 2026-08-04T23:28:09Z) → PR open (23:28:56Z) = 47 seconds — this branch was cut fresh and opened immediately. Cohort is `prose/contract` (the diff is 9 files, all `.md`, a genuine docs-only harvest — no doc-leak confound here, unlike most `prose/contract` rows in this ledger). |

### Rounds undercounted when a re-review is clean

**`rounds` and `review hrs` are understated for row 11 (#286), row 12 (#288), AND row 16 (#292) — three confirmed instances, not a hypothesis.** This correction (2026-08-01) reverses a mistake this PR's own review loop made and re-made across rounds 5, 8, and 11: each of those rounds accepted Codex's claim that #288's gap was unconfirmed ("nobody captured that reaction directly") without anyone actually checking PR #288's own comment history — the reaction was sitting there the whole time, just never looked at. Resolving this PR's merge against a concurrent PR (#292) surfaced a paragraph making the confirmed claim with exact timestamps; independently re-verified against `get_comments` on PR #288 directly before accepting it (not taken on the merged text's word alone) — see below for what was checked. Row 16 (#292) adds a third confirmed instance from its own history (round 8, against `02bdcac`), found while resolving a later merge (PR #295's branch) against this same file.

After row 11/#286's round-1 fix (`6b04de2`), an explicit `@codex review` trigger drew a genuine second review from Codex against the fix commit — confirmed by its own "Reviewed commit: `6b04de28e6`" line — that found nothing further. That clean result posted as a **plain issue comment** ("Codex Review: Didn't find any major issues. Delightful!"), not as a formal `pull_request_review` submission. `countRounds` and `reviewInterval` only scan the `reviews` collection, so this real reviewer engagement is invisible to both: `rounds` reports 1 where the true reviewer-engagement count is 2, and `review hrs` reports 0.1 (PR-open → the round-1 review) where the true interval runs to the round-2 comment, roughly 2.8 hours. This is a **different** gap than the trigger-counting pitfall `countRounds`'s own docstring already documents and rejects (counting `@codex review` comments instead of formal reviews would miss the automatic on-open review — which is exactly why `countRounds` counts formal review records instead, not a live bias in the approach it actually takes); it lives in the approach `countRounds` *does* take: a re-review that finds **zero** new findings routes through a non-review-object reply path rather than the formal review-submission path on this repo's Codex transport.

**Row 12/#288 is the second confirmed instance, not a candidate.** Checked directly against PR #288's own `get_comments` history: a clean "Codex Review: Didn't find any major issues. :+1:" landed at `2026-07-30T02:05:58Z` (reviewing `5800debd7d`, between this row's counted round 1 and round 2) and a second, "Codex Review: Didn't find any major issues. Swish!", at `2026-07-30T03:32:17Z` (reviewing `62d9e8ab5f`, after the last formal review this row's snapshot captured) — both genuine `chatgpt-codex-connector[bot]`-authored plain issue comments, zero findings, same shape as row 11's. Row 12's `rounds: 5` and `review hrs: 1.6` both undercount the true reviewer engagement by at least these two rounds; the true `review hrs` extends past the snapshot's last captured review to at least `03:32:17Z`. Not re-derived here (rebuilding the row's mechanical columns with plain comments folded in is a real task, not a footnote edit) — recorded as confirmed so a future re-derivation has the exact timestamps rather than needing to re-search for them.

Two confirmed instances is enough to promote this from "one observation" to a documented, repo-wide caveat, recorded in [`working-modes.md`](../../docs/ai-context/working-modes.md#the-loop-ledger) in this same PR — with #288 corrected there too, from the unconfirmed/hypothetical framing three earlier rounds of this PR's own review settled on, to the confirmed second instance it actually is. **This PR already touches `loop-metrics.mjs` once** (round 3's comment-only fix distinguishing #279/#280 as worst-case by round vs. finding count), which retires "whenever that file is next touched for another reason" as a real deferral point for teaching `countRounds`/`reviewInterval` to recognize this shape — that touch happened and didn't fold it in. Doing so is a genuine code change (parsing comment bodies, not just review objects, plus test coverage for the new detection), out of scope for this docs-only PR; it remained an open, unscheduled gap when this passage was written. **It has since been closed** — a later change to `loop-metrics.mjs` taught it to fold plain-comment clean reviews into `rounds`/`review hrs`, and row 17 (#294) is the first row confirmed to benefit: its own final round (a plain-comment clean pass) was counted correctly rather than lost.

`findings` and the causal classification are unaffected: `countFindings` reads root comments directly and a review with zero findings contributes zero root comments either way.

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

**Eleven rows carry a real adjudicated self-inflicted-share percentage** —
every adjudicated row except #284 (adjudicated but with nothing to report:
its one finding is `invalid`, so the denominator is zero; see its own row
note), #290 (adjudicated on both sides, but the two readings disagreed by
25% — above the 20% gate — so its figure is `unmeasured` and excluded here,
per its own row note), #292 (same reasoning: 21.1% disagreement, also
over the gate, also `unmeasured`; see row 16's note), #294 (adjudicated
by two independent readings that broadly agree, but never paired
finding-by-finding into an exact disagreement count — `unmeasured` pending
that reconciliation, not because a gate fired; see row 17's note), and #319
(same reasoning as #290/#292: 30.2% disagreement, 13/43, over the gate,
`unmeasured`; see row 24's note). Naming
all eleven, not a subset, matters: #270 64.7%, #274 68.4%, #276 0%, #282
72.1%, #283 0%, #285 50.0%, #286 0%, #288 35.0%, #289 33.3%, #304 61.1%,
#308 0%. (A concurrent PR — #292 — independently derived #288 at 40.0%
instead of 35.0%; row 12's own note discloses both readings rather than
picking one silently. #292's #289 figure agrees exactly at 33.3%. #304's
figure is the blind adjudicator's reading, the more self-critical of two
that disagreed by 13.6% — row 23's own note discloses the author's
dissenting 55.6%, per the same disclose-don't-silently-pick convention.)

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

**#308 (row 22) is a fourth 0% row, but not a fourth instance of the
structural floor above — it is a genuine measurement.** #308 had **two**
finding-bearing rounds (round 1: 3 findings, round 2: 4 findings), so
propagation and wrong-fix were structurally *possible* there in a way they
never are for #276/#283/#286 — the loop simply didn't produce any: every
one of round 2's four findings was independently verified, against that
round's own fix commit's actual diff, to target a site round 1's fix never
touched. #308 therefore belongs with the multi-finding-round trend loops
below, not with the single-round structural-floor group above, even though
its share happens to be the same number.

**The self-inflicted-share trend is only informative for loops with more
than one finding-bearing round** — where propagation and wrong-fix are
structurally possible — which is #270 (16 rounds, 15 finding-bearing — row 3
notes one review event with zero findings), #274 (4 rounds, findings in
every one), #282 (9 rounds, findings in every one), #285 (5 rounds, findings
in every one), #288 (5 rounds, findings in every one), #289 (2 rounds,
findings in every one), #304 (7 rounds, 6 finding-bearing), and #308 (3
rounds, 2 finding-bearing). #286 does not qualify despite its true two-round
engagement, because only round 1 produced findings. **#290, #292, #294, and
#319 would qualify by round shape but are excluded because their figures are
`unmeasured`, not because they're single-round loops** — the two exclusion
reasons are different and shouldn't be conflated (#319 most emphatically:
11 finding-bearing rounds, the second-most of any row in this ledger after
#270's 15). (#294's causal share is
unresolved for a different reason than #290/#292's gate-tripping — see
row 17's note — but the trend-exclusion result is the same.)

**Of these eight, three are confirmed pre-boundary, four are confirmed
post-boundary, and one (#285) straddles the boundary — this is not a clean
split, and treating it as one would repeat the exact error corrected here
previously.** David enabled Codex "Exhaustive code review"
shortly after 6:56 PM on 2026-07-29 (the ChatGPT settings screenshot he sent
is timestamped then, and he confirmed the change in the same breath) — no
timezone was recorded alongside that timestamp. #270, #274, and #282 all ran
their review rounds before 2026-07-29 entirely and are confirmed
pre-boundary regardless of which timezone "6:56 PM" was in. For #288 and
#289, "any plausible U.S. timezone" is **not** timezone-independent —
Alaska (`-09:00`) puts the toggle at 02:56Z, inside both loops' windows,
and Hawaii (`-10:00`) puts it at 04:56Z, after both loops ended entirely,
so different plausible zones give different (and in Hawaii's case,
opposite) answers. The only non-circular grounding is the same evidence
used for #285 below: this session's own surrounding commits
(`TheAnswerManIsHere`'s commits from 2026-07-28 and 2026-07-29 are
consistently authored at `-06:00`, switching to `-04:00` only starting the
daytime of 2026-07-30) are the best evidence this repo has for what "6:56
PM" actually meant in UTC — 00:56Z. **Anchored to that same `-06:00`
evidence, #288's review window (2026-07-30T02:03–03:20 UTC) and #289's
(2026-07-30T02:17–03:10 UTC) both start well after 00:56Z, so both are
confirmed post-boundary** — grounded in the repo's own commit evidence,
not a "latest plausible timezone" argument that doesn't actually hold.
(#294's own window is unambiguously post-boundary too — starting nearly 21
hours after even the `-04:00`-shifted commits begin on 2026-07-30 — but
it's excluded from this population regardless, per its `unmeasured` status
above.) **#304 and #308 need none of this timezone grounding either**: both
loops' review windows fall on 2026-08-04, nearly a week after the toggle,
so they're confirmed post-boundary the same unambiguous way #294 is.
**#285 is different**: its review window is
2026-07-29T22:39Z–2026-07-30T02:09Z, and 00:56Z falls **inside** that
window, not before it, so #285 straddles the boundary: its earlier
rounds reviewed under the old settings, its later rounds did not. An earlier
draft of this section hedged the #285 boundary call as "unverified" and was
told to drop the hedge (Codex review on PR #290) — at that point nobody had
checked the toggle time against this session's own commit timestamps.
Having now checked it, the straddle is the better-supported reading, so the
hedge is restored — anchored to the `-06:00` evidence above, not left as an
unresolved unknown the way the original hedge was. **A concurrent,
independent backfill of #285/#288/#289's boundary classification exists**
(PR #292): it reports all three as cleanly "confirmed post-boundary,"
using reasoning close to this section's own now-retired "6:56 PM ...
entirely the following day" argument — the same reasoning this section's
own later revisions (rounds 6, 9, 10, and 12 of this PR's own review loop)
found didn't survive checking the actual timezone range or this session's
commit evidence. #292's #285 classification is not adopted here: this
section's straddle finding is the product of that later, more thoroughly
checked analysis, not an equally-valid alternative reading.

**The pre-boundary trend (n=3) stands as originally measured: 64.7% → 68.4%
→ 72.1%, not falling.** **The confirmed post-boundary population is now n=4
(#285 still excluded as a boundary straddle): 35.0% (#288) → 33.3% (#289) →
0% (#308) → 61.1% (#304), in review-order** (#308 merged `56804b2` at
2026-08-04T23:09Z, #304 merged `d67b035` at 2026-08-04T23:20Z). The
"declining slightly" reading this section previously reported from n=2 does
not survive two more points: the four-point sequence drops from a
near-plateau to a genuine, non-structural zero (#308 — see the note above
distinguishing this from the single-round structural floor) and then back
up to the fourth-highest recorded share in the ledger (#304, 61.1%, behind
only #282's 72.1%, #274's 68.4%, and #270's 64.7% — driven by a loop that
spent five rounds hardening code it had itself written mid-loop — see row
23). Four points remains thin evidence for a trend in either direction;
the honest read is that post-boundary self-inflicted share varies loop to
loop with what each loop actually asked of the workflow (novel mid-loop
machinery vs. a well-scoped feature with clean seams), not that review
quality is trending up or down since the toggle. #294 ran a genuinely large
post-boundary loop (2026-07-30T21:23 to 2026-08-01T04:41, unambiguously
post-boundary) but its causal share is `unmeasured` (row 17's note), so it
is not a trend point here, the same way #290 and #292 aren't. **#319 is the
same shape again**: unambiguously post-boundary (merged 2026-08-05, the day
after #304), 11 finding-bearing rounds — more than any of the four rows
that do carry a trend point — but its causal share is also `unmeasured`
(row 24's note, 30.2% disagreement), so it's a fifth loop this section
discloses without counting rather than a fifth trend point. **All four
confirmed post-boundary rows still carry the same `prose/contract` cohort
*label*, but that label was never evidence of a shared underlying PR
shape — and with two more rows now sharing it, that gap is harder to miss,
not easier, which dilutes but doesn't remove the earlier
implementation-vs-docs confound.** #288 and #289 are both classified
`prose/contract` only because
`classifyCohort` checks for any `.md` file before checking the PR's own
fix-tier field (row 12 describes #288 as a 21-file backend/frontend
implementation that happens to carry paired docs; row 13 describes #289 as
a pure documentation-backfill). #304 is the same `prose/contract` leak
again (a devops/process-design PR carrying `CLAUDE.md` alongside its guard
script); #308 breaks the pattern (a 22-file backend+frontend feature PR,
also cohorted `prose/contract` by the same `.md`-file leak, per row 22).
With four different underlying shapes now sharing one label, the cohort
column is even less informative for this comparison than the original n=2
confound already made it, not more — the shared label was never evidence of
a shared shape, and adding rows doesn't fix that, it just makes it more
visible. #285 itself is not discarded as a data point: its 50.0%
self-inflicted share still stands in the row 10 note and in the
eleven-row list above; it is excluded from this specific pre/post-boundary
comparison only, because its own rounds don't sit cleanly on one side of
the line being compared. (#292's alternate n=3 reading — #285 50.0%, #289
33.3%, #288 40.0%, all treated as cleanly post-boundary — is disclosed in
row 12's own note rather than adopted; its #288 figure also differs from
this row's 35.0%, per that same note.)

**Two structural observations, both from counted data rather than
impression, now checked against eight loops instead of six:**

- **Round 1 is where new ground lives.** In #282, round 1 was 11/11 new
  ground; in #274, 5/5; in #285, 7/7; in #288, 5/5; in #289, 6/6; in #308,
  3/3. Six of eight qualifying loops replicate this exactly (#270 ran before
  this ledger tracked per-round breakdowns finely enough to confirm or deny
  it, and #304's round 1 was 2 new ground + 1 invalid — zero self-inflicted,
  matching the pattern's substance, but not a clean X/X new-ground ratio
  since one of its three findings was invalid rather than new ground — see
  row 23's note) — this pattern is not an artifact of the pre-boundary
  reviewer, the plan-review cohort, or any single loop's shape. (#294's
  author classification separately shows 9/9 for its own round 1, but with
  the row's overall causal share `unmeasured`, it's noted in row 17 rather
  than added to this confirmed count. #319's round 1 was a clean 4/4 new
  ground on both the author's and the blind adjudicator's independent
  readings — the one part of that row's classification neither reading
  disagreed on — but the same `unmeasured` exclusion applies to the row as
  a whole, so it's disclosed here rather than folded into the "six of
  eight" count.)
- **Wrong fix dominates propagation in four of the seven loops where the
  comparison applies, not all seven.** #274 (7 wrong-fix vs 6 propagation),
  #282 (38 vs 24), #285 (12 vs 6), and #288 (4 vs 3) all show it. **#270,
  #289, and #304 do not; #308 has no self-inflicted findings at all and
  doesn't enter this comparison.** #270's reversal (18 propagation vs 4
  wrong-fix) is already explained in row 3: this ledger's own bootstrapping
  loop, with propagation findings concentrated in subsystems built
  *mid-loop* (the MCP adapter, the rubric itself) rather than "fixed one
  site, left another." #289's reversal is narrower (2 propagation vs 1
  wrong-fix, on only 3 self-inflicted findings total) and is better read as
  too small a sample to show the pattern than as a genuine counter-example —
  a single finding moving categories would flip it back. **#304 reverses by
  the same mechanism as #270** (9 propagation vs 2 wrong-fix, on the
  adjudicated reading — row 23's note): most of its propagation traces to
  `openLedgerPrCarries`/`confirmedLedgerPrNumbers`/`fetchFileAtRef`, code
  this same loop wrote mid-flight and then hardened across five more
  rounds, not pre-existing code a fix half-repaired. Three of the seven
  comparable loops now reverse the pattern, all three by the identical
  mid-loop-construction mechanism — a real, replicated exception, not
  three unrelated one-offs. **#294's author classification also reverses
  (22 propagation vs 16 wrong-fix), by the largest margin in the ledger,
  and by the same mechanism** — row 17's note traces most of that
  propagation to findings critiquing this same loop's own mid-loop-added
  material — but because the row's causal share is `unmeasured`, this is
  disclosed as a data point from the author's classification rather than
  folded into a confirmed count the way #270/#289/#304 are. This is the
  closest this section has come to testing the dominance pattern on a
  genuinely large
  *pure-docs-harvest* loop the way #270 tested it for code; it just isn't a
  clean confirmation yet, pending #294's own reconciliation. The dominance pattern holds reliably for
  plan-review loops (#274/#282) and for #288 — a 21-file, code-plus-docs
  *implementation* PR (backend, frontend, migration, tests, paired docs;
  cohorted `prose/contract` only because the diff carries docs alongside
  code, not because it's a single-document edit), which is a genuinely
  different loop shape than a plan review. That #288 shows the same
  dominance despite the shape difference is a real replication, not a
  restatement of the plan-review case.

This is a hypothesis at n=3 pre-boundary (not falling) and n=4 confirmed
post-boundary (varying loop to loop, not declining; #285 excluded as a
boundary straddle — a separate issue from, and not fixed by, the
implementation-vs-docs cohort confound the remaining four still partly
carry), not a finding. It is recorded here so the next rows — on either
side of the boundary — can confirm or kill it rather than re-deriving it.

### The cohort rule leaks bugfix loops into prose/contract

Four of this file's seventeen rows (#276, #283, #292 — and #284 only narrowly escaping)
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
| [#301](https://github.com/TheAnswerManIsHere/Overhypeme/pull/301) | prose/contract | Docs/skill-migration + ledger-maintenance PR (CLAUDE.md, `.claude/skills/*`, `.agents/`, `docs/ai-context/decisions.md`; the one script it touches, `check-docs-accuracy.mjs`, is doc-tooling, not product code). Same characterization-tradeoff reasoning as #272 — prose/contract already has a dozen+ measured rows; folded in while resolving PR #308's `check-ledger-coverage.mjs` gate, not part of a scoped backfill event. |
| [#300](https://github.com/TheAnswerManIsHere/Overhypeme/pull/300) | prose/contract | Docs-only — migrates procedural ceremony out of CLAUDE.md into `.claude/skills/*.md` and `lib/api-zod/CLAUDE.md`. No product/tooling code touched. Same reasoning as #301. |
| [#295](https://github.com/TheAnswerManIsHere/Overhypeme/pull/295) | prose/contract | Docs-only — corrects `.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md` and `.agents/metrics/loop-ledger.md` itself. Same reasoning as #301. |
| [#291](https://github.com/TheAnswerManIsHere/Overhypeme/pull/291) | prose/contract | Docs-only manual/architecture-map backfill (`docs/ai-context/architecture-map.md`, `decisions.md`, `docs/manual/README.md`, `background-work.md`). Same reasoning as #301. |
| [#323](https://github.com/TheAnswerManIsHere/Overhypeme/pull/323) | prose/contract | Docs-only — adds `.claude/skills/status/SKILL.md`, a single new read-only skill file. No script, no workflow, no product code. Same reasoning as #301/#300. |
| [#324](https://github.com/TheAnswerManIsHere/Overhypeme/pull/324) | prose/contract | Docs-only — wires workstream-label maintenance into four existing skill files plus two new `.agents/memory/` notes (9 files, all `.md`). No script or workflow touched. Same reasoning as #301/#300. PR body states explicitly: "Docs-only, no product surface." |

**Why these eleven and not others.** All eleven are prose/contract loops, the
cohort that already had measured rows (#268, #270, #276, and many since) at
the time each was scoped out. Backfilling them would have re-confirmed a
cohort we can already characterise while cohorts that could not be
characterised at all (bugfix, plan-review) stayed empty or thin. That is a
defensible trade, but it is a trade: the prose/contract sample stays smaller
than it could be, and no claim about prose-loop trend should be made as
though these eleven were measured and clean. #301/#300/#295/#291 were added
2026-08-04 while resolving PR #308's `check-ledger-coverage.mjs` failure — a
gate failure surfaced on an unrelated PR, not a dedicated backfill session —
applying the exact reasoning David already set for #272/#273/#275/#277/#278
rather than a new decision. #323/#324 were added 2026-08-05 for the same
reason, resolving PR #327's own coverage gate. **Not exempted, deliberately:**
the same #327 fold-in added real (not exempted) rows for #318 (feature/code)
and #322 (bugfix) — see rows 25/26 below — the two cohorts this table's own
precedent says must be measured, not the cohort already well characterised.
See row 6 (#279) and row 14 (#280)'s notes for why some of those rows are
mechanical-only rather than fully causally classified: this table rejects
"deferred because it's a lot of work" as an exemption reason (see "#280 is
not in this table" below), so those three got real rows, not entries here,
even though full causal classification was deferred on the largest of them.

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
