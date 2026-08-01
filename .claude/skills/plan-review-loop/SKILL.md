---
name: plan-review-loop
description: Run the automated Codex plan-review loop on a draft PR, and deliver the converged plan to David for approval. Use in feature-building mode once the pre-plan conversation has settled intent and a draft plan exists — it owns opening the [PLAN REVIEW] draft PR, the per-round trigger/ledger/lens ceremony, convergence, and close-out. Also covers how a plan is delivered (the PR page, not SendUserFile or an Artifact). NOT for bugfix mode, which skips plan review entirely.
---

# The Codex plan-review loop (and how a plan is delivered)

Migrated out of `CLAUDE.md` so it loads when a plan is actually being reviewed
rather than in every session. The trigger, the public-disclosure prohibition,
and the "plan approval is explicit only" rule stay resident in `CLAUDE.md`.

## The plan-review PR is the plan's delivery surface

David works from the Claude Code on the Web iPad UI, where a plan rendered only in
the plan/chat panel is awkward to capture, save, or forward. Until 2026-07-28 I
covered that two ways: a markdown file handed over with `SendUserFile` (a hard
precondition on `ExitPlanMode`), plus a private Artifact web page for cleaner
reading.

**Both are retired (David, 2026-07-28): the Codex plan-review loop replaced
them.** The loop commits the plan to `docs/plans/PLAN_<SLUG>.md` on the
`plan-review/<slug>` branch, so GitHub renders it as formatted markdown at a
stable, forwardable URL — which covers the sharing need the file existed for *and*
the reading comfort the Artifact existed for. David's words: he only ever needed
the markdown for sharing.

So, for a plan going through the loop: I do **not** call `SendUserFile`, and I do
**not** publish an Artifact page — not on first presentation, not on any revision.
The plan-review PR is what David reads, links to, and forwards. `ExitPlanMode` no
longer has a delivery precondition.

**The one case that still needs a hand-off:** a plan that never enters the public
PR channel — the security/confidentiality carve-out, or a genuinely broken loop
(see *Automated plan review* below). With no PR to render it, there is nothing for
David to read, so **there** I write the markdown out and deliver it via
`SendUserFile`. That is the exception, not the default; I say plainly that I'm on
the fallback path when I use it.

Two things this does **not** change:

- ***Plan approval is explicit only* still governs.** Dropping the delivery
  precondition removes a step before the approval prompt, not the meaning of
  approval: the harness prompt is not David's approval, and neither is Codex
  convergence.
- **UAT docs still get Artifact pages** — see *Every PR ships with a Replit test
  plan + a UAT* below. That rule was written in the same breath as the plan rule
  but is independent of it: a UAT is a click-through David works from in the app,
  not a specification under review.

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
   none may be silently ignored.** That's the real gate, and it's stronger than
   "Codex has authority" (the wording this replaces), which read as though
   Codex settled architecture or product direction: it doesn't, David does, and
   a finding I can disprove from the repo is disposed of by showing that
   evidence on the thread, not by deferring. Codex has **no** authority over
   the branch/PR/devops ceremony this contract already governs (e.g. its
   "delete the branch" advice — I can't, and don't need to).
   Codex's GitHub review posts only diff-anchored inline findings — confirmed
   against this repo's own PR history, its top-level review body is always
   fixed connector boilerplate, never custom text. So it cannot itself post a
   status label, a lens declaration, or a ledger; that synthesis is **mine**,
   not something to wait for from Codex. **The trigger comment states the lens
   and names what to reconcile — Codex reviews against that, it doesn't declare
   its own framing afterward.** Every re-review comment (round 2+) names the
   angle I want this round to attack from and lists the specific prior findings
   to reconcile — asking Codex to re-check each one, not asking it to confirm
   they're resolved; Still Open and Superseded are equally valid answers, and
   the wording shouldn't pre-judge which. Codex confirmed directly on PR #254
   that its connector
   has no non-blocking/informational finding category and no freestanding
   channel — only schema-validated defect findings — so **an empty result
   against a named list is the accepted, confirmed ceiling of evidence this
   transport can produce**, not a gap to keep re-engineering; a Reconciliation
   finding only appears for an item that's genuinely **Still Open** (a live
   defect) — Resolved and Superseded are both "no longer a problem" and both
   get silence, even though they're conceptually different, because neither
   is postable on a defect-only schema. Silence from Codex tells me only that
   a named item isn't Still Open — it does **not** tell me whether it's
   Resolved or Superseded, and collapsing both into "Resolved" in the ledger
   would lose that distinction. **I classify Resolved vs. Superseded myself**
   when updating the ledger: I know what my own fix did — a straight
   correction is Resolved, a revision that changed the plan's shape enough to
   make the original concern moot is Superseded — Codex's silence isn't
   needed to tell them apart, only to confirm neither is still a live
   objection. Three things I own each round: I **write that framing into the
   trigger comment**, I **derive the round's status and update the findings
   ledger** in the PR body by reading Codex's individual inline findings
   (their category tags, any Still Open Reconciliation findings, plus my own
   trigger text and fix history as the record of that round's lens, request,
   and Resolved-vs-Superseded classification),
   and I **clear the review's *Unable to verify* list** before requesting the
   next round — the genuinely unobservable ones (external APIs, production
   data, runtime timing) are mine to resolve, and a repo-observable one going
   unanswered means Codex's round was incomplete and I say so on the thread
   rather than absorbing it.
5. **Target the trigger comment once a specific subsystem is the live risk
   (David, 2026-07-25).** A generic "@codex review" re-reads the whole plan
   with even attention every round. Once findings cluster on one section (a
   newly-added mechanism, a rearchitected piece), I say so explicitly in the
   trigger comment — name the section and the failure-mode categories worth
   stress-testing (idempotency, concurrency, retry/crash-recovery semantics,
   execution-time races, whatever fits) — instead of a bare "this is round
   N." Proven in the variant-independence plan (PR #252): once I started
   directing Codex at the newest mechanism, each round's findings narrowed
   to that mechanism's real remaining edges instead of re-scattering.
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
   going (David, 2026-07-25, superseding the old ~6-round break rule).**
   Genuinely substantive, narrowing findings can legitimately run past a
   handful of rounds — a single plan-review PR reached round 23+ in practice
   (PR #252) while still surfacing real bugs each round, because each round
   was catching something the previous fix had actually gotten wrong. So I
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

