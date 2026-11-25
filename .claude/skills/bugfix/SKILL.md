---
name: bugfix
description: Bug-fixing workflow — fix a bug without the planning ceremony. Use when David says /bugfix (the explicit override), or whenever a request is bugfix-shaped — a report that already-agreed behavior is broken, "just fix this", a defect with an observable symptom. Announce the classification in one line on entry; ask when it could really be a behavior change. One bug per branch per PR, opened as soon as the fix is verified. Drops the plan file and the plan-review loop; keeps (and tiers) verification — a Tier A/B fix carries a regression test, a blast-radius note, and a bugfix oracle in the PR body, while a trivial Tier C schema fix uses its own dedicated oracle block instead — and Codex still reviews the diff under the write-gate rule. Opposite of the default feature-building flow in CLAUDE.md.
---

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# Bug-fixing mode

> The shared, cross-agent contract — the tier checklist, the loop, the bugfix
> oracle, what's turned off and what's non-negotiable — is
> **[`docs/ai-context/working-modes.md`](../../../docs/ai-context/working-modes.md)**
> (Codex uses it too). **Read it; it is the source of truth.** This skill adds
> only what is specific to *me*: git mechanics in this environment, the PR
> template, the Codex trigger mechanics, and the model-tier prompts.

Entry is **routed, announced, and vetoable.** I classify each work request by
its shape:

- **Bugfix-shaped** — a report that already-agreed behavior is broken (an
  error, a wrong output, a defect with an observable symptom) → I enter this
  workflow and **announce it in one line** ("Treating this as a bugfix — tier
  after diagnosis; say the word if you want feature ceremony"). The
  announcement is David's veto surface: he pre-declares nothing, but always
  sees which contract is in force before code moves.
- **`/bugfix` is the explicit override** — it forces the light path when I'd
  otherwise hesitate. It is still a hypothesis, not a verdict: Tier C exits
  the workflow regardless of how it was entered.
- **Ambiguous** — the "bug" could really be a behavior change ("fix the
  ranking, it feels wrong") → one question, under its ID (`claude-core.md`, interaction rule 4): whether behaviour
  changes is product intent, the one ambiguity the lighter-mode rule keeps
  as an ask (`working-modes.md`, *How each agent enters / exits a mode*).

**Classification is per-request — there is no sticky mode state.** "Here's
another one" is bugfix-shaped on its face and needs no re-invocation; a
feature-shaped request arriving mid-run simply gets the feature workflow
(announced, like every classification). What *does* recur per bug is the
branch discipline in step 1 — skipping it is how a second bug lands on the
first bug's already-pushed branch, breaking one-bug-per-PR.

**Never for a feature David has declared prototype phase.** A defect there is
the next version through the `prototype` skill, not a bugfix PR — nothing
about a prototype is agreed behaviour yet, and no review loop runs on it
([`working-modes.md`](../../../docs/ai-context/working-modes.md#the-prototype-phase-per-feature-david-2026-09-26)). The registry is read
before this mode is entered.

**What this mode is:** it drops the *planning* ceremony (plan file, pre-plan
conversation, the multi-round Codex plan-review loop), not the
*verification*. The verification scales to what diagnosis reveals the fix
actually touches.

## 1. Before each bug — set up the branch

**This step runs once per bug, *before* diagnosing it — however the bug's
request arrived** (routed classification or explicit `/bugfix`). Check state
first: if the branch currently checked out already has a prior bug's fix
pushed to it (its PR is open or merged), that branch is spoken for — cut a
new one per below. Only skip this step if the current branch has no bug on
it yet (nothing committed).

One bug, one branch, one PR. Cut fresh from current `origin/main` (David
squash-merges, so a fresh base avoids phantom conflicts), with a **topic** slug:

```
git fetch origin main
# Topic slug, not a date: claude/bugfix-annual-plan-lookup
git checkout -b claude/bugfix-<topic> origin/main   # -b, never -B
```

**Never `-B`.** `-B` *resets* the ref to `origin/main`, which would silently wipe
an existing same-named branch's unpushed work. If `-b` fails because the name
exists, that is the signal to pick a different slug — never fall back to `-B`,
`--force`, or any reset. (See CLAUDE.md's *This environment's git
constraints*.)

> **The assigned-branch exception is scoped to an *unclaimed* branch.** If I was
> invoked on a designated working branch and it has no bug on it yet, **stay on
> it**. But the "spoken for" check above still applies on every bug: the
> moment that assigned branch carries a prior bug's pushed fix, it's claimed the
> same as any other branch, and this exception no longer covers it. If the
> environment also disallows creating a fresh branch (a runner that assigned
> exactly one branch), don't put the second bug on the first bug's branch to
> route around that — stop and ask David for a new assigned branch instead.

**A bug arriving mid-feature-build doesn't touch the feature's working
tree.** Don't stash-juggle the feature state: run the bugfix in an isolated
worktree (`EnterWorktree`, branched from `origin/main` per above) or, when a
fresh session is cleaner, start one for the bug (the `handoff` skill, Step 5,
for the call and its fallback) and say which I chose — either way the
feature tree comes back untouched.

Then confirm the branch name (the classification announcement at entry
already named the workflow).

**Workstream issue.** The disclosure check that gates opening it is the
shared contract's
([`working-modes.md`](../../../docs/ai-context/working-modes.md#disclosure-check-before-the-workstream-issue-opens)'s
*Disclosure check, before the workstream issue opens*); I run it.

For everything else: per `workstream-tracking.md`, bugfix mode branches
straight from Discovery to Coding, skipping Planning and Plan approval. If
David's bug report doesn't already have a workstream issue, **check for a
backlog issue first** — a known, already-queued bug (`queue:` label). Per
`workstream-tracking.md`'s *The backlog* section, promote a matching
backlog issue (drop `queue:`, add the labels below) rather than opening a
duplicate. Only when no backlog match exists does a genuinely new issue
open — **but only if the disclosure check above passed.** If it didn't, open
a private draft Project item instead of a public issue, and say so plainly
rather than silently taking the fast path. When the check passed, open the
public issue with `stage:coding`, `waiting:claude`, `mode:bugfix` — one per
bug, matching the one-bug-per-branch-per-PR rule above — and give it a State
of Play block (per `workstream-tracking.md`) at the same time, not just
labels. From PR open onward, `pr-watch` owns the label transitions and the
block's upkeep.

**If this bug was found during UAT, record the way back up — in the same
edit, not later.** Per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)'s
*When UAT finds a bug*:

- Add `Blocked by: #<this bug>` to the **interrupted** workstream's issue
  body, and one line in its State of Play naming **which UAT step failed**, by its static ID
  (`uat-doc-format.md`, *The rule that makes it deterministic*), so
  resumption is "resume at T4" rather than a full re-run.
- **Also flip the interrupted issue's `waiting:` label to `claude`** —
  unless this session was started from a `/uat` run's intake whose prompt
  says the run is still live: that label, and its parent's, are then the
  UAT session's to set when the run stops (the `uat` skill, section 4). Otherwise flip it,
  recording its prior value (normally `david`, mid-UAT) in the same State
  of Play line. (`/status-all` doesn't parse `Blocked by:` and is deliberately left that way; left at
  `waiting:david` it shows a non-actionable UAT under NEEDS YOU while the
  actual ask is agent-held work.)
- **If the interrupted workstream is a phase sub-issue, mirror the same
  flip onto its parent, in the same edit.** The parent's `waiting:`
  mirroring obligation (`pr-watch`, per `workstream-tracking.md`'s *Phased
  features*) only covers PR-driven toggles — this is an issue edit, not a
  PR one.
- Do it at intake, while the context is in front of me. A session that ends
  before this is written loses the link entirely; nothing reconstructs it.
- The chain nests if the fix hits its own blocker, and it pops on its own:
  closing this issue makes the interrupted UAT actionable again, and
  `/next` surfaces it as the top recommendation.
- **If diagnosis reveals this isn't a bug fix at all** but a real
  behavior change or a subsystem rebuild, that's Tier C — leave bugfix mode
  per the classification rule. The `Blocked by:` link stays exactly as
  written; it doesn't care which mode the work ends up in.

## 2. Diagnose, classify, then fix

Follow the loop in
[`working-modes.md`](../../../docs/ai-context/working-modes.md#per-bug--the-loop)
— root cause, **tier classification**, regression test first, smallest correct
fix, blast radius, verify, one commit.

**Step 1 of that loop asks whether the root cause is even in the repo.** When
a bug turns on what the running system actually *contains*, the shared
contract puts that evidence in step 1, before the tier — the rule is
cross-agent and lives there, not here.

**This is my enactment of it.** When a bug is in that class, read
**[`live-diagnosis.md`](live-diagnosis.md)**: which source answers which
question (Sentry for what production threw, the Agent's read-only production
query for what production data is, the Repl for live dev state, the
repo for what the code does), how to drive the connector so the answer is
evidence rather than the agent's account of itself, and what must be redacted
before any of it is quoted into a public artifact. It stays diagnosis — the fix
still goes branch → PR → Codex → merge.

**The classification is a real beat, not a formality.** I state the tier and the
reason out loud before writing the fix, because the tier decides what ships with
the PR. Tier A is the exception, by design.

**Model tier follows the classification (CLAUDE.md's *Model, cost, and routing*):**

- **Entering the bugfix workflow** (routed or via `/bugfix`) — **diagnose on
  whatever tier the session is on; ask for Opus before writing the fix.** The
  boundary is product code, and a bugfix crosses it: reproducing the symptom,
  reading the failing path and classifying the tier are all thinking, so a
  Fable session does them without ceremony — then names the boundary and asks
  for `/model claude-opus-5-5` before the first edit. **A Tier B fix never starts
  on Fable at all**, since it is Opus-reserved execution. Triage and
  diagnosis stay in my main loop. A **bounded** piece of the work — reproduce
  the symptom, find every caller of X — is eligible for a Sonnet subagent;
  the diagnosis itself is not, because it is stateful.
- **The moment I classify a fix as Tier B** — I say so, and the fix is
  **not eligible for subagent routing**: I write it myself, in my main loop.
  - **This assumes the main loop is Opus — verify, don't assume.** A Tier B
    fix is Opus-reserved *execution*, and the contract requires me to write
    it myself, so it is not routable by construction. If the session is
    genuinely below Opus — an in-Repl session pinned to `sonnet`, or one
    still on `opusplan` until restart — **I stop and ask David to run this
    fix from an Opus session.** Executing a Tier B fix on Sonnet because "the
    contract says the session is Opus" is exactly the silent failure the tier
    guard exists to prevent.
- **Tier C** — stop and escalate to David; it isn't a bug fix, so this mode
  doesn't pick its model tier. Where it goes next does: non-trivial or
  behavior-changing Tier C work **restarts in feature mode**, which picks the
  tier there — but a genuinely **trivial database schema fix that David
  explicitly green-lights runs migration ceremony directly, without
  restarting anywhere** (see *When NOT to use this mode*), and that path is
  **Opus, always** — a migration is Opus-reserved execution (`CLAUDE.md`'s
  *Model, cost, and routing*) — never the Sonnet triage tier it was
  diagnosed on.

## 3. Ship it — PR immediately, no waiting

As soon as the fix is verified, open the PR. **There is no "create the PR"
gate** — holding the PR back only delays the review that catches things.

1. Push the **actual current branch** — `git push -u origin HEAD` (retry with
   backoff on network errors; never force-push). Don't hardcode the
   `claude/bugfix-<topic>` name here: the assigned-branch exception in step 1
   means the real name can differ, and pushing a literal wrong name either
   fails or targets an unrelated ref. The branch was cut from current
   `origin/main` and has never been pushed, so **no rebase is needed or
   wanted** — see CLAUDE.md's git constraints. If the branch later needs
   current `main`, **merge, don't rebase**.
2. Open the PR with `mcp__github__create_pull_request` — base `main`
   normally, **never as a draft**: round 1 fires on a non-draft open, and a
   Tier B fix's UAT section is already in the body at open (step 3).
   **Exception: a stacked fix bases against its parent's branch, not `main`**
   (per `working-modes.md`'s *Dependent bugs* note) — otherwise the new PR's
   diff carries both bugs' commits until the parent merges. **Retarget to
   `main` *before* the parent's PR is merged, not after** — this repo
   auto-deletes a merged branch with no reliable window afterward (deletion
   can happen as part of the merge itself), orphaning the stacked PR.
   Retargeting early leaves the diff temporarily broad (it still shows the
   parent's unmerged commits) — accept that, it's cosmetic. Once the parent
   has actually merged, narrow the diff: `git fetch origin main && git merge
   origin/main` into this branch (merge, never rebase, on an already-pushed
   branch), then push.
   Use **`.github/pull_request_template.md`** — the
   repo template applies to bug fixes too. Fill the **Approved-plan oracle**
   section with the **bugfix oracle** instead of "n/a — no plan" — **which
   block depends on the tier:** Before it opens, the whole body — the
   quoted symptom, root cause and blast radius included — passes the
   canonical disclosure check or is written sanitized, its specifics on the
   private path ([`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md#what-must-never-happen)).

   **The tier letter goes on the body's `Oracle source:` line**
   (`claude-core.md` Pull requests rule 4); everything else stays prose. The
   reason for the tier is its own required field, **`Tier rationale`**,
   because a reviewer uses it to challenge a mis-tiering and a bare letter
   cannot be challenged.

   The body also carries the **Decisions taken on my recommendation**
   section every PR carries (`none` when there are none): a bugfix's tier
   oracle is the plan for *A reversible choice proceeds*
   (`agent-working-rules.md`), so a reversible technical choice inside a Tier
   A or B fix proceeds on my recommendation and is listed there — under the
   canonical disclosure check like every record of one (`workstream-tracking.md`,
   *Sensitive / disclosure-carve-out workstreams*) — and never the regression
   test of step 3, which only that step's carve-out waives
   ([`working-modes.md`](../../../docs/ai-context/working-modes.md#per-bug--the-loop)).

   **Tier A/B:**
   ````markdown
   Oracle source: bugfix, Tier <A or B>

   **Tier rationale:** <the tier checks run, written "tier check 1" and "tier check 2", never Q1/Q2, which are David's question IDs (`claude-core.md`, interaction rule 4): which one fired (B), or
     which were ruled out (A) — a bare tier letter isn't enough; A is the
     classification a reviewer most needs to be able to challenge>
   **Reported symptom:** <David's report, quoted verbatim>
   **Intended correct behavior:** <what right looks like>
   **Must not change:** <adjacent behaviors sharing this code path>
   **Root cause:** <the mechanism, not the instance>
   **Blast radius:** <what else calls this / shares this path, and what I checked>
   ````

   **Tier C, trivial schema fix** (David authorized migration ceremony directly
   — a *different* block, not the one above):
   ````markdown
   Oracle source: bugfix, Tier C

   **Tier rationale:** trivial schema/migration fix, no plan
   **Reported symptom:** <David's report, quoted verbatim>
   **Root cause:** <the mechanism, not the instance>
   **Why this is trivial:** <single-step, no data transformation, no behavior
     change — the specific reason it didn't need a full plan>
   **David's go-ahead:** <how/when confirmed>
   **Migration ceremony checklist:** <idempotency, observable counts,
     human-edited-row preservation, rollback for destructive ops>
   ````

   Then **Verification** (exact commands + results, and the click-through steps
   to observe the fix), and the checklist.
3. **Tier B, product-visible fix — ship the UAT section in this PR's body.** The
   test is whether the fix has *any* product-visible behavior, not which
   Q1/Q2 trigger put it in Tier B — a fix whose only surface is internal
   (CI, build tooling, API-schema codegen with no frontend-visible type
   change) takes the **internal/infra-only exception**
   instead: a written verification note in the PR body, no UAT section (see
   [`working-modes.md`](../../../docs/ai-context/working-modes.md#tier-b--elevated-fix)).
   When one is due it is the `## UAT` section of the PR body, written
   before the PR opens like the rest of the body. Write it to
   [`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md) — the format
   is mandatory, and **not** "match the nearest merged PR's section." **No
   Artifact page** — David works the script through
   [`/uat`](../uat/SKILL.md) with me — and its setup lines are mine to
   execute, per `pr-docs`. The PR body's Post-merge verification section
   gets real content only if something genuinely needs Replit's
   environment — per
   [`test-run-contract.md`](../../../docs/tests/test-run-contract.md), it
   is not a default ("none needed" is the correct content otherwise; no
   standalone TEST_RUN file). **Name the PR in the
   workstream issue's State of Play `Artifacts` field as carrying the
   UAT** — the same instruction `pr-docs` follows for feature-mode UAT
   sections, so a cold-resumed `/uat` finds the script regardless of which
   path produced it.
4. **Watch the PR** per CLAUDE.md's *Watching the PRs I open*:
   `subscribe_pr_activity` immediately, on whatever tier the session is on.
   **There is no model gate.**

## 4. Drive the review under the write-gate rule

The review-loop contract is shared and enacted elsewhere — **the mechanics
live in the `pr-watch` skill** (which loads for any watched PR, bugfix or
feature) **and in
[`working-modes.md`](../../../docs/ai-context/working-modes.md)**: the tier of
what the fix touches (a statement of what is downstream — not a rubric
selector, and not a round budget), the **write-gate
rule — every round that returns findings gets two independent assessments
before anything is written for it, and any commit that does get written gets a
mandatory review round; the shared judgement advises rather than binds**
(no continue/stop call, criticality gate, count trend, oscillation
diagnosis, per-finding adjudicator or critical-only decline quota applies), the
fix / accept-and-document / escalate triage stated per finding, the
class-sweep protocol (name the class, cite the mechanical oracle, sweep to
zero, re-run prior rounds' oracles before every push), resolving each thread
myself right after addressing it, bare-trigger re-requests with context in a
separate defanged comment, the cumulative-diff rule after 2+ fix rounds, and
unsubscribing at merge/close. **Pointer, not a copy** — those mechanics are
not restated here.

What is *bugfix-specific* about the loop:

- **The review carries more weight here than in feature mode.** With no plan
  and (on Tier A) no UAT section, Codex's diff review is the main net.
  Engage every round; the light *planning* path must never shade into a
  light *review* path.
- **Round 1 is automatic.** The Codex connector reviews on non-draft PR
  open — every bugfix PR opens non-draft, Tier B included (step 2) — so no
  `@codex review` on open.
- **The artifact the fix touches picks the tier — never the fact that it's
  a fix.** A fix to product code is a product loop. A bug can be *in the
  docs*: when the whole diff is agent-facing markdown or process tooling, the
  internal loop applies to a fix that is internal by its consequence and
  recoverability — the automatic pass, a coherent batch of corrections if any
  are warranted, and a review of that corrected head — and what ends it is the
  builder's judgement under the ship gate, with "record the gap" the ordinary
  answer from the second review on; no count ends it. It is scoped by
  consequence and not by the tier, so a fix to process tooling governing
  approvals, publication, credentials or destructive operations is weighed on
  its consequence and recoverability. The tier itself only says nobody's
  money or data is downstream, and leaves the judgement to
  [`review-judgment.md`](../../../docs/ai-context/review-judgment.md) — exactly
  as if the same change had arrived through feature mode. Entering through
  this mode never raises an artifact's ceremony, and never lowers product
  code's.
- **The re-reviewer's oracle is the bugfix oracle** (step 3), not a plan —
  it's what lets Codex ask "root cause or symptom-patch?" and "did this
  miss a caller?", so re-requests reference it the way feature loops
  reference the approved plan.

The reviewer's own standard is shared, not my ceremony:
[`code-review.md`](../../../docs/engineering/code-review.md#re-reviews-round-2-onward).

## When the next request isn't a bug

There is no mode to exit — classification is per-request. A feature-shaped
request ("let's build / add / change X") simply gets the feature workflow —
after the registry read at the top of this file, which sends a
prototype-phase feature to the `prototype` skill instead (where a first
version still plans) — and the
classification announcement makes the switch visible. Two cases
still deserve care:

- **A request that could be either** — a "fix" that might really mean
  re-designing the behavior — gets one question, under its ID, not a guess:
  whether behaviour changes is product intent, which still asks even where
  the mode itself is taken on the lighter reading
  ([`working-modes.md`](../../../docs/ai-context/working-modes.md#how-each-agent-enters--exits-a-mode),
  *How each agent enters / exits a mode*; what the product should do is
  *Ask always* in `agent-working-rules.md`, and a consequence a settled
  decision already covers is not asked — *A reversible choice proceeds on
  the recommendation* there):
  guessing wrong is expensive in both directions — either I skip a plan the
  work needed, or I pile ceremony onto a one-line fix.
- **Tier C** is the same call arriving from the other direction: the request
  looked bugfix-shaped, and *diagnosis* revealed it's really
  feature/migration work. Same escalation, different trigger.

Questions, status checks, and meta-discussion aren't work requests and get
no classification at all.

## When NOT to use this mode

A feature, a behavior change, **any *database* schema change, migration, or
backfill** (Tier C without exception, regardless of product consequence; not
generated API-validation schemas, which stay Q1 Tier B — see
[`working-modes.md`](../../../docs/ai-context/working-modes.md#tier-c--this-is-not-a-bug-fix-leave-bugfix-mode)),
or anything where David needs to verify intent is out of the fast path — a
non-trivial one goes to **feature mode**, a genuinely trivial database schema
fix runs migration ceremony directly per Tier C, and one on a feature the
registry lists in prototype phase goes to the `prototype` skill. Don't use `/bugfix` to sneak a
feature through the fast path — and don't let a fix quietly become one
mid-build; that's Tier C.

**A "clean up the review findings" batch is not a bug fix either.** Leftover
findings from earlier PRs are N separate defects, and batching them
recreates what one-bug-per-PR banned. Each real defect gets its own
classification and its own PR.

When unsure whether behaviour changes, ask; when unsure only which mode
applies, take the lighter one and say so (`working-modes.md`, *How each
agent enters / exits a mode*).
