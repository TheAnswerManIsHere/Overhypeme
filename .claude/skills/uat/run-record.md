<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# /uat — the run record, and ending a run

Part of the `uat` skill ([`SKILL.md`](SKILL.md)), its sections 5 and 6, moved here whole.
Read it before the first write to the run record, and again before ending a run.

## 5. The run record — mutable, batched, resumable at the step

State lives on the **workstream issue body**, as a `## UAT run` section
alongside State of Play. **The body, not a comment, and that's a mechanical
constraint rather than a preference:** the available GitHub tools can
*create* a comment (`add_issue_comment`) but cannot *edit* one, while
`issue_write` updates the body freely. A record that has to be rewritten at
every checkpoint therefore cannot live in a comment — it would either freeze
after setup or fan out into a dozen comments, and a resuming session would
have no reliable way to tell which is current.

```markdown
## UAT run — PR #472 · Admin help system

**Script:** PR #472, `## UAT` (a legacy run names its file: `docs/tests/UAT/PR<N>_…_UAT.md`)
**Commit under test:** `<Repl's checked-out sha>` (contains merge `<PR merge sha>`)
**Started:** 2026-08-21 · **Last updated:** 2026-08-21
**Verdict:** in progress

| Step | Status | Note |
| --- | --- | --- |
| T1 · Manual renders (ci) | Pass | settled at merge — PR gate (`adminHelp.spec.ts`) |
| T2 · Deep link (human, run in browser) | Fail | #903 — landed at chapter top, not the heading; a screen fact, read by me at 1440 px, so the lane is corrected in the PR body at close-out |
| T3 · Search results read as the right answers (human) | Pass | |
| T4 · Nothing feels missing from the chapter list (human) | — | not yet run |
| R1 · Sidebar unchanged (ci) | Pass | settled at merge — PR gate (`adminHelp.spec.ts`) |
| R2 · Chapter diagram drawn in the Manual (capture) | Pass | shot `manual-diagram` at the commit under test, evidence `<link at the evidence commit>`; read: every box labelled, arrows run left to right |
| R3 · Readable on his own phone (human, his device) | — | not yet run |

**Setup owed on resume:** `budget_limit_legendary_usd` → 0.01 (real value
2500.00 captured, restored at pause)
**Bugs filed:** #903 (major)
**Product notes:** none
**Lifecycle gaps:** T2 — screen fact labelled `human` (lane corrected in PR #472's body)
**Resume at:** T4 (2 judgement steps remaining, T4 and R3; T2's screen fact was mine and is recorded; the 3 machine-lane checks are settled: 2 at merge, the capture at this commit)
```

**The `Lifecycle gaps` line is how the scripts learn.** It lists every check this
run had to do because the script or the PR left it to the session — a
screen fact labelled `human`, a `scripted` step with no recoverable
output, a `live` step whose check was missing from Post-merge
verification — one entry per step, by kind, or `none`. A `live` re-run
because the Repl moved is not a gap, and nor is a missing record on a PR
merged before 2026-11-13. Its reader is the `/maintenance` pass's process
health (step 6b), which counts the kinds across the window; a kind that
recurs becomes a `pr-docs` or `check-uat-format.mjs` change, per
*Recurring failure patterns become CI guards*.

**Write it on the moments that matter, not every turn:** once after setup
(so the record exists before anything can be lost), on every non-pass, on
pause, at the end, and every fifth step through a clean stretch. A record
written every turn costs a round trip per step and buys nothing a five-step
gap doesn't.

**An ACCEPTED run finalizes; a BLOCKED run stays live.** On either accepted
verdict, post the final record once as a comment — the permanent, immutable
history — and clear the body section so the next run starts clean. A
**Blocked** run does neither: its `## UAT run` section stays in the body
with verdict `blocked — resumes after #<bug>`, because that section is the
only thing section 1's resume path searches; finalizing it would make a
cold `/uat` start a fresh run instead of resuming at the recorded step with
the owed setup. A re-run after an accepted-with-issues ship is a fresh
`## UAT run 2 — …` section, never an edit of a previous run's results.

**Keep the State of Play's `To resume` field pointed at it**, per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md).
That field is what a cold session actually reads first.

## 6. Ending a run

Roll the step statuses up into one verdict — and roll up from the **steps**,
never from a general impression of how it went:

| Verdict | When |
| --- | --- |
| **Accepted** | Every step executed and Passed — **every step section 3 enumerated, regression checks and machine lanes included**; a `Deferred:` step is never a pass: it is left out of "every step" only when another step in the same run Passed the behaviour it would check; when it is the only evidence for a behaviour the PR claims, the run is **Blocked**, resuming after its owner issue lands. A mechanical step is never turned into a human one to get past a deferral: David's share is judgement only. A Skip counts toward this only when **David explicitly called the step not-applicable** — a reason alone doesn't qualify, or a run where he lacked a phone or a test account could skip its way to a clean acceptance without exercising anything. A step he *couldn't* do is `Blocked`, which never counts. The script-wrong case counts only re-run per section 3 |
| **Accepted with issues** | Failures exist and **David explicitly accepts each one as shippable**. Minor/cosmetic is the normal case; accepting a major is his call to make in so many words, never a default |
| **Blocked** | Any failure David hasn't accepted — a showstopper or an unaccepted major ends the run here even when more steps were testable — or too much skipped/untestable to honestly call it either way |

A run that stops with required coverage unexecuted and no decision from him
isn't a verdict at all — it's a pause, and the record stays `in progress`.

Then, in one edit:

- **Do the teardown** I owe, and confirm it in the record.
- **Set the labels from the verdict**, and update the **State of Play block
  in the same edit** — Stage, Waiting on, Last movement, and the narrative,
  not just `To resume`. `workstream-tracking.md` requires the block and the
  labels to move together, and a clean run that left the body saying "UAT,
  waiting on David" while the labels said close-out would be exactly the
  drift that rule exists to prevent.

| Verdict | Stage | Waiting | The bugs |
| --- | --- | --- | --- |
| **Accepted** | `close-out`, then `done` when nothing remains (below) | `claude` | none |
| **Accepted with issues** | same as Accepted | `claude` | **de-linked** — remove their `Blocked by:` markers; they are tracked independently now |
| **Blocked** | stays `uat` | `claude` — **recording the prior holder** (`was waiting:david, mid-UAT`) in the same State of Play line, exactly as `bugfix` intake does: `pr-watch`'s blocker-pop restores a holder only from that stashed value, so without it the workstream stays agent-held after the fix instead of returning to David | stay linked; the run resumes after the fix |

  **`Accepted with issues` really does reach close-out.** Every failure in a
  run has already produced an outstanding bug, so a blanket "any outstanding
  bug means hold at `uat`" rule would make this verdict unreachable —
  David could explicitly say ship the cosmetic ones and the workstream would
  sit at `uat` forever, with the bugs still blocking it. Him accepting the
  run is exactly what converts those bugs from blockers into ordinary
  independently-tracked work.

- **On an accepted verdict, drive close-out to done rather than parking
  there.** An accepted UAT is the last David-gate; what remains of close-out
  is mine (the harvest-notes comment for a production-phase product feature — a prototype-phase one posts none, per [`working-modes.md`](../../../docs/ai-context/working-modes.md#the-prototype-phase-per-feature-david-2026-09-26) — any outstanding
  item the State of Play lists). Do what remains, and when nothing is left,
  set `stage:done` and close the issue as completed, with a comment naming
  the PR(s) — the shared rule is
  [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md#closing-an-issue)'s
  *Closing an issue*. Only when a real close-out item
  genuinely can't be finished now does the workstream sit at
  `stage:close-out`, with that item named in the State of Play.
- **If this workstream is a phase sub-issue and the verdict reached
  close-out, do the parent edits too** — tick this phase's line in the
  parent's Phases checklist, re-point the parent's `waiting:`, and if this
  was the last phase, move the parent to `stage:close-out` and close it out
  in the same pass under the same shared rule (its own State of Play items,
  `stage:done`, closed naming the phase PRs, or held with a named item). `pr-watch`
  normally owns those edits at the moment a phase reaches `stage:close-out`,
  but it finished when the PR merged and nothing wakes it again — so if I
  skip them, nothing performs them and `/next` keeps treating a finished
  phase as active.
- **Log product notes as backlog issues with complete backlog labels** —
  a concrete priority (`queue:now` / `queue:next` / `queue:later` — ask
  David which, he's right there; default `queue:next` if he waves it off)
  plus a `mode:` label and **no** `stage:` label, per
  `workstream-tracking.md`'s backlog contract. A bare `queue:` shorthand
  creates an item `/next` can't rank and the board can't display.
- **Fix the script** where a step's expected result or lane was wrong: an
  edit of the PR body's `## UAT` section (`update_pull_request`), with the
  corrected text already quoted on the step's row in the run record, which
  is the pinned evidence. No PR, no commit — the body is not under the
  guard after merge, and the record is where the result lives.
- **Every `Deferred:` step still in the script is recorded on its owner
  issue** — one comment there naming the PR, the step and the check still
  owed — so the obligation does not depend on anyone re-reading a merged
  PR's body. A step not yet recorded there blocks the close-out.
- **Nothing is deleted.** The script stays in the
  merged PR's body as history; the `stage:uat` label leaving is what says
  the run is no longer owed, and section 1 discovers from the label. **A
  legacy doc is the exception**: a run driven from a file under
  `docs/tests/UAT/` deletes that file once he confirms the run complete, in
  the same close-out — unless it is the only written description of some
  behaviour, which is a gap in the Manual, not a reason to keep a test:
  harvest it into the right chapter, say so, then delete. "It might be
  useful later" is not a reason; a re-run of a merged PR's UAT is written
  fresh from current behaviour, not resurrected.
- **Tell him what he's holding**: verdict, bugs filed with severities, what
  he can do next — and, last, the run's plain-English summary
  (`claude-core.md`, *A reversible choice proceeds, and every hand-back says what it did*, rule 2), with a 🛑 banner when what he
  can do next is something the work waits on, or on the
  `✅ **PLAN DONE** —` line when an accepted run finished the approved work
  and nothing of mine is scheduled after it.
