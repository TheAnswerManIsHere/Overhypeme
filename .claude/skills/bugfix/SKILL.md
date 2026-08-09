---
name: bugfix
description: Enter bug-fixing mode — fix a bug without the planning ceremony. Use when David says /bugfix, or asks to "just fix" a bug. One bug per branch per PR, opened as soon as the fix is verified. Drops the plan file and the plan-review loop; keeps (and tiers) verification — a Tier A/B fix carries a regression test, a blast-radius note, and a bugfix oracle in the PR body, while a trivial Tier C schema fix uses its own dedicated oracle block instead — and Codex still reviews the diff to convergence. Opposite of the default feature-building flow in CLAUDE.md.
---

# Bug-fixing mode

> The shared, cross-agent contract — the tier checklist, the loop, the bugfix
> oracle, what's turned off and what's non-negotiable — is
> **[`docs/ai-context/working-modes.md`](../../../docs/ai-context/working-modes.md)**
> (Codex uses it too). **Read it; it is the source of truth.** This skill adds
> only what is specific to *me*: git mechanics in this environment, the PR
> template, the Codex trigger mechanics, and the model-tier prompts.

David invokes `/bugfix` explicitly so there is **zero inference** about the mode.
Since bugfix mode no longer batches, he invokes it **per bug** — though the mode
stays in force across messages, so a follow-up bug doesn't need a re-invocation
(see *Exiting bug-fixing mode*). **It does need step 1 run again, explicitly** —
see the note there. Skipping it is how a second bug lands on the first bug's
already-pushed branch, silently breaking one-bug-per-PR.

**The one-line summary of what this mode is:** it drops the *planning* ceremony
(plan file, pre-plan conversation, the multi-round Codex plan-review loop), not
the *verification*. A small-looking fix can still have wide consequences, so the
verification scales to what diagnosis reveals the fix actually touches.

## 1. Before each bug — set up the branch

**This step runs once per bug, not once per `/bugfix` invocation.** On the
first bug it runs at `/bugfix`; on every bug after that — sent as a plain
message with the mode still in force, no re-invocation — it runs again,
*before* diagnosing that bug. Check state first: if the branch currently
checked out already has a prior bug's fix pushed to it (its PR is open or
merged), that branch is spoken for — cut a new one per below. Only skip this
step if the current branch has no bug on it yet (fresh from `/bugfix`, nothing
committed).

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

Then confirm: branch name + "bug-fixing mode is on."

**Workstream issue.** The disclosure check that gates opening it is a
shared-contract requirement now
([`working-modes.md`](../../../docs/ai-context/working-modes.md#disclosure-check-before-the-workstream-issue-opens)'s
*Disclosure check, before the workstream issue opens*), not Claude-specific
— I run it, but I don't restate the *why* here.

For everything else: per `workstream-tracking.md`, bugfix mode branches
straight from Discovery to Coding, skipping Planning and Plan approval. If
David's bug report doesn't already have a workstream issue, open one now —
**but only if the disclosure check above passed.** If it didn't, this is
where that matters mechanically, not just as a stated rule: open a private
draft Project item instead of a public issue, and say so plainly rather
than silently taking the fast path. When the check passed, open the public
issue with `stage:coding`, `waiting:claude`, `mode:bugfix` — one per bug,
matching the one-bug-per-branch-per-PR rule above — and give it a State of
Play block (per `workstream-tracking.md`) at the same time, not just
labels. From PR open onward, `pr-watch` owns the label transitions and the
block's upkeep.

## 2. Diagnose, classify, then fix

Follow the loop in
[`working-modes.md`](../../../docs/ai-context/working-modes.md#per-bug--the-loop)
— root cause, **tier classification**, regression test first, smallest correct
fix, blast radius, verify, one commit.

**The classification is a real beat, not a formality.** I state the tier and the
reason out loud before writing the fix, because the tier decides what ships with
the PR. Tier A is the exception, by design.

**Model tier follows the classification (CLAUDE.md's *Token / cost discipline*):**

- **Entering `/bugfix`** — Sonnet is fine. Triage and diagnosis are usually
  shallow, and Codex's diff review is the net.
- **The moment I classify a fix as Tier B** — I say so and ask David to switch me
  to **Opus** before I write it. That is the whole point of the tier: these are
  the fixes where a subtle error slips both nets. I don't switch myself; a
  system-reminder confirming the change is what tells me it happened.
- **Tier C** — stop and escalate to David regardless of tier; it isn't a bug fix.

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
2. Open the PR with `mcp__github__create_pull_request` — base `main` normally.
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
   When a UAT doc is due, the filename needs the PR
   number, so it is PR-first, exactly like feature mode: open the PR with a
   "Docs pending" note, then commit `docs/PR<N>_<FEATURE>_UAT.md` to the **same
   PR before merge** and replace the note with a link. Match the most recent
   surviving `docs/PR<N>_*_UAT.md`. Publish it as an Artifact page too (per
   CLAUDE.md's *Every PR ships with a Replit test plan + a UAT* section, which
   now owns that rule — the combined plan/UAT delivery ritual it used to live in
   was retired). A `TEST_RUN` doc only if something
   genuinely needs Replit's environment — per
   [`test-run-contract.md`](../../../docs/tests/test-run-contract.md), it
   is not a default. **Add the UAT (and TEST_RUN, if shipped) doc link to the
   workstream issue's State of Play `Artifacts` field once committed** — the
   same instruction `pr-docs` follows for feature-mode UAT docs, so a
   cold-resumed session finds the doc regardless of which path produced it.
   **This UAT commit lands after round 1 already fired on
   PR open, and a push doesn't reliably re-trigger a review** (see step 4) —
   so it needs its own explicit `@codex review` once it's pushed, the same as
   any other fix-round commit. Don't let the PR reach convergence with a
   commit Codex never actually saw.
4. **Watch the PR** per CLAUDE.md's *Watching the PRs I open* — including its
   **Sonnet gate**: already on Sonnet → `subscribe_pr_activity` immediately; on
   Opus (which a Tier B fix will have put me on) → tell David the PR is ready to
   watch and ask him to switch me to Sonnet first.

## 4. Drive the review to convergence

This is the part the old skill left to a dangling pointer, and it matters more
here than in feature mode: with no plan and (on Tier A) no UAT doc, **Codex's
diff review is carrying more of the weight.** It has also earned that trust —
several entries in
[`known-failure-patterns.md`](../../../docs/ai-context/known-failure-patterns.md)
were caught by Codex review *after* the shipped tests passed.

- **Round 1 is automatic.** The Codex connector reviews on "open a pull request
  for review," so a non-draft PR triggers it with no comment from me. (This is
  why the plan-review loop needs an explicit trigger and this doesn't — that PR
  is a *draft*.) I don't post a redundant `@codex review` on open.
- **Every fix round needs an explicit `@codex review`.** A push does **not**
  reliably re-trigger it, and reactive fix code is exactly where subtle mistakes
  hide. One comment per round (batched, never per-comment), naming which findings
  the round was meant to close and asking Codex to confirm each is resolved *in
  the code* — not merely responded to.
- **After more than one fix round, ask for the cumulative branch diff**
  (`git diff origin/main...HEAD --stat` gives the file list to name), not only
  the newest commits — a fix in one file can break something from the original
  diff that isn't re-shown.
- **Reply inline on each comment's own thread**, one reply per comment. Never a
  standalone summary comment; never resolve threads (that's David's).
- **Fix the mechanical, escalate the substantive.** A design/architecture/
  behavior-change call goes to David, not silently into the code — even on a
  bot's say-so. Break after ~2 non-converging rounds and bring David the
  diagnosis.
- Unsubscribe once the PR merges or closes.

The reviewer's own standard for all of this is shared, not my ceremony:
[`code-review.md`](../../../docs/engineering/code-review.md#re-reviews-round-2-onward).

## Exiting bug-fixing mode

The mode persists across messages. It ends in any of these ways:

1. **David exits explicitly** — "exit bugfix mode", "done with bugs", "back to
   features", `/bugfix done`. I acknowledge and return to the feature workflow.

2. **David signals feature work — I ASK, I don't assume.** If a request looks
   like building or changing product functionality rather than fixing a bug, I do
   **not** silently treat it as a fix and do **not** silently flip modes. I stop
   and ask:

   > "It looks like you're ready to build new functionality — should I exit
   > bug-fixing mode and switch to the feature workflow?"

   This is the pause-and-ask rule
   ([`agent-working-rules.md`](../../../docs/ai-context/agent-working-rules.md#mid-build-ambiguity-pause-and-ask))
   made concrete: guessing wrong is expensive in both directions — either I skip
   a plan the work needed, or I pile ceremony onto a one-line fix.

   Note this is distinct from a **Tier C** finding, which is the same call
   arriving from the other direction: David asked for a fix, and *diagnosis*
   revealed it's really feature/migration work. Same escalation, different
   trigger.

3. **A new chat or entering plan mode resets to the default automatically.**

Not every non-bug message means "exit." Questions, status checks, and
meta-discussion don't end the mode — the trigger in case 2 is specifically a
request to **build or change product functionality.** When genuinely unsure
whether a message is the next bug or a pivot, I ask.

## When NOT to use this mode

A feature, a behavior change, **any *database* schema change, migration, or
backfill** (Tier C without exception, regardless of product consequence; not
the `lib/api-zod` Zod schemas, which stay Q1 Tier B — see
[`working-modes.md`](../../../docs/ai-context/working-modes.md#tier-c--this-is-not-a-bug-fix-leave-bugfix-mode)),
or anything where David needs to verify intent is out of the fast path — a
non-trivial one goes to **feature mode**, a genuinely trivial database schema
fix runs migration ceremony directly per Tier C. Don't use `/bugfix` to sneak a
feature through the fast path — and don't let a fix quietly become one
mid-build; that's Tier C. When unsure, ask.
