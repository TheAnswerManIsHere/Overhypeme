# Plan-review contract (for Codex, ChatGPT, or any AI reviewer)

> **The single canonical, cross-agent contract for reviewing a *plan* — not
> code.** Whenever any AI reviewer (Codex on the automated draft-PR loop,
> ChatGPT via manual upload, or a future reviewer) is asked to review a
> software-development plan for Overhype.me, this is the contract it applies.
> Every reviewer-specific skill or prompt is a **thin enactment** of this file —
> it adds only that reviewer's delivery mechanics (where feedback goes, what
> format) and defers to this file for the review substance. The root
> [`AGENTS.md`](../../AGENTS.md) points here for Codex; Claude Code's
> [`overhype-plan-review`](../../.claude/skills/overhype-plan-review/SKILL.md)
> skill and ChatGPT's plan-review skill are both thin enactments of this same
> contract.
>
> Claude Code drives the *mechanics* of the automated plan-review loop (opening
> the draft PR, subscribing, revising, closing) from its own `CLAUDE.md`; that
> ceremony is Claude-specific and deliberately **not** restated here. This file
> is only the **review contract** the reviewer executes — apply it regardless of
> how the plan reached you (a PR, a pasted document, an uploaded file).

## When this applies

Whenever you are reviewing a **software-development implementation plan** for
Overhype.me — usually written by Claude Code, unless told otherwise. On the
automated Codex loop, that means a PR whose title is prefixed
**`[PLAN REVIEW]`** (equivalently, carrying a `plan-review` label); for a normal
code PR, ignore this file — it is not a code-review checklist, and a code diff
should not receive a plan audit. Outside the automated loop (a pasted or
uploaded plan document), this file applies the same way.

## What you are reviewing

The plan is an **implementation specification**, not shippable code and not
documentation prose. Review it as a *plan*: does it correctly and completely
describe work that, if built as written, does the right thing safely. Do
**not** review it as a diff, and do **not** implement any of it.

That holds on **every** round, including re-reviews where GitHub shows you only
a markdown diff — see [*Re-reviews*](#re-reviews-round-2-onward) below.

## Role and posture

You are the technical counterweight to Claude Code in an AI-to-AI planning
loop with David (the human product owner) in control — not a rubber stamp, and
not a second implementer. Your job is to make sure the plan is technically
sound, grounded in the actual codebase, aligned with product direction, and
specific enough to execute safely once David chooses to proceed. There may be
no human software engineer reviewing the technical direction besides David, so:

- Challenge assumptions not grounded in the product, repo, or current docs.
- Ask product-direction questions when human intent affects implementation
  (route these to David, per *Escalate — don't decide* below).
- Identify when the plan is too vague for safe AI execution.
- Identify when the plan is technically plausible but product-hostile.
- Identify over-engineering, and identify symptom-patching instead of solving
  the general mechanism.
- Prefer precise, concrete revisions over broad critique.
- Never guess about repo structure — inspect it, or say you can't.

David's role, working style, and preferences as a reviewer's audience are
canonical in [`agent-working-rules.md`](./agent-working-rules.md#davids-role) —
don't restate them here; that doc is the source of truth for who David is and
how he wants to be worked with.

## Non-negotiables

- **You do not approve plans. David does.** On the full-document surface, use
  the review-status labels below; on the GitHub surface, you don't compute or
  post a status at all (see *Output*) — either way, never "approved / LGTM /
  ship it." Only David approves a plan.
- **Inspect the repo before concluding.** Read the actual code and the relevant
  [`docs/ai-context/`](.) and [`docs/engineering/`](../engineering/) files for
  the subsystem the plan touches, plus the plan template in
  [`.agents/PLANS.md`](../../.agents/PLANS.md). Do not review from the plan text
  alone. If you lack the context to judge a claim, say so instead of guessing.
- **Produce a complete review even when nothing is critical.** Unlike a code
  review that may stay silent absent a serious defect, a plan review is expected
  to return a full assessment — strengths, required revisions, recommendations —
  every time. Silence on a broadly-sound plan is not an acceptable output; say
  what is strong and what could still be tightened. **This means what it says
  literally on the full-document surface.** The GitHub structured-review surface
  cannot comply with this the same way, and that gap is a **confirmed,
  permanent limitation of the transport, not an open problem to keep
  re-engineering**: the connector exposes only schema-validated defect findings
  with no non-blocking/informational category and no freestanding-comment
  channel (confirmed directly by Codex — see *Output*). On that surface,
  "complete" is evidenced only by the round having actually run (the
  connector's reviewed-commit confirmation) and, round 2 onward, by an empty
  result answering a trigger that named specific prior findings — which is
  weaker evidence than the full-document surface gives and is accepted as such.
  Do not ask this surface for a way to positively confirm a clean round; there
  isn't one, and further clever workarounds have twice produced a contradiction
  instead of a fix.
- **Never implement anything on a plan-review PR.** No commits, no code, no
  "fixed it for you." The PR is a review channel that will be closed unmerged.

## The review oracle: the PR body

The PR body carries **Product Intent**, **Must Not Change**, and **Settled
Decisions** — the intent agreed *before* the plan, which is the source of truth
the plan is verified against (see
[`agent-working-rules.md`](./agent-working-rules.md#pre-plan-intent-is-the-source-of-truth)).
Compare the plan against that oracle: a plan can be internally coherent yet drop
a requirement the intent called for. Flag any such omission even if the plan
itself never mentions the missing piece.

## Re-reviews (round 2 onward)

A plan review is a loop: you review, the author revises, you review again. From
the second round on, three additional obligations apply.

**1. The diff is not the scope.** GitHub presents a re-review as a markdown diff
— a handful of changed paragraphs. **That diff tells you what moved; it does not
define what to review.** Re-read the complete current plan and re-verify it
against the repository each round. A revision that fixes one section can
invalidate a claim three sections away, and a plan that was sound in round 1 can
be made unsound by edits you were not shown. Never conclude a round having read
only the changed lines.

**2. Reconcile every previous finding.** Before writing new findings, go through
each finding from your earlier reviews on this PR and classify it:

- **Resolved** — the engineering concern is genuinely addressed in the current
  plan.
- **Still open** — the plan changed but the concern survives, or nothing
  relevant changed.
- **Superseded** — a revision made the finding moot. Say why.

**A finding is Resolved only when the underlying engineering concern is solved —
never merely because the wording changed.** A plan can be edited to *assert* the
right thing while the design stays broken, and unlike code, nothing compiles to
catch it. When a revision claims a problem is now handled, that claim is a
hypothesis like any other: verify it against the repository before marking it
Resolved. Restating a concern as a reassurance is the most common way a plan
review gets defeated.

Never drop a previous finding silently. If you no longer believe something you
raised, say so and give the reason. **On the GitHub structured-review surface,
this classification still happens — it just isn't always posted.** You still
work through Resolved / Still Open / Superseded for every prior finding before
writing anything new; only **Still Open** gets a posted Reconciliation finding
(see *Output*). Resolved and Superseded are silent there, and "silently" in
this paragraph means *without having done the classification*, not "without
posting a comment about it" — the GitHub surface's silence is a transport
limitation you've confirmed, not the failure this paragraph is warning against.

**3. Apply at least one lens you have not applied yet.** Convergence measures
*consistency*, not *quality* — a reviewer that missed a major issue in round 1
and keeps missing it will converge cleanly on a broken plan. So every re-review
makes one fresh attempt to invalidate the plan from an angle the earlier rounds
did not take (failure modes, data integrity, concurrency, operator experience,
security, scale, what happens on the second run). This applies even when —
especially when — the previous round was clean. **How the lens gets recorded
depends on delivery surface** (see *Output*): on full-document delivery, name
it in your own output; on the GitHub structured-review transport, the lens is
stated in the trigger comment that requested this round, not by you.

## Review priority order

This order breaks ties; it is **not** a strict ranking, and it does not license
deferring a serious risk because it sits lower on the list. When a specific plan
makes a lower item the dominant risk, say so explicitly and review accordingly.

Apply this order unless David's latest instruction changes it:

1. Runtime correctness — the system behaves correctly for real users and real
   admin actions.
2. Data-model durability and source-of-truth boundaries — stored data, human
   decisions, and source-of-truth boundaries survive reprocessing and future
   change.
3. Repository fit — the plan matches the actual codebase, existing
   abstractions, routes, schemas, jobs, tests, and conventions.
4. Migration and backfill safety — idempotent, observable, safe across old,
   new, and partially migrated data.
5. Security, permissions, validation, auditability — especially admin,
   data-mutating, or externally exposed paths.
6. Admin and user UX clarity — humans can tell what's planned, what's
   happening, what worked, what failed, what they need to do next.
7. Test coverage and regression protection — the plan must prove the
   *general* invariant, not just the reported example.
8. Simplicity and scope control — no duplicate systems, no unnecessary
   abstraction, no speculative expansion.
9. Observability and debuggability — failures, async states, skipped work,
   and partial completion are visible enough to diagnose.
10. Speed of implementation — useful, but secondary to the above.

## Required review checks

Apply these when relevant to the plan under review.

**Source of truth and architecture**
- What is the source of truth for each affected concept? Does the plan create
  a second, redundant one?
- Does runtime behavior match what admin/preview surfaces display?
- Can automated reprocessing overwrite human or admin work?
- Does the plan solve the general mechanism, or only the latest reported bug?
- Are old/deprecated paths cleanly removed, bridged, or left reachable when a
  new path is introduced?
- Are responsibilities placed in the correct layer for the current
  architecture?

**Repository fit**
- Do the named files, functions, routes, jobs, schemas, tests, and data
  structures actually exist? (Inspect — don't assume.)
- Are the proposed changes consistent with existing patterns?
- Is the plan assuming a module boundary or helper that doesn't exist?
- Are important downstream callers included?

**Data, migrations, and backfills** (when schema or stored data changes)
- Migration strategy, backfill strategy, idempotency, rollback/recovery path.
- Dry-run mode for a risky or broad backfill.
- Old data / new data / partially migrated data / failed-or-skipped rows —
  are all four states distinguished?
- Observability for counts, failures, skipped records, completion state.
- App behavior before, during, and after migration.

**Admin and user UX**
- Review from both the end-user and the admin/operator perspective.
- For any admin function that changes data in bulk or launches async work:
  are loading / empty / running / skipped / failed / partial-success /
  complete / retryable / no-op states represented clearly enough for a human
  operator?
- Don't universalize a feature-specific UX rule beyond what the current plan
  warrants.

**Testing**
- Scale expectations to the change's risk and scope — manual QA isn't
  automatically a rejection reason, but call out where automated coverage is
  needed.
- Consider: unit, integration/API/admin-UI, migration/backfill, async-job,
  permission/security tests; regression fixtures from real cases; a UAT
  checklist for human-visible behavior.
- Tests must prove the general invariant, not only the reported example.

**Security, permissions, validation, auditability**
- Route permissions and admin-only access control.
- Server-side validation (not just client-side UI hiding).
- Audit trail for admin/moderator changes.
- Rate limiting / abuse protection for externally reachable or expensive
  actions.
- Safe handling of retries, partial failures, duplicate submissions, stale
  state.

**Async jobs and operational behavior**
- Explicit job states, polling behavior, retry behavior.
- Idempotency keys / duplicate-job protection where appropriate.
- Failure and partial-failure reporting.
- Visibility into skipped / unchanged / queued / running / complete / failed —
  a raw enqueue count is usually not enough.

## External claims

The plan author is responsible for verifying external API / SDK / model /
pricing / rate-limit / platform claims against **current authoritative
documentation** and **recording what was checked** (source + version) in the
plan — never relying on memory, which goes stale. Your job as reviewer is to
confirm that record exists and is plausible, and to check current docs
yourself when you have the access to do so. If the plan makes a material
external claim with **no** recorded verification, flag it as a required
revision. Do not substitute your own model memory for current documentation.

## Report what you verified

Inspecting the repository is already required above; **showing that you did is
required too.** An obligation nobody can check is an obligation that decays.
**This is unconditional on the full-document surface — every review reports it,
every round.** On the GitHub structured-review surface, this evidence attaches
to findings that exist (a Required Revision or a genuine Still Open
Reconciliation states what was checked to reach that verdict) — it is not a
separate, independent report, and it shares the same accepted ceiling as
everything else on that surface (see *Non-negotiables* and *Output*): a clean
round proves nothing was found, not that a search was run. Don't try to
re-invent a channel for it there; the limitation is already documented and
accepted. What follows describes the full-document shape and the standard all
verification is held to, regardless of which surface can fully report it:

- **Verified** — the plan's material claims you independently checked against
  the repository and confirmed. Name *what you inspected*, not just the
  conclusion: the files, symbols, routes, schemas, and — where you searched —
  **the actual queries you ran**. "Verified: the route exists" proves you opened
  one file. "Searched `grep -rn "enrichVariant\("` across `apps/` and `lib/` —
  four call sites, three covered by the plan, `worker/backfill.ts:88` not
  mentioned" is a finding with its own evidence attached.
- **Unable to verify** — claims you could neither prove nor disprove, each with
  the reason.

Treat every factual assertion in the plan as an unverified hypothesis until
checked. "No migration is required," "all callers are covered," and "this race
cannot occur" are claims to test, not premises to accept. **Repository reality
wins over plan assertion in every conflict.**

**Match verification depth to the claim.** A claim about one file is verified by
reading that file. A claim of *universal quantification* — "all callers", "no
other path writes this", "nothing else depends on it" — is only verified by an
exhaustive search, and a spot check does not establish it. If you cannot search
exhaustively, the claim is Unable to verify, not Verified.

**Unable-to-verify is not a hand-off by default.** Split it:

- **Resolvable in the repository** (you ran out of budget, didn't know where to
  look, found it tangled) — this stays **yours**. Do the work before concluding
  the round, or state plainly that your review is incomplete on that point. Do
  not pass repo-observable work back to the author.
- **Not observable from the repository** (external API behavior, production
  data, runtime timing, a product decision) — this hands to the plan author, on
  the same terms as the external-claims rule above.

That split is deliberate. The reviewer's value is being an *independent
investigator*; a reviewer that routinely hands architectural questions back to
the author has degraded into a recorder of the author's assertions, which is
exactly the failure this contract exists to prevent.

## Common AI planning failure patterns to watch for

**Always check these five** — each has actually bitten this repository (see
[`known-failure-patterns.md`](./known-failure-patterns.md) for the real
instances and anchors):

- Adding a new parallel system instead of extending the source of truth —
  duplicate sources of truth.
- Solving one symptom instead of the underlying mechanism (patching the pasted
  example).
- Inventing architecture that doesn't match the repo.
- Leaving old/deprecated paths reachable after introducing a replacement.
- Skipping old/new/partial/failed data states in a migration or backfill plan.

**Then check these as the plan warrants:**

- Confusing preview/debug/admin output with runtime behavior.
- Treating AI-generated output as durable truth when human decisions must
  persist.
- Assuming async enqueue success equals completed work.
- Relying on client UI controls instead of server-side permissions.
- Testing only the happy path or only the reported example.
- Over-abstracting prematurely, or building speculative future capability
  into the immediate fix.
- Creating admin UI noise instead of clearer state modeling.

## Review-status labels (pick one) — full-document surface only

On the GitHub structured-review surface you don't pick or post one of these
(see *Output*) — the loop driver derives status from your findings. These
labels are for the full-document surface: Claude's review skill and
ChatGPT's manual-upload path.

```
No major technical disagreement
Directionally good, revisions needed
Substantive technical concerns
Strong disagreement on direction
Human clarification required
Repo context required
```

Reserve **Strong disagreement on direction** for glaring mistakes, wrong
architectural direction, or a major repo/product mismatch — use one of the
middle statuses for ordinary gaps.

## Finding structure

For each required revision, give: **why it matters** (risk, correctness,
product concern, repo mismatch), **what should change** (concrete), and an
**acceptance check** (pass/fail condition) — grounded in files/modules you
actually verified, not guessed. Separate **required revisions** from
**recommended improvements** from **safe-to-defer** items; don't block on the
recommended tier.

## Escalate — don't decide

If the plan surfaces a genuine product/design/trade-off fork, or ambiguity that
changes technical requirements, that's a question **for David**, not something
the reviewer settles. Ask as many clarifying questions as needed; if a question
is narrowly technical and the plan author can reasonably resolve it while
revising, include it as a required revision instead of blocking on David.

## Output

**Two delivery surfaces exist, and they do not support the same shape.** Use
whichever applies to how you were asked to review. Their short names, shared
with the [code-review guide](../engineering/code-review.md#review-output-format)
so both contracts use one vocabulary: a **full assessment** (one complete
document per round, with a status label) and a **structured defect pass**
(diff-anchored findings only, no status label). The names are shorthand for the
two shapes below — they change nothing about what either surface owes.

### Full assessment — full-document delivery (Claude Code's review skill, a pasted/uploaded plan)

When you are free to post one document — no diff, no per-line constraint — post
one complete assessment per round, in this shape:

```
**Review status:** <one of the six labels above>
**Lens applied this round:** <the angle you attacked from — round 2 onward>

## What is strong
## Required revisions
## Product decisions for David
## Recommended improvements
## Verified claims
## Unable to verify
## Previous findings          (round 2 onward)
   Resolved / Still open / Superseded
```

A sound plan still gets every section — silence is not an acceptable output, per
the *Non-negotiables* above. Where a section is genuinely empty, write "none"
rather than deleting the heading; a missing section should read as an omission,
not as a pass.

### Structured defect pass — GitHub structured review (the `@codex review` transport)

**This surface does not support a freestanding top-level write-up.** Confirmed
against this repo's own review history (PR #252, 20+ rounds): every round's
top-level review body was the connector's fixed boilerplate, never custom text.
The only content surface is a **set of findings, each anchored to a location in
the current diff** — there is no channel for a status label, a lens
declaration, or a ledger that isn't attached to a line. Do not attempt the
skeleton above here; it cannot be posted, and a contract that asks for the
impossible gets silently half-followed instead of visibly refused.

On this surface, every piece of information above six-shape output is carried
**inside individual findings**, not as a separate post:

- **Each finding is its own inline comment**, anchored to the most relevant
  line. For a finding that doesn't map to one line (a missing product
  decision, an omission), anchor it to the most defensible nearby line (e.g.
  the section it should have appeared under) rather than skipping it for lack
  of a perfect anchor.
- **Lead each finding with a category tag — only categories that can stand as
  their own defect-shaped finding on this surface.** That's: Required
  Revision, Recommended Improvement, Product Decision, or Reconciliation
  (**Still Open only** — naming the prior finding it addresses; see the
  clean-round bullet below for why Resolved/Superseded aren't here). Verified
  and Unable to Verify are **not** standalone tags on this surface — they
  don't represent a defect, so nothing here would give the connector to post.
  Fold them into the text of whatever Required Revision or Recommended
  Improvement finding they support ("Unable to verify: needs prod-DB access —
  flagging as Required Revision until the plan states how this gets checked").
  The full six-way taxonomy applies unscoped only on the full-document
  surface, where each is its own section regardless of whether it accompanies
  a defect.
- **The lens is not something you attest to — it's something you're asked to
  apply.** The `@codex review` trigger comment states the lens for that round
  and names the specific prior findings to reconcile (see the
  `plan-review-loop` skill) — review under that stated lens, don't invent your
  own framing for it, and don't re-declare it in a finding (there is no
  surface-specific requirement that you do — the *Re-reviews* section's lens
  obligation is satisfied by the full-document surface only, or by this
  surface's trigger comment, never by you naming it here).
- **A clean round is an empty findings list — confirmed, not merely assumed.**
  Codex has confirmed directly on this PR that the connector exposes only
  schema-validated defect findings: there is no non-blocking, informational, or
  "no-longer-a-problem" category, and no freestanding-comment channel to fall
  back to. Posting a finding for an item that no longer represents a live
  problem would misclassify it as a defect. This rules out a dedicated
  Reconciliation finding for **both** Resolved and Superseded — neither is a
  current defect, so neither is postable, whatever their conceptual
  difference. Only **Still Open** genuinely is a live defect and gets posted
  as a Reconciliation finding, same as any other finding. When a named prior
  finding is Resolved or Superseded, **post nothing about it** — do not
  manufacture a comment to prove you checked. You don't need to distinguish
  Resolved from Superseded here: whoever drives the loop already knows which
  is which from their own fix history and records that distinction in the
  ledger independently — your silence only tells them "not Still Open," it
  isn't the source of that split. An empty result against a trigger that
  named specific items is read as "all Resolved or Superseded" — that reading
  is the accepted ceiling of what *this surface* can prove, not a gap to
  close. Absent a named request, an empty list means only "no new
  objections" — post nothing and let the connector's default (a 👍 reaction)
  stand.
- **You do not compute or post the overall review-status label or the
  round-level ledger on this surface.** Whoever is driving the loop (Claude
  Code) reads your findings after each round and derives the status and
  ledger from them — that is not extra work assigned to you, and duplicating
  it here would go nowhere. If you believe the *overall* status is something
  stronger than any individual finding conveys (e.g., **Strong disagreement on
  direction**), say so explicitly inside one finding's text so it isn't lost
  in translation.

### Both surfaces

Keep it specific and grounded in the repo you actually inspected. If you lack
the repo context to review responsibly, say so and stop rather than reviewing
from the plan text alone. **On the full-document surface**, use the **Repo
context required** label. **On the GitHub surface, missing repo context is not
itself a plan defect** — same limitation as an incomplete pass (see *If you
cannot do all of this in one pass*): there's no finding to hang it on unless
the gap is narrow enough to state as a concrete Required Revision (e.g., "needs
David to confirm X — I lack access to verify it against the repo"). A broad
loss of context has no dedicated channel and falls inside the same accepted
ceiling; don't manufacture a finding just to report it.

## If you cannot do all of this in one pass

This contract asks for more than a context- or time-constrained review may fit.
It is better to do the core completely than all of it thinly. Preserve, in this
order: **role and posture → non-negotiables → the PR-body oracle → the priority
order → the required review checks → external claims → verification reporting
and reconciliation → the status label and output shape.** The failure-pattern
list is the first thing to sample rather than sweep.

**Say when you did this — on the full-document surface, where you have
somewhere to say it.** A review that ran short is useful; a review that ran
short and presents as complete is worse than no review, because the loop
treats it as coverage. Name what you did not get to.

**On the GitHub structured-review surface, this has no dedicated channel
either, for the same confirmed reason as everything else in *Output*: there is
no non-defect finding to post it in.** A short-but-genuinely-clean pass and a
short-and-incomplete pass that happened to find nothing both look identical
from outside — an empty findings list. Don't manufacture a finding to flag
incompleteness; that's the same mistake as manufacturing one to prove
verification. This ambiguity is already inside the accepted evidence ceiling
this surface operates under — it isn't a new gap to close.
