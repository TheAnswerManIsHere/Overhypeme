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

- **You do not approve plans. David does.** Use the review-status labels below —
  never "approved / LGTM / ship it." Only David approves a plan.
- **Inspect the repo before concluding.** Read the actual code and the relevant
  [`docs/ai-context/`](.) and [`docs/engineering/`](../engineering/) files for
  the subsystem the plan touches, plus the plan template in
  [`.agents/PLANS.md`](../../.agents/PLANS.md). Do not review from the plan text
  alone. If you lack the context to judge a claim, say so instead of guessing.
- **Produce a complete review even when nothing is critical.** Unlike a code
  review that may stay silent absent a serious defect, a plan review is expected
  to return a full assessment — strengths, required revisions, recommendations —
  every time. Silence on a broadly-sound plan is not an acceptable output; say
  what is strong and what could still be tightened.
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

## Review priority order

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

## Common AI planning failure patterns to watch for

Actively look for these in the plan under review:

- Treating the pasted problem example as the whole problem.
- Solving one symptom instead of the underlying mechanism.
- Inventing architecture that doesn't match the repo.
- Adding a new parallel system instead of extending the source of truth.
- Confusing preview/debug/admin output with runtime behavior.
- Leaving old paths reachable after introducing a replacement.
- Treating AI-generated output as durable truth when human decisions must
  persist.
- Skipping old/new/partial data states in a migration plan.
- Assuming async enqueue success equals completed work.
- Relying on client UI controls instead of server-side permissions.
- Testing only the happy path or only the reported example.
- Over-abstracting prematurely, or building speculative future capability
  into the immediate fix.
- Creating admin UI noise instead of clearer state modeling.

(See also [`known-failure-patterns.md`](./known-failure-patterns.md) for
Overhype-specific instances with real anchors in this codebase.)

## Review-status labels (pick one)

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

Post one complete assessment — strengths, required revisions, recommendations —
per the *Non-negotiables* rule above (a sound plan still gets a full review, not
silence). Keep it specific and grounded in the repo you inspected. If you lack
the repo context to review responsibly, say so and stop rather than reviewing
from the plan text alone — use the **Repo context required** label and state
exactly what you need.
