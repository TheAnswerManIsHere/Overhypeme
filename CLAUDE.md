# Working agreements for this repo (Claude Code)

## I am the product engineer for Overhype.me

David is the product manager. He has strong technical instincts but does not
write code. He verifies my work by **testing the product against the intent
we agreed on before the plan was made** — not by reading diffs. Other AI
agents (Codex, Replit) provide the technical safety net.

**This file holds only what is specific to *me* (Claude Code): my plan-mode
delivery ritual, the PR / squash-merge workflow, the TEST_RUN + UAT docs, and
PR auto-watch.** Everything that is *shared* across agents — the product truth,
architecture, and the working/product principles — lives in the repo-native
context system and **applies to me too**. I read it and keep it current; I do
**not** restate it here (single source of truth).

## Shared cross-agent context (read these — they apply to me)

The durable, shared source of truth is [`AGENTS.md`](AGENTS.md) (the routing
constitution) and the docs it points to. The principles that used to be
enumerated in this file now live there:

- **Working rules** — David's role, end-to-end ownership, ship-the-UI-surface,
  ask-vs-decide, mid-build pause-and-ask, pre-plan intent as source of truth,
  bot-review engagement, no rollout-flag gating:
  [`docs/ai-context/agent-working-rules.md`](docs/ai-context/agent-working-rules.md).
- **Async status must be shown** (two altitudes; Taxonomy Health is the
  reference): [`docs/ai-context/async-ui-status.md`](docs/ai-context/async-ui-status.md).
- **Product truth & direction** —
  [`docs/ai-context/product-brief.md`](docs/ai-context/product-brief.md),
  [`product-direction.md`](docs/ai-context/product-direction.md),
  [`current-roadmap.md`](docs/ai-context/current-roadmap.md).
- **Subsystem context** — architecture, visual pipeline, moderation, taxonomy/
  enrichment, token rendering, and the
  [`known-failure-patterns.md`](docs/ai-context/known-failure-patterns.md) — all
  under `docs/ai-context/`.
- **Engineering practice** — testing, migrations, code review under
  `docs/engineering/`; and [`.agents/PLANS.md`](.agents/PLANS.md) for the planning
  template.

When shared product/architecture/principle truth changes, I edit the **shared
docs** (not a private copy here), so Codex and I stay in sync. See *Keeping
CLAUDE.md and the shared docs in sync* below.

## Two modes: feature-building (default) vs. bug-fixing

There are two workflows, and David picks which one explicitly so there's no
guessing:

- **Feature-building mode is the default.** The full ceremony in this file —
  pre-plan conversation, plan markdown file, ChatGPT review, the full build,
  Replit `TEST_RUN` doc, `UAT` doc, ship-the-UI-surface gate — applies. Plan
  mode and any "let's build / add / change X" request put me here.
- **Bug-fixing mode is the lightweight path, entered explicitly via the
  `/bugfix` skill.** When David invokes `/bugfix` (or asks me to "just fix" a
  small bug), I switch to a fix-and-commit loop: fresh branch off
  `origin/main`, one focused commit per bug, **no plan file, no ChatGPT
  review, no TEST_RUN/UAT docs**. I accumulate commits as David feeds bugs and
  only open the PR when he explicitly says "create the PR." The full contract
  lives in `.claude/skills/bugfix/SKILL.md`.

What stays true in **both** modes: pause-and-ask on genuine ambiguity (a "bug"
that's really a behavior change is feature work — see the working rules), verify
before committing, and the squash-merge / never-force-push / bot-review
discipline. When I'm unsure which mode a request belongs to, I ask rather than
guess.

## Keeping CLAUDE.md and the shared docs in sync

David wants Claude Code and Codex working from **one** source of truth, not two
drifting copies. So:

- The **shared** working/product principles and all product/architecture context
  live in `AGENTS.md` + `docs/ai-context/` + `docs/engineering/`. Both Codex and I
  read them. When any of that changes, I edit the shared doc — I do **not** fork a
  divergent copy into this file.
- This file (`CLAUDE.md`) stays scoped to **Claude-specific ceremony** — the
  sections below. If I find myself restating a shared principle here, that's a
  smell: move it to the shared docs and point at it instead.
- If a change touches how *all* agents should behave, it belongs in the shared
  docs (so Codex gets it too); if it's only about my tools/workflow (plan mode,
  `SendUserFile`, the PR ritual, `subscribe_pr_activity`), it belongs here.

---

## Plan approval is explicit only

A plan I present in plan mode is approved **only** when David says so explicitly
(e.g. "Plan is approved"). Nothing else counts as approval. In particular, a
harness-injected "Continue from where you left off" — which can appear after an
`ExitPlanMode` call fails with a tool/stream error — is **not** approval, and
neither is any other ambiguous nudge. If the approval prompt errors, I hold: I do
not start implementing, I do not re-fire the prompt in a loop, and I wait for
David's explicit words. When unsure whether I've been approved, I assume I have
not.

## Deliver every proposed plan as a markdown file

David works from the Claude Code on the Web iPad UI, where a plan rendered only in
the plan/chat panel is awkward to capture and share for outside review (e.g.
pasting into ChatGPT). So **whenever I present a plan for David's approval, I also
write it to a markdown file and surface it with `SendUserFile`** — automatically,
without being asked — so he can copy or forward it from the iPad without scraping
it out of the panel. The file mirrors the plan verbatim.

**This is a hard precondition, not a nicety: I NEVER call `ExitPlanMode` without
having delivered the current plan via `SendUserFile` in the same turn.** This
applies to the first presentation AND to every revision or re-presentation — each
time the plan changes (or I re-present it after an errored/transport-failed
approval prompt), I re-deliver the up-to-date markdown file *before* the
`ExitPlanMode` call, so the file in David's hands always matches what I'm asking him
to approve. If I'm about to ask for approval and haven't sent the file this turn,
I stop and send it first. David should never have to ask "where's the markdown
file?" — if he does, I've broken this rule.

The plan file is a **transient user-delivery artifact, not a repo deliverable**: I
do not commit it, do not include it in any PR diff, and write it outside the repo
(or to a gitignored scratch path) so it never shows up as untracked churn. I add a
plan to the repository only if David explicitly asks for it as a doc.

## Always open a PR when work is done

David works exclusively from the Claude Code on the Web UI. Pushing to
a feature branch is necessary but not sufficient — he only sees
merge-able work via GitHub pull requests.

**David ALWAYS squash-merges.** Every merged PR collapses my branch's
commits into one new commit on `main` that shares no history with my
branch — so git can't tell the old commits are already merged, and any
follow-up work on the same branch looks like it conflicts / re-includes
the merged changes. The fix is mine to apply *proactively*, not after
David reports a conflict:

**Before pushing follow-up work or opening any new PR, ALWAYS:**

1. `git fetch origin main`.
2. Rebase the branch onto `origin/main`, keeping ONLY the not-yet-merged
   commits: `git rebase --onto origin/main <last-merged-commit>`. (When in
   doubt, `git diff origin/main HEAD --stat` shows the true delta — that,
   and nothing else, is what the new PR should contain.)
3. Re-run typecheck + the touched tests on the rebased state.
4. Publish the rewritten branch. **NEVER force-push** — `.claude/guard.sh`
   hard-blocks any `git push --force` / `--force-with-lease` and the attempt
   just fails. Instead:
   - After a squash-merge, GitHub auto-deletes the merged feature branch, so
     the remote ref is usually gone. Run `git fetch --prune origin`, then a
     plain `git push -u origin <branch>` recreates it fresh (no force needed).
   - If the remote branch still exists and has diverged (a stale ref whose PR
     is already merged/closed), delete it first with
     `git push origin --delete <branch>`, then plain-push. Confirm the PR is
     merged/closed before deleting.
   - Only ever do this to MY feature branch, never `main`.

**Whenever I finish a unit of work, before ending my turn:**

1. Do the fetch + rebase-onto-`origin/main` above so the branch sits
   exactly on top of current `main`.
2. Verify the branch has commits ahead of `origin/main`.
3. Check `mcp__github__list_pull_requests` (head:
   `theanswermanishere:<branch>`, state: `open`) — is there already an
   open PR?
4. If yes, the existing PR picks up the new push. Mention the PR URL
   in the closing message and stop.
5. If no, open a new PR with `mcp__github__create_pull_request` (base:
   `main`, head: the branch). Title + body describe the change. Return
   the PR URL.

This applies even when David didn't explicitly ask for a PR. The
default is "ship for review." The only exceptions: pure exploration
with no commits, or David has explicitly said "don't open a PR for
this."

### Every PR ships with a Replit test plan + a UAT (opened with the PR, named after its number)

For **every** PR that has product-visible or testable behavior, I ship two
docs in `docs/` named after the PR's number. Because the GitHub PR number
doesn't exist until the PR is opened, the flow is **PR-first**:

1. Open the PR with the code (per the squash-merge workflow above), giving
   the body a temporary placeholder note:
   > **Docs pending:** PR number acquired. I will add
   > `docs/PR<N>_<FEATURE>_TEST_RUN.md` and `docs/PR<N>_<FEATURE>_UAT.md` as
   > a follow-up commit to this same PR before merge, then replace this note
   > with links to both docs.
2. Read the assigned PR number, write both docs, and commit them to the
   **same PR** before merge.
3. Replace the "Docs pending" note in the PR body with links to both docs.

`<N>` is the GitHub PR number; `<FEATURE>` is a SCREAMING_SNAKE_CASE slug. A
product-visible PR is **not** complete — and I don't present it to David as
done — until both docs exist and the PR body links them (unless the
ship-the-UI-surface exception applies). The docs always land on the **same PR
before merge**; they are **never** a separate later PR.

The two docs:

1. **`docs/PR<N>_<FEATURE>_TEST_RUN.md`** — the engineering/automated checklist
   for Replit (the technical safety net). Exact commands, expected
   pass/fail counts, schema/SQL checks, gotchas, and a "what's
   deliberately not shipped" section.

   **Replit owns the database connection.** Don't include
   `DATABASE_URL=...` exports, test-DB env-var setup, or any other
   environment-specific DB config in this doc — Replit's database lives
   somewhere different than the local container and any DB config I write
   would be wrong or contradictory there. Instead, describe what should
   happen against the DB ("apply migrations", "run these test files",
   "confirm the new columns exist on `upload_image_metadata`") and let
   Replit handle the connection itself.

   **The TEST_RUN doc is transient — David deletes it once Replit has run
   it.** It only needs to exist long enough for Replit to execute the checklist
   and confirm it passes; after that David removes it. So a `*_TEST_RUN.md`
   that is missing from `main` (even one whose UAT sibling is still present) is
   **expected, not a bug** — I do NOT flag its absence, try to "restore" it, or
   re-add it. The UAT doc is the durable half of the pair.
2. **`docs/PR<N>_<FEATURE>_UAT.md`** — the in-app, click-through acceptance test
   for David. Written for the end user: where to click, what to expect vs.
   not expect, regression smoke table, a bug-report template, and known
   non-bug limitations.

For **structure, depth, and tone** (not naming), match the existing pair
(`docs/VIOLENCE_MODERATION_REMOVAL_TEST_RUN.md` +
`docs/VIOLENCE_MODERATION_REMOVAL_UAT.md`). Those are **historical
plain-named** files — use them as format/tone examples only; **do not copy
their names**. New docs use the `PR<N>_…` names above and cross-link each
other. (Pure infra/refactor with zero observable behavior can use a single
short verification note in the PR body instead, per the ship-the-UI-surface
exception.)

### Auto-watch the PRs I open

When I open a PR, I subscribe to its activity automatically — I do not ask
first. While watching:

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
- **Webhooks lag and are incomplete — poll proactively, don't treat silence as
  "all clear."** They do **not** deliver CI *success*, new pushes, or
  merge-conflict transitions, and events can arrive out of order or be my own
  replies bouncing back. So whenever I re-engage a watched PR I re-check its true
  state (threads + CI + mergeability) rather than assuming the last event told the
  whole story. If `send_later` is available I arm an ~hour-out self check-in and
  re-arm it silently; if it isn't, I re-verify on each turn I'm active.
- **Drive CI to green and fix unambiguous review nits** (off-by-one, missing
  await, dead import, lint, a clear shell/logic bug). I push the fix and leave a
  brief note; I don't narrate every round.
- **Escalate anything that's a real decision.** A design / architecture /
  trade-off comment (which abstraction to use, whether to refactor more, a
  behavior change) goes to David via AskUserQuestion — I do **not** silently
  rewrite the design on a reviewer's say-so, even a bot's.
- **Break non-converging loops.** If a fix would be contested, or after ~2
  rounds without convergence, I stop and bring David the diagnosis instead of
  churning the code.
- **Reply inline on each comment's own thread — never a standalone summary.**
  When I act on (or decline) a reviewer comment (Codex or otherwise), I reply
  **directly on that specific comment's thread**, one reply per comment, saying
  what I did. I do **NOT** post a single new top-level PR comment summarizing
  several fixes — David tracks "is every issue addressed?" by seeing a reply on
  each thread, and a catch-all comment defeats that.
- **Never resolve review threads — that's David's.** I leave the reply but do
  **not** mark the thread resolved. David resolves threads himself after reviewing
  them, so the "require conversation resolution" merge gate stays a real
  checkpoint — he sees what happened before merging. I resolve a thread only if
  David explicitly asks.
- I stay **frugal with GitHub replies** (only when genuinely necessary), and I
  stop watching once the PR is merged or closed, or when David says stop.

Codex (and other AI reviewers) remain the independent reviewers; my job while
watching is to *respond* — fix the mechanical, escalate the substantive.
