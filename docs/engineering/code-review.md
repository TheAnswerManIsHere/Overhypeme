# Code Review Guide

> A consistent checklist for reviewing Overhype.me changes (Codex, Claude, or
> human). Priorities match the root [`AGENTS.md`](../../AGENTS.md).
>
> **Status language depends on the delivery surface** (see
> [*Review output format*](#review-output-format)). On the **full assessment**
> surface — a human reviewer, or an agent free to post one document — reviewers
> use **review-status labels, not approval language**. On the **structured
> defect pass** surface (the `@codex review` GitHub transport) reviewers post
> only concrete diff-anchored findings, never a status label and never approval
> language; that surface has no status channel at all. Either way, **only David
> approves.**

## The review oracle: the PR body

A code diff can be internally sound — well-tested, correctly implemented,
sensibly scoped — and still be the wrong PR, because it quietly narrowed or
dropped part of what David actually approved. Reviewing the diff against
itself can't catch that; it needs an oracle outside the diff, same principle
as the [plan-review contract](../ai-context/plan-review-contract.md#the-review-oracle-the-pr-body).

For a PR built from a David-approved plan, the PR body's **Approved-plan
oracle** section (see the
[PR template](../../.github/pull_request_template.md)) carries that plan's
Product Intent / Must Not Change / Settled Decisions verbatim. Check the code
against that, not only against internal consistency: does it implement
everything the intent called for, does it touch anything the plan marked
must-not-change, does it match the settled decisions rather than a plausible
alternative. Flag a dropped or narrowed requirement even if the code itself
never mentions it — the absence is the finding.

**If the plan cites a direction, check the code against that too, not just
the plan's own Product Intent.** A plan built under
[the increment test](../ai-context/working-modes.md#the-increment-test) can
correctly build a narrower increment while its direction still carries
constraints on that increment (a boundary rule, an invariant, a decision
already settled at the direction level) — a PR that satisfies the plan's
stated intent while violating its direction is exactly the "internally sound,
quietly wrong" shape this oracle exists to catch. Missing Direction on a PR
whose plan cited one is itself a finding.

The oracle also carries **Approved-plan source** — the exact final revision
those words came from (plan-review PR + final plan commit sha, or the plan
filename + content hash on the private/manual path), plus the date David
approved it. In a multi-round plan review, an oracle pasted from an earlier
revision is a plausible failure and an invisible one: the PR looks correctly
oracled while the code is checked against a plan David never approved. A
missing source, or one that names only a title or a mutable branch, is itself
a finding — the oracle can't be trusted until it's pinned.

**On the private/manual path, "pinned" is as far as an independent reviewer
can verify — and that's accepted, not a gap to close.** That path exists
specifically because the plan must never be committed anywhere (a
security-sensitive or embargoed plan disclosed by its own review trail would
defeat the purpose of keeping it private), so no reviewer — Codex or human —
has access to the bytes the filename + hash claim to identify, and can't
recompute the hash to check it. A reviewer on this path confirms the field is
*present and specific* (a real filename, a real hash, a real date — not "n/a"
or something vague) and stops there; verifying the hash actually matches the
approved artifact is David's check alone, made when he compares the
implementation PR's oracle text against the file he personally approved. Don't
flag an unresolvable-by-you hash as a finding on this path — that's expected,
not a defect.

### The bugfix oracle (a PR with no plan)

A bug fix has no approved plan, but it is **not** therefore oracle-free. Reviewing
a fix against itself can't catch the characteristic bugfix failure: the diff makes
the reported symptom disappear while breaking an adjacent behavior nobody wrote
down, or patches the reported instance while the underlying class survives. Both
are documented failure patterns here (*One-example bug fixes*, *Uniform default
over a falsely-ambiguous space*).

So a bugfix PR carries its own oracle in the same body section — see
[`working-modes.md`](../ai-context/working-modes.md#the-bugfix-oracle-what-the-pr-body-must-carry).
**This field list is for a Tier A/B PR**: **Fix tier**, **Reported symptom**
(David's words, verbatim), **Intended correct behavior**, **Must not change**,
**Root cause**, **Blast radius**. A Tier C PR (the trivial-schema-fix exception
below) uses a **different**, dedicated oracle block — symptom, root cause, why
it's trivial, David's go-ahead, the migration-ceremony checklist — with no
*Intended correct behavior*, *Must not change*, or *Blast radius* fields; don't
flag a correctly filled Tier C block as incomplete for lacking Tier A/B fields
it was never meant to carry. Review the diff against whichever block applies,
and specifically ask:

- **Is this the root cause or a symptom-level patch?** Does the fix address the
  stated mechanism, or only the reported instance? If the root-cause line
  describes a general mechanism but the diff special-cases one input, that gap is
  the finding. (Both blocks carry Root cause — this applies to either.)
- **Tier A/B only — did it miss a caller?** Check the blast-radius claim
  against the code. An incomplete or absent blast-radius note on a fix to
  shared code is itself a finding. The Tier C block has no *Blast radius*
  field — don't flag its absence there.
- **Tier A/B only — did it break a neighbor?** Anything under *Must not
  change* that the diff touches, directly or through a shared path. The Tier
  C block has no *Must not change* field — don't flag its absence there. For
  Tier C, check instead that the **migration-ceremony checklist** field is
  actually filled with real specifics (idempotency, observable counts,
  human-edited-row preservation, rollback for destructive ops — see
  [`migrations-and-backfills.md`](./migrations-and-backfills.md)), not a
  placeholder.
- **Does the regression test prove the invariant?** A test that only asserts the
  reported input passes leaves the class open — negative cases required. (Tier
  C has no separate regression-test field, but the fix's own tests still apply
  this standard.)
- **Is the tier right? Check Tier C first, then A vs. B.** The most
  consequential mis-tier is a PR labeled A or B that is actually **Tier C** —
  **any** of: a behavior/product change; any *database* schema, migration, or
  backfill work (not the generated `lib/api-zod` Zod schemas, which are Q1's
  own Tier B trigger); a design flaw rather than a defect; needing a new
  abstraction; or needing an external vendor (see
  [`working-modes.md`](../ai-context/working-modes.md#tier-c--this-is-not-a-bug-fix-leave-bugfix-mode))
  — because that PR shouldn't be in bugfix mode's fast path at all,
  regardless of which of those five it trips. Flag that first. **A
  behavior/product change is unconditionally a full-plan finding —
  there is no trivial exception for it, ever**; a bugfix PR can't carry
  approval for a behavior change it has no plan for, full stop. The trivial
  exception is narrower than "Tier C" and applies **only** to a
  schema/migration/backfill fix, per `working-modes.md`'s Tier C section: a
  **non-trivial** one needs a full plan and David's approval before it ran,
  which a bugfix PR obviously can't have; a genuinely **trivial** one is
  allowed to have run migration ceremony directly with David's go-ahead
  instead, and that's not a finding. So on a Tier C PR: a behavior change is
  always a finding; a schema/migration/backfill change is a finding only if
  it's non-trivial. Only once Tier C is ruled out does the A-vs-B question
  apply: a fix tagged Tier A that trips a Tier B trigger is
  under-verified — flag the mis-tier, not just its consequences. Check
  **both** halves of the A/B checklist in
  [`working-modes.md`](../ai-context/working-modes.md#the-tier-is-chosen-after-diagnosis-never-at-intake):
  the **subsystem** the fix lands in (payments/auth, tokenizer/grammar, the
  visual pipeline, the async queue, enrichment/moderation, `lib/api-zod`,
  dev-infra) as much as the fix's **shape** (shared code, a changed
  predicate/default, concurrency or async state, persisted data, a
  generalized fix, a shaky diagnosis, a previously untested path) — a leaf
  edit in a Tier B subsystem is Tier B even if none of the shape triggers
  fire.

Only a genuinely trivial change with no plan and no bug behind it (a typo, a
comment) reads "n/a — no plan"; there, review the diff on its own terms as usual.

## Review priorities (in order)

1. Runtime correctness
2. Durable data & source-of-truth boundaries
3. Repository fit
4. Migration & backfill safety
5. Security, validation, permissions, auditability
6. Admin/user UX clarity
7. Tests & regression protection
8. Simplicity & scope control
9. Observability & debuggability

Weight findings by this order — a correctness or source-of-truth issue outranks a
style nit.

### Documentation-only PRs get a light review (David, 2026-08-08)

When a PR changes only documentation — UAT docs, `docs/ai-context/`,
`docs/engineering/`, skills, READMEs, the manual — the review bar drops to:
**is it generally correct, with no glaring issues?** A glaring issue means an
instruction that would lead someone to do something harmful or wrong, a claim
that contradicts how the product or code actually behaves, or a
safety-relevant error. That's the whole list.

Explicitly **not** findings on a docs-only PR, even when technically true:

- Grammar, phrasing, tone, formatting, and style.
- Minor numeric or count discrepancies ("the doc says ~25 lines, the file has
  24") and similar precision drift that misleads no one.
- Completeness beyond the doc's stated purpose — a checklist or guide does
  not need to enumerate every edge case to be good enough.

Docs are self-catching and fixed in one commit; pedantic findings on them
cost more than the defects they describe. This is the *depth* rule; the
*continuation* rule for the same artifacts is consequence-based — a round
earns a successor only if it surfaced behavior-changing defects (this
file's "glaring issue" class), the re-request names the specific fixes it
verifies, out-of-diff findings route to follow-up issues by default, and a
third round fires the adversarial adjudication tripwire — defined in
[`working-modes.md`](../ai-context/working-modes.md#docs-only-loops-continue-on-consequence-not-count-david-2026-08-15-superseding-the-2026-08-14-one-re-request-cap)
(David, 2026-08-15, superseding the brief 2026-08-14 hard cap; PR #434's
eight polish rounds and PR #449's behavior-changing second pass are the
two calibration cases). The author's review request on a docs-only PR
states this bar explicitly ("docs-only — light review per
code-review.md"), so the reviewer calibrates from the request itself, not
just from this file.

**Loop-ledger records get the same light bar, split by which half of the
record a finding touches (David, 2026-08-11).** A `.agents/metrics/loops/
<pr>.json` record has a mechanical half (`derive()`'s numbers) and a
judgment half (hand-typed causes and prose explaining them — see
`working-modes.md`'s *The loop ledger*). Only flag: **(a)** a mechanical
value that's actually wrong — a causal count that doesn't sum to
`findings`, a date/PR number/schema violation, anything `check-loop-metrics
.mjs` would itself reject; or **(b)** a judgment claim that's factually
wrong about what happened in the loop (e.g. claiming a finding was fixed
when the diff shows it wasn't). **Not** a finding: a defensible read of an
ambiguous rubric provision, or imprecise *phrasing* in the prose that
explains a causal label which is itself correct — three review rounds on
PR #406 were exactly this shape (the counts were right every round; only
the wording justifying them kept getting relitigated), which is the
concrete cost this carve-out exists to stop paying twice.

**This bar, and the one-pass cap in `working-modes.md`'s ceremony table,
apply only to findings on the ledger JSON file itself.** A ledger record
routinely rides a carrier PR alongside unrelated product-code changes (it
"rides any *mergeable* PR of mine except the one it measures — never a
`[PLAN REVIEW]` PR" — see `working-modes.md`'s
*The loop ledger*); those changes are reviewed to convergence as normal
product code, exactly as if the ledger file weren't in the diff. The
author's review request on a loop-ledger PR states this bar explicitly, and
scopes it to the ledger file by name, so the reviewer never has to infer
which files it covers ("ledger record — light review per code-review.md,
mechanical-or-factual findings only, on `.agents/metrics/loops/<pr>.json`;
other files in this PR get the normal review bar for their class"),
matching the docs-only convention above.

## Runtime correctness

- Does it do what the plan/intent says, including edge cases?
- Async: is a job's **terminal** state used, not enqueue-as-done?
- Visual/enrichment: does runtime match the admin preview path?
- When concurrent changes are possible, are validation and mutation tied to the
  **same authoritative state** — through a transaction, version check,
  conditional write, or equivalent stale-state guard? Checking one version of
  state and then mutating a later one is the general shape behind TOCTOU
  approval races, async results applied to input that has since changed,
  stale admin actions, and unconditional writes after out-of-transaction
  validation.

## Source-of-truth & data durability

- Is there a **single** source of truth for each concept, or did this add a
  competing one? (See
  [`../ai-context/known-failure-patterns.md`](../ai-context/known-failure-patterns.md).)
- Are **human overrides preserved** across AI reprocessing?
- Is `facts.*` still the sole active enrichment truth (versions table = archive)?

## Repository fit

- Does it follow existing patterns (generated API hooks on the frontend, Drizzle
  schema conventions, the async job queue, the engines catalogue)?
- Does it reuse the right shared module rather than reimplementing (e.g.
  `resolveEnrichment`, `render-fact`, `compileForSubjectRenderMode`,
  `useTaxonomyHealthActions`)?

## Security & validation

- Every permission enforced **server-side** (`requireAdmin`/`requireRole`), not just
  in the client?
- Zod validation on inputs; no trust of client-sent roles/flags?
- Auditability: are moderation decisions/overrides recorded, not silently mutated?

## Migration / backfill safety

- Idempotent, hand-authored SQL (generator caveat)? Counts/failed/skipped
  observable? Human-edited rows preserved? Destructive ops have rollback? See
  [`migrations-and-backfills.md`](./migrations-and-backfills.md).

## Admin / user UX

- Async surfaces show **per-item + aggregate** status, with empty/loading/running/
  failed/partial/skipped/complete/no-op distinguished — no single global spinner,
  no UI timeout on long jobs?
- **Ship the surface with the behavior** — no dead UI, no invisible backend?

## Tests

- Do tests prove the **general invariant**, not just the reported example, with
  negative cases? Run via the repo runners (never raw `node --test`)?
- Regression fixtures added for the bug class?
- If this fixes a **recurring** pattern (a second occurrence of something
  already in [`known-failure-patterns.md`](../ai-context/known-failure-patterns.md)),
  did the fix add a deterministic CI guard
  (`.github/workflows/build.yml`) rather than just a one-off correction or a
  stronger doc warning? A doc reminder didn't stop the `api-zod` codegen-revert
  mistake from recurring once already; a mechanical check can't be skipped by
  not reading the doc. See
  [`decisions.md`](../ai-context/decisions.md) → "Recurring failure patterns
  become CI guards."

### A source guard bounds a *shape*, and shapes have more forms than they look

The CI-guard rule above is right, but a source guard has a specific failure
mode worth pricing in when reviewing one. It matches **syntax**, while the
defect is **semantics**, and the set of syntactic forms with the same meaning
is usually larger than the author enumerated.

Worked example, PR #474's `check-budget-gate-unconditional.mjs` — a guard
against a spend check being made conditional. Three consecutive review rounds
each found one more reachable form the current version missed: a regex over
`if (<identifier>)` missed `if (priced !== null)`; the AST rewrite that fixed
that treated an entire `if` condition as unconditional and so missed
`if (priced && await checkBudget(…))`; and the fix for *that* inspected only
the then-branch, missing `if (priced) {…} else return;`. Each fix was correct
and each left a cheaper equivalent reachable.

What to take from it, as a reviewer or an author:

- **Probe, don't reason.** Every one of those was found by writing the form
  into a throwaway source file and running the guard — never by reading it.
  A guard's own correctness claim is worth exactly the probes behind it, so ask
  which forms were actually executed against it.
- **Prefer a real test when the behavior is testable.** The same PR's
  admin-exemption regression was ordinary unit-testable behavior and got three
  tests pinning it, verified to fail against the old code. A source guard is
  the right instrument only when the invariant is inline control flow that no
  unit test can reach — not merely when writing one is inconvenient.
- **Expect to cap it, and document the residual.** At some point another
  missed shape is evidence the space cannot be closed syntactically, not a
  to-do. Record the known limits in the guard's own header, and be explicit
  that it is a backstop rather than the control — silence from it is not proof
  of safety.
- **Watch the cost.** That guard was belt-and-braces on an otherwise ~10-line
  fix and generated three of the loop's eight findings. Worth it here, on a
  money path; not worth it by default.

## Observability

- Failures reported (Sentry where appropriate)? Bulk operations expose what
  happened? Enough logging to debug a bad render/enrichment/job?

## Scope control

- Smallest coherent change for the approved plan? No speculative abstraction, no
  new external vendor, no scope creep beyond intent?

## Re-reviews (round 2 onward)

A code review is a loop too: you review, the author pushes fixes, you review
again. The plan-review contract's
[*Re-reviews*](../ai-context/plan-review-contract.md#re-reviews-round-2-onward)
section is the plan-side analog of this one; these are the code-side
invariants, and they are the engineering standard regardless of which agent is
reviewing:

1. **Re-inspect the current code.** An author's reply, explanation, or claimed
   fix is not evidence that the defect is gone. Read what the branch actually
   does now.
2. **Reconcile every specifically named prior finding** against the current
   branch. A finding is closed only when the engineering defect is absent — not
   because the thread received a response, and not because a commit message
   says it was fixed.
3. **Inspect related callers, invariants, and tests the fix could affect.** A
   local correction can introduce a regression outside the edited line.
4. **A regression introduced by the fix is a new finding**, weighted by the
   priority order above like any other.
5. **After more than one fix round, review the cumulative branch diff against
   the base branch**, not only the latest incremental commits. A fix in one
   file can break something that was part of the original diff and isn't
   re-shown in the newest commits — the diff is not the scope.
6. **A clean re-review is an empty findings list** on the structured defect
   pass surface (see below). Don't manufacture a finding to prove the round
   ran.

### The author's declines are where their error rate concentrates

Observed across seven rounds on PR #498 (20 findings, all confirmed, none
declined *as findings*): the author's error rate was not uniform across the
diff. It concentrated in the replies that said **"confirmed, but I resolved it
differently, and here is why."**

Both round-1 substitutions in that PR were incomplete, and one rested on a
factual premise the author had never checked — an objection about process
restarts that turned out to be irrelevant, because the job state it worried
about did not survive a restart either. The recommendation being declined was
correct; the reasoning for declining it was not.

**Two consequences, one for each side of the loop.**

*As the reviewer:* when the author accepts a finding but substitutes their own
remedy, re-review the substitution at least as hard as you reviewed the
original defect — it is newly written, un-reviewed code justified by an
argument you have not checked. "Agreed, fixed differently" is not convergence.

*As the author:* a decline is the one reply where you are reasoning rather than
reporting, so state the premise it rests on explicitly, and **verify that
premise before posting** rather than after. If the premise is about how the
code behaves, read the code; if it is about what a construct does, run a
three-line probe. The cheapest tell that a decline is unsafe is that its
justification contains a claim you have not executed.

Who posts the re-review trigger, which findings it names, who replies on which
thread, and the git mechanics around all of it are the implementing agent's
ceremony — for Claude Code, `CLAUDE.md`'s *Watching the PRs I open*. This
section defines only the reviewer's substantive standard.

## Codex has two usage limits — a security-review bounce is NOT a code-review outage

**The fact (David, 2026-08-15), canonical here because it binds every agent
watching a PR, not just the one that hit it:**

The Codex connector meters **two independent things**:

| Limit | Capacity | What bouncing it means |
|---|---|---|
| **Security reviews** | Limited, and the one that actually bounces | Only that security reviews are unavailable |
| **General code reviews** | Effectively unlimited for this repo | — |

The connector's comment names its own scope:

> You have reached your Codex usage limits **for security reviews**. Please try again later.

**So the rule is: ignore that comment and request the code review.** Post
`@codex review` as normal. A security-limit bounce is never a reason to skip a
code review, defer one, treat a round as converged, or merge past it.

**Evidence, because this was previously written up from a bad inference.** On
PR #458 the security bounce landed at 22:42 and a **full code review with 8
findings arrived at 22:48**, with a second round of 7 at 22:59 — code review
was working the entire time the bounce was on screen. On PR #459 the identical
bounce produced no review at all, not because Codex was unavailable but
because the misreading meant nobody asked. The earlier PR #371 observation
(bounces while David's visible weekly quota showed ~98% remaining) fits the
same picture: that quota is the code-review pool, which stayed full while the
*security* limit bounced.

**A genuine code-review outage is a different animal** — a request that yields
**no code review**. Judge that on the absence of the code review alone: the
two limits are independent, so a security bounce can fire *during* a real
code-review outage, and testing for "no review **and** no bounce" would let
that unrelated comment mask the outage indefinitely. That case still exists,
and since 2026-08-17 it is a **development stop**, not a stakes-graded
proceed: **every PR gets a code review, and nothing merges until it returns.**
A PR's criticality governs how many rounds are worth requesting; it never
governs whether the first one has to come back. So an agent that cannot get a
code review stops and says so loudly to David rather than proceeding on a
docs-only or low-criticality exemption — that exemption is retired. The retry
limit in the implementing agent's ceremony (for Claude Code,
`.claude/skills/pr-watch/SKILL.md`) governs how many times to re-ask before
escalating. A security-limit bounce does not qualify as an outage, and must
not be reported as one.

**The failure mode this exists to prevent is a reading error, not a tooling
gap** — the prior rule quoted the "for security reviews" wording verbatim and
still concluded the review was unavailable. See
[`known-failure-patterns.md`](../ai-context/known-failure-patterns.md)'s
*Reading a scoped limit message as a blanket outage*.

## Review output format

**Two delivery surfaces exist; they don't support the same shape** — same split
as the [plan-review contract's *Output*](../ai-context/plan-review-contract.md#output),
adapted for a code diff instead of a markdown plan. Names for the two, used
throughout this doc: a **full assessment** (one complete document, with a
status label) and a **structured defect pass** (diff-anchored findings only, no
status label). Naming them is terminology, not permission to weaken either —
the expectations on each surface are unchanged.

### Full assessment — full-document delivery (a human reviewer, or an agent free to post one document)

Produce concise, prioritized feedback. Label overall status (no approval
language) — e.g. *No major technical disagreement · Directionally good, revisions
needed · Substantive technical concerns · Strong disagreement on direction · Human
clarification required · Repo context required.* For each finding: what, why (tied
to a priority above), and a concrete suggestion. Separate **must-fix** from
**nice-to-have**. Escalate design/architecture/trade-off calls to David rather than
deciding them.

### Structured defect pass — GitHub structured review (the `@codex review` transport)

Same confirmed limitation as the plan-review contract: this surface has no
freestanding top-level write-up, only diff-anchored inline findings, and no
status-label or ledger channel. Don't ask this surface for the full-document
shape above — it can't post it. Each finding is its own inline comment,
anchored to the relevant line (or, for an oracle-driven finding with no single
line — a dropped requirement, a touched must-not-change area — the most
defensible nearby line). A clean round is an empty findings list; on a diff
this is stronger evidence than on a plan (compiling, passing tests, and CI back
it up), so — unlike the plan contract — silence here is a real, sufficient
result, not a transport limitation to work around.

(The `overhype-plan-review` skill defines the full plan-review format; this
section is the code-review analog.)
