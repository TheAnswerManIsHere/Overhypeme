<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# /uat — the lanes: what settles each machine-lane step, and where the browser runs

Part of the `uat` skill ([`SKILL.md`](SKILL.md), section 3), moved here whole.
Read it before settling the first machine-lane step of a run.

- **`ci`** — **settled at merge, never re-run or re-checked here, for a
  check the PR carried when it merged.** The `main` ruleset requires the
  gate, so the merge is the evidence: the row reads `settled at merge — PR
  gate` and counts as a Pass. A `**Check:**` written into the body after
  the merge, retiring a `Deferred:` line, was never seen by this PR's gate
  or guard, so the merge is no evidence for it: the `Deferred:` bullet
  below governs it.
- **`scripted`** — **cited, not re-run, when the PR recorded its output
  at the merged head**: close-out posts that record before it merges
  (`pr-watch` step 8; `pr-docs` gives its shape), and the row quotes it and
  its commit. **A missing comment is missing evidence, not proof the proof
  never ran**, so before running anything I look for the output the
  lifecycle already holds — a PR comment or CI job log **at the merged
  head**, and nothing older: output from any other commit is not evidence
  however recent, and judging that nothing the proof reads has changed is
  the call this rule exists not to make — and cite that. Only when none exists does the step run here, **in
  a checkout or worktree at the commit under test** (or the on-demand
  workflow dispatched on that commit), with the output kept with the commit
  it ran at; that is close-out's lapse, so it goes on the run record's
  **Lifecycle gaps** line (section 5). One that would start a paid AI run runs under David's paid-run rule — a ceiling set before it starts, a 🛑 stop for a run whose worst case is $10 or more or a task past $10, and asking first past $100 a calendar month across every product, as a paid capture does (below).
- **`live`** — **cited from close-out's Post-merge verification when that
  section ran the step's check and the Repl's commit has not moved since**:
  the workstream reaching `stage:uat` is that pass's evidence, and the row
  names the merge report that carried it. Run here only when close-out did
  not run that check — close-out's lapse, so a **Lifecycle gaps** entry —
  or when the Repl now holds a later commit than the
  one close-out verified — a deployed environment can drift in ways
  `main`'s CI never sees. Then I run it through the live-environment
  connector, **read-only, always**, after confirming the Repl's synced
  commit is the commit under test, and quote what it printed. A check that would start a
  paid AI run is not read-only: it runs under David's paid-run rule — a ceiling set before it starts, a 🛑 stop for a run whose worst case is $10 or more or a task past $10, and asking first past $100 a calendar month across every product, as a
  paid capture does (below). State a check needs is a
  Setup `[claude]` line with its `[restore]` (section 2); a probe whose
  refusal is the thing tested writes nothing and is not a write.
- **`capture`** — I produce the shot each step's `**Check:**` cites
  **at the commit under test**: the citation says which shot answers the
  step, and the capture command the consumer declares (its
  `overlay-declarations.md`, *UAT capture*) says how to bring up the stack
  and run the set that contains it. **I read each image before it is
  published anywhere**, and the disclosure check (section 4, step 3) runs
  on it first, whether or not its clauses pass: a shot it rejects goes to
  *The private path* (section 4), never to the evidence store. Only then is
  the shot committed to the evidence store the declaration names, which
  holds test data alone — a throwaway test database and publishable
  fixtures — on a dedicated branch that is only appended to. I record, on
  the step's own row, the shot name, the commit, the evidence link pinned
  to the evidence commit, and my reading clause by clause. A shot another
  host has to publish before I can read it — a paid render made where the
  vendor keys are — is published that way only while the consumer's
  disclosure check is off; with it on, the shot reaches me privately first.
  The step's result is
  that reading: a shot that was not produced, or that I cannot read, is
  Blocked, never Pass; a reading that contradicts the `Expect` is a Fail,
  filed before he sees anything (section 4). **A capture that needs a paid vendor runs under David's paid-run rule** — as
  does any check, in any lane, that would start a paid AI run
  (`uat-doc-format.md`, *Lanes*, its only statement): it runs without asking,
  inside a ceiling set before it starts (the cap the declaration names, or its
  own worst case), and only a run or task of $1 or more reads the fleet's
  ledger first and is logged on it. One that would cost $10 or more, in the
  run or across the task, or take the month past $100, stops and asks,
  naming the PR, the paid calls and the worst-case cost, and its
  steps are Blocked on him until he answers, or he answers the judgement
  steps from an image he makes himself in the product. A consumer with no such declaration has no
  capture run, and its `capture` steps are Blocked on that, never handed to
  him. **A real AI render is read only for what anyone would verify the
  same way** (`uat-doc-format.md`, *An image an AI model
  generated*): the render completed, the image decodes at the size asked
  for, a bubble reads the given text. I make no judgement about generated
  content — likeness, scene, humour, quality, whether something is shown,
  whether it is acceptable — unless the answer is as plain and checkable
  as a bubble's text, and none even when an `Expect` asks for one: that
  clause is David's, presented as a judgement step with the shot beside it,
  and the script is recorded as wrong (the lane is corrected in the PR
  body, section 6).
- **`Deferred:`** — not run; listed as outstanding with its owner. Never a
  pass, never a skip he can wave through. When it is the only evidence for a
  claimed behaviour, the run is Blocked on its owner: `Blocked by: #N` on
  this workstream, recorded as section 4 step 5 does for a bug, so the
  owner landing is what reopens it. The owner's PR replaces the line with
  its runnable **Check:** in the owning PR's body (`pr-docs`), so the
  resumed run executes it — at the commit under test, whatever its lane,
  since no gate of this PR ever ran it; a script still carrying the line after #N closed
  is the script-wrong case, and closing #N alone is never passing evidence.
- **A `human` step whose `Expect` a screen can answer** — an element is
  there, a message reads a given sentence, a status or an error shows, a
  layout holds at a width — **is mine, whatever lane the script gave it,
  when its `Do` is one I can perform**: the lane is read from the
  `Expect`'s clauses and from who can perform the `Do`, never from the
  heading or the verb (the rule's home is *Where the browser automation
  lives*, below). **Not an interpretive clause about an image an AI model
  generated**: that stays his whatever its wording (the `capture` bullet
  above). A `Do` only his own account or device can perform keeps
  the step `human`, and its screen-fact `Expect` is read after his "yes"
  (the format's self-contained rule, `uat-doc-format.md`, *Lanes*). I run
  the step in a real browser at the commit under test, in this block,
  before he sees anything: a browser in the session's container against a
  local stack at that commit, launched the way the consumer's per-PR
  browser job launches it, on a throwaway test-marked database, signed in
  as the test identity that job already uses (Overhype.me: Playwright, the
  E2E Smoke launcher, the seeded test accounts or the dev-admin login); or
  the live-environment connector read-only where the step needs the
  deployed build. The state the step needs — its `[claude]` setup lines —
  is applied to the stack the browser opens, never seeded on the deployed
  build and read locally (section 2). A consumer whose gate has no test
  identity has not settled the identity question: a screen check behind a
  login there is a `[david]` setup line or stays his, never an identity I
  invent. The record quotes what the browser read, with the
  commit it ran at; a screenshot is evidence when layout is the claim. Only
  the clause that is judgement — "it is readable", "the image suits the
  subject" — reaches him, as a turn of its own recorded on the step's own
  row as a multi-part result (the "it sort of worked" rule, section 4): the
  row is Pass only when every clause is, and the preview counts that step
  among his. Such a step was mislabelled
  (`uat-doc-format.md`, *A step is `human` only when no machine can answer
  it*): it is the script-wrong case, and the lane fix is an edit of the PR
  body at close-out (section 6).

Each gets the same four statuses as a human step, with its evidence in the
record. A machine-lane step that fails is a failure like any other: section 4
applies, and I file it before he sees the first human step. **He sees the
machine block, then only the human steps that are judgement** — a `human`
label over a screen fact went into the machine block, above — so the
preview says both counts ("9 machine-lane checks — 7 settled at merge and
close-out, 2 run now, all passed; 3 steps for you").


## Where the browser automation lives

**Driving a browser for the mechanical steps is not a later phase.** The
admin identity is settled wherever the consumer's per-PR browser job already
signs in as a test identity, which is the identity I use (Overhype.me: the
seeded test accounts and the dev-admin login); a consumer whose gate has no
such identity has not settled it, and section 3's machine block says what
happens there. **The rule: a step's lane is read
from its `Expect`'s clauses and from who can perform its `Do`, never from
its heading or its verb. A screen fact — an element is there, a message
reads a given sentence, a status or an error shows, a layout holds, or any
other UI check that needs no taste input from him — is machine-lane; a `Do` only David's own account or device can perform keeps
the step `human`; the clause that is judgement is a `human` step of its
own, and what an image an AI model generated shows, beyond what anyone
would verify the same way, is always judgement (`uat-doc-format.md`, *Lanes*, *An image an AI model generated*); and a screen fact that reaches a run labelled `human` is run by me, in
a real browser at the commit under test, before he sees anything (section
3's machine block says how).** What remains is where each check lives, and
that is three places:

- **A screen fact a PR claims lives in CI**, as an assertion in a spec or
  component test the gate already runs, written in the same PR
  (`pr-docs`): it runs on every change forever instead of once.
- **A screen fact that reached a run as a `human` step is run by me at run
  time**, in the machine block above, and the step's lane is corrected.
- **An answer only pixels hold is the `capture` lane**: a script captures the named image at the commit under test,
  I read it, and the consumer's evidence store keeps it once the disclosure
  check has passed it — section 3's machine block says how. The consumer declares the command, the evidence
  store and any paid-render cap in its `overlay-declarations.md`. For an image an AI
  model generated, the reading is limited to what anyone would verify the
  same way; everything interpretive is David's (`uat-doc-format.md`,
  *Lanes*, *An image an AI model generated*).

**Once a step is fully scriptable, UAT is usually the wrong home for it.** It
belongs in CI or in the PR's post-merge verification, where it runs on every
change forever instead of once — unless it calls a paid AI vendor, which
runs under David's paid-run rule — a ceiling set before it starts, a 🛑 stop for a run whose worst case is $10 or more or a task past $10, and asking first past $100 a calendar month across every product (`uat-doc-format.md`, *Lanes*). Automation is mostly *draining* mechanical
steps out of UAT into the layers that already exist — and scripting whatever
live-app checks are left over into the PR's post-merge verification.
