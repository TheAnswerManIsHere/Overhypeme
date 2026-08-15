---
name: plan-review-loop
description: Use in feature-building mode once the pre-plan conversation has settled intent and a draft plan exists, or whenever a plan needs to be delivered to David for approval. NOT for bugfix mode, which skips plan review entirely.
---

# The Codex plan-review loop (and how a plan is delivered)

Migrated out of `CLAUDE.md` so it loads when a plan is actually being reviewed
rather than in every session. The trigger, the public-disclosure prohibition,
and the "plan approval is explicit only" rule stay resident in `CLAUDE.md`.

## The plan-review PR is the plan's delivery surface

The loop commits the plan to `docs/plans/PLAN_<SLUG>.md` on the
`plan-review/<slug>` branch, so GitHub renders it as formatted markdown at a
stable, forwardable URL — that PR page is what David reads, links to, and
forwards (he works from the iPad web UI, where the plan/chat panel is awkward
to capture or share). The two older delivery rituals — a markdown hand-off via
`SendUserFile` (once a hard precondition on `ExitPlanMode`) and a private
Artifact page — are **retired (David, 2026-07-28)**: he only ever needed the
markdown for sharing, and the PR page covers both needs. So for a plan going
through the loop I call neither — not on first presentation, not on any
revision.

**The one case that still needs a hand-off:** a plan that never enters the public
PR channel — the security/confidentiality carve-out, or a genuinely broken loop
(see the loop steps below). With no PR to render it, there is nothing for
David to read, so **there** I write the markdown out and deliver it via
`SendUserFile`. That is the exception, not the default; I say plainly that I'm on
the fallback path when I use it.

Two things this does **not** change:

- ***Plan approval is explicit only* still governs.** Dropping the delivery
  precondition removes a step before the approval prompt, not the meaning of
  approval: the harness prompt is not David's approval, and neither is Codex
  convergence.
- **UAT docs still get Artifact pages** — see the `pr-docs` skill. That rule
  was written in the same breath as the plan rule but is independent of it: a
  UAT is a click-through David works from in the app, not a specification
  under review.

Where the plan file lives: `docs/plans/` on a **never-merged** plan-review
branch — `plan-review/<slug>` for the ordinary single-PR loop, and additionally
`plan-review/<slug>-combined` for a step-10 split's compiled document (close-out
step 11). Those two branch forms are the only places a plan file gets committed —
the plan never lands on `main` and never rides an implementation PR, unless David
explicitly asks to keep it as a doc.

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
[`plan-review-contract.md`](../../../docs/ai-context/plan-review-contract.md) (routed from
`AGENTS.md`), which tells it to review the markdown as a *specification* and
return a complete assessment every time. On Codex's actual GitHub transport that
means diff-anchored findings only — no free-form status label or write-up is
postable there (see the contract's *Output* section) — so "complete" is
evidenced by the round running against a trigger that states the lens and names
what to reconcile, not by a status label Codex cannot post. The full skeleton
with status labels is real, but it belongs to the *other* consumer of this same
contract — my own `overhype-plan-review` skill and ChatGPT's manual-upload path
— which aren't diff-anchored and can post one complete document.

**Before opening anything — the disclosure check.** This repo is **public**, and
a closed-unmerged PR stays in public history. So before I open a plan-review PR I
run the disclosure check —
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)'s
canonical definition of what disqualifies a workstream from a public issue,
which this same check gates for a plan too. **If it does, it does NOT go
through the public PR channel** — that plan stays on the manual/private review
path (a public plan describing an exploit discloses it before the fix ships;
plans are the one workstream kind where the fallback is manual/private review
rather than a draft Project item, since a plan's whole purpose is external
review). I run this check every time, before creating the PR, not after.

**And I record that it passed, in the PR body** (the *Public-disclosure check*
section of the template below). An obligation that leaves no evidence decays —
the same reasoning the plan-review contract applies to verification reporting.
The attestation is deliberately contentless: it says the check passed, never
what was screened out or why some other plan was judged sensitive, since that
description would itself be the disclosure. A plan that fails the check never
reaches this template at all.

**External-claim verification is mine.** Codex's review environment is often
network-restricted, so I don't outsource external verification to it. When a plan
makes a material external API / SDK / model / pricing / rate-limit claim, **I**
verify it against current authoritative docs (I have web access) and record what
I checked — the sources and their versions — in the plan itself. Codex's contract
then just confirms that record exists; it never substitutes model memory for
current docs.

**The scope-of-work gate comes between the pre-plan conversation and the
loop (David, 2026-08-15).** Once intent has settled and before the plan's
first push, I bring David the scope of work as a 🛑 NEED YOU banner (with
its push notification): the direction served, this increment's product
intent, must-not-change, settled decisions, the now/next/never boundaries
already decided, the ceremony tier, and the 1–100 criticality. **Only his
explicit agreement starts the loop**, and that agreement is what authorizes
the loop to run autonomously to convergence under
[`working-modes.md`](../../../docs/ai-context/working-modes.md#the-post-round-adjudication-david-2026-08-15-superseding-the-2026-08-07-per-round-check-in)'s
post-round adjudication: anything that would change the agreed SOW — a
scope addition, a split, a product fork — comes back to him; everything
else is the loop's to decide.

**The agreed SOW is persisted, not left in chat.** The banner's content
becomes the PR-body template's fields below — including *Ceremony tier* and
*Criticality*, which the template did not previously carry as named fields
— when the review PR opens, so the findings ledger and any later close-out
audit can establish exactly what cadence and scope David authorized without
the original conversation still being in context. If the workstream issue
already exists at the SOW-gate moment, set `waiting:david` on it right then
(don't wait for the review-trigger step below to touch `waiting` for the
first time) — otherwise `/status-all` can keep reporting me as the holder
while the loop is actually blocked on his SOW agreement.

In feature-building mode, once the SOW is agreed, I have a draft plan, and
the disclosure check passes:

1. **Open the review channel.** Commit the plan markdown (with the
   external-verification record folded in) as `docs/plans/PLAN_<SLUG>.md` on a
   fresh branch `plan-review/<slug>` cut from
   `origin/main`, push, and open a **draft PR** (base `main`) titled
   `[PLAN REVIEW] <title> — DO NOT MERGE`. The PR body uses this template — it is
   Codex's review oracle:

   ```markdown
   ## Review mode
   Plan review only. Never merge. Do not implement. Apply
   docs/ai-context/plan-review-contract.md.

   ## Public-disclosure check
   Passed. This plan contains no unpatched vulnerability details, secrets,
   private customer information, fraud-enabling details, or embargoed material.

   ## Scope of work (agreed with David at the SOW gate)
   **Ceremony tier:** <per the ceremony table — product code / migrations
   & sensitive subsystems / etc.>
   **Criticality:** <1–100, per the stopping-rule's criticality gate>
   **Scope boundaries:** <now/next/never calls already made, so a mid-loop
   discovery is checked against a decision instead of argued fresh>

   ## Direction
   <Which direction this plan serves, linked, and the one sentence naming what
   this increment makes true. If genuinely none applies, say so — never leave
   this silently blank.>

   ## Product intent
   <What THIS INCREMENT accomplishes — never the end state, which belongs in
   Direction above. If David's own words were totalising ("all", "every",
   "exclusively"), that sentence goes in the Direction, and this section
   states the narrower thing this plan actually builds.>

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
   <Round-by-round, maintained by me: each finding, its status, the lens each
   round applied, and the plan file's line count for that round. Cross-round
   state lives here so it survives whatever Codex does or doesn't carry
   between rounds. The line count is not decoration — it is the growth
   tripwire's only record, and a round-1 baseline that was never written down
   cannot be compared against later.>
   ```

   **Record the plan file's round-1 line count in the ledger before triggering
   the first review** (`wc -l docs/plans/PLAN_<SLUG>.md`). It is the baseline
   the growth tripwire in
   [`working-modes.md`](../../../docs/ai-context/working-modes.md#review-loops-need-a-stopping-rule-not-just-a-convergence-target)
   measures against, and it is unrecoverable after the fact once revisions
   land.
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
   the current head), weigh every comment on plan *substance* — **and then, on
   a substantive round, run the post-round adjudication before revising
   anything (David, 2026-08-15, superseding the 2026-08-07 per-round David
   check-in)**: the round record defined in
   [`working-modes.md`](../../../docs/ai-context/working-modes.md#the-post-round-adjudication-david-2026-08-15-superseding-the-2026-08-07-per-round-check-in)
   (count + trend + bucket mix, per-finding nature / affected area / verdict,
   the causal flag — new ground vs. repairing an earlier round's revision vs.
   impossible-as-specified — the continue/stop decision with its flip
   condition), kept in the findings ledger, with the judgment moments gated
   by the adversarial subagent (`model-routing`'s structural triggers) and
   noteworthy adjudications surfaced as 👀 FYIs. **The decision is mine;
   what still goes to David mid-loop, as a 🛑, is only what the SOW gate
   reserved**: a product/design fork, a scope addition, a split.
   **The round record carries the plan's line count next to the finding count
   (David, 2026-08-11)** — "round 3: 21 findings, 24 → 14 → 21; plan 1,370
   lines, +56% from round 1" — because the growth tripwire is the one a
   falling finding count conceals, and an unstated number is one I can talk
   myself past. If growth has passed roughly +50% and the adjudicated kind
   of growth is scope accretion, the conclusion is **stop and split — which
   escalates to David**, not another round: per step 10's amendment,
   everything added since round 1 is a split candidate regardless of review
   status once the tripwire has fired, and each addition goes to David as a
   **now / next / never** question per `CLAUDE.md`, defaulting to *next*.
   The same framing applies to any single finding whose fix would introduce a
   **new mechanism** — a table, a role, a config domain, an endpoint — whether
   or not the tripwire has fired: the fix does not go in silently just because
   a reviewer's finding motivated it. Depth-growth (the same coupled
   mechanism getting more precise) resolves to cap-and-implement or continue,
   which are my calls. Skip-on-clean applies: a
   clean or trivial-nits-only round needs no adjudication — under the
   minimum-3-rounds rule in step 7 it proceeds straight to the next lens
   with a one-line status. After the adjudication (or on a clean round), I revise the plan
   file, push, reply inline on each comment's thread (never resolving threads),
   and request the next round with a fresh explicit `@codex review` comment.
   **Revisions are class-level, per
   [`working-modes.md`](../../../docs/ai-context/working-modes.md#a-finding-names-an-instance-the-fix-owes-the-class-david-2026-08-08)**:
   each reply names the finding's class and cites the sweep oracle
   (`grep`/`ls`/…) with its post-revision zero — a plan-file finding almost
   always has siblings (a term used inconsistently, a section pattern
   repeated) — and before each push I re-run every prior round's oracle so a
   later revision can't reintroduce an earlier class. A finding with no
   mechanical oracle, or a recurrence of a swept class, escalates per the
   `model-routing` skill's structural triggers (on this loop's Opus tier the
   escalation is usually moot, but the recurrence flag still goes in the
   check-in).
   Codex is the independent technical reviewer. **Every substantive finding
   must be fixed, rebutted with repository evidence, or escalated to David —
   none may be silently ignored.** Codex does not settle architecture or
   product direction (David does), a finding I can disprove from the repo is
   disposed of by showing that evidence on the thread, and Codex has **no**
   authority over the branch/PR/devops ceremony this contract already governs
   (e.g. its "delete the branch" advice — I can't, and don't need to).
   Codex's GitHub transport posts only schema-validated, diff-anchored defect
   findings — no status labels, lens declarations, informational notes, or
   freestanding write-ups (confirmed directly with Codex on PR #254). Three
   consequences, all mine to own each round:
   - **The trigger comment states the lens and names the prior findings to
     reconcile** — asking Codex to re-check each one, not to confirm they're
     resolved; Still Open and Superseded are equally valid answers, and the
     wording shouldn't pre-judge which. **Every trigger also carries the
     toolchain exclusion** required by
     [`working-modes.md`](../../../docs/ai-context/working-modes.md#a-plan-specifies-invariants-not-implementation-david-2026-08-12):
     *do not report what the compiler or the test suite would catch — report
     what survives into production invisibly.* Without it, "a lens not yet
     applied" invites the reviewer to find anything, and most of what it
     finds on a detailed plan is what the toolchain finds for free. **An empty result against a named
     list is the accepted, confirmed ceiling of evidence this transport can
     produce**, not a gap to keep re-engineering — a Reconciliation finding
     appears only for an item that's genuinely Still Open.
   - **I derive the round's status and update the findings ledger myself.**
     Codex's silence on a named item tells me only that it isn't Still Open —
     never whether it's Resolved or Superseded, both of which get silence on
     a defect-only schema. I classify that distinction myself from my own fix
     history: a straight correction is Resolved; a revision that made the
     original concern moot is Superseded.
   - **I clear the review's *Unable to verify* list** before requesting the
     next round — the genuinely unobservable items (external APIs, production
     data, runtime timing) are mine to resolve, and a repo-observable one
     going unanswered means the round was incomplete, which I say on the
     thread rather than absorb.
5. **Target the trigger comment once a specific subsystem is the live risk
   (David, 2026-07-25).** A generic "@codex review" re-reads the whole plan
   with even attention every round. Once findings cluster on one section (a
   newly-added mechanism, a rearchitected piece), I say so explicitly in the
   trigger comment — name the section and the failure-mode categories worth
   stress-testing (idempotency, concurrency, retry/crash-recovery semantics,
   execution-time races, whatever fits) — instead of a bare "this is round
   N." (Proven on PR #252: directed triggers narrowed each round's findings
   to the named mechanism's real remaining edges.)
6. **Consolidate, don't just accrete, once a subsystem's history gets long
   (David, 2026-07-25).** A subsection that's absorbed several rounds of
   "Correction (Codex round N): my previous claim was wrong" ends up
   carrying its whole revision history forever — Codex re-reads all of it
   every round for no benefit, and it's most of what makes replies/diffs
   balloon. Once a subsystem's design has actually changed shape (not just
   picked up one more caveat), I rewrite that section into one coherent
   final version — keep the reasoning that explains a genuinely non-obvious
   decision, drop the blow-by-blow "I was wrong, then wrong again" narrative
   once it's served its purpose. This is a prose/structure pass, not a
   technical change, so it doesn't reopen anything Codex already confirmed.
7. **Convergence: minimum 3 rounds, and three conditions (David, 2026-07-22).**
   This cadence presupposes the artifact *earns* a plan loop at all — the
   criticality gate ([`working-modes.md`](../../../docs/ai-context/working-modes.md#review-loops-need-a-stopping-rule-not-just-a-convergence-target),
   David 2026-08-08) and the ceremony-tiering rule keep low-criticality
   artifacts (agent-facing markdown, transient docs) out of this loop
   entirely; if I catch myself running this ceremony on something
   single-digit on the 1–100 production-impact scale, the loop itself is
   the mistake and I exit and say so, rather than applying the minimum
   below. For a qualifying plan: I do not stop before three completed Codex
   review rounds, even if an early round comes back clean — in that case I request the re-review through a
   different lens (edge cases, data integrity/migrations, source-of-truth risks,
   failure modes) instead of manufacturing plan churn. From round 3 on, I stop
   only when **all three** hold: (a) no substantive new objections (zero
   Required Revision findings from Codex), (b) my findings ledger — Codex's
   Still Open Reconciliation findings tell me what's not yet resolved, and I
   classify the rest as Resolved or Superseded myself from my own fix history,
   per the ledger-ownership rule above — shows **zero Still Open**, and (c)
   the trigger comment for that round named a **fresh lens**.
   A round with no evidence trail at all — no ledger discipline, no fresh
   lens each round — is ambiguous between *converged* and *the reviewer
   stopped looking on round 1 and never adjusted*; (b) and (c) rule out that
   failure mode, which is real value. **What they do not rule out, and I
   accept as a known risk of this transport rather than a solved problem:** an
   individual round that runs short and emits no defect is indistinguishable
   from one that ran a genuinely complete pass — both look like zero Required
   Revision, zero Still Open. The GitHub surface gives no way to independently
   confirm depth beyond the connector's own reviewed-commit confirmation, and
   that's already established as the ceiling (*Non-negotiables*, *Output*).
   Multiple rounds across different stated lenses is the actual mitigation —
   a review that's shallow on one lens is less likely to be shallow the same
   way on all three-plus — not a guarantee any single round was complete.
8. **Escalate, don't absorb, real product decisions.** If Codex raises a genuine
   product/design fork, it goes to David as a numbered question — the loop never
   settles product intent on its own.
9. **No round-count cap — the judgment rubric is the whole stopping rule
   (David, 2026-08-15, superseding the ~20-round check-in of 2026-07-25).**
   Genuinely substantive, narrowing findings can legitimately run past a
   handful of rounds (PR #252 stayed productive past round 23), and a
   round count was never the decision variable — the bucket mix, the
   tripwires, and the criticality gate are. What replaces the old cap is
   not "run forever": every round's adjudication already asks whether the
   loop should continue, and two situations force the full adversarial
   adjudication regardless of trend — the SAME category of finding
   resurfacing without narrowing (oscillation or a failed sweep), and a
   flat substantive disagreement between Codex and me (a decline that
   doesn't survive, or a finding neither fixable nor refutable, escalates —
   that was always David's). A long loop that keeps yielding new ground is
   the loop working; a short loop that is mostly self-repair stops. Round
   counts still get recorded and reported in the loop-close trail, so David
   can see the cost even though it no longer drives the decision.
10. **Split foreseeably multi-subsystem plans into parallel review PRs
    up front, not retroactively (David, 2026-07-25).** If I can tell before
    opening the review PR that a plan spans genuinely independent
    subsystems (e.g. a bug-fix site enumeration *and* a new infrastructure
    piece neither depends on the other's outcome), I open one plan-review
    PR per subsystem and run their Codex loops in parallel, then compile
    the converged pieces into one final plan document for David's approval.
    I do **not** retroactively fork a PR mid-loop once a subsystem turns out
    to need its own attention — by then Codex's context on the existing PR
    is already established and cheaper to keep using than to rebuild fresh
    on a new one; the upfront split only pays off when decided upfront.

    **Amendment (David, 2026-08-11): that rule covers *reviewed* material by
    default, and the growth tripwire (step 4) is the override.** What the
    original rule protects is accumulated review context, and **brand-new
    scope added mid-loop has none to lose** — so forking *unreviewed*
    additions out of the plan is not just allowed, it is the expected move,
    cost-free, any time:

    - **Reviewed material** — has been through at least one review round,
      whether it was in the plan since round 1 or added at round *N* and then
      survived round *N+1*'s pass. Stays put by default; forking it on a
      routine basis discards the review context this rule exists to
      preserve. The test is **"has a round reviewed this since it was
      added,"** not "when was it added" — a mechanism added at round 3 and
      reviewed at round 4 is reviewed material by round 5, exactly like
      anything else.
    - **Unreviewed scope** — added since the *most recent* round, so no round
      has attacked it yet. Forking it costs **nothing**, because there is no
      review history attached to it. It leaves as a backlog item and a line
      in the ledger, and the current plan reverts to the scope it had before
      the addition.

    **The growth tripwire overrides the "reviewed material stays" default,
    because it is a size judgment, not a review-completeness one.** If
    growth accumulates gradually — each addition reviewed before the next
    one lands — the plan can cross +50% while nothing is ever, at any single
    moment, "unreviewed." Reading the rule above as an absolute would make
    the tripwire's mandated split (step 4: growth past ~50% means split and
    backlog, unconditionally) unreachable in exactly the shape PR #404 took.
    So: when the tripwire fires, **everything added since round 1 is a split
    candidate regardless of review status** — but reviewed material forked
    out this way carries its accumulated findings and ledger rows into the
    successor plan-review PR rather than losing them; only genuinely
    unreviewed material is dropped to a plain backlog item. This is what
    keeps the two rules compatible: routine mid-loop forking still protects
    reviewed context by leaving it in place, and the tripwire still protects
    itself by being allowed to reach it when size, not review status, is the
    problem.

    This is the exit that did not exist during PR #404, which is why its
    only available response to a mid-flight discovery was to absorb it. The
    *now vs. next* question for each forked-out piece goes to David per
    `CLAUDE.md`.
11. **Close out — the two ways a loop ends, not just convergence.** Step 7's
    convergence criteria are one route to close-out; the adjudicated stop
    from the post-round adjudication (oscillation, or a stop/cap call
    surviving the adversarial subagent) is the other, and both close the
    PR the same way below — a stop is not stuck between "not converged
    enough to close" and "not clean enough to request another round." On
    an adjudicated stop: don't request a further round (more prose rounds
    don't fix oscillation) — **and no implementation starts either; the
    stop routes to David's approval like every other loop exit.** The
    approval ask states what stopped the loop and what I recommend comes
    next: for an oscillating mechanism, that only running code can verify
    it — so the plan goes to him as-is with the oscillation named, and any
    prototype or implementation happens only after his explicit approval
    (of the plan, or of a named experiment), never as a side effect of the
    stop. *Plan approval is explicit only* is untouched by autonomy: the
    SOW gate authorized the loop to *review* without check-ins, not to
    build. A cap-and-implement call is the same — "implement" begins at
    his approval, per the normal path below. Either way, the close-out
    comment states which of the two routes ended the loop and why, so the
    findings ledger reads as a real disposition, not an unexplained stop
    mid-round.

    **When converged** (or adjudicated-stopped, per above): close the draft PR **without merging**
    (`update_pull_request`, state `closed`) with a closing comment recording the
    final review status, unsubscribe, then ask David for approval — linking the
    final plan file on the branch, since that PR page is now the plan's delivery
    surface and stays readable after closing (I do not hand over a markdown file
    or an Artifact; see *The plan-review PR is the plan's delivery surface*).
    **The approval ask carries the loop-close decision trail (David,
    2026-08-15)** — rounds run, finding trend, every tripwire that fired and
    how it was adjudicated, declines and their subagent survivals, in
    product English — since this is now the first moment David re-enters a
    loop that ran without him; the trail is what he audits before approving.
    **Codex convergence is NOT plan approval** — *Plan approval is explicit only*
    still governs; only David approves.

    **The split path needs one extra step (Codex review, PR #275).** After a
    step-10 multi-subsystem split, each review branch holds only its own
    subsystem's plan, so "the final plan file on the branch" names nothing —
    the compiled document would exist only in chat, which is exactly the gap
    retiring `SendUserFile` could otherwise open. So I commit the combined
    plan as `docs/plans/PLAN_<SLUG>.md` on **one** dedicated
    `plan-review/<slug>-combined` branch, push it, and link *that* file for
    approval. It needs no PR and no review round of its own — the subsystem
    loops already converged; the branch exists so the approved artifact has a
    stable URL and a resolvable commit sha. That sha is what the
    implementation PR's **Approved-plan source** line cites, which the
    per-subsystem branches cannot supply.

## Keeping the workstream issue's labels current

Per [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md),
this loop is `plan-review-loop`'s slice of label ownership for a workstream
already at `stage:planning`:

- **The SOW gate itself, if the workstream issue already exists** →
  `waiting:david` (stage stays `planning`) the moment the banner posts —
  don't wait for step 3's first review trigger to touch `waiting` for the
  first time; the loop is blocked on David from the SOW banner onward, not
  from the first `@codex review`.
- **The moment David explicitly agrees the SOW** → `waiting:claude` while I
  persist the agreement into the PR template and open the review channel —
  otherwise the issue stays mis-labeled `waiting:david` through step 1's
  work, which is exactly the gap the SOW-gate entry above was meant to
  close, just on the other side of the same transition.
- The moment I post a round's `@codex review` trigger (step 3, and each
  round of step 4) → `waiting:codex`.
- The moment Codex's findings land and I start working the reply →
  `waiting:claude`.
- At close-out (step 11) → `stage:plan-approval`, `waiting:david` — the
  loop's actual handoff, since only David approves.

**If the plan ships in phases, David's approval is also when the Phases
checklist gets written.** Per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)'s
*Phased features* section, a multi-PR feature tracks as a parent issue plus
one sub-issue per phase. This loop's one obligation:

- **At approval of a phased plan** → write the **Phases checklist** into the
  parent workstream issue's body, with *every* phase listed and each one
  marked `not yet opened`. Writing only the phases that start immediately
  defeats the point: the checklist is the sole durable record of what the
  feature still owes, and a phase absent from it is a phase `/next` cannot
  see and nobody will remember.

**This loop never opens a phase sub-issue itself, for any phase, including
the first.** Its lifecycle ends at this step-11 handoff — approval — and
doesn't run again for phase 2 onward, so putting phase-opening here would
work by accident for phase 1 and silently fail for every phase after it.
Opening a phase's sub-issue happens uniformly at the moment that phase's
implementation actually starts, which is `overhype-implementation`'s job
(see that skill) — the same skill for phase 1 as for phase 8.

**A split is proposed to David, never declared silently** — that rule is
this loop's own (step 4's stopping-rule menu already escalates a split),
and it governs phasing identically. The checklist is written *after* he
approves the phased shape, not as a way of announcing one.

If the workstream issue doesn't exist yet when the review PR opens (a
Discovery conversation that went straight to a plan without ever getting
its own issue), open it now rather than leaving this loop untracked —
with the full initial label set (`stage:planning`, `waiting:codex` if the
first `@codex review` trigger is about to post or `waiting:claude` if not
yet, `mode:feature`) and a State of Play block, not just the issue itself.
An issue opened without these three labels is invisible to
`/status-all` (it filters to issues carrying a `stage:` label) and
to the board's sync Action, so skipping them isn't a smaller version of
tracking this workstream — it's not tracking it at all.

**Immediately after, edit the already-open PR body to add `Workstream: #N`
with the issue's real number.** The PR opened before the issue existed, so
its body was created from the template with that field blank or absent —
the issue's number literally didn't exist yet to fill it in. Nothing
backfills this automatically: `pr-watch` can't find an issue-less PR to
label, and `/status-all`'s targeted Planning-stage search
(`status-all/SKILL.md`'s Step 3) can't find a PR with no
`Workstream:` marker in its body either — so without this edit, the PR
stays permanently unlinked to the issue that now exists for it, in both
directions, for the rest of its life.

**Every label change above lands with a State of Play update in the same
edit** — the block's `Stage`/`Waiting on`/`Last movement` fields, per
`workstream-tracking.md`'s ownership rule. A label change with no matching
narrative update is the exact drift that rule exists to prevent.

**Reviewer efficacy is measured by the loop-metrics store**
(`.agents/metrics/loops/<pr>.json`, one record per loop, written with
`node scripts/loop-metrics.mjs --pr <n> --write`): every loop's rounds,
findings, and self-inflicted share are recorded there, which is the evidence
base for changing the reviewer or the ceremony. Records are not append-only —
they can be edited or deleted in an ordinary commit, with PR review as the
control and git history as the durable record (`decisions.md`, 2026-08-07) —
so "recorded" here means durable via that control, not permanent by
construction. The answers reach
David through the digest (`node scripts/loop-report.mjs`, narrated by
`/maintenance`), not by anyone reading records. `.agents/metrics/loop-ledger.md`
is the frozen archive of the first 46 loops and is never appended to again.
(This supersedes the original
"first ~3 plans" calibration pilot — a dozen loops have run and the ledger
measures them better than a one-time comparison would have.)

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

