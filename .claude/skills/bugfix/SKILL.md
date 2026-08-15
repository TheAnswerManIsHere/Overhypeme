---
name: bugfix
description: Bug-fixing workflow — fix a bug without the planning ceremony. Use when David says /bugfix (the explicit override), or whenever a request is bugfix-shaped — a report that already-agreed behavior is broken, "just fix this", a defect with an observable symptom. Announce the classification in one line on entry; ask when it could really be a behavior change. One bug per branch per PR, opened as soon as the fix is verified. Drops the plan file and the plan-review loop; keeps (and tiers) verification — a Tier A/B fix carries a regression test, a blast-radius note, and a bugfix oracle in the PR body, while a trivial Tier C schema fix uses its own dedicated oracle block instead — and Codex still reviews the diff to convergence. Opposite of the default feature-building flow in CLAUDE.md.
---

# Bug-fixing mode

> The shared, cross-agent contract — the tier checklist, the loop, the bugfix
> oracle, what's turned off and what's non-negotiable — is
> **[`docs/ai-context/working-modes.md`](../../../docs/ai-context/working-modes.md)**
> (Codex uses it too). **Read it; it is the source of truth.** This skill adds
> only what is specific to *me*: git mechanics in this environment, the PR
> template, the Codex trigger mechanics, and the model-tier prompts.

Entry is **routed, announced, and vetoable (David, 2026-08-09 — replacing
explicit-only invocation).** I classify each work request by its shape:

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
  ranking, it feels wrong") → one numbered question, per the pause-and-ask
  rule. No entry design settles these; they were always going to be asked.

**Classification is per-request — there is no sticky mode state.** "Here's
another one" is bugfix-shaped on its face and needs no re-invocation; a
feature-shaped request arriving mid-run simply gets the feature workflow
(announced, like every classification). What *does* recur per bug is the
branch discipline in step 1 — skipping it is how a second bug lands on the
first bug's already-pushed branch, silently breaking one-bug-per-PR.

**The one-line summary of what this mode is:** it drops the *planning* ceremony
(plan file, pre-plan conversation, the multi-round Codex plan-review loop), not
the *verification*. A small-looking fix can still have wide consequences, so the
verification scales to what diagnosis reveals the fix actually touches.

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
`--force`, or any reset. (`.claude/guard.sh` blocks force-push and
`git reset --hard` outright; see CLAUDE.md's *This environment's git
constraints*.)

> **The assigned-branch exception is scoped to an *unclaimed* branch.** If I was
> invoked on a designated working branch and it has no bug on it yet, **stay on
> it** — the fresh-branch step is for the normal case where David starts a bug
> from scratch. But the "spoken for" check above still applies on every bug: the
> moment that assigned branch carries a prior bug's pushed fix, it's claimed the
> same as any other branch, and this exception no longer covers it. If the
> environment also disallows creating a fresh branch (a runner that assigned
> exactly one branch), don't put the second bug on the first bug's branch to
> route around that — stop and ask David for a new assigned branch instead.

**A bug arriving mid-feature-build doesn't touch the feature's working tree
(David, 2026-08-09).** With routed entry, bug reports can land while a
feature branch has in-flight work. Don't stash-juggle the feature state: run
the bugfix in an isolated worktree (`EnterWorktree`, branched from
`origin/main` per above) or say plainly that a fresh session is cleaner and
let David choose — either way the feature tree comes back untouched.

Then confirm the branch name (the classification announcement at entry
already named the workflow).

**Workstream issue.** The disclosure check that gates opening it is a
shared-contract requirement now
([`working-modes.md`](../../../docs/ai-context/working-modes.md#disclosure-check-before-the-workstream-issue-opens)'s
*Disclosure check, before the workstream issue opens*), not Claude-specific
— I run it, but I don't restate the *why* here.

For everything else: per `workstream-tracking.md`, bugfix mode branches
straight from Discovery to Coding, skipping Planning and Plan approval. If
David's bug report doesn't already have a workstream issue, **check for a
backlog issue first** — a known, already-queued bug (`queue:` label) is
exactly this situation, David just decided to fix it now. Per
`workstream-tracking.md`'s *The backlog* section, promote a matching
backlog issue (drop `queue:`, add the labels below) rather than opening a
duplicate. Only when no backlog match exists does a genuinely new issue
open — **but only if the disclosure check above passed.** If it didn't, this is
where that matters mechanically, not just as a stated rule: open a private
draft Project item instead of a public issue, and say so plainly rather
than silently taking the fast path. When the check passed, open the public
issue with `stage:coding`, `waiting:claude`, `mode:bugfix` — one per bug,
matching the one-bug-per-branch-per-PR rule above — and give it a State of
Play block (per `workstream-tracking.md`) at the same time, not just
labels. From PR open onward, `pr-watch` owns the label transitions and the
block's upkeep.

**If this bug was found during UAT, record the way back up — in the same
edit, not later.** This is the single most common way a bug arrives here,
and the descent is what makes it dangerous: chasing it is usually right
pre-launch, but the interrupted UAT is what gets lost. Per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)'s
*When UAT finds a bug*:

- Add `Blocked by: #<this bug>` to the **interrupted** workstream's issue
  body, and one line in its State of Play naming **which UAT step failed**
  — that's what turns resumption into "resume at step 4" rather than a full
  re-run.
- **Also flip the interrupted issue's `waiting:` label to `claude`**,
  recording its prior value (normally `david`, mid-UAT) in the same State
  of Play line. Left at `waiting:david`, `/status-all` — which doesn't
  parse `Blocked by:` and was deliberately left unchanged — keeps showing
  a mechanically non-actionable UAT under NEEDS YOU while the actual ask
  is the new bug, which is agent-held work. `waiting:claude` is accurate:
  a session needs to close this bug before David has anything to look at
  again.
- **If the interrupted workstream is a phase sub-issue, mirror the same
  flip onto its parent, in the same edit.** The parent's `waiting:`
  mirroring obligation (`pr-watch`, per `workstream-tracking.md`'s *Phased
  features*) only covers PR-driven toggles — this is an issue edit, not a
  PR one, so without this the parent sits at `waiting:david` for the whole
  descent while the phase correctly shows `waiting:claude`.
- Do it at intake, while the context is in front of me. A session that ends
  before this is written loses the link entirely; nothing reconstructs it.
- The chain nests if the fix hits its own blocker, and it pops on its own:
  closing this issue makes the interrupted UAT actionable again, and
  `/next` surfaces it as the top recommendation.
- **If diagnosis reveals this isn't a bug fix at all** but a real
  behavior change or a subsystem rebuild (the PR #213 → admin-permission
  shape), that's Tier C — leave bugfix mode per the classification rule.
  The `Blocked by:` link stays exactly as written; it doesn't care which
  mode the work ends up in.

## 2. Diagnose, classify, then fix

Follow the loop in
[`working-modes.md`](../../../docs/ai-context/working-modes.md#per-bug--the-loop)
— root cause, **tier classification**, regression test first, smallest correct
fix, blast radius, verify, one commit.

**The classification is a real beat, not a formality.** I state the tier and the
reason out loud before writing the fix, because the tier decides what ships with
the PR. Tier A is the exception, by design.

**Model tier follows the classification (CLAUDE.md's *Token / cost discipline*):**

- **Entering the bugfix workflow** (routed or via `/bugfix`) — Sonnet is
  fine. Triage and diagnosis are usually shallow, and Codex's diff review is
  the net.
- **The moment I classify a fix as Tier B** — I say so and ask David to switch me
  to **Opus** before I write it. That is the whole point of the tier: these are
  the fixes where a subtle error slips both nets. I don't switch myself; a
  system-reminder confirming the change is what tells me it happened.
- **Tier C** — stop and escalate to David; it isn't a bug fix, so this mode
  doesn't pick its model tier. Where it goes next does: non-trivial or
  behavior-changing Tier C work **restarts in feature mode**, which picks the
  tier there — but a genuinely **trivial database schema fix that David
  explicitly green-lights runs migration ceremony directly, without
  restarting anywhere** (see *When NOT to use this mode*), and that path is
  **Opus, always** per the tier table's migrations row, never the Sonnet
  triage tier it was diagnosed on.

## 3. Ship it — PR immediately, no waiting

As soon as the fix is verified, open the PR. **There is no "create the PR" gate
anymore** — batching is gone, so nothing is waiting to accumulate, and holding
the PR back only delays the review that catches things.

1. Push the **actual current branch** — `git push -u origin HEAD` (retry with
   backoff on network errors; never force-push). Don't hardcode the
   `claude/bugfix-<topic>` name here: on the normal path that *is* the current
   branch, but the preselected/assigned-branch exception in step 1 means the
   real name can differ, and pushing a literal wrong name either fails or
   targets an unrelated ref. The branch was cut from current `origin/main` and
   has never been pushed, so **no rebase is needed or wanted** — see CLAUDE.md's
   git constraints. If the branch later needs current `main`, **merge, don't
   rebase**.
2. Open the PR with `mcp__github__create_pull_request` — base `main`
   normally; **as a draft only when the Tier B draft-first flow in step 3
   applies** (a plain non-draft open is the point for everything else —
   round 1 fires immediately).
   **Exception: a stacked fix bases against its parent's branch, not `main`**
   (per `working-modes.md`'s *Dependent bugs* note) — otherwise the new PR's
   diff carries both bugs' commits until the parent merges, defeating the
   one-bug-per-PR isolation this whole redesign is for. **Retarget to `main`
   *before* the parent's PR is merged, not after** — this repo auto-deletes a
   merged branch with no reliable window afterward (deletion can happen as
   part of the merge itself), and a documented prior incident
   ([`CODEX_GITHUB_REVIEW_WORKFLOW.md`](../../../docs/CODEX_GITHUB_REVIEW_WORKFLOW.md))
   shows exactly this orphaning; that doc's own required workflow says to
   retarget before squash-merging, not after. Retargeting early leaves the
   diff temporarily broad (it still shows the parent's unmerged commits) —
   accept that, it's cosmetic. Once the parent has actually merged, narrow the
   diff: `git fetch origin main && git merge origin/main` into this branch
   (merge, never rebase, on an already-pushed branch), then push.
   Use **`.github/pull_request_template.md`** — the
   repo template applies to bug fixes too. Fill the **Approved-plan oracle**
   section with the **bugfix oracle** instead of "n/a — no plan" — **which
   block depends on the tier:**

   **Tier A/B:**
   ```markdown
   **Fix tier:** <A or B> — <the Q1/Q2 triggers checked: which one fired (B),
     or which were ruled out (A) — a bare tier letter isn't enough; A is the
     classification a reviewer most needs to be able to challenge>
   **Reported symptom:** <David's report, quoted verbatim>
   **Intended correct behavior:** <what right looks like>
   **Must not change:** <adjacent behaviors sharing this code path>
   **Root cause:** <the mechanism, not the instance>
   **Blast radius:** <what else calls this / shares this path, and what I checked>
   ```

   **Tier C, trivial schema fix** (David authorized migration ceremony directly
   — a *different* block, not the one above):
   ```markdown
   **Fix tier:** C — trivial schema/migration fix, no plan
   **Reported symptom:** <David's report, quoted verbatim>
   **Root cause:** <the mechanism, not the instance>
   **Why this is trivial:** <single-step, no data transformation, no behavior
     change — the specific reason it didn't need a full plan>
   **David's go-ahead:** <how/when confirmed>
   **Migration ceremony checklist:** <idempotency, observable counts,
     human-edited-row preservation, rollback for destructive ops>
   ```

   Then **Verification** (exact commands + results, and the click-through steps
   to observe the fix), and the checklist.
3. **Tier B, product-visible fix — ship the UAT doc on this same PR.** The
   test is whether the fix has *any* product-visible behavior, not which
   Q1/Q2 trigger put it in Tier B — a fix whose only surface is internal
   (CI, build tooling, `lib/api-zod`/`lib/api-spec` codegen with no
   frontend-visible type change) takes the **internal/infra-only exception**
   instead: a written verification note in the PR body, no UAT doc (see
   [`working-modes.md`](../../../docs/ai-context/working-modes.md#tier-b--elevated-fix)).
   When a UAT doc is due, the filename needs the PR number, so the flow is
   **draft-first (David, 2026-08-09 — replacing the docs-pending +
   explicit-re-review dance, which bought a guaranteed second round for
   file-naming reasons):** open the PR **as a draft** (the number now
   exists, and a draft doesn't trigger the Codex connector — the same
   property the plan-review loop relies on), commit
   `docs/tests/UAT/PR<N>_<FEATURE>_UAT.md` with the PR body linking it, then
   **mark the PR ready for review** — round 1 fires once, on the complete
   diff, UAT included. **The connector documents this trigger itself:** its
   review boilerplate lists exactly three — "Open a pull request for
   review", **"Mark a draft as ready"**, and commenting `@codex review`
   (observed on PR #391, 2026-08-09). Still glance that round 1 actually
   lands on the first draft-first fix; if it somehow doesn't, post one
   explicit `@codex review` naming the full diff and correct this line.
   Match the most recent surviving `docs/tests/UAT/PR<N>_*_UAT.md`. Publish
   it as an Artifact page too (per
   CLAUDE.md's *Every PR ships with a Replit test plan + a UAT* section,
   which owns that rule). The PR body's Post-merge verification section
   gets real content only if something genuinely needs Replit's
   environment — per
   [`test-run-contract.md`](../../../docs/tests/test-run-contract.md), it
   is not a default ("none needed" is the correct content otherwise; the
   standalone TEST_RUN file is retired, 2026-08-15). **Add the UAT doc
   link to
   the workstream issue's State of Play `Artifacts` field once committed** —
   the same instruction `pr-docs` follows for feature-mode UAT docs, so a
   cold-resumed session finds the doc regardless of which path produced it.
4. **Watch the PR** per CLAUDE.md's *Watching the PRs I open* — including its
   **Sonnet gate**: already on Sonnet → `subscribe_pr_activity` immediately;
   on **any other tier** — Opus (which a Tier B fix will have put me on),
   Fable, or anything future — tell David the PR is ready to watch and ask him
   to switch me to Sonnet first. The gate is "not Sonnet," not "is Opus":
   naming one non-default tier is how this rule got read literally and missed
   once already (David, 2026-08-08).

## 4. Drive the review to convergence

The review-loop contract is shared and enacted elsewhere — **the mechanics
live in the `pr-watch` skill** (which loads for any watched PR, bugfix or
feature) **and in
[`working-modes.md`](../../../docs/ai-context/working-modes.md)**: the
post-round adjudication before any fixes are implemented (count + trend,
causal flags, the continue/stop decision made in-loop via the adversarial
subagent, product English on anything that reaches David — skip-on-clean), the
class-sweep protocol (name the class, cite the mechanical oracle, sweep to
zero, re-run prior rounds' oracles before every push), the criticality gate
before every re-request, the fix / accept-and-document / escalate / decline
triage (a decline posts only after surviving the Opus-subagent challenge),
resolving each thread myself right after addressing it, per-round
`@codex review` re-requests naming what the round closes, the
cumulative-diff rule after 2+ fix rounds, breaking non-converging loops by
diagnosis — oscillation or a genuinely contested fix, not a round count
(David, 2026-08-15, superseding the earlier ~2-round figure) — and
unsubscribing at merge/close. **Pointer, not a copy** —
restating those mechanics here is how this section went stale once already
(it carried a "never resolve threads" rule for two months after David
reversed it, 2026-08-06).

What is *bugfix-specific* about the loop:

- **The review carries more weight here than in feature mode.** With no plan
  and (on Tier A) no UAT doc, Codex's diff review is the main net — and it
  has earned that: several entries in
  [`known-failure-patterns.md`](../../../docs/ai-context/known-failure-patterns.md)
  were caught by review *after* the shipped tests passed. Engage every
  round; the light *planning* path must never shade into a light *review*
  path.
- **Round 1 is automatic.** The Codex connector reviews on non-draft PR
  open — or on marking a draft ready, in the Tier B draft-first flow
  (step 3, with its first-use caveat) — so no `@codex review` on open.
  (The plan-review loop needs an explicit trigger only because its PR
  *stays* a draft.)
- **The criticality gate rates the artifact the fix touches — never the fact
  that it's a fix.** A fix to product code passes the gate normally; a real
  product fix is essentially never single-digit. But routed entry means a bug
  can be *in the docs*: when the whole diff is agent-facing markdown or a
  transient checklist, that artifact's rule governs — no round cap but
  continuation gated on behavior-changing findings for markdown, and the
  automatic first pass with no re-request for a transient checklist — per
  `working-modes.md`'s *Docs-only loops continue on consequence, not
  count* and the ceremony table, and the review
  request states the docs-only light bar — exactly as if the same change had
  arrived through feature mode. Entering through this mode never raises an
  artifact's ceremony, and never lowers product code's.
- **The re-reviewer's oracle is the bugfix oracle** (step 3), not a plan —
  it's what lets Codex ask "root cause or symptom-patch?" and "did this
  miss a caller?", so re-requests reference it the way feature loops
  reference the approved plan.

The reviewer's own standard is shared, not my ceremony:
[`code-review.md`](../../../docs/engineering/code-review.md#re-reviews-round-2-onward).

## When the next request isn't a bug

There is no mode to exit — classification is per-request. A feature-shaped
request ("let's build / add / change X") simply gets the feature workflow,
and the classification announcement makes the switch visible. Two cases
still deserve care:

- **A request that could be either** — a "fix" that might really mean
  re-designing the behavior — gets one numbered question, not a guess
  (the pause-and-ask rule,
  [`agent-working-rules.md`](../../../docs/ai-context/agent-working-rules.md#mid-build-ambiguity-pause-and-ask)):
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
the `lib/api-zod` Zod schemas, which stay Q1 Tier B — see
[`working-modes.md`](../../../docs/ai-context/working-modes.md#tier-c--this-is-not-a-bug-fix-leave-bugfix-mode)),
or anything where David needs to verify intent is out of the fast path — a
non-trivial one goes to **feature mode**, a genuinely trivial database schema
fix runs migration ceremony directly per Tier C. Don't use `/bugfix` to sneak a
feature through the fast path — and don't let a fix quietly become one
mid-build; that's Tier C.

**A "clean up the review findings" batch is not a bug fix either (David,
2026-08-09).** Leftover findings from earlier PRs are N separate defects,
and batching them recreates exactly what one-bug-per-PR banned — PR #334
(nominally a bugfix, actually eleven batched findings: 21 rounds, 69
findings, 72% self-inflicted, no breaker fired) is the measured cost. Each
real defect gets its own classification and its own PR.

When unsure, ask.
