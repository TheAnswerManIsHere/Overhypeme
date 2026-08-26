---
name: pr-watch
description: Use after opening or being re-engaged on any PR (implementation or [PLAN REVIEW]), and whenever a github-webhook-activity event arrives for a watched PR.
---

# Watching the PRs I open

Migrated out of `CLAUDE.md` so it loads when a PR is actually being watched.
The three standing rules that must fire without this skill loaded — always
subscribe (no tier gate), the bounded self-check-in contract, and resolve
review threads once addressed — stay resident in `CLAUDE.md`.

### Subscribe rules (resident in CLAUDE.md — pointer, not a second copy)

The subscribe rule lives in `CLAUDE.md`'s *Watching the PRs I open* stub,
which fires at PR-open time before this skill is ever invoked: **I subscribe
immediately, on whatever tier the session is on — there is no model gate**
(David, 2026-08-15, retiring the Sonnet gate), for implementation and
`[PLAN REVIEW]` PRs alike. **Self-check-ins follow the bounded contract in
`CLAUDE.md`'s *Scheduled self-check-ins*** (David, 2026-08-15, replacing the
2026-07-07 blanket ban): allowed against a named external state that won't
reliably wake me, bounded by **both** caps (3 consecutive no-op wakes, and 6
wakes or 24 hours total), silent when nothing changed **except a terminal
wake** — never a routine heartbeat.

The old gate's companion rule — *"if the session gets switched to Sonnet
later, that's the moment to subscribe any open unwatched PR"* — is retired
with it: there is no tier moment to wait for any more. What survives is the
substance underneath: **an open PR I created and am not yet watching gets
subscribed the moment I notice it, without David re-asking.**

**One explicit exception, and it is not optional (Codex, PR #458 round 1):
a `/document` harvest PR is subscribed only at step 5 of
[`documentation-workflow.md`](../../../docs/ai-context/documentation-workflow.md)** —
after the workstream issue exists and the PR body's `Workstream:` line points
at it. Subscribing performs label writes, so subscribing early labels an
untracked draft against a missing or wrong issue; that doc says in as many
words that deferring the *subscribe* is what defers labeling, since draft
status alone does not. The old tier gate happened to enforce this ordering as
a side effect of making me wait — with the gate gone, the ordering has to be
stated outright or it silently breaks.

### The write-gate rule, and the internal tier (David, 2026-08-22)

**Any commit I push gets a review round. The loop stops when the adjudicator
refuses to write more — never after a push.** So the order is: round returns
findings → **dispatch the adjudicator BEFORE writing anything** → on *write*,
push the fixes and re-request (that round is mandatory, not optional); on
*stop*, the loop is over and the head is already reviewed. This supersedes
2026-08-21's mid-budget terminal receipt, which existed to make an unreviewed
head mergeable and is gone with it.

**If this PR is internal** — a guard, a script, a skill, an agent contract, a
process doc, a documentation harvest:

- **Clean automatic pass on PR-open → merge on it.** No budget, no receipts,
  no adjudication; the merge receipt accepts an automatic pass covering the
  head.
- **Rounds 1–2: the pass found things → triage once, decline out-of-scope
  findings in one line, fix the rest, push — then declare `--tier internal`
  and re-request.** No judge yet: the ledger says these rounds always carry
  findings worth writing for, and the mandatory re-review of the push is
  the write-gate working.
- **Round 3's findings → the adjudicator, before anything is written.** On
  this tier the entry point IS the cap decision: it rules under the internal
  rubric (write only for a very high chance of a CRITICAL flaw), or
  everything ships as recorded gaps on the round-3-reviewed head.
- **Budget 3, two-tier tripwire like every tier** (David, 2026-08-26): the
  adjudicator's grants self-serve to at most round 6, where the David gate
  stands — a fresh Fable recommendation goes to David, and only his receipt
  moves the loop.

### Declare the round budget at loop start (product loops only)

**Before round 1, in the same breath as subscribing**, a product loop declares
its round budget:

```
node scripts/review-budget.mjs declare --pr <n> --tier <product|sensitive|internal> \
     --criticality <1-100> --artifact "<what is under review>"
```

`product` = 5 rounds, `sensitive` = 5 (auth, payments, migrations),
`internal` = 3 (declared at the first re-request, not before round 1 — see
the internal-tier section above). Every tier runs the same two-tier
tripwire past its budget (David, 2026-08-26). The
tier picks the number; it is not a field to fill in.
**Commit the receipt AND PUSH IT**, then **state the budget in the PR body**.

The push is not housekeeping — it is what makes the budget exist. Budgets and
extensions are read from the branch's remote-tracking ref, never from the
working tree, so an unpushed receipt reads as *no budget declared* and `check`
refuses. (Committing without pushing gets a refusal that says exactly this,
rather than sending you back to `declare`.)

**Then, before every `@codex review` post, count the rounds fresh:**

```
node scripts/review-budget.mjs check --pr <n> --mcp-snapshot <file>
```

The snapshot is `pull_request_read` (`get`, `get_reviews`, `get_comments`),
paginated and attested complete, and it must also name its source
(`repo: "TheAnswerManIsHere/Overhypeme"`) and the moment GitHub was read
(`capturedAt`) — a PR number alone does not identify a pull request, and
freshness is a property of the evidence rather than of when the command was
typed. Bodies are required on every issue comment and every reviewer-authored
review, because that is where the count actually reads. It writes an ephemeral
round-check receipt that authorizes exactly **one** post — the same
evidence-at-decision-time pattern the merge gate uses, because the round count
is evidence, not something to remember. There is no tally to maintain and
nothing to reconcile if a request stalls.

**Post the request as an issue comment.** The guard refuses a trigger sent
through a thread reply or a review body: those land where the round count
cannot see them, so a request in flight there would be invisible as a pending
round. The refusal says so and names the surface to use.

**Known gap: an automatic review can be in flight unseen.** Codex has three
triggers and only one is a comment — opening a non-draft PR and marking a
draft ready also start a review, through calls this hook never sees. Those
passes are counted correctly once they land, but while one is in flight
`pending` reads 0, so marking a PR ready and immediately requesting a round
can land two passes against one. Bounded at one round, and it needs that exact
sequence. Avoid it by letting the automatic pass land before requesting.

**Re-capture the snapshot for every check.** A snapshot must be strictly newer
than the evidence behind the current receipt; re-presenting one that has
already authorized a post is refused. That is what makes "one check, one post"
true sequentially as well as concurrently.

**A retry of a stalled round is not a new round and costs nothing.** If a
request produced no review, re-asking is allowed even at the cap — `pending`
stays 1 until a pass lands, and the guard gates on delivered passes. The one
retry limit below is still the rule; it is a judgement about when to stop
asking, not a budget constraint.

This is not optional and not a reminder: `.claude/guard.sh` refuses the
**first** `@codex review` post until the budget receipt exists, refuses any
post without current counted evidence, and refuses again at the budget. The
full contract — the per-round adjudicator, the adjudicator-sized extension
inside the 3-round leash, and the David gate at budget + leash — is resident
in `CLAUDE.md`'s *Review loops*
section, because it has to hold whether or not this skill is loaded. What belongs here is the timing: **declare at loop
start**, alongside the subscribe, and **check before each request**.

I re-verify true PR state (threads + CI + mergeability) whenever a real
webhook event arrives or David re-engages me. I may additionally schedule a
wake-up **when a specific external state won't reliably deliver one** — a CI
run that may never report success, a PR gone quiet before merge, a review
request that produced no code review (a security bounce is irrelevant to that
judgement) — under the bounded contract
in `CLAUDE.md`. **A security-review usage-limit bounce is not one of these:**
request the code review instead. Whenever a watched PR merges or closes, I unsubscribe and
disarm any check-in still pending on it.

**The convergence-break and skip-review-if-docs-only rules below are
for implementation PRs.** A `[PLAN REVIEW]` draft PR follows
`plan-review-loop`'s own cadence instead — minimum 3 rounds even on a clean
early pass, and every
revision re-triggered regardless of whether the diff is docs-only, since
the diff *is* the plan. Its stopping rule is the SAME declared budget and
two-tier tripwire as every loop (a plan loop takes the tier of what it
plans — see that skill's step 9): the budget guard's refusals apply to
plan-review triggers exactly as to implementation ones, with the per-round
adjudicator, the leash, and the David gate all in force. While watching an implementation PR:

- **Never judge a webhook event from its text alone — fetch the live PR state
  first.** This is the rule I broke: a `<github-webhook-activity>` arrived that
  looked like my own reply echoed back (it even carried the "Generated by Claude
  Code" footer), so I dismissed it as "just my echo, no action needed" — when it
  was actually evidence of a real Codex P1. Every time an event arrives — *even one
  that looks like a duplicate, an echo of my own comment, or noise* — I first pull
  the current state with `mcp__github__pull_request_read` (`get_review_comments`
  for open/unresolved threads, plus CI status and the latest commits) and decide
  from **that**, not from the event body. The webhook is a nudge to go look, not a
  summary I can act on.
- **Treat every Codex / bot review comment as feedback to act on, not noise.** I
  read each one, decide if it's tractable, and either fix it (if small + I'm
  confident) or escalate (if it's a real decision). A P1 left sitting because I
  pattern-matched the event as an echo is a miss, not a no-op. When a thread looks
  already-handled, I confirm it from the live thread (resolved? a real fix commit
  referenced and present on the branch?) — never from the comment's author or
  footer.
- **Webhooks lag and are incomplete — don't treat silence, or an event's own
  text, as "all clear."** They do **not** deliver CI *success*, new pushes, or
  merge-conflict transitions, and events can arrive out of order or be my own
  replies bouncing back. So whenever I'm re-engaged on a watched PR — by a real
  webhook event or by David — I re-check its true state (threads + CI +
  mergeability) rather than assuming the last event told the whole story.
  **A scheduled wake-up supplements that, it does not replace it**: I use one
  only when a named external state won't reliably deliver an event (CI
  success is the classic drop), never as a general poll and never for a
  security-review bounce. The contract — named condition, matched cadence,
  exit condition, **both caps** (3 consecutive no-ops; 6 wakes or 24 hours
  total), silent on no change **except a terminal wake** — is in `CLAUDE.md`'s
  *Scheduled self-check-ins*.
- **From round 3 onward, the external adjudicator decides whether to WRITE
  for a round's findings — before anything is written (David, 2026-08-22).**
  Rounds 1–2 are written for by default; a round with no findings (or all
  declines) needs no verdict at all. Triage the round's findings first — nature,
  affected area, verdict (fix / accept-and-document / escalate / decline), and
  the causal flag (new ground vs. repairing an earlier round's fix vs.
  impossible-as-specified). Then generate the mechanical record and dispatch:

  ```
  node scripts/review-loop-record.mjs --pr <n> --mcp-snapshot <file> --write
  ```

  Dispatch **one** `review-loop-adjudicator` subagent **on Fable**, passing
  `model: "fable"` explicitly (a per-invocation model outranks frontmatter),
  and announce the dispatch. Its only input is that record — never this
  session's prose, and never a case for continuing written by me. **Its verdict
  decides**: continue, stop, or split-to-David. I do not weigh it or adopt part
  of it; if I think it is wrong, that is a disagreement for David, not license
  to overrule.

  **Delivery depends on the verdict, and only `continue` is followed by
  another trigger** (Codex, #543 rounds 2 and 4). A per-round `continue` —
  the budget not yet spent — goes as **one line in the separate defanged
  context comment** that precedes the next bare trigger, never a file
  (per-round receipts would rebuild the machinery this replaced) and never
  inside the trigger comment itself, which stays bare — prose beside the
  trigger is what spawns unintended tasks. A per-round **stop** ends the
  loop right there: the verdict goes in a defanged comment and **no further
  trigger is posted** — the loop proceeds to close-out on the rounds already
  returned. (Under the write-gate rule a stop
  precedes any new commit, so the head is already reviewed and no receipt is
  written for it — the 2026-08-21 internal stop-receipt is gone; the only
  committed verdict receipts are tripwire receipts, on any tier: at budget
  exhaustion, and at a David gate.)
  **Known gap, recorded rather than fixed (#553 rounds 4–5):** a standing
  `split`/`escalate` on a tier that writes no receipt is invisible to
  `checkRail`, so the readiness gate can mint READY on a PR whose own last
  verdict handed it to David. Making those receipts mid-budget was tried and
  reverted — every receipt is held to the exhaustion floor, so a blocking one
  written earlier is rejected as malformed and **not even a David grant can
  reopen that loop**. Covered by process instead: both verdicts go to David
  as a 🛑 by construction, and READY is not a merge. A **split-to-David** likewise posts no trigger; it goes to David
  as a 🛑. **A round with no adjudication keeps the normal next-round
  trigger** — rounds 1 and 2 have no judge by design (measured: zero clean
  round 1s and three round-2 convergences in the ledger's 41 reviewed
  loops), and a zero-findings round dispatches none — so after those
  rounds' fixes are pushed, the next bare trigger goes out as usual (it is
  mandatory: pushed code is reviewed code): the rule gates on verdicts that
  exist, and the absence of a dispatch is not a stop (Codex, #548). But a verdict at **budget exhaustion** is an
  extension decision, on every tier (David, 2026-08-26 — sensitive and
  internal loops write adjudication receipts like product ones now). The
  guard reads extensions only from committed receipts — so that verdict is written to
  `.agents/receipts/loop-extension-<pr>-<n>.json`, committed and pushed, per
  the tripwire-1 refusal's own instructions; at a **David gate** the same
  receipt is committed as the recommendation and David's answer follows it
  as a `david`-kind receipt. A comment-only exhaustion verdict
  leaves the allowance unchanged: the guard blocks the next request and tells
  you to run the adjudication you already ran. The
  self-refereeing that used to live here (count trend, growth tripwire,
  oscillation diagnosis, criticality gate) is gone: 0-for-15 at stopping loops,
  and the budget plus this judge replaced it.

  **Skip-on-clean:** a round with **zero findings** (or whose findings are
  all reasoned declines — nothing gets written) needs no adjudication: the
  loop ends on the head that round reviewed. From round 3 onward, a round
  with findings gets the verdict before anything is written, however
  mechanical the findings look — under the write-gate rule writing code is
  what commits me to another round, so "it's only a nit" is precisely the
  judgment the external judge exists to make instead of me.

  What still stops for a 🛑 whatever the adjudicator says: a genuine
  design/architecture/product decision, a scope addition, a split, a disclosure
  question. Anything reaching David is written in product English — outcomes,
  never mechanics; the mechanics stay in the PR thread.

- **Every fix is class-level — the sweep protocol (David, 2026-08-08).** The
  shared contract is
  [`working-modes.md`](../../../docs/ai-context/working-modes.md#a-finding-names-an-instance-the-fix-owes-the-class-david-2026-08-08)'s
  *"A finding names an instance; the fix owes the class."* My enactment,
  per finding: the thread reply names the class, cites the mechanical
  oracle (`grep`/`ls`/`find`/one-liner) and its post-fix zero-hits result;
  when instance = class, the reply says so and that claim is the sweep.
  **Before every push of a fix round, I re-run all prior rounds' oracles**
  so a later fix can't reintroduce an earlier class.
  **The three finding-level dispatch triggers that used to live here (any
  decline, any oracle-less finding, any swept-class recurrence) are RETIRED
  (2026-08-20, PR #543)** — superseded by the single external per-round
  adjudicator, exactly as the `model-routing` skill records. Running
  per-finding and per-decline Fable dispatches alongside the per-round judge
  would re-create the parallel self-refereeing the #541 review deleted
  (Codex, #543 round 4). Declines keep their full care without a dispatch:
  each is a reasoned reply on the thread, and the adjudicator sees every
  round's declined findings in the mechanical record. The sweep itself (name
  the class, write the oracle, sweep to zero) and the recurrence
  round-record flag apply throughout.
- **A reply with no oracle in it is malformed (David, 2026-08-22).** The sweep
  protocol above has been written down since 2026-08-08 and I kept not doing
  it: on PR #553 I posted 20+ thread replies across five rounds citing **zero**
  oracles. The replies read as thorough — they named the class, described what
  I had checked, argued the fix was complete — and not one of them ran a
  command. That is the failure mode this rule exists to make impossible:
  **prose that sounds thorough is not an oracle that ran.**

  So the reply is not a paragraph that *should mention* a sweep. It has a
  shape, and a reply missing any line of it does not get posted:

  ```
  Class: <what the whole class of this finding is>
  Oracle: `<the exact command>`
  Result: <its output — a count, or "0 matches">
  ```

  Three things follow from that, and they are the point:

  1. **The command runs before the reply is written**, not after. The Result
     line is transcribed from real output; there is no version of this rule
     where I predict what the grep would say.
  2. **If I cannot write the command, I have not understood the finding.** An
     unwritable oracle is a signal to go back to the code, not a licence to
     reply in prose. If the class genuinely has no mechanical oracle (a design
     judgement, a naming preference), the reply says *that* on the Oracle
     line — `Oracle: none — <why this class is not mechanically enumerable>` —
     which is a claim I can be held to, unlike silence.
  3. **`instance = class` is still an oracle line**, not an exemption: the
     Oracle line carries the command that proves the class has exactly one
     member, and Result carries its `1`.

  This applies to **every** thread reply — fixes, declines, and "no change
  needed" alike. A decline especially: declining without an oracle is
  asserting the class is empty without looking.

- **Drive CI to green and fix unambiguous review nits** (off-by-one, missing
  await, dead import, lint, a clear shell/logic bug). I push the fix and leave a
  brief note; I don't narrate every round. CI failures and nits of this class
  are the skip-on-clean category — they don't wait on an adjudication, but they
  do get the class sweep above (a lint error's class is "this lint rule,
  everywhere in the diff").
- **Escalate anything that's a real decision.** A design / architecture /
  trade-off comment (which abstraction to use, whether to refactor more, a
  behavior change) goes to David via AskUserQuestion — I do **not** silently
  rewrite the design on a reviewer's say-so, even a bot's.
- **The adjudicator breaks non-converging loops, not a count.** A round
  dominated by failures of the previous round's fixes, or a fix that would be
  contested, is exactly what the mechanical record surfaces and what the
  adjudicator rules on. A loop still yielding new ground keeps running to its
  budget; past the budget the adjudicator sizes the extension, and the 2x rail
  sends it to David.
- **Reply inline on each comment's own thread — never a standalone summary.**
  When I act on (or decline) a reviewer comment (Codex or otherwise), I reply
  **directly on that specific comment's thread**, one reply per comment, saying
  what I did. I do **NOT** post a single new top-level PR comment summarizing
  several fixes — David tracks "is every issue addressed?" by seeing a reply on
  each thread, and a catch-all comment defeats that.
- **Internal artifacts re-request only for pushed fixes, and continue only
  on the strict rubric** (the internal-tier section at the top of this
  skill). There is no criticality gate any more — the artifact's class
  decides, not a rated number: internal means the automatic pass, re-review
  of fixes, and the strict adjudicator; product means a declared budget and
  the standard adjudicator. Every review request, either tier, names its
  pre-registered flip conditions (what finding, count, or change of shape
  would end the loop) and confirms there has been a behavioral change since
  the last reviewed commit.
- **A "usage limits for security reviews" bounce is NOT a code-review
  outage — ignore it and request the code review (David, 2026-08-15,
  correcting the 2026-08-08 rule that used to live here).** Codex meters
  security reviews and general code reviews separately, and our code-review
  capacity is effectively unlimited. **The canonical fact, the evidence, and
  the standing rule live in
  [`code-review.md`](../../../docs/engineering/code-review.md#codex-has-two-usage-limits--a-security-review-bounce-is-not-a-code-review-outage)**
  — it binds every agent watching a PR, so it is not restated here. The
  failure mode is in
  [`known-failure-patterns.md`](../../../docs/ai-context/known-failure-patterns.md)'s
  *Reading a scoped limit message as a blanket outage*; note that the rule
  this replaced quoted the "for security reviews" wording and still drew the
  unscoped conclusion, so having the evidence nearby is not protection.
  - **My enactment:** post `@codex review` as normal and treat the bounce as
    unrelated noise. A security-limit bounce never satisfies "converged,"
    never justifies skipping or deferring a round, and never licenses a
    merge.
  - **A genuine code-review outage** — a request producing **no code
    review**, judged *only* on whether the code review arrived. **A security
    bounce is irrelevant noise and must not enter this test** (Codex, round
    3): the two limits are independent, so a bounce can fire alongside a real
    code-review outage, and an "and no bounce" conjunction would let that
    unrelated comment mask the outage permanently — the one-retry
    termination would never fire and a high-stakes PR would wait forever.
    This is a real, separate case, and it is now a **full stop** rather than
    a stakes split (David, 2026-08-17): *"We'll have to pause our development
    until the token limit resets. You'll need to fail loudly."* **Every PR gets a Codex review, and nothing merges until
    it returns, whatever the PR's stakes** — an internal PR gets exactly one
    pass, but that one pass still has to come back. One retry, then stop re-asking and raise it with David as a
    🛑 banner with a push notification. **A security-limit bounce does not
    qualify.**
- **Fix commits get re-reviewed — one `@codex review` per fix round (David,
  2026-07-22).** Codex reviews the PR's *initial* diff, but a push does NOT
  reliably re-trigger it — so the fixes I push in response to review comments or
  CI failures would otherwise reach David's squash-merge unreviewed, and
  reactive fix code is exactly where subtle mistakes hide. After I've addressed
  a round of review feedback (fixes pushed, inline replies posted), I post
  **one** explicit trigger comment so the new commits get reviewed — batched
  per round, never per-comment, and it's the *commits* being reviewed, never my
  prose replies. **The trigger comment is the bare trigger and NOTHING else**
  (David, 2026-08-21): the connector interprets mention text, and
  trigger-plus-prose has measurably spawned unintended code-writing tasks
  (#490, #539, #472) while a bare trigger reliably starts a review. Round
  context — flip conditions, trend, focus areas — goes in a **separate,
  defanged comment posted immediately before** the trigger (reserved strings
  in their leet form per CLAUDE.md, e.g. atC0dex r3view). **No minimum rounds, no convergence ceremony** — that
  is the plan loop, not this: a clean/silent re-review ends it, and new
  substantive findings just follow the rules above (fix the mechanical,
  escalate real decisions, and let the adjudicator rule on the round).
  **The old zero-risk exemption — a docs-only push or comment typo needing no
  re-review — is RETIRED (David, 2026-08-17).** Nothing merges without a
  completed pass covering the commit that would merge, so any push after a
  review needs a fresh round however small it was: what makes a push safe is
  not knowable from its own diff, which is the assumption that let PR #487 be
  reported ready. The merge gate enforces this rather than trusting the
  judgement — `scripts/pr-ready.mjs` requires a `**Reviewed commit:**`
  announcement matching the head sha, so a push after the last pass simply
  fails the receipt.
  **Two conditions gate every re-request (the round-budget contract).**
  1. **A behavioral change since the last reviewed commit.** No re-request
     buys a round with prose edits: `node scripts/review-loop-record.mjs`
     classifies the diff since the last reviewed commit and precomputes
     `proseOnly`. A **skill file, `CLAUDE.md`, or a `docs/ai-context/`
     contract counts as behavioral** — in this repo those change what
     agents do — while comment wording, and a UAT doc do not. (This composes with the no-exemption rule above rather than
     contradicting it: a prose-only push may not *buy a round*, and it also
     doesn't *escape review* — it simply waits and rides the next
     behavioral round, since the merge gate demands a pass covering the
     final head either way.)
  2. **Pre-registered flip conditions, in the request itself.** Name, before
     the round runs, what would stop the loop: the finding that would end
     it, the count that would trip it, the shape change that would mean
     split. This is the only judgment-shaped device with a working record
     (2-for-2 on PR #488, against 0-for-15 for everything else), and it
     works precisely because a condition written in advance collides with an
     event instead of waiting to be recalled. A missing flip condition — or
     one that was already true when written — fires the adversarial subagent
     before the round proceeds.

  The round count itself is no longer mine to track or remember: the guard
  counts it from fresh GitHub evidence (a round-check receipt) and refuses
  past the budget. Because a round is a *completed reviewer pass*, a request
  that stalls and gets retried costs one round, not two — the count corrects
  itself the moment the retry's pass lands, with nothing to reconcile.

  **Name the branch head, never a specific SHA, in a review request (David,
  2026-08-17).** Codex reviews the head at the moment it runs, not the SHA it
  was told — and the `**Reviewed commit:**` line it emits is what the merge
  gate binds against and what the ledger keys on, so a request that names a
  commit the reviewer will not review misstates its own target. Say "the
  branch head" and let the cumulative-diff instruction carry the scope.

  **Verify CI on the SHA that is actually HEAD, not the one you last
  looked at.** After a push, the previous SHA's green checks say nothing
  about the current one, and `get_check_runs` returning `total_count: 0`
  means *checks have not reported yet* — which is not green and must never
  be reported as green.

  **The re-request says what to reconcile.** A bare `@codex review` on a fix round invites a
  review of just the new commits, so I state in the comment which findings the
  round was meant to close and ask Codex to confirm each is actually resolved
  in the code — not merely responded to. **The reviewer's side of this is the
  shared contract, not my ceremony**: what makes a prior finding genuinely
  closed, and how deep a re-review has to look, live in
  [`code-review.md`](../../../docs/engineering/code-review.md#re-reviews-round-2-onward)
  so any reviewer and any future implementing agent get the same standard. What
  stays mine here is who posts the trigger, what it names, and the git around
  it.
- **After 2+ fix rounds, ask for the cumulative diff, not just the latest
  commits (David, 2026-07-25).** A per-round `@codex review` only shows Codex
  the new commits since its last pass — fine for round 1's fix, but a fix in
  file A can silently break something in file B that was part of the
  *original* diff and isn't re-shown on round 2+. Once a PR has gone through
  more than one fix round, I say so explicitly in the re-request and ask
  Codex to check the branch's full diff against `main`
  (`git diff origin/main...HEAD --stat` gives me the file list to reference),
  not only the incremental commits — same "the diff is not the scope"
  principle as the plan loop's re-reviews, applied to code, and now stated for
  the reviewer as invariant 5 of
  [`code-review.md`'s *Re-reviews*](../../../docs/engineering/code-review.md#re-reviews-round-2-onward).
- **I resolve each thread myself right after I address it** (resident rule
  in `CLAUDE.md`, reversed 2026-08-06): reply inline with the fix commit or
  a reasoned decline, then resolve that thread — not a batch at the end, and
  never a standalone summary comment in place of the reply.
- I stay **frugal with GitHub replies** (only when genuinely necessary), and I
  stop watching once the PR is merged or closed, or when David says stop.

## Keeping the workstream issue's labels current

Per [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md),
`pr-watch` owns `stage:code-review` and everything downstream of it for the
PR's workstream issue (found via `Workstream: #N` in the PR body — if it's
missing, that PR skipped the tracking convention; flag it rather than
silently leaving the workstream unlabeled):

- **PR opens / round 1 triggers** → `stage:code-review`, `waiting:codex`.
- **Codex posts findings, I start responding** → `waiting:claude`.
- **I post the next round's `@codex review` trigger** → `waiting:codex`.
- **A genuine design/architecture decision goes to David** (the escalate
  rule above) → `waiting:david`; `stage:code-review` stays put — the stage
  hasn't moved, but the turn has.
- **CI is green and Codex has converged, and every thread is resolved** →
  the ready bar is met and **I merge it myself per CLAUDE.md's close-out
  contract (David, 2026-08-15)** — re-verify live state, squash-merge, sync,
  verify, report — so `stage:merge` is normally a moment, not a resting
  state. The exception is a carve-out PR (guardrail/authority-widening,
  which stays David-merge-only): there, label `stage:merge`,
  `waiting:david`, deliver the 🛑 merge ask, and don't let it sit at
  `stage:code-review` — a ready-to-go workstream parked under the wrong
  label is exactly what `/status-all` exists to surface.
- **The PR merges with a Post-merge verification section that has real
  content** → `stage:test-run`, `waiting:replit` — the lifecycle's own
  Test-run stage, between Merge and UAT, not a step to skip past. Per the
  `pr-docs` contract this stage is now **executed inside close-out**: I
  drive the section through the connector, read the results, and on a
  clean pass move the label myself to `stage:uat`/`stage:close-out` per
  the next bullet's check, in the same close-out sequence. A failure
  keeps the workstream here while it routes through the normal channel.
  (The `test-run-completion.yml` Action that used to own this transition —
  built on PR #334 when file deletion was the completion signal and no
  agent owned the moment — is retired along with the TEST_RUN file
  pattern, 2026-08-15: close-out now has an owner, me. A **legacy**
  `docs/tests/Replit/PR<N>_..._TEST_RUN.md` doc still on `main` follows
  this same flow, plus deleting the doc on a full pass — a tiny deletion
  PR, self-merged; the label move is likewise mine, since the Action is
  gone.)
- **The PR merges with "none needed" verification** → `stage:uat` **only
  after the close-out sync checks pass, and only if a UAT doc
  exists or is actually due**. The transition moment is the verified Repl
  sync (matching SHA + clean worktree, per CLAUDE.md's close-out
  sequence), not the merge click — a failed sync would otherwise put a
  David-held UAT gate on the board for a build he can't actually reach;
  until the checks pass the workstream stays agent-held in close-out.
  On the UAT-doc test: pure-docs/pure-devops PRs never have one,
  and neither does a Tier A bugfix or a Tier B bugfix whose only surface is
  internal (per `working-modes.md`'s Tier B exception): all three go
  straight to `stage:close-out` instead, since holding them at `uat` would
  be a gate with nothing to run against it. "Has product-visible behavior"
  is *not* the test by itself — a Tier A fix can be product-visible and
  still ship no UAT doc, which is what makes checking for the doc the right
  test, not the behavior. **When that straight-to-close-out case is a
  product-visible fix that shipped no UAT doc (the Tier A case), the
  close-out State of Play's *What you need to do* aims David instead of
  saying "nothing" (David, 2026-08-09):** one line — where in the app to
  glance next time he's there, and to reopen the workstream if the symptom
  persists. No gate, no extra stage — David is the acceptance test whether
  or not a stage tracks it; this just points him. Never `stage:done` at
  merge — that's David's to set once he's actually verified it, the same
  reason the Project's built-in `PR merged → Done` workflow is off.

**If this PR is one phase of a phased feature, every `waiting:` toggle
updates the parent too — not just close-out.** Per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)'s
*Phased features* section, the parent's `waiting:` is supposed to mirror
whoever holds the active phase at all times. Touching it only at close-out
leaves the parent showing a stale holder for the entire review-and-merge
cycle of every phase — so **each time this section moves the phase issue's
`waiting:`** (round-by-round toggling, escalation, merge), mirror the same
value onto the parent, in the same edit, State of Play included.

**The parent's Phases checklist moves when the phase issue itself reaches
`stage:close-out` — never at merge.** This is the same distinction the
general flow above already makes for an ordinary workstream (merge is not
verified work; David's UAT is) — a phase is no different. A product-visible
phase merges into `stage:test-run`/`stage:uat` like any workstream and sits
there through David's UAT before reaching `stage:close-out`; a phase with
no UAT reaches `stage:close-out` sooner, immediately after its verification
checks, but through the same transition, not a merge-time shortcut. Ticking
the checklist at merge instead would let `/next` treat a phase as done —
and surface the next phase, or close the parent — while its own UAT is
still outstanding.

**Keep mirroring the parent's `waiting:` through this entire span**, per
the toggle rule above — that already covers the phase's `stage:uat`/
`waiting:david` transition, so the parent correctly shows "waiting on
David's UAT" for exactly as long as that's true.

**When the phase issue reaches `stage:close-out`, move the parent's
checklist**, in the same edit as the phase's own transition:

- **Tick this phase's checkbox** in the parent's checklist, replacing
  `(active)` with the merged PR number.
- **Re-point the parent's `waiting:`** at whoever holds the next phase — or
  `waiting:claude` when the next phase hasn't been opened yet, since an
  unstarted next phase is work owed, not a resting state.
- **If this was the last phase**, move the parent straight to
  `stage:close-out`. There is no separate whole-feature UAT gate — every
  phase already ran its own UAT wherever it was product-visible, per
  `workstream-tracking.md`'s *Phased features* section, so a UAT stage here
  would be a gate with nothing left to run against it.
- **If a phase's own UAT surfaced a bug**, that's the UAT-descent case —
  see `workstream-tracking.md`'s *When UAT finds a bug* section for the
  `Blocked by:` marker that records the way back up. The phase stays open
  (not `stage:close-out`) until that descent resolves, so the checklist
  correctly doesn't tick early.

**At the close-out of any workstream, check whether it was the target of a
`Blocked by:` marker** — one `search_issues` call, `"Blocked by: #<this
issue>" in:body`, trusted-issue filtered the same way every other marker
lookup here is. If a match comes back, that match is a parent this closure
just unblocked — but what to do about its `waiting:` depends on whether
this is the UAT-descent shape:

- **If the matched issue's State of Play records a stashed prior
  `waiting:` value** (only `bugfix`'s UAT-descent intake writes one, per
  `workstream-tracking.md`'s *When UAT finds a bug*) — **restore it**
  (normally back to `david`) and remove the now-stale `Blocked by:` line.
  Skipping this leaves the unblocked parent sitting at `waiting:claude`
  indefinitely — mechanically releasable per the `Blocked by:` contract,
  but with no open question left for anyone to notice needs restoring.
  **If that matched issue is itself a phase sub-issue, restore its
  parent's `waiting:` the same way, in the same edit** — `bugfix` mirrors
  the descent flip onto the parent at intake, so the restore has to mirror
  back the same way, or the parent is left stuck at `waiting:claude` after
  the phase itself has already recovered.
- **Otherwise** — an ordinary workstream-to-workstream dependency, or a
  blocked backlog item — **only remove the stale `Blocked by:` line.**
  Nothing stashed a prior value for these, so guessing a `waiting:` (or
  adding one to a `queue:`-only item that shouldn't carry the label at
  all) would fabricate state instead of restoring it. Their own next
  `waiting:`-touching moment sets the right value normally.

**Every transition above lands with a State of Play update in the same
edit** — the block's `Stage`/`Waiting on`/`Last movement` fields at minimum,
and `Where it actually stands`/`What's blocking` whenever there's real
narrative to add (a round's findings, an escalation's actual question, what
shipped at merge). Per `workstream-tracking.md`'s ownership rule: the skill
that moves the label moves the block, in the same edit, every time.

An echo of my own comment bouncing back as a webhook event still needs the
silent live-state check like any other event, but never a label change on
its own — only real state (a new commit, a new finding, an actual merge)
moves a label.

Codex (and other AI reviewers) remain the independent reviewers; my job while
watching is to *respond* — fix the mechanical, escalate the substantive.

