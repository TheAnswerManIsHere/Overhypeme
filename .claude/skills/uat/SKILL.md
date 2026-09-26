---
name: uat
description: Run a UAT session with David step by step, in chat, instead of handing him a markdown file to read alone. Use when he says /uat, "let's test PR N", "walk me through the UAT", "I'm ready to test this", or "resume the UAT". I do the setup, present one step at a time, record Pass/Fail/Blocked/Skipped per step, capture evidence on anything that isn't a clean pass, file the bug and the way back the moment something breaks, and leave a durable run record any session can resume from. NOT for writing a UAT doc — that's `pr-docs`.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# /uat — I run the test session, David does the judging

The UAT doc stopped being something David reads and became the **script I
drive** (David, 2026-08-21). He used to open a markdown file in one window
and the app in another, keep his own place, and remember what failed. Now he
tells me what he saw and I own everything else: the setup, the place, the
record, the bug intake, and the way back.

**What has not changed:** the doc is still written per
[`pr-docs`](../pr-docs/SKILL.md), still lands on its PR before merge, still
David's own to-do list, and **I delete it once he confirms the run
complete** (David, 2026-08-22) — see section 6.

**The UAT doc is no longer published as an Artifact page (David,
2026-08-21).** That reading surface existed because he was reading alone; the
session replaced it. If he ever wants one for a solo run he asks.

## 1. Find the run, confirm it, preview it

An invocation may name a PR, an issue, or nothing.

1. **Find the candidate docs on current `origin/main` — not in my checkout.**
   `git fetch origin main`, then list `docs/tests/UAT/PR<N>_*_UAT.md` as of
   `origin/main`. Every file still present *there* is unfinished — deletion
   on his confirmation (section 6) is what completes one. My working tree
   is the wrong
   oracle in both directions: an older branch still carries docs he already
   deleted (so I'd offer a finished run), and a stale checkout misses one
   that just merged.

   **Then filter by lifecycle: offer only docs whose workstream is at
   `stage:uat`.** A doc's presence on `main` proves its PR merged, nothing
   more — `pr-watch` deliberately holds a workstream at `stage:test-run`
   while post-merge verification is pending or failed, and offering that doc
   would start David testing a build the lifecycle is withholding. Resolve
   each candidate's workstream issue (the doc names its PR; the PR body
   names the issue) and check the label. A doc whose workstream isn't at
   `stage:uat` is listed as "not ready — held at <stage>", never offered as
   startable; David can override explicitly, and that override goes in the
   run record.
2. **Check for an interrupted run first.** Read the workstream issue body for
   a `## UAT run` section (section 5) whose verdict is `in progress`. If one
   exists, offer to **resume at its recorded step** — and re-do any setup it
   records as owed (section 2), since a paused run tears its setup down.
3. **One candidate → start it. Several → ask which**, one numbered question.
   **None → say so** and don't invent a run.

Then give him a **three-line preview before step 1**, never the whole doc:
how many steps and how many regression checks, what I'm setting up for him
(section 2), and anything he needs on hand — an admin login, a phone, a fresh browser tab. The doc's
narrative preamble is mine to have read, not his to sit through.

## 2. Setup is mine, and so is putting it back

**Anything mechanical that stands between David and step 1, I do** (David,
2026-08-21). Seeding rows, creating a test account, putting config in a
known state, confirming the Repl is synced and the app is up. He should
arrive at step 1 with the app already in the state the test needs.

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
  pause.** This is not a tidiness rule, it's a production-safety one: real
  UAT scripts put the live app into deliberately wrong states, and
  `PR443_BUDGET_GATE_FAIL_CLOSED_UAT.md` is the worked example — it lowers
  `budget_limit_legendary_usd`, the **real** Legendary spend limit, and puts
  it back at the end. A run paused mid-bugfix can sit for days, so a pause
  that skipped teardown would leave production mis-configured for exactly
  that long. Tear down, record in the run what setup is owed on resume, and
  re-create it when he comes back.
- **Say plainly what I can't set up.** I have no admin session — every
  `/admin/*` route answers *Access Denied* to me, which is the same
  limitation that made admin click-throughs UAT-shaped in the first place.
  Admin-gated setup falls to David, as exact click steps in the preview, not
  as a vague "get the app ready."

Setup runs through the Replit connector per CLAUDE.md's connector policy,
and it is a **deliberately mutating** action — scope it explicitly, or Replit
Agent will helpfully build a feature instead.

## 3. The walkthrough — one step, minimal context, cheap pass

**The step list is a lookup, not a judgment.** Every UAT doc is written to
[`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md), which exists so
this is true:

> A step is any `### ` heading inside `## Steps` or `## Regression`, in
> document order. Nothing else in the file is a step.

So enumerate once at the start, say both counts in the preview ("7 steps, then
4 regression checks"), and present them in order — the regression checks are
steps in every sense that matters here: presented, recorded, and counted
toward the verdict in section 6. There is nothing to infer and nothing to
classify; if a doc doesn't parse this way it is not in the format, and the
answer is to fix the doc, not to guess.

**That determinism is the point, and it was bought the hard way.** The first
version of this skill tried to infer coverage from whatever shape a doc
happened to have. It couldn't — six-plus conventions for the regression
section, eleven docs with no numbered steps — and the failure mode was the
worst available: pass every feature step, declare `Accepted`, never run the
sweep. A false pass makes this session *worse* than the file it replaced.
Hence one format, one rule (David, 2026-08-22; #554, #560).

**One step per turn.** What to do, what to expect, nothing else. Not the
next step, not the section after, not the reasoning behind the expectation
unless he asks. He is clicking, not reading.

**"Yes" advances.** Any short affirmative — yes, y, ok, next, worked — is a
Pass; I record it and move on without commentary. Anything else is a real
report and gets read as one.

Four statuses, and they mean different things:

| Status | Means |
| --- | --- |
| **Pass** | Did it, got what the doc said |
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
record it honestly as partial ("1–2 fine, 3 wrong") rather than flattening
it into one Pass or one Fail. A multi-part step is allowed to have a
multi-part result; the roll-up in section 6 handles it.

**Two reports that are not step failures**, and mis-filing them is expensive
in both directions:

- **"That's what it says, and I don't like it."** The step did what the doc
  said it would. That's a Pass plus a **product note** — a
  behavior-change request, not a defect. It becomes a backlog issue, never a
  bugfix branch. This is the Tier C shape from
  [`working-modes.md`](../../../docs/ai-context/working-modes.md) arriving
  in a testing session, and treating it as a bug is how a design decision
  gets fixed without ever being decided.
- **The doc's expected result is wrong.** My error, not the product's — and
  **the step still has to be run against the corrected expectation, in this
  run, before it counts as anything.** Mark it `Skipped — doc wrong`, say
  what the expectation should have been, and **re-present the step
  immediately**. A wrong oracle that merely gets skipped lets a real
  regression pass as a clean acceptance, because section 6 counts a
  reasoned Skip toward `Accepted` — the product was never actually checked.
  Fixing the doc file itself happens at close-out; re-running the step
  happens now.

## 4. When a step fails — file it now, then ask

David wants the fix started while the context is hot, and he's right: he
opens a bugfix session immediately. My job is to make sure the report that
session inherits is a real one and that the way back to *this* run survives
(David, 2026-08-21).

In order, in the same turn:

1. **Capture the evidence before anything else.** The exact error text, the
   exact URL, a screenshot — not a paraphrase. Ask for it plainly if it
   isn't in what he said. Paraphrased symptoms are the single biggest
   quality loss in this hand-off, and the moment to prevent it is now, not
   when a cold session reads the issue tomorrow.
2. **State a severity, as my read, in one word** — showstopper / major /
   minor / cosmetic — so he can correct it by contradicting me rather than
   by classifying anything. **This is not the fix tier**: the tier is
   diagnosis's job in the bugfix session, and pre-empting it here would put
   a guess where a classification belongs.
3. **Run the disclosure check** before writing anything public — this repo
   is public, and a UAT failure can be exactly the kind of thing that must
   not become a public issue
   ([`working-modes.md`](../../../docs/ai-context/working-modes.md#disclosure-check-before-the-workstream-issue-opens)).
   If it fails, **the whole run goes private from that moment** — see
   *The private path* below, and do not write the symptom anywhere public.
4. **File the bug** — check the backlog for a match and promote it rather
   than duplicating, per [`bugfix`](../bugfix/SKILL.md) step 1. New issues
   open with `stage:coding`, `waiting:claude`, `mode:bugfix` and a State of
   Play block. `mode:bugfix` is a hypothesis at intake; diagnosis may make
   it Tier C, and that's fine — the link doesn't care which mode the work
   ends up in.
5. **Record the way back, in the same edit** — `Blocked by: #<bug>` on this
   workstream, plus a State of Play line naming **which step failed**. This
   is what makes resumption "step 4" instead of a full re-run, and it goes
   in now, at intake, because a session that ends before it is written loses
   the link entirely. `bugfix` step 1 owns this contract; I'm executing it
   at the earlier moment, because I'm the one holding the context.
6. **Hand him a paste-ready prompt** for a fresh session, naming the issue
   number so that session works the filed bug instead of opening a second
   one for the same defect.

**The `waiting:` flip is NOT part of intake — it happens when the run
actually stops** (section 6). `bugfix` step 1 flips the interrupted
workstream to `waiting:claude` because by the time *it* runs, the UAT is
interrupted by definition. Here it may not be: if David says continue, he is
still the holder and the next real action is still his click, so
`stage:uat`/`waiting:david` stays exactly right. Flipping at intake would
also mirror the wrong holder onto a phased parent and hide an active,
David-held run from `/status-all`. What goes in at intake is the `Blocked
by:` link and the failed-step line — the crash-critical parts. The label is
display state, and it costs nothing to set it once, correctly, at the end.

**Then ask: continue or pause?** His call, every time. Continuing is often
worth it — it banks two or three more bugs that can be fixed in parallel
instead of serially — but a Blocked step or a showstopper usually means
there's nothing left worth testing, and I say so rather than making him
work it out. **A pause is a stop: tear the setup down first** (section 2),
and record what's owed on resume.

**Never diagnose the bug inside the UAT session.** Not even when the cause
looks obvious. Diagnosis belongs to the bugfix session with a real branch
and a real review; guessing at it here spends his testing time and produces
a root cause nobody reviewed.

### The private path

When the disclosure check rejects a failure, the descent-stack machinery
cannot be used as written — a private draft Project item **has no issue
number**, so there is no `#N` for a `Blocked by:` marker or for the handoff
prompt, and the run record itself would leak the symptom on a public issue.
So, from that moment:

- **The bug becomes a private draft Project item**, per CLAUDE.md's
  disclosure rule, with a short stable reference of my choosing
  (`UAT-<PR>-<step>`) written into the item.
- **The run record goes manual, and I say so.** A draft Project item is
  write-only to me — no available tool reads or writes Projects v2 item
  fields (`workstream-tracking.md`), so it cannot hold a record I checkpoint
  and rediscover. On the private path the live record is therefore
  maintained **in the session and handed to David at every checkpoint
  moment** (the same moments section 5 names): a compact copy in chat that
  he can paste into the private item himself, and that a resuming session
  asks him for. Resumability degrades from mechanical to David-carried on
  exactly this path — an accepted cost of not leaking the symptom, stated
  out loud at the moment it starts, never silently.
- **The public workstream issue keeps only a content-free pointer**:
  `Blocked by: private tracking (UAT-472-2)` and a State of Play line saying
  which step failed **without saying how**. That reads as prose rather than
  the anchored `Blocked by: #N` marker, so it does not gate automatically —
  which means I say so plainly to David rather than assuming the stack pops
  on its own.
- **I tell him the automation doesn't cover this path**, in the same breath,
  because a silent downgrade from mechanical to manual tracking is how a
  sensitive bug gets forgotten.

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

**Doc:** `docs/tests/UAT/PR472_ADMIN_HELP_SYSTEM_UAT.md`
**Started:** 2026-08-21 · **Last updated:** 2026-08-21
**Verdict:** in progress

| Step | Status | Note |
| --- | --- | --- |
| 1 · Manual renders | Pass | |
| 2 · Deep link | Fail | #903 — landed at chapter top, not the heading |
| 3 · Search | Pass | |
| 4 · Deliberate absences | — | not yet run |
| R1 · Sidebar unchanged | — | not yet run |
| R2 · Admin on a phone | — | not yet run |

**Setup owed on resume:** `budget_limit_legendary_usd` → 0.01 (real value
2500.00 captured, restored at pause)
**Bugs filed:** #903 (major)
**Product notes:** none
**Resume at:** step 4 (4 of 6 remaining, R1–R2 included)
```

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
| **Accepted** | Every step executed and Passed — **every step section 3 enumerated, regression checks included**. A Skip counts toward this only when **David explicitly called the step not-applicable** — a reason alone doesn't qualify, or a run where he lacked a phone or a test account could skip its way to a clean acceptance without exercising anything. A step he *couldn't* do is `Blocked`, which never counts. The doc-wrong case counts only re-run per section 3 |
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
  is mine (the harvest-notes comment for a product feature, any outstanding
  item the State of Play lists). Do what remains, and when nothing is left,
  set `stage:done` and close the issue. Only when a real close-out item
  genuinely can't be finished now does the workstream sit at
  `stage:close-out`, with that item named in the State of Play.
- **If this workstream is a phase sub-issue and the verdict reached
  close-out, do the parent edits too** — tick this phase's line in the
  parent's Phases checklist, re-point the parent's `waiting:`, and move the
  parent to `stage:close-out` if this was the last phase. `pr-watch`
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
- **Fix the doc** if a step's expected result was wrong.
- **Delete the UAT doc once he confirms the run is complete** (David,
  2026-08-22). Deletion is the default, in the same close-out, so
  `docs/tests/UAT/` never accumulates finished tests and a surviving file
  always means a run still owed — which is exactly what section 1's
  discovery assumes. It is a better signal than it was: it used to lag
  behind a manual click, so a completed run could sit there looking
  startable for days.

  **The one reason to keep one is content, not sentiment:** a doc that is
  the only written description of some behavior. That is a gap in the
  Manual, not a reason to hoard a test — harvest the description into the
  right chapter, say I've done so, then delete the doc. "It might be useful
  later" is not a reason; a re-run of a merged PR's UAT is written fresh
  from current behavior, not resurrected.
- **Tell him what he's holding**: verdict, bugs filed with severities, what
  he can do next, and that the doc is gone.

## Notification discipline during a run (David, 2026-08-21)

A live walkthrough is a conversation: nearly every turn ends with a question
by construction, and firing the 🛑 banner and a push for each one would make
interaction rule 6 unusable exactly where he's most present. So, **scoped to
an active run**: ordinary step-by-step turn-taking — including the
continue-or-pause question right after a failure — gets **no banner and no
notification**. He's at the keyboard; that's the premise of the session.

The banner and the push fire normally when the **run ends** needing a
decision from him, when an ask would hold work up after he's walked away, or
when he's gone quiet mid-run and something needs him. This is a deliberate,
narrow carve-out from interaction rule 6 rather than a drift away from it —
written down so a later session doesn't "fix" it back.

## What version 1 deliberately doesn't do

**Playwright automation of the mechanical steps** is the intended next phase,
not a gap (David, 2026-08-21) — the goal is that he only ever judges what
genuinely needs human eyes. It waits on one real decision: a browser driving
the admin console needs an admin identity that isn't David's personal login,
and picking that (a dedicated test-admin account, most likely) is a security
question, not a detail.

Worth saying now, because it shapes that phase: **once a step is fully
scriptable, UAT is usually the wrong home for it.** It belongs in CI or in
the PR's post-merge verification, where it runs on every change forever
instead of once. The automation phase is mostly *draining* mechanical steps
out of UAT into the layers that already exist — and scripting whatever
live-app checks are left over.

## Model tier

The walkthrough is conversational and cheap; the judgement calls in it are
not. Severity reads, the is-this-a-bug-or-a-design-change split, and the
bug intake all happen in **my main loop** — never routed to a subagent,
which would be a cold worker guessing at a session it didn't sit through.
No tier switch, no ask; the session is Opus.
