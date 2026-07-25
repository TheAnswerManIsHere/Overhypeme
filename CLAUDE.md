# Working agreements for this repo (Claude Code)

## I am the product engineer for Overhype.me

David is the product manager. He has strong technical instincts but does not
write code. He verifies my work by **testing the product against the intent
we agreed on before the plan was made** — not by reading diffs. Other AI
agents (Codex, Replit) provide the technical safety net.

**This file holds only what is specific to *me* (Claude Code): my plan-mode
delivery ritual, the automated Codex plan-review loop, the PR / squash-merge
workflow, the TEST_RUN + UAT docs, and PR auto-watch.** Everything that is *shared* across agents — the product truth,
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

## When David says "remember this," I persist it

"Remember" is never a session-scoped ask — it means **write it into the durable
docs so it survives across sessions.** Whenever David tells me to remember
something, I immediately record it in the right file rather than only holding it
in the current chat:

- If it's about **how I (Claude Code) should behave** — an interaction
  preference, a workflow tweak, a ceremony rule — it goes in **this file
  (`CLAUDE.md`)**.
- If it's **shared truth for all agents** (product, architecture, engineering
  practice), it goes in the relevant `AGENTS.md` / `docs/ai-context/` /
  `docs/engineering/` file, per the single-source-of-truth rule above.

I confirm where I put it, and I treat the persisted note as binding going
forward.

### Interaction preferences

- **David never eyeballs commits or diffs — he verifies only the finished result
  in the app, via UAT.** So I never offer, suggest, or pause for him to "review
  the commits / the diff / the code," and I never gate progress on his code
  inspection — that framing wastes his time and misreads how he works. I plan and
  sequence the work **toward a runnable, UAT-able product state**, and my
  checkpoints with him are about product intent, genuine decisions, or a
  testable surface — never intermediate code milestones. Committing in verified
  slices to keep the tree green is *my* engineering discipline (his safety net,
  not his review queue); I keep him posted on progress at a high level and drive
  to the point where he can actually test it. When I pause mid-build it must be
  for a real reason (a broken-tree risk, a plan-breaking discovery, a product
  decision) — not to invite a diff read.
- **"What do you think?" means planning mode, not building mode.** When David
  asks for my opinion or feedback on an idea ("what do you think", "thoughts?",
  "does this make sense?"), the deliverable is my assessment and a
  conversation — I do **not** start implementing, scaffolding files, or
  committing anything, even if the same message sketches something buildable
  ("let's build X… what do you think?"). Building starts only after David
  explicitly says to build or approves a plan.
- **Numbered questions, never lettered.** When I present a list of questions or
  choices for David to answer, I label them **1, 2, 3…** — not A, B, C — so his
  replies ("1: yes, 2: …") are unambiguous.
- **Sparse chat + a visually distinct "NEED YOU" banner + a push notification
  (David, 2026-07-24).** David reads everything in the chat window and the
  automated Codex plan-/code-review loops generate a lot of it, so my prose was
  burying the moments that actually need him. Going forward, on **all** work:
  1. **Be sparse in the chat window.** Short status lines, no essays. State
     what happened and what's next in as few words as carry the meaning; drop
     the play-by-play. (This governs my *chat messages to David* — not Codex
     thread replies or the plan/PR artifacts themselves.)
  2. **Every moment I need David's input gets a visually distinct banner** so
     he can spot it while scrolling — a horizontal rule, then
     `🛑 **NEED YOU** — <one-line ask>`, then the decision, then a closing
     rule. Nothing else in my output uses that marker, so a scan for 🛑 finds
     exactly the blocking moments. **The banner body is a few short sentences,
     structured so David can decide fast (David, 2026-07-24):** (a) the
     **issue** in one or two plain sentences, (b) the **options**, and (c) the
     **ramifications** of each option — the concrete consequence/trade-off of
     picking it. Enough for an informed decision at a glance; no more. Save the
     deep evidence/verification for the Codex threads and the plan, not this
     banner.
  3. **Fire a push notification at those moments** (the `PushNotification`
     tool) so David gets pulled back to the app. Scope: when I'm **blocked on
     his input/decision**, AND at **major completions** that hand the turn back
     to him (plan converged & ready for approval, PR green/ready, build done) —
     the natural "come back" points. Not for routine progress. When unsure,
     bias to *fewer* notifications, not more.
- **Work split into "Phase 1 / Phase 2 / …", spelled out — never "P1/P2" or
  ad-hoc names (David, 2026-07-23).** When I chop one feature into sequential
  deliverables, I label the pieces **Phase N**, written out. I do **not**
  abbreviate to "P1/P2": that collides with Codex's review-finding *severity*
  badges (P1 = critical, P2 = medium), which are already in use in this repo, so
  "P2" would be ambiguous between "phase two" and "a medium-priority finding." I
  also retire one-off scope names like "Head 1/Head 2." (Retroactively: the VSO
  presence-based / required-Concept work is **Phase 1** (PR #234) and the
  system-wide activation guard + ingestion→Stage-1 routing is **Phase 2**.)
- **ChatGPT's review is advisory on product/design/correctness only — never on
  branches, PRs, or devops in my environment.** ChatGPT reviews plans without
  access to my execution environment, so its suggestions about *how* to ship —
  which branch to cut, whether to split/combine PRs, force-push, rebase
  mechanics, any git/devops choreography — carry no authority. I own those
  decisions through our contract (the designated working branch, the
  squash-merge / never-force-push workflow, the PR ritual), and I follow the
  contract without deferring to ChatGPT (or any external reviewer) on them. I
  weigh ChatGPT on the *substance* of a plan — product intent, design fit,
  correctness, source-of-truth risks — and ignore it on environment mechanics.
  I don't surface an external reviewer's devops opinion to David as an open
  question when the contract already answers it. The same split governs the
  **automated Codex plan-review loop** (see *Automated plan review* below):
  Codex's comments on a plan carry weight on substance and none on how I run
  branches, PRs, or git.

### Workflow tweaks (mechanical checks I've missed before)

- **`lib/api-zod` exports: verify against codegen immediately, not later.**
  `lib/api-spec/patch-generated.mjs` owns `lib/api-zod/src/index.ts` and
  rewrites it from a hardcoded line list on every codegen run — a hand-added
  `export * from "./newModule"` survives typecheck and targeted tests but gets
  silently wiped the next time anything runs
  `pnpm --filter @workspace/api-spec run codegen` (which `pretest` does),
  surfacing later as a broad, unrelated-looking wave of test failures (see
  [`known-failure-patterns.md`](docs/ai-context/known-failure-patterns.md)'s
  "Manual `api-zod/src/index.ts` export silently reverted by codegen" — I've
  now hit this twice, most recently on PR #228). So: the moment I add a new
  file under `lib/api-zod/src/` or a new export to an existing one, I add the
  line to `patch-generated.mjs`'s `apiZodIndexLines` **and** run codegen once
  right then to confirm `git diff --exit-code lib/api-zod/src/index.ts` is
  clean — before writing a single consumer of that export, not deferred to
  "when I run the full suite later." (`pnpm run check:codegen-drift` runs this
  exact check; CI runs the same script, so local and merge-gate can't drift.)

## Two modes: feature-building (default) vs. bug-fixing

The shared, cross-agent definition of these two modes (which Codex uses too) lives
in [`docs/ai-context/working-modes.md`](docs/ai-context/working-modes.md). Below is
the **Claude-specific** elaboration — my extra ceremony layered on the shared
contract. David picks the mode explicitly so there's no guessing:

- **Feature-building mode is the default.** The full ceremony in this file —
  pre-plan conversation, plan markdown file, the automated Codex plan-review
  loop, the full build, Replit `TEST_RUN` doc, `UAT` doc, ship-the-UI-surface
  gate — applies. Plan mode and any "let's build / add / change X" request put
  me here.
- **Bug-fixing mode is the lightweight path, entered explicitly via the
  `/bugfix` skill.** When David invokes `/bugfix` (or asks me to "just fix" a
  small bug), I switch to a fix-and-commit loop: fresh branch off
  `origin/main`, one focused commit per bug, **no plan file, no plan review
  (no Codex loop, no ChatGPT), no TEST_RUN/UAT docs**. I accumulate commits as David feeds bugs and
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

## Area work: memory lives in files, not a marathon chat

David scopes his work into long-running areas of functionality and wants the
model to have that area's full context on tap. The cheap, reliable way to
deliver that is **durable files, not one ever-growing chat** — a long chat
re-reads its entire transcript *uncached* every time he returns to it across
sessions, and `/compact` only preserves a lossy summary of it. So by
**default**, without being asked, whenever we dig into an area of functionality:

- I **proactively keep a running working-notes doc** for that area (a scratch
  doc, or the relevant `docs/ai-context/` file), capturing the decisions,
  gotchas, and subsystem shape *as we go* rather than letting them accumulate
  only in the transcript.
- Before we wrap a session, I **fold the durable bits into the shared docs**
  (`docs/ai-context/`, `decisions.md`, `known-failure-patterns.md`, etc.) so the
  next **fresh** chat — mine or Codex's — loads that context cheaply instead of
  paying to re-read an old transcript.

This lets David keep short, disposable chats without losing area context, keeps
the durable memory in versioned files (single source of truth), and avoids the
worst-case token pattern of returning day after day to one giant compacted
thread. `/compact` stays an in-session relief valve, not the memory itself.

### The `/document` ceremony is the explicit end-of-feature fold-in

The running working-notes habit above captures learnings *during* a build; the
**`/document` skill** is the explicit fold-in pass at the *end*, when David
judges a feature done. It harvests the feature's durable learnings and routes
each to its one canonical home across `docs/ai-context/`, `.agents/memory/`,
and the human-facing [Overhype.me Manual](docs/manual/README.md). The full,
cross-agent contract is
[`docs/ai-context/documentation-workflow.md`](docs/ai-context/documentation-workflow.md)
and my thin enactment is `.claude/skills/document/SKILL.md`; I don't restate
either here.

This is **distinct from "remember this"** (above), which stays what it always
was — immediate targeted persistence of *one* item. `/document` is the
whole-feature harvest; "remember this" is a single note. The contract's trigger
table draws the line, and I ask one numbered question when a request's referent
is genuinely unclear.

### I proactively remind David to run `/document`

David asked (2026-07-23) that I not rely on him remembering this ceremony
himself. When I judge that a moment has produced durable learnings worth
harvesting — per the shared contract's bar: a settled decision + rationale, a
subsystem shape change, a gotcha that cost real time and generalizes, a new
term of art, a retired mistake, or roadmap movement — I say so and suggest
running `/document`, rather than waiting to be asked. That moment is most
often right after:

- A product-visible feature's PR merges and the build surfaced non-trivial
  decisions or gotchas along the way.
- A long working session on one area wraps — even without a merged PR, if
  investigation or debugging surfaced real subsystem truth worth locking in.

The reminder is a one-line nudge at a natural stopping point, not a gate on
finishing the turn — David decides whether the moment actually warrants the
full ceremony, targeted persistence instead, or nothing at all if the work
produced nothing durable. I still never run `/document` myself without David
triggering it; the trigger stays his, per the shared contract's trigger
semantics above.

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
the plan/chat panel is awkward to capture, save, or forward. So **whenever I
present a plan for David's approval, I also
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

**Artifact pages ride along (David, 2026-07-22):** in addition to the markdown
file (which remains the hard precondition above — never a substitute for it), I
also publish the plan as a private **Artifact web page** when presenting it —
cleaner reading on iPad than a raw `.md`. The same applies to **UAT docs**: when
I deliver a `docs/PR<N>_*_UAT.md`, I publish it as an Artifact page too (the
committed markdown stays the canonical, durable copy). Artifacts start private;
they're a reading surface, not a source of truth.

The plan file is a **transient user-delivery artifact, not a repo deliverable**: I
do not commit it, do not include it in any PR diff, and write it outside the repo
(or to a gitignored scratch path) so it never shows up as untracked churn. I add a
plan to the repository only if David explicitly asks for it as a doc.

**One carve-out (David, 2026-07-22):** the automated Codex plan-review loop
(next section) commits the plan file to a dedicated `plan-review/<slug>` branch
on a **never-merged draft PR**, purely as the review channel. That branch is the
only place a plan file gets committed; the plan still never lands on `main` and
never rides an implementation PR.

## Automated plan review: the Codex draft-PR loop

**Standing rule (David, 2026-07-22): plan review runs automatically through
Codex on a draft PR — David no longer copy-pastes plans into ChatGPT.** The
manual paste-into-ChatGPT flow is the fallback only for the two carve-outs below
(security-sensitive plans; a broken loop), and I say so explicitly when falling
back.

**What Codex actually applies.** The default Codex GitHub reviewer is a *code*
reviewer tuned for serious defects — left to its default persona it may stay
silent on a plan that merely *looks* sound. So the loop does not rely on that
persona: Codex reads the shared
[`plan-review-contract.md`](docs/ai-context/plan-review-contract.md) (routed from
`AGENTS.md`), which tells it to review the markdown as a *specification* and
return a complete assessment every time. On Codex's actual GitHub transport that
means diff-anchored findings only — no free-form status label or write-up is
postable there (see the contract's *Output* section) — so "complete" is
evidenced by the round running against a trigger that states the lens and names
what to reconcile, not by a status label Codex cannot post. The full skeleton
with status labels is real, but it belongs to the *other* consumer of this same
contract — my own `overhype-plan-review` skill and ChatGPT's manual-upload path
— which aren't diff-anchored and can post one complete document. (This is the
narrow, correct thing to put in the shared docs — a *review contract Codex
executes* — as distinct from mirroring my whole workflow ceremony there, which
stays out per the sync rule.)

**Before opening anything — the disclosure check.** This repo is **public**, and
a closed-unmerged PR stays in public history. So before I open a plan-review PR I
confirm the plan contains no unpatched-vulnerability details, auth/authorization
bypass specifics, secrets/credentials, payment-fraud abuse paths, private
customer/commercial data, or embargoed plans. **If it does, it does NOT go
through the public PR channel** — that plan stays on the manual/private review
path (a public plan describing an exploit discloses it before the fix ships). I
run this check every time, before creating the PR, not after.

**External-claim verification is mine.** Codex's review environment is often
network-restricted, so I don't outsource external verification to it. When a plan
makes a material external API / SDK / model / pricing / rate-limit claim, **I**
verify it against current authoritative docs (I have web access) and record what
I checked — the sources and their versions — in the plan itself. Codex's contract
then just confirms that record exists; it never substitutes model memory for
current docs.

In feature-building mode, once the pre-plan conversation has settled intent, I
have a draft plan, and the disclosure check passes:

1. **Open the review channel.** Commit the plan markdown (the same content I
   deliver via `SendUserFile`, with the external-verification record folded in)
   as `docs/plans/PLAN_<SLUG>.md` on a fresh branch `plan-review/<slug>` cut from
   `origin/main`, push, and open a **draft PR** (base `main`) titled
   `[PLAN REVIEW] <title> — DO NOT MERGE`. The PR body uses this template — it is
   Codex's review oracle:

   ```markdown
   ## Review mode
   Plan review only. Never merge. Do not implement. Apply
   docs/ai-context/plan-review-contract.md.

   ## Product intent
   <What David asked this feature to accomplish — verbatim or faithful.>

   ## Must not change
   <Invariants / out-of-scope behavior.>

   ## Settled decisions
   1. <decision> …

   ## Open product questions
   <None, or only genuine David-only questions.>

   ## External-claim verification
   <not-applicable | what I checked against current docs, with versions.>

   ## Plan file
   `docs/plans/PLAN_<SLUG>.md`
   **Re-reviews: read the whole file, not the diff.** Reconcile every prior
   finding (Resolved / Still open / Superseded) and attack from a lens not yet
   applied. See the contract's *Re-reviews* section.

   ## Findings ledger
   <Round-by-round, maintained by me: each finding, its status, and the lens
   each round applied. Cross-round state lives here so it survives whatever
   Codex does or doesn't carry between rounds.>
   ```
2. **Subscribe** with `subscribe_pr_activity` immediately — regardless of model
   tier, and **without asking to switch tiers.** The Sonnet gate under *Watching
   the PRs I open* is for *implementation* PRs (ops-shaped work); a
   `[PLAN REVIEW]` PR and the whole revise-until-converged loop are **planning**,
   so I stay on **Opus** for all of it and do **not** ask David to switch me to
   Sonnet mid-plan. The tier only ever changes *after* David approves the plan,
   at the transition to execution — see the tier-lifecycle rule in
   *Token / cost discipline*.
3. **Trigger the first review explicitly.** I do **not** assume opening the PR
   auto-triggers Codex — I post an explicit `@codex review` comment after
   opening. I never treat a push, or webhook silence, as proof the current
   revision was reviewed.
4. **Each round:** when Codex reviews, I fetch live PR state first (never act on
   the webhook text alone), confirm which revision it reviewed (compare against
   the current head), weigh every comment on plan *substance*, revise the plan
   file, push, reply inline on each comment's thread (never resolving threads),
   and request the next round with a fresh explicit `@codex review` comment.
   Codex has authority on plan *substance*, **none** on branch/PR/devops
   mechanics (e.g. its "delete the branch" advice — I can't, and don't need to).
   Codex's GitHub review posts only diff-anchored inline findings — confirmed
   against this repo's own PR history, its top-level review body is always
   fixed connector boilerplate, never custom text. So it cannot itself post a
   status label, a lens declaration, or a ledger; that synthesis is **mine**,
   not something to wait for from Codex. **The trigger comment states the lens
   and names what to reconcile — Codex reviews against that, it doesn't declare
   its own framing afterward.** Every re-review comment (round 2+) names the
   angle I want this round to attack from and lists the specific prior findings
   to check as resolved; Codex posts a **Reconciliation finding per named
   item** (Resolved / Still Open / Superseded, with what it checked) even when
   every one is Resolved — "clean" means zero Required Revision findings, not
   zero comments, so the ledger gets real evidence rather than inferring
   "resolved" from silence. Three things I own each round: I **write that
   framing into the trigger comment**, I **derive the round's status and
   update the findings ledger** in the PR body by reading Codex's individual
   inline findings (their category tags, the Reconciliation verdicts, plus my
   own trigger text as the record of that round's lens),
   and I **clear the review's *Unable to verify* list** before requesting the
   next round — the genuinely unobservable ones (external APIs, production
   data, runtime timing) are mine to resolve, and a repo-observable one going
   unanswered means Codex's round was incomplete and I say so on the thread
   rather than absorbing it.
5. **Convergence: minimum 3 rounds, and three conditions (David, 2026-07-22).**
   I do not stop before three completed Codex review rounds, even if an early
   round comes back clean — in that case I request the re-review through a
   different lens (edge cases, data integrity/migrations, source-of-truth risks,
   failure modes) instead of manufacturing plan churn. From round 3 on, I stop
   only when **all three** hold: (a) no substantive new objections (zero
   Required Revision findings from Codex), (b) my findings ledger — built from
   Codex's Reconciliation findings, not from silence — shows **zero Still
   Open**, and (c) the trigger comment for that round named a **fresh lens**.
   A round with no evidence trail is otherwise ambiguous between *converged*
   and *the reviewer stopped looking* — (b) and (c) are what tell the
   difference, since consistency across rounds is not evidence of quality.
6. **Escalate, don't absorb, real product decisions.** If Codex raises a genuine
   product/design fork, it goes to David as a numbered question — the loop never
   settles product intent on its own.
7. **Break non-convergence.** If substantive objections are still coming after
   ~6 rounds, or Codex and I flatly disagree on a point of substance, I stop and
   bring David the disagreement instead of churning.
8. **Close out.** When converged: close the draft PR **without merging**
   (`update_pull_request`, state `closed`) with a closing comment recording the
   final review status, unsubscribe, then deliver the final plan via
   `SendUserFile` and ask for David's approval per the ritual above. **Codex
   convergence is NOT plan approval** — *Plan approval is explicit only* still
   governs; only David approves.

**Calibration (first ~3 real plans).** This is a pilot, not a proven
replacement. For the first few plans I run the Codex loop *and* note where its
review lands versus what the manual ChatGPT pass would have caught, and report
that to David — so we replace ChatGPT on evidence, not on "same models, should be
fine." If Codex's plan reviews prove too shallow, the transport (PR) still stands
and we swap the reviewer, per David's call.

Hard boundaries:

- The plan-review PR is **never merged**, and its branch is **never reused for
  implementation** — the build happens on a normal feature branch after David
  approves. (Remote branch deletion is blocked in this environment, so closed
  `plan-review/*` branches simply accumulate; that's expected, not a mess to
  clean up — and not something to take Codex's "delete the branch" advice on.)
- A `docs/plans/` file reaches `main` only if David explicitly asks to keep it
  (the plan lives only on the never-merged review branch otherwise).
- Security-sensitive/confidential plans never enter this public channel (the
  disclosure check above).
- No `send_later` self-check-ins for this loop either — the standing
  no-background-check-ins rule applies. Codex's webhook events and David's pings
  are the only wake-ups.

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

### This environment's git constraints (learned the hard way — work WITH them)

`.claude/guard.sh` and the git proxy impose hard limits. I verified all of these;
do not relitigate them mid-task:

- **`git push --force` / `--force-with-lease` → BLOCKED** by the guard.
- **`git reset --hard` → BLOCKED** by the guard.
- **`git push origin --delete <branch>` → does NOT work** (the proxy hangs /
  "remote end hung up"). I cannot delete a remote branch.
- **`git checkout -B <branch> <ref>` → WORKS** (moves the branch ref without a
  `--hard` reset; the guard allows it). This is my reset primitive.

**The governing rule: NEVER rewrite history that is already pushed.** Because I
can't force-push, can't delete the remote branch, and can't hard-reset, a
rebased/amended already-pushed branch becomes **unpublishable** — plain push is
(correctly) rejected as non-fast-forward and I have no way to reconcile it. A
clean rebase wastes effort at best and strands the branch at worst. GitHub's
squash-merge already 3-way-merges my branch against current `main` at merge time,
so **rebasing "to sit on top of main" is unnecessary** and I stop doing it.

**Before the FIRST push of a fresh branch** (nothing on the remote yet): it's
fine to base it cleanly on main — `git fetch origin main` then
`git checkout -B <branch> origin/main`, apply my work, push. (This is also how I
**restart a branch after its PR squash-merged**: `git checkout -B <branch>
origin/main` gives a fresh base with no merged history to fight — the sanctioned
no-force reset.)

**For follow-up work on an ALREADY-pushed branch:**

1. Just add new commits on top and `git push -u origin <branch>` (fast-forward —
   works). Do **not** rebase/amend the pushed commits.
2. If I genuinely need current `main`'s changes in the branch, **merge, don't
   rebase**: `git fetch origin main && git merge origin/main` (a merge commit is
   fine — the squash collapses it). Then push.
3. If local has accidentally diverged from the remote (e.g. an errant rebase I
   can't publish), realign to the remote and continue: `git checkout -B <branch>
   origin/<branch>` (content is preserved — the remote already has the work),
   then add new commits and plain-push.

Only ever do this to MY feature branch, never `main`. When in doubt,
`git diff origin/main HEAD --stat` shows the true delta the PR will contain.

**Pre-PR quality pass (David, 2026-07-22):** before opening an implementation
PR (feature mode; bug-fix batches are exempt — they're already minimal), I run
the `/simplify` pass over my changed code — dead weight, duplication,
needless complexity — and fold in its fixes. Codex then reviews a cleaner
diff, which means fewer mechanical review rounds. This is my discipline, not
a David checkpoint; I don't announce it beyond a line in the PR body.

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

### Watching the PRs I open (always — implementation-PR watching gated on Sonnet)

**Standing rule (David, 2026-07-21): I always subscribe to a PR I create — no
per-PR ask — but ONLY while running on Sonnet.** Watching (triaging comments,
driving CI green, mechanical fixes) is ops-shaped work per the token-discipline
table below, so it belongs on Sonnet, not whatever tier I built the PR on.

**Scope — this gate is for *implementation* PRs only (David, 2026-07-22).** A
`[PLAN REVIEW]` draft PR (the *Automated plan review* loop above) is a
**planning** artifact: I watch it and revise the plan on **Opus**, subscribing
immediately with **no** tier-switch ask. Everything below — the Sonnet gate, the
"ask to switch" step — applies only to the normal implementation/feature PRs I
open *after* a plan is approved. I never bounce off Opus mid-plan just to watch
the plan-review PR.

Concretely, at the point I'd open/finish an **implementation** PR:

- **Already on Sonnet** → call `subscribe_pr_activity` immediately, no asking.
- **On Opus (or anything else)** → do NOT subscribe yet. Tell David plainly that
  the PR is ready to watch and I'm on the wrong tier, and ask him to switch me
  to Sonnet. **I don't assume `/model claude-sonnet-5` is how he'll do it** — on
  iPad (Claude Code on the Web) there's no slash-command input; he switches via
  the model picker in the UI instead. So I ask generically ("switch me to
  Sonnet") rather than prescribing the CLI command, and either mechanism ends
  the same way: a system-reminder confirms "The model for this session has been
  changed to claude-sonnet-5" — that confirmation, not the input method, is
  what tells me the switch happened. I don't switch myself either way.
- If a session ever gets switched to Sonnet later (e.g. for this exact reason)
  and there's an open, unwatched PR I created earlier in the session, that's the
  moment to subscribe — I don't need David to re-ask.

**I still do NOT arm background self-check-in loops, ever, by default** — this
part is unchanged and does not depend on model tier. Each `send_later`
self-check-in wakes a *persistent* session on a timer, and every wake reloads
that session's full accumulated context uncached (the prompt cache is long dead
after the interval) — so a fleet of PR watchers quietly burns tokens in the
background whether or not David is present. Subscribing (webhook events) is now
the default per above; *scheduling my own wake-up* stays off, standing, per the
next paragraph.

**David has told me directly (2026-07-07): no background check-ins, period — he
checks PR status manually and pings me if he needs me.** This overrides the
"long interval if David wants a timer" allowance that used to live here: I do
**not** arm a `send_later` self-check-in for PR watching, do not offer to arm
one, and do not ask whether he wants one — the default is off, standing, across
all PRs, not a per-PR ask. I still re-verify true PR state (threads + CI +
mergeability) whenever I'm reactively woken by a real webhook event or by David
directly, per the rules below — I just never schedule my own wake-up for it.
Whenever a watched PR merges or closes, I unsubscribe (no timer to clean up,
since none was armed). While watching:

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
  mergeability) rather than assuming the last event told the whole story. I do
  **not** schedule my own wake-up (`send_later`) to go check in the absence of
  being re-engaged: per David's standing instruction above, he checks PR status
  manually and pings me if he needs me, so there is nothing for me to
  proactively poll for.
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
- **Fix commits get re-reviewed — one `@codex review` per fix round (David,
  2026-07-22).** Codex reviews the PR's *initial* diff, but a push does NOT
  reliably re-trigger it — so the fixes I push in response to review comments or
  CI failures would otherwise reach David's squash-merge unreviewed, and
  reactive fix code is exactly where subtle mistakes hide. After I've addressed
  a round of review feedback (fixes pushed, inline replies posted), I post
  **one** explicit `@codex review` comment so the new commits get reviewed —
  batched per round, never per-comment, and it's the *commits* being reviewed,
  never my prose replies. **No minimum rounds, no convergence ceremony** — that
  is the plan loop, not this: a clean/silent re-review ends it, and new
  substantive findings just follow the rules above (fix the mechanical,
  escalate real decisions, break after ~2 non-converging rounds). Only
  exception: a genuinely zero-risk push (docs-only, comment typo) doesn't need
  one — anything touching product code or test logic does. **The re-request
  says what to reconcile.** A bare `@codex review` on a fix round invites a
  review of just the new commits, so I state in the comment which findings the
  round was meant to close and ask Codex to confirm each is actually resolved
  in the code — not merely responded to. Same principle as the plan loop's
  *Re-reviews*, in miniature: a reply on a thread is not evidence the defect is
  gone.
- **Never resolve review threads — that's David's.** I leave the reply but do
  **not** mark the thread resolved. David resolves threads himself after reviewing
  them, so the "require conversation resolution" merge gate stays a real
  checkpoint — he sees what happened before merging. I resolve a thread only if
  David explicitly asks.
- I stay **frugal with GitHub replies** (only when genuinely necessary), and I
  stop watching once the PR is merged or closed, or when David says stop.

Codex (and other AI reviewers) remain the independent reviewers; my job while
watching is to *respond* — fix the mechanical, escalate the substantive.

## Standing devops rituals (David, 2026-07-22)

- **Weekly maintenance is a David-invoked ritual, not a background task.** The
  `/maintenance` skill (`.claude/skills/maintenance/SKILL.md`) owns the
  contract; the one piece worth restating here is the standing authorization
  it grants — green minor/patch Dependabot bumps are the single category of PR
  I squash-merge myself. David invokes it roughly weekly; I never schedule it
  myself (the no-background-check-ins rule stands). David asked for a one-shot
  ~4-week reminder (around 2026-08-19) to revisit whether he wants it
  automated.
- **Quarterly security review.** Roughly every quarter — or after any
  payment-path / auth-touching feature merges, whichever comes first — David
  asks for a `/security-review` pass. Opus always (per the tier table: a missed
  vulnerability is uncatchable by either safety net). If a quarter has clearly
  lapsed and a payment/auth change just shipped, I proactively suggest it
  rather than waiting to be asked.
- **Recurring failure patterns become CI guards.** When an entry in
  [`known-failure-patterns.md`](docs/ai-context/known-failure-patterns.md)
  recurs, the default response is not a better memory note — it's a
  deterministic check in `.github/workflows/build.yml` that makes the mistake
  impossible (models: the docs-accuracy check, the migration-snapshot
  validator, the codegen-drift guard). Same principle for my own ceremony:
  **a CLAUDE.md rule I've broken twice is a candidate for a hook** (like
  `.claude/guard.sh` blocking force-pushes) that physically blocks the wrong
  action instead of relying on my recall.

## Token / cost discipline

David tracks cumulative plan-quota usage (not just one session's context
window) and flagged that routine ops work — checking PR comments, watching
CI, mechanical fixes — was running at premium-model cost with redundant tool
calls. Two concrete, durable changes:

- **Match model tier to task shape.** I cannot switch the active model myself
  — David is the one who switches it, by typing `/model <name>` in the CLI **or**
  using the model picker in the UI (his standing note: on iPad/Claude Code on
  the Web there's no slash-command input, so the picker is how he does it
  there) — so codifying this means I *reliably prompt* instead of leaving it to
  habit or memory. I ask for the tier by name ("switch to Opus" / "switch to
  Sonnet") rather than assuming he'll type the slash command, since I don't know
  which surface he's on. Either way, a system-reminder confirming "The model for
  this session has been changed to …" is what tells me the switch actually
  happened — not the input method. David is not a software engineer and relies
  on me + Codex's code review as his only two safety nets, so the deciding
  question for any task is: **if this goes subtly wrong, will Codex's review or
  David's product-testing catch it before it does damage?** Yes → Sonnet is
  safe. No → Opus, because I'm the only guard.
  - **Entering `/bugfix` mode** → I suggest switching to Sonnet (`claude-sonnet-5`).
  - **Entering plan mode, or any "let's build/design/add X" feature-building
    request** → I suggest switching to Opus (`claude-opus-4-8`).
  - **Planning stays on Opus end-to-end — no switching back and forth (David,
    2026-07-22).** A planning cycle is *continuous* Opus: the pre-plan
    conversation, the plan itself, **and the whole Codex plan-review loop**
    (watching the `[PLAN REVIEW]` PR and revising until it converges, through to
    David's approval). I do **not** ask to be switched to Sonnet at any point
    during planning — including to watch the plan-review PR, which is planning,
    not ops. David should never have to switch me *back* to Opus for the next
    plan because I bounced to Sonnet mid-cycle.
  - **The only downshift to Sonnet is to *execute* an approved plan — and only
    when the execution is simple/low-risk (David, 2026-07-22).** Per the
    *Implementing features* row below, simple builds run on Sonnet (Codex's diff
    review is the net); high-risk subsystems (migrations, tokenizer/grammar,
    visual pipeline, dev-infra, or a build that surfaces real complexity) stay on
    Opus. So at plan approval I suggest Sonnet **only if** the execution ahead is
    genuinely simple; otherwise I stay on Opus to build. Watching that
    implementation PR afterward then follows the ops-shaped Sonnet gate above.
  - **By task type** (the reference table, since the two boundaries above
    don't cover everything I do):

    | Task | Model | Why |
    |------|-------|-----|
    | Planning new features | **Opus, always** | A plan can match stated intent and still be architecturally wrong — David's product-testing only checks what got built, never the road not taken. |
    | Implementing features | **Sonnet default**, Opus for high-risk subsystems | Codex reviews the diff, so the net holds for most code. Escalate for migrations/data, the tokenizer/grammar, the visual pipeline, or when the build surfaces real complexity. |
    | Debugging new features | **Sonnet start**, escalate to Opus if it thrashes | Most bugs are shallow. 2+ rounds without convergence is the signal to switch — grinding on the cheap tier costs more than one clean Opus pass. |
    | Devops / working-with-Claude-and-Codex meta | **Sonnet** | Workflow reasoning with checkable output, no uncatchable downside. |
    | Documentation | **Sonnet, always** | David reads the docs — drift is self-catching, and fixes are cheap. |
    | Optimization | **Opus-leaning** | A "faster" version that's subtly wrong on an edge case still looks like it works, so it can dodge both nets. Trivial/obvious cleanups can stay on Sonnet. |
    | Security review | **Opus, always** | A missed vulnerability is the definition of uncatchable by either net. |
    | **Dev-infra / self-healing / build-tooling resilience** (retry & reload loops, `dev-supervisor.sh`, Vite/esbuild config, HMR) | **Opus, always** | Uncatchable by either net: the defect is usually a *missing* guard (invisible to diff review) in code that isn't a product surface (invisible to product-testing). The crash/reload loop that cost days lived exactly here — see the *Self-retriggering recovery* pattern in [`known-failure-patterns.md`](docs/ai-context/known-failure-patterns.md). |
    | **Database migrations / schema changes / backfills** | **Opus, always** | Often irreversible, and a subtly-wrong backfill isn't visible until the data is already mangled. The sharpest edge on this list. |
    | Product direction / roadmap trade-offs | **Opus** | Pure judgment, uncatchable if wrong. |
    | Large structural refactors | **Opus** (touches invariants) vs. **Sonnet** (small tidy-ups) | Depends on whether it can perturb an invariant David can't see in a diff. |
    | "How does X work?" / codebase questions | **Sonnet** | Read-and-explain, low risk. |
    | Triaging Codex review comments | **Sonnet**, escalate to Opus only for a genuine architecture question | Most comments are mechanical fixes. |

  - **I stay vocal about the model in play — David expects to forget this, not
    track it.** Whenever it's relevant, I state which tier is active and flag
    a mismatch immediately: before starting a task that's clearly wrong for
    the current tier ("this is a migration — you're on Sonnet, want to switch
    to Opus first?"), and mid-task if a debugging/optimization thread thrashes
    past ~2 rounds without converging. The goal is David never
    burns Opus tokens on something Sonnet could do, and never asks Sonnet to
    do something high-risk or genuinely hard, **without me saying so out
    loud first.**
  - Outside the two explicit mode boundaries and the table above, I default to
    treating the session's *current* tier as correct and only flag a mismatch
    if the task shape clearly shifted mid-thread.
  - `.claude/settings.json` sets Sonnet as the **default starting model** for
    new sessions, since most turns are ops-shaped per David's usage data —
    Opus is the explicit upgrade for the tasks in the table above, not the
    default you have to remember to downgrade from.
- **Batch PR re-verification into one call; don't reduce how often I check.**
  The *"re-verify on each active turn"* rule under **Watching the PRs I
  open** above stays exactly as-is — webhooks lag and drop events, so silence
  still isn't "all clear." What changes is mechanics: pull threads + CI
  status + latest commits via a **single** `pull_request_read` call instead
  of chaining separate calls, and pass `minimal_output: true` when I don't
  need full bodies/diffs. Same verification cadence, a fraction of the
  tool-call cost. When a re-verify finds nothing new, I say so explicitly
  ("re-checked — no new activity since last update") so the discipline stays
  visible instead of assumed.
- I also default to `list_*` over `search_*` for simple retrieval, and
  paginate in small batches (5-10 items), per the GitHub server's own
  guidance — not a cadence change, just cheaper calls for the same coverage.
