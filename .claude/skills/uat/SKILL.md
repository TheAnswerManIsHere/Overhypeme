---
name: uat
description: Run a UAT session with David step by step, in chat, instead of handing him a markdown file to read alone. Use when he says /uat, "let's test PR N", "walk me through the UAT", "I'm ready to test this", or "resume the UAT". I do the setup, present one step at a time, record Pass/Fail/Blocked/Skipped per step, capture evidence on anything that isn't a clean pass, file the bug and the way back the moment something breaks, and leave a durable run record any session can resume from. NOT for writing a UAT doc — that's `pr-docs`.
---

# /uat — I run the test session, David does the judging

The UAT doc stopped being something David reads and became the **script I
drive** (David, 2026-08-21). He used to open a markdown file in one window
and the app in another, keep his own place, and remember what failed. Now he
tells me what he saw and I own everything else: the setup, the place, the
record, the bug intake, and the way back.

**What has not changed:** the doc is still written per
[`pr-docs`](../pr-docs/SKILL.md), still lands on its PR before merge, still
David's own to-do list, and **he still deletes it himself** when he's done
with it. I never delete a UAT doc.

**The UAT doc is no longer published as an Artifact page (David,
2026-08-21).** That reading surface existed because he was reading alone; the
session replaced it. If he ever wants one for a solo run he asks.

## 1. Find the run, confirm it, preview it

An invocation may name a PR, an issue, or nothing.

1. **Find the candidate docs** — `docs/tests/UAT/PR<N>_*_UAT.md`. Every file
   still present is by definition unfinished (David deletes them on
   completion), so the surviving set *is* the pending queue.
2. **Check for an interrupted run first.** Read the workstream issue's
   comments for a `## UAT run` record (section 5) whose verdict is
   `in progress`. If one exists, offer to **resume at its recorded step**
   rather than starting over — that record is the whole reason it exists.
3. **One candidate → start it. Several → ask which**, one numbered question.
   **None → say so** and don't invent a run.

Then give him a **three-line preview before step 1**, never the whole doc:
how many steps, what I'm setting up for him (section 2), and anything he
needs on hand — an admin login, a phone, a fresh browser tab. The doc's
narrative preamble is mine to have read, not his to sit through.

## 2. Setup is mine, and so is putting it back

**Anything mechanical that stands between David and step 1, I do** (David,
2026-08-21). Seeding rows, creating a test account, putting config in a
known state, confirming the Repl is synced and the app is up. He should
arrive at step 1 with the app already in the state the test needs.

Three rules, because setup writes to the live app:

- **Name what I created, out loud, in the preview.** Test data that nobody
  labelled as test data is indistinguishable from real content the moment
  the session ends. Say "I created fact #4821 and user `uat-tester`" so he
  can recognise them later.
- **Capture the restore path before the write, and do the teardown at the
  end of the run** — the same discipline
  [`test-run-contract.md`](../../../docs/tests/test-run-contract.md) puts on
  a live-environment write. If something can't be cleanly undone, say so
  *before* doing it and let him decide.
- **Say plainly what I can't set up.** I have no admin session — every
  `/admin/*` route answers *Access Denied* to me, which is the same
  limitation that made admin click-throughs UAT-shaped in the first place.
  Admin-gated setup falls to David, as exact click steps in the preview, not
  as a vague "get the app ready."

Setup runs through the Replit connector per CLAUDE.md's connector policy,
and it is a **deliberately mutating** action — scope it explicitly, or Replit
Agent will helpfully build a feature instead.

## 3. The walkthrough — one step, minimal context, cheap pass

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
multi-part result; the roll-up in section 5 handles it.

**Two reports that are not step failures**, and mis-filing them is expensive
in both directions:

- **"That's what it says, and I don't like it."** The step did what the doc
  said it would. That's a Pass plus a **product note** — a
  behavior-change request, not a defect. It becomes a backlog issue, never a
  bugfix branch. This is the Tier C shape from
  [`working-modes.md`](../../../docs/ai-context/working-modes.md) arriving
  in a testing session, and treating it as a bug is how a design decision
  gets fixed without ever being decided.
- **The doc's expected result is wrong.** My error, not the product's. Mark
  the step **Skipped — doc wrong**, note the correction, and fix the doc as
  part of close-out.

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
3. **Run the disclosure check** before opening anything public — this repo
   is public, and a UAT failure can be exactly the kind of thing that must
   not become a public issue
   ([`working-modes.md`](../../../docs/ai-context/working-modes.md#disclosure-check-before-the-workstream-issue-opens)).
   If it fails, private draft Project item, and say so plainly.
4. **File the bug** — check the backlog for a match and promote it rather
   than duplicating, per [`bugfix`](../bugfix/SKILL.md) step 1. New issues
   open with `stage:coding`, `waiting:claude`, `mode:bugfix` and a State of
   Play block. `mode:bugfix` is a hypothesis at intake; diagnosis may make
   it Tier C, and that's fine — the link doesn't care which mode the work
   ends up in.
5. **Record the way back, in the same edit** — `Blocked by: #<bug>` on this
   workstream, plus a State of Play line naming **which step failed**. This
   is what makes resumption "step 4" instead of a full re-run. `bugfix`
   step 1 owns this contract; I'm executing it at the earlier moment,
   because I'm the one holding the context. Mirror the `waiting:` flip onto
   the parent if this workstream is a phase sub-issue.
6. **Hand him a paste-ready prompt** for a fresh session, naming the issue
   number so that session works the filed bug instead of opening a second
   one for the same defect.

**Then ask: continue or pause?** His call, every time. Continuing is often
worth it — it banks two or three more bugs that can be fixed in parallel
instead of serially — but a Blocked step or a showstopper usually means
there's nothing left worth testing, and I say so rather than making him
work it out. The run record persists either way, so pausing costs nothing.

**Never diagnose the bug inside the UAT session.** Not even when the cause
looks obvious. Diagnosis belongs to the bugfix session with a real branch
and a real review; guessing at it here spends his testing time and produces
a root cause nobody reviewed.

## 5. The run record — durable, batched, resumable at the step

State lives on the **workstream issue**, as a comment, because that is
already what survives a session ending and what a cold session reads. Not
in the chat, not in a file, not in my head.

**One comment per run.** A re-run after fixes is a new record
(`## UAT run 2 — …`), not an edit of the old one — the previous run's
results are the record of what was true then.

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

**Setup I performed:** seeded `uat-tester` account; fact #4821
**Teardown owed:** both, at end of run
**Bugs filed:** #903 (major)
**Product notes:** none
**Resume at:** step 4
```

**Write it on the moments that matter, not every turn:** once after setup
(so the record exists before anything can be lost), on every non-pass, on
pause, at the end, and every fifth step through a clean stretch. A record
written every turn costs a round trip per step and buys nothing a
five-step gap doesn't.

**Update the State of Play's `To resume` field to point at it**, per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md).
That field is what a cold session actually reads first.

## 6. Ending a run

Roll the step statuses up into one verdict — and roll up from the **steps**,
never from a general impression of how it went:

| Verdict | When |
| --- | --- |
| **Accepted** | Every step Pass (or Skipped with a stated reason) |
| **Accepted with issues** | Failures exist, all minor/cosmetic, David says ship it |
| **Blocked** | A showstopper, or too much untestable to call it |

Then, in one edit:

- **Do the teardown** I owe, and confirm it in the record.
- **Set the labels once, correctly, from the outcome.** `Accepted` →
  `stage:close-out`. Anything with an outstanding bug → `waiting:claude`,
  because the next real action is a fix, not something David can click.
  Leaving it at `waiting:david` is what makes `/status-all` show a
  mechanically non-actionable UAT under NEEDS YOU.
- **Log product notes as backlog issues** (`queue:`), separately from bugs.
- **Fix the doc** if a step's expected result was wrong.
- **Tell him what he's holding**: verdict, bugs filed with severities, what
  he can do next. He deletes the UAT doc himself — I don't, and I don't
  ask him to.

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
