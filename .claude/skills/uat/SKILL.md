---
name: uat
description: Run a UAT session with David step by step, in chat, instead of handing him a markdown file to read alone. Use when he says /uat, "let's test PR N", "walk me through the UAT", "I'm ready to test this", or "resume the UAT". Starts from this session's own context — work it just merged or delivered that owes a run is the run (unless it handed that workstream to a session /handoff started, which took the run with it), and only a session with nothing to test searches the repository for every run owed. I do the setup, settle every machine-lane step first — citing what the lifecycle already ran (the PR gate's `ci` checks, the PR's `scripted` record, close-out's `live` checks) and running only what nothing ran (a screen fact whose action I can perform is mine to check in a browser, whatever the script labels it; one only his own account or device can perform stays his; what an AI-generated image shows, beyond what anyone would verify the same way, is always his), present only the judgement steps to him one at a time, record Pass/Fail/Blocked/Skipped per step, capture evidence on anything that isn't a clean pass, file the bug and the way back the moment something breaks, and leave a durable run record any session can resume from. NOT for writing a UAT script — that's `pr-docs`.
---

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# /uat — I run the test session, David does the judging

The UAT script is the **script I drive**. David tells me what he saw and I
own everything else: the setup, the place, the record, the bug intake, and
the way back.

The script is written per [`pr-docs`](../pr-docs/SKILL.md), on its PR before
merge, and is the script his judgement steps come from (the machine-lane
steps in it are mine, section 3). **It is the `## UAT` section of the PR
body**, not a file under `docs/tests/UAT/`, so
there is nothing to delete when a run completes — the workstream's
`stage:uat` label says a run is owed, and section 1 reads that. A **legacy
doc** still in `docs/tests/UAT/` on a consumer's `main` is the one case the
old file rules survive for: driven from the file, deleted when he confirms
its run complete (section 6). Everywhere below, "the script" is the body
section or that legacy file, and the format is the same one heading level
apart ([`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md)).

**The UAT script is not published as an Artifact page.** If he wants one
for a solo run he asks.

## 1. Find the run, confirm it, preview it

An invocation may name a PR, an issue, or nothing. One that names a PR or
an issue is the run, whatever this session did. One that names nothing
starts with this session, and only reaches the repository-wide search when
the session holds nothing to test.

0. **First, the work this session just finished.** Before any search, read
   my own context for the units of work this session took to a merge or
   delivered — the PRs whose merge report I wrote here, and a workstream
   handed to this session by a `/handoff` prompt, which is this session's
   work by inheritance. A workstream this session handed to a session the
   `handoff` skill started is no longer its own, whoever wrote the merge
   report: its run, owed or paused, went with it (the `archive` skill,
   Step 1 item 8). Context compaction keeps the summary of them, and
   the summary is enough to name them; nothing else is read for this step.
   A PR of this session's that has not merged is not finished work — the
   Repl tracks `main`, so there is nothing of it for him to click — and is
   named in one line as untestable until its merge, never run.
   For each, the same script lookup item 1 makes — the PR body's `## UAT`
   section, else a legacy doc on current `origin/main`. Then:
   - **None of them owes a run** — no such unit, every one already has a
     finished run record (section 5), or every one had no script
     (an internal, Trivial, Documentation or bugfix change with no UAT
     section; a prototype version, whose verification is his feedback, not a
     run) → **the session is new as far as UAT is concerned**: say so in one
     line and continue at item 1, unchanged.
   - **At least one owes a run** → **those are the only candidates.** I do
     not run item 1's repository-wide search, and I do not list other
     workstreams' runs or held runs; item 2's interrupted-run check reads
     only these workstreams, and item 3 picks among them. One at
     `stage:uat` is startable. One still short of `stage:uat` is this
     session's own unfinished close-out, not someone else's held run: what
     is mine to move it — the Repl sync, the Post-merge verification, the
     label — I finish now (`pr-watch`), then start the run; one the
     lifecycle is holding on a failed check is reported as held, with what
     failed, and never started, and I do not substitute another
     workstream's run for it. If he wants a different run he names it, and
     that override goes in the run record like item 1's.
1. **Find the candidates from the lifecycle, not from a directory.** The
   runs owed are the workstream issues at `stage:uat` (`list_issues` by
   label): that label is what `pr-watch` sets once the merge's sync is
   verified and the post-merge checks pass, and it is the only oracle —
   `pr-watch` deliberately holds a workstream at `stage:test-run` while
   verification is pending or failed, and offering such a run would start
   David testing a build the lifecycle is withholding. For each candidate,
   the script is the `## UAT` section of the PR its State of Play names
   (`pull_request_read` for the body); a workstream at `stage:uat` whose PR
   body has no such section is checked for a **legacy doc** on current
   `origin/main` — `git fetch origin main`, then `docs/tests/UAT/PR<N>_*_UAT.md`
   as of `origin/main`, never my checkout, which can carry a doc he already
   deleted or miss one that just merged — and driven from that file; one
   with neither is listed as "no script found", never run from memory.
   **Then list what the lifecycle is holding**: every open workstream short
   of `stage:uat` — at `stage:code-review`, `stage:merge` or
   `stage:test-run`, wherever the lifecycle left it — whose PR has merged
   and has a script by the same lookup, the body's `## UAT` section or else
   a legacy doc on current `origin/main`. Each is listed as "not ready —
   held at <stage>", never offered as startable, so a close-out interrupted
   before the label moved, or a PR merged by hand with no session to finish
   it, still shows its run rather than hiding it; the merged test keeps an
   ordinary PR still in review out. David can override explicitly, and that
   override goes in the run record.
2. **Check for an interrupted run first.** Read the workstream issue body for
   a `## UAT run` section (section 5) whose verdict is `in progress`. If one
   exists, offer to **resume at its recorded step** — and re-do any setup it
   records as owed (section 2), since a paused run tears its setup down.
3. **One candidate → start it. Several → ask which**, one question under its ID (`claude-core.md`, interaction rule 4).
   **None → say so** and don't invent a run.

Then give him a **three-line preview before the first step**, never the whole script:
how many machine-lane checks are settled and how many steps are his, in
`### Steps` and in `### Regression` (section 3), what I'm setting up for him
(section 2), and anything he needs on hand — an admin login, a phone, a fresh browser tab. The script's
narrative preamble is mine to have read, not his to sit through.

## 2. Setup is mine, and so is putting it back

**Anything mechanical that stands between David and the first step, I do.** Seeding rows, creating a test account, putting config in a
known state, confirming the Repl is synced and the app is up. He should
arrive at the first step with the app already in the state the test needs.

Four rules, because setup writes to the live app:

- **Name what I created, out loud, in the preview.** Test data that nobody
  labelled as test data is indistinguishable from real content the moment
  the session ends. Say "I created fact #4821 and user `uat-tester`" so he
  can recognise them later.
- **Capture the restore path before the write — and write it down before
  the write, too.** The same discipline
  [`test-run-contract.md`](../../../docs/tests/test-run-contract.md) puts on
  any live-environment write, plus a durability rule: the planned mutation
  and the captured original value go into the issue-body run record
  **before** the first live write, not after setup completes. Written
  after, a crash between the mutation and the checkpoint loses both the
  original value and the teardown obligation — for a budget-limit change,
  that's production misconfigured indefinitely with no record of what to
  restore. If something can't be cleanly undone, say so *before* doing it
  and let him decide.
- **Teardown runs before the run stops — at the end, and equally before a
  pause.** A production-safety rule: UAT scripts put the live app into
  deliberately wrong states (e.g. Overhype.me's PR #443 script lowers `budget_limit_legendary_usd`, the
  **real** Legendary spend limit, and putting it back at the end). A run paused mid-bugfix can sit for days, so a pause
  that skipped teardown would leave production mis-configured for exactly
  that long. Tear down, record in the run what setup is owed on resume, and
  re-create it when he comes back.
- **Say plainly what I can't set up.** On the deployed build I have no
  admin session: the live-environment connector reads, it does not click,
  so admin-gated setup *there* falls to David, as exact click steps in the
  preview, not as a vague "get the app ready." That is the deployed build
  only. On a local stack at the commit under test, the test identity the
  consumer's per-PR browser job already signs in with is mine (Overhype.me:
  the seeded test accounts and the dev-admin login), which
  is what lets me run a screen check myself (*Where the browser automation
  lives*, in [`lanes.md`](lanes.md)); a consumer whose gate has no such identity has not settled
  it, and a screen check behind a login there is a `[david]` setup line or
  stays his, never an identity I invent.

Setup for a step read on the deployed build runs through the Replit
connector per CLAUDE.md's connector policy, and it is a **deliberately
mutating** action — scope it explicitly, or Replit Agent will helpfully
build a feature instead. Setup for a step I read in a browser against a
local stack is applied to that stack instead (section 3): the same
`[claude]` lines, seeded into the throwaway database the browser opens,
never written to the deployed build and read locally.

## 3. The walkthrough — one step, minimal context, cheap pass

**The step list is a lookup, not a judgment.** Every UAT script is written to
[`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md), which exists so
this is true:

> A step is any `#### ` heading inside `### Steps` or `### Regression` of
> the PR body's `## UAT` section, in document order. Nothing else in the
> body is a step.

(A legacy doc is the same rule one level up: `### ` inside `## Steps` or
`## Regression`.)

So enumerate once at the start, say the counts in the preview ("7 steps,
then 4 regression checks" — each count split by lane, below, since the
machine-lane ones are settled before he starts), and present them in order
— the regression checks are steps in every sense that matters here:
presented, recorded, and counted toward the verdict in section 6. There is nothing to infer and nothing to
classify about *which headings are steps*; if a script doesn't parse this way
it is not in the format, and the answer is to fix the script, not to guess. (Which
lane a step is in is a different reading — its `Expect`'s clauses, below —
and a label that disagrees with them is the script-wrong case, not the
authority.)

**Lanes decide who verifies each step, and only `human` reaches David**
([`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md#lanes-where-each-step-is-verified-david-2026-10-07))
— and a `human` step whose `Expect` a screen can answer is read as a
machine step, whatever its label, except what an AI-generated image shows,
which stays his ([`lanes.md`](lanes.md), its last bullet and *Where the browser automation lives*).
**The commit under test** is the commit the run verifies: **the Repl's
checked-out commit when the run starts** — the same SHA close-out's sync
check reads — and it must **contain the PR's merge commit** (an ancestor
check, `git merge-base --is-ancestor <merge> <deployed>`). Usually it is a
later commit on `main`, because other PRs merge while a run waits; that is
the build he clicks. If it does not contain the merge, the Repl is behind:
the run is Blocked on the sync, never run against an older build. I record
both SHAs in the run record before the first step. On resume I re-read the
Repl's commit; if it has moved, what ran here at run time — a `live`
check, a capture, a screen fact — runs again at the new commit, and every
earlier result keeps the commit it ran at rather than becoming evidence
for the new one.

**`/uat` runs a machine check only when nothing earlier in the lifecycle
has run it.** A
check is worth running again only when something it depends on changed
since it last ran, and by the time a workstream reaches `stage:uat` the
lifecycle has already run nearly all of them: the PR's required gate ran
every `ci` check on the merged head, the PR recorded its `scripted`
proofs before the merge (`pr-docs`), and close-out ran the `live` checks
in its Post-merge verification before the label moved (`pr-watch`, which
holds a workstream at `stage:test-run` until they pass). Code merged since
is `main`'s own CI's to check, not a UAT session's. So before the first
human step I settle each machine-lane step **in document order**, show
him the result in one block — never one per turn, and never as a
question — and run only what nothing ran. Machine-lane checks are
self-contained by the format's rule; a script whose machine step depends
on a human step's state is the script-wrong case below, never a check to
run early:

**What settles each lane** — `ci`, `scripted`, `live`, `capture`, a
`Deferred:` step, and a `human` step whose `Expect` a screen can answer — and
what the preview then says, is [`lanes.md`](lanes.md), with *Where the browser
automation lives*. **Read it before settling the first machine-lane step.**

**Every step is shown under its static ID**: `T1`, `T2`, … for `### Steps` and `R1`, `R2`, … for `### Regression`, read
from the script's own headings (`uat-doc-format.md`, *The rule that makes it
deterministic*), so a step keeps its ID when machine-lane steps are settled
around it, when the run pauses and resumes, and when it is re-presented. A
turn opens with the ID in bold — `**T3 — Search results read as the right
answers**` — and he may answer with it ("T3: pass", "T3: the second result
is wrong") or with a bare reply, which belongs to the one step on screen. A
legacy script numbered `1.`, `2.` is shown as `T1`, `T2`.

**One step per turn.** What to do, what to expect, nothing else — not the
next step, not the section after, not the reasoning behind the expectation
unless he asks, and not a hand-back summary: a walkthrough turn is the step
itself, and the run's summary goes in the end-of-run hand-back
(`claude-core.md`, *A reversible choice proceeds, and every hand-back says what it did*, rule 2). He is clicking, not reading.

**"Yes" advances.** Any short affirmative — yes, y, ok, next, worked — is a
Pass; I record it and move on without commentary. Anything else is a real
report and gets read as one.

Four statuses, and they mean different things:

| Status | Means |
| --- | --- |
| **Pass** | Did it, got what the script said |
| **Fail** | Did it, got something else |
| **Blocked** | *Couldn't* do it — button missing, app down, precondition absent |
| **Skipped** | Deliberately not run this time |

**Blocked is not a worse Fail, it's a different branch.** A Fail usually
leaves the rest of the run testable; a Blocked step often makes everything
downstream of it untestable. On a Blocked step, say which remaining steps
depend on it and propose skipping exactly those — don't march him through
steps that cannot produce a signal.

**"It sort of worked" gets one question, never a forced verdict.** The
question is a real one — did the result differ from what was expected, or
was it just slow, ugly, or awkward? — and the answer often splits the step:
record it honestly as partial ("parts 1–2 fine, part 3 wrong") rather than flattening
it into one Pass or one Fail. A multi-part step is allowed to have a
multi-part result; the roll-up in section 6 handles it.

**Two reports that are not step failures**, and mis-filing them is expensive
in both directions:

- **"That's what it says, and I don't like it."** The step did what the
  script said it would. That's a Pass plus a **product note** — a
  behavior-change request, not a defect. It becomes a backlog issue, never a
  bugfix branch. This is the Tier C shape from
  [`working-modes.md`](../../../docs/ai-context/working-modes.md) arriving
  in a testing session, and treating it as a bug is how a design decision
  gets fixed without ever being decided.
- **The script's expected result is wrong.** My error, not the product's — and
  **the step still has to be run against the corrected expectation, in this
  run, before it counts as anything.** Mark it `Skipped — script wrong`, say
  what the expectation should have been, and **re-present the step
  immediately**. A wrong oracle that merely gets skipped lets a real
  regression pass as a clean acceptance, because section 6 counts a
  reasoned Skip toward `Accepted` — the product was never actually checked.
  Fixing the script itself happens at close-out (section 6); re-running the
  step happens now.

## 4. When a step fails — file it now, then ask

A bugfix session starts immediately, and I start it. Evidence first, a
one-word severity, the disclosure check, the bug filed, the way back recorded
in the same edit, a fresh session for the fix, and the private path for a
sensitive one: [`failure.md`](failure.md). **Read it the moment a step is not
a clean pass, before anything is written or filed.**

## 5 and 6. The run record, and ending a run

State lives on the workstream issue body, as a `## UAT run` section, and a
run ends by its own rules: [`run-record.md`](run-record.md). **Read it before
the first write to the record, and again before ending a run.**

## Notification discipline during a run (David, 2026-08-21)

A live walkthrough is a conversation: nearly every turn ends with a question
by construction, and firing the 🛑 banner and a push for each one would make
interaction rule 6 unusable exactly where he's most present. So, **scoped to
an active run**: ordinary step-by-step turn-taking — including the
continue-or-pause question right after a failure — gets **no banner and no
`PushNotification` call**. A step's Pass/Fail verdict carries no question
ID of the `Q` kind, since the step's own `T` or `R` ID identifies it; every other question in the run
(the "sort of worked" question, continue-or-pause, which priority) carries
its ID like any question (`claude-core.md`, interaction rule 4). He's at the keyboard; that's the premise of the
session. The alert hook rings nothing on those turns either: a walkthrough
turn carries no banner and no plan-done line, which are the only hand-backs
the hook rings for — beyond a permission prompt the session parks on and a
turn that dies on an error, which ring whenever they happen
(`claude-core.md`, interaction rule 6).

The banner and the push fire normally when the **run ends** needing a
decision from him, when an ask would hold work up after he's walked away, or
when he's gone quiet mid-run and something needs him. This is a deliberate,
narrow carve-out from interaction rule 6 rather than a drift away from it —
written down so a later session doesn't "fix" it back.

## Model tier

The walkthrough is conversational and cheap; the judgement calls in it are
not. Severity reads, the is-this-a-bug-or-a-design-change split, and the
bug intake all happen in **my main loop** — never routed to a subagent,
which would be a cold worker guessing at a session it didn't sit through.
No tier switch and no ask: a walkthrough is not building, so it runs on
whatever the session is (`CLAUDE.md`'s *Model, cost, and routing* asks for
Opus only before product code).
