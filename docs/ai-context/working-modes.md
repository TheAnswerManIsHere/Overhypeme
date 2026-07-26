# Working Modes: feature (default) vs. bugfix

> The canonical, cross-agent statement of the two workflows David uses. **David
> picks the mode explicitly so there is zero guessing.** This applies to Codex,
> Claude, and any agent. (Claude Code layers extra ceremony on top per
> [`CLAUDE.md`](../../CLAUDE.md) and its `/bugfix` skill; the *distinction* below
> is the shared truth.)

There are two modes. The default is **feature mode**. **Bugfix mode** is a path
David turns on explicitly to fix a bug without the planning ceremony — it drops
the plan and the plan-review loop, **not** the verification, and it tiers its
remaining ceremony to what the fix actually turns out to touch.

## Feature mode (default)

The full workflow for building or changing product functionality. In this mode:

1. **Inspect the repo first** (read the relevant `docs/ai-context/*`).
2. **Plan before implementing, and get David's explicit approval** before you
   build — see the plan-before-implementation rule in
   [`agent-working-rules.md`](./agent-working-rules.md) and the template in
   [`../../.agents/PLANS.md`](../../.agents/PLANS.md). Do not start the build on an
   unapproved non-trivial plan.
3. **Build it fully, end to end** (backend + the UI surface to exercise it + tests
   + any doc updates).
4. **Tests prove the general invariant**, not just the reported example.
5. **Open a PR** for review.

Any "let's build / add / change X", a behavior change, or a schema change with
product consequences is feature mode.

## Bugfix mode (explicit, one bug per PR, tiered by what the fix touches)

A focused fix-and-ship loop for a bug — restoring behavior that was already
agreed, not deciding new behavior. **David turns it on explicitly** (see *How each
agent enters/exits a mode* below).

**What bugfix mode saves is the planning ceremony, not the verification.** It
drops the plan file, the pre-plan conversation, and the multi-round plan-review
loop — the genuinely expensive parts, and the ones that mitigate a risk a fix
rarely carries ("we chose the wrong approach before any code existed"). It does
**not** license thin verification: a small-looking fix can still have wide
consequences, and several entries in this repo's own
[`known-failure-patterns.md`](./known-failure-patterns.md) are defects whose
shipped tests passed and which were caught only in code review.

### One bug, one branch, one PR (David, 2026-07-26)

**Bugfix mode does not batch.** Each bug gets its own branch off current
`origin/main`, its own commit, and its own PR, opened as soon as the fix is
verified — no waiting for a "create the PR" signal, no accumulating several bugs
on one branch.

Batching was costing more than it saved: it kept several half-verified fixes in
flight at once, and it meant no reviewer saw *any* fix until the whole batch
landed — so a wrong fix early got built on top of repeatedly and reviewed zero
times. One bug per PR means every fix is reviewed in isolation, immediately, and
against a diff that contains nothing else.

Use a **topic** slug, not a date (`…/bugfix-annual-plan-lookup`, not
`…/bugfix-jul26`) — with one bug per branch, a date collides the moment two bugs
land the same day. Create non-resettingly (fail rather than wipe existing work),
pick a disambiguated name on a clash, and **never** force/reset onto
`origin/main` to resolve one.

> **Exception — a preselected/assigned branch wins.** If you were already invoked
> on a designated task branch (a preselected branch, a Codex cloud run, an assigned
> working branch, or a runner that disallows branch creation), **stay on it** — do
> not create a fresh branch. The fresh-branch step is only for the normal case
> where David starts a bug from scratch with no branch assigned.

> **Dependent bugs.** If a new bug's fix depends on an earlier fix whose PR is
> still open, say so rather than silently branching from `origin/main` (which
> wouldn't contain it). **Prefer waiting** for the parent to merge, then
> branching from fresh `origin/main` as normal — the only way to guarantee the
> new PR's diff contains just the new bug. If the wait is genuinely too
> costly: branch from the parent PR's head, but **open the new PR with the
> parent's branch as its base, not `main`.** Basing against `main` while the
> branch carries the parent's unmerged commits puts both bugs in one diff,
> which defeats the one-bug-per-PR isolation this section exists for. State
> the stack order in the new PR body. **Once the parent merges, retargeting
> alone does NOT narrow the diff** — David squash-merges, so the parent's
> commits never become ancestors of `main` and a three-dot diff still compares
> against the pre-parent merge base. First `git fetch origin main && git merge
> origin/main` into the child branch (the squash commit becomes an ancestor,
> per CLAUDE.md's squash-merge-follow-up guidance — merge, never rebase, on an
> already-pushed branch), push, **then** retarget the PR base to `main`; the
> diff narrows to just the new bug only after that merge.

### The tier is chosen after diagnosis, never at intake

The old design picked its ceremony level at intake, from the **symptom**. That is
the wrong moment with the wrong information: every risk that matters is a property
of the **fix** — what it touches, how many callers share it, whether it crosses
persisted state — and none of that is knowable until the cause is found.
"Simple-seeming" describes a bug report; it never described a blast radius.

So: **diagnose first, then classify, then fix.** Run the checklist below once the
cause is known. **If any item trips, it is Tier B.** With this list, Tier A is the
exception — that is intended, not a mis-calibration.

**Q1 — Where does the fix land?** Any of these subsystems → **Tier B**:
payments / auth / permissions / security headers; the tokenizer, grammar, or
`render-fact`; the visual pipeline (planner, compiler, render policy, Visual
Concept); the async job queue, worker lanes, or any enqueue helper; enrichment or
moderation source-of-truth (`facts.*`, `resolveEnrichment`, override layers);
`lib/api-zod/` or `lib/api-spec/` (the codegen allowlist trap); dev-infra and
build tooling (Vite/esbuild config, the dev supervisor, retry/reload paths, CI
workflows).

**Q2 — What shape is the fix?** Any of these → **Tier B**:

1. **Shared, not a leaf.** The edit lands in an exported symbol or a function with
   more than one caller — so its blast radius is every caller, not this one site.
2. **A predicate, default, or heuristic.** It changes *when* or *whether*
   something happens — a condition, a skip check, a fallback, a dedupe key — not
   just what value comes out. (See *Uniform default over a falsely-ambiguous
   space*, *Cost-skip heuristic*, *Dedupe key coalesces two distinct intents*.)
3. **Concurrency, ordering, retry, or async state.** Enqueue paths, job state
   transitions, races, retries, or anything whose correctness depends on two
   reads seeing the same state. This is the single densest cluster of real
   defects in this repo, and each took multiple review rounds to converge.
4. **Persisted or derived data.** It changes what gets written, the shape it's
   written in, or how a stored/derived value is read back — even with no
   migration.
5. **Generalized past the report.** You concluded the *mechanism* was wrong and
   widened the fix beyond the reported instance. Correct instinct (see
   *One-example bug fixes*) and a real risk in the same breath (see *Regex
   grammar rewrite reaches past a safe anchor*).
6. **Shaky diagnosis.** No deterministic reproduction, more than one plausible
   root cause, or this symptom has been "fixed" before. Uncertainty at diagnosis
   is the strongest single predictor that the fix is a guess.
7. **The path had no pre-existing tests at all.** Not "this exact regression
   scenario wasn't covered" — by definition almost no escaped bug's precise
   scenario was covered, so that reading would send nearly every real fix to
   Tier B and makes the trigger meaningless. The observable boundary: before
   this fix, did the touched function/module have **any** test file
   exercising it, in any scenario? Zero prior coverage of the path itself
   (you're originating a suite, not extending one) fires this trigger; adding
   a missed case to an already-tested path does not.

### Tier A — contained fix

Fix + regression test + one commit + PR, with the bugfix oracle and blast-radius
note below. Verification lives in the PR body ("how to verify" steps), which is
the miniature UAT. No separate docs.

### Tier B — elevated fix

Everything in Tier A, plus:

- **A real UAT doc** (`docs/PR<N>_<FEATURE>_UAT.md`) — the click-through
  acceptance script, so David's product-verification net is restored for exactly
  the fixes that can reach past the reported symptom.
- **A TEST_RUN doc only when the fix genuinely needs one** — i.e. when something
  can only be verified in Replit's environment (live DB state, live config/data).
  Per [`../engineering/test-run-contract.md`](../engineering/test-run-contract.md),
  a TEST_RUN is not a default; most bug fixes need none, and one that re-verifies
  what CI already gates is waste.
- **The strongest model tier available** for the fix itself.

**Internal/infra-only exception on the UAT doc.** The test is **whether the
fix has any product-visible behavior at all — not which Q1/Q2 trigger(s)
fired.** A CI-workflow or dev-supervisor fix routinely trips a Q2 shape
trigger too (a retry predicate, a dedupe condition) without gaining any
in-app surface, so gating the exception on "the only trigger was Q1" would
disqualify exactly the fixes it's meant to cover. If nothing about the fix is
product-visible, ship a written verification note in the PR body instead of
a click-through UAT doc, regardless of how many or which triggers fired —
the same ship-the-UI-surface exception feature mode already grants pure
infra/refactor changes (see
[`../engineering/testing-guide.md`](../engineering/testing-guide.md) and
CLAUDE.md). A click-through script for a fix with no in-app surface to click
through is manufactured ceremony, not verification. The moment the fix also
touches anything product-visible — even indirectly, e.g. a codegen change
that alters generated API types the frontend consumes — the full UAT
applies.

### Tier C — this is not a bug fix; leave bugfix mode

Stop and tell David. Any of: the "fix" is a behavior change or a product
decision; diagnosis revealed a design flaw rather than a defect; or the fix
would need a new abstraction or an external vendor — these go to **feature
mode** (plan + David's approval).

**A schema change, migration, or backfill is Tier C without exception** —
there is no size or scope of schema change that stays on bugfix mode's fast
path. It always runs
[`../engineering/migrations-and-backfills.md`](../engineering/migrations-and-backfills.md)'s
ceremony (idempotency, observable counts, human-override preservation,
rollback for destructive ops), on David's explicit go-ahead. What varies is
only whether it *also* needs a full feature-mode plan first, decided by the
same product-consequences line the mode boundary above already draws: a
schema fix with no product-visible consequence (making stored data match
what the product already assumes — no new behavior, no new surface) runs
migration ceremony directly; a schema change with product-visible
consequences gets a full feature-mode plan before anything runs. If genuinely
unsure which side of that line it's on, ask rather than guess.

### Per bug — the loop

1. **Reproduce and find the root cause.** Name the mechanism, not the instance.
2. **Classify** against the checklist above. State the tier and the reason.
3. **Write the regression test first** — a test that **fails on current code
   because of this bug**. This is the difference between fixing a bug once and
   fixing it forever, and it must prove the **general invariant** with negative
   cases, not just the reported input (see *One-example bug fixes*).
4. **Make the smallest correct fix** and confirm the new test passes.
5. **Establish the blast radius.** What else calls this code, shares this path, or
   depends on this behavior — and what you checked. Regression tests pin the fixed
   behavior; they say nothing about the neighbors, which is exactly where a
   small-looking fix does its damage.
6. **Verify** — the touched tests + typecheck (see
   [`../engineering/testing-guide.md`](../engineering/testing-guide.md)). A fix
   that breaks the build doesn't get committed.
7. **One focused commit** — fix + its regression test together, message naming the
   bug and the fix.
8. **Open the PR** with the oracle below, and engage the review to convergence.

> **Narrow carve-out on step 3:** if a fix is genuinely untestable at reasonable
> cost (a pure visual/CSS tweak with no assertable behavior), the regression test
> may be skipped — but say so explicitly in the commit message and the PR body
> ("no regression test: <why>"), so the exception is always visible, never silent.
> "The test is annoying to write" does not qualify; a tokenizer, API, data, logic,
> or concurrency bug always gets its test.

### The bugfix oracle: what the PR body must carry

A diff can be internally sound and still be the wrong fix — it can make the
reported symptom disappear while breaking an adjacent behavior nobody wrote down.
Feature mode solves this by pasting the approved plan into the PR body as the
reviewer's oracle. **A bug fix has no plan, so it needs its own oracle** — and
"n/a — no plan" leaves the reviewer checking the diff against nothing but itself.

The feature oracle's fields map onto a fix directly:

| Feature mode | Bugfix mode |
|---|---|
| Product intent | **Reported symptom** — David's report, quoted verbatim |
| *(implicit in the plan)* | **Intended correct behavior** — what right looks like |
| Must not change | **Must not change** — the adjacent behaviors sharing this path |
| Settled decisions | **Root cause** — the mechanism, in one or two lines |

Plus **Blast radius** (from step 5) and the **fix tier with its reason** —
**required for Tier A as much as Tier B.** A is the classification reviewers
most need to be able to challenge, so "A (contained)" alone is not enough:
name the Q1/Q2 items you checked and ruled out, not just the ones that would
have fired. A bare tier letter with no reasoning is a mis-tiering risk
whether or not the letter turns out to be right.

This is cheap to write and it is what lets a reviewer ask the two questions that
matter most on a fix: *is this the root cause or a symptom-level patch?* and *did
this miss a caller?*

**What bugfix mode turns OFF:**
- No plan file, no pre-plan ceremony, no plan-review loop.
- No forced "ship a new UI surface" gate for a pure fix (include UI only if the fix
  genuinely needs it to be testable).
- No UAT/TEST_RUN docs on **Tier A**. Tier B ships a UAT, and a TEST_RUN only when
  something truly needs Replit's environment.

**What it KEEPS (non-negotiable):**
- **Pause-and-ask on real ambiguity.** If a "bug" is actually a behavior change in
  disguise, or the correct behavior is genuinely unclear, **stop and ask** — that's
  Tier C, not a fix.
- **Root cause over symptom**, and a regression test proving the general invariant.
- **Verify before committing.**
- **Source-of-truth discipline** (don't silently overwrite human decisions, don't
  create a duplicate source of truth) — see
  [`known-failure-patterns.md`](./known-failure-patterns.md).
- **Squash-merge / never-force-push discipline.**
- **Bot-review engagement to convergence** once a PR is open — including
  re-review of every fix round, since a push does not reliably re-trigger a
  reviewer and reactive fix code is where subtle mistakes hide. Code review is
  the highest-yield net this repo has: several entries in
  [`known-failure-patterns.md`](./known-failure-patterns.md) were caught by
  review *after* the shipped tests passed.

## How each agent enters / exits a mode

**The mode is always David's explicit choice — never inferred.**

- **Claude Code** has an auto-loading `/bugfix` skill; David types `/bugfix` to
  enter and any clear exit phrase ("back to features", "exit bugfix mode") to leave.
- **Codex** has no auto-triggering skill system, so the signal is **in David's
  prompt**. David starts a request with, e.g., **"Bugfix mode:"** (lightweight fix)
  or **"Regular mode:"** / **"Feature mode:"** (full workflow, plan first). Codex
  reads *this doc* via `AGENTS.md` and applies the matching workflow. Absent an
  explicit signal, Codex is in **feature mode** (the default) and follows the
  plan-before-implementation rule.
  - *Optional:* if a given Codex setup supports custom prompt files (e.g. a
    `/bugfix` prompt), point that prompt at this doc — it doesn't change the
    contract, just the trigger.

**Mode persistence & switching:** a mode stays in force across messages until David
ends it. If a request that arrives during bugfix mode looks like **building or
changing product functionality** (a feature, a behavior change, a schema change
with product consequences), **do not silently treat it as a fix and do not silently
switch** — **ask** whether to exit bugfix mode and switch to the feature workflow.
Guessing wrong is expensive in both directions (skipping a plan a feature needed, or
piling ceremony onto a one-line fix), and the confirm costs one question.

## When NOT to use bugfix mode

Features, behavior changes, schema changes with product consequences, or anything
where David needs to verify intent — that's **feature mode**. Don't use bugfix mode
to sneak a feature through the lightweight path. When unsure which it is, **ask.**
