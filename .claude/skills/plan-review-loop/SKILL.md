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

In feature-building mode, once the pre-plan conversation has settled intent, I
have a draft plan, and the disclosure check passes:

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
     wording shouldn't pre-judge which. **An empty result against a named
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
   I do not stop before three completed Codex review rounds, even if an early
   round comes back clean — in that case I request the re-review through a
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
9. **Soft cap at ~20 rounds — check in, don't silently stop or silently keep
   going (David, 2026-07-25).**
   Genuinely substantive, narrowing findings can legitimately run past a
   handful of rounds (PR #252 stayed productive past round 23), so I
   don't treat "many rounds" alone as a signal to stop. At ~20 rounds
   (or sooner if the SAME category of finding keeps resurfacing without
   narrowing, or Codex and I flatly disagree on a point of substance), I
   pause and bring David the state via the NEED YOU banner — status, what's
   still open, my recommendation — rather than deciding unilaterally either
   way. If he says keep going, I do, without re-asking at the next
   milestone unless the shape of the problem changes.
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
11. **Close out.** When converged: close the draft PR **without merging**
    (`update_pull_request`, state `closed`) with a closing comment recording the
    final review status, unsubscribe, then ask David for approval — linking the
    final plan file on the branch, since that PR page is now the plan's delivery
    surface and stays readable after closing (I do not hand over a markdown file
    or an Artifact; see *The plan-review PR is the plan's delivery surface*).
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

- The moment I post a round's `@codex review` trigger (step 3, and each
  round of step 4) → `waiting:codex`.
- The moment Codex's findings land and I start working the reply →
  `waiting:claude`.
- At close-out (step 11) → `stage:plan-approval`, `waiting:david` — the
  loop's actual handoff, since only David approves.

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
is the frozen archive of the first 42 loops and is never appended to again.
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

