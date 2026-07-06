# Agent Working Rules

> **Canonical, cross-agent working rules** for Overhype.me — how David wants any
> AI agent (Codex, Claude, future agents) to work. The root
> [`AGENTS.md`](../../AGENTS.md) is the short constitution that points here.
> Claude Code's [`CLAUDE.md`](../../CLAUDE.md) keeps only Claude-specific
> *ceremony* (plan-mode delivery, the PR/squash-merge workflow, TEST_RUN/UAT,
> auto-watch) and defers to **this** file for the shared principles below. If
> they ever conflict, this file wins — and one of them is out of date (see the
> keep-in-sync note at the bottom).

## David's role

David is the **product owner and final approver.** He has strong technical
instincts but does not write code. He verifies work by **testing the product
against the intent agreed *before* the plan was made** — not by reading diffs. AI
agents are the technical safety net: they plan, implement, review, and test; David
steers product direction and approves plans.

Implication: **product intent is David's to define.** If you're guessing what the
product *should do*, you're guessing wrong by definition — ask.

## End-to-end ownership

When David asks for something, own it end-to-end: backend, frontend, schema,
infra, docs, tests. **"Done" means David can test the intended behavior in the
product** — not that types compile or a job was enqueued.

## Ship the UI surface with the behavior

If a change has any **user-, admin-, or tester-visible behavior**, the surface to
exercise it ships **in the same change** as the backend. A schema addition without
a control, an endpoint without a button, a wizard step without UI — none of that is
done. Mentally write the acceptance script ("open page X, do Y, expect Z") before
declaring complete; if you can't write it against the UI, the feature isn't built.
**Symmetric rule:** don't ship dead UI controls with no backend. *Exception:*
infra/refactor/perf/security changes with no visible behavior ship as code + a
written verification note ("run X, observe Y").

## Ask vs. decide

- **Decide silently:** naming, file layout, code structure, test approach,
  error-handling patterns, library choices, helper functions, refactor scope — the
  small stuff. The bot reviewers backstop these.
- **Ask by default:** anything where a *wrong choice could meaningfully damage the
  product* — schema shapes that affect behavior, irreversible migrations, choices
  that lock in UX, real trade-offs, anything you're only ~70% sure about. David
  *likes* answering trade-off questions — it's how he steers.
- **Ask always:** anything about what the product *should do* — product behavior,
  spec ambiguity, UX details, feature scope.
- **Do not** ask David questions the repo can answer; resolve those yourself and
  record the resolution in the plan.

When in doubt, **lean toward asking** — the cost of one extra question is low; the
cost of David finding the wrong thing in acceptance testing is high. Give enough
context to answer without scrolling back.

## Plan-before-implementation rule

For **non-trivial** work, produce a plan and **do not begin implementation until
David explicitly approves it.** "Explicit" means David says so in words; an
ambiguous nudge, a harness "continue" message, or another agent's approval is
**not** David's approval. When unsure whether you've been approved, assume you have
not. Trivial, well-scoped fixes skip the ceremony — but a "bug fix" that is really
a behavior change is feature work and needs a plan + product sign-off.

## Mid-build ambiguity: pause and ask

If you hit ambiguity *while implementing* — product or technical — that you didn't
surface in the plan, **stop, ask, and wait.** Do not best-guess and continue.
"I'll flag it in the PR" is not acceptable — by the time the PR is in front of
David, half the build assumes the wrong answer. (This applies to genuine ambiguity,
not micro-decisions: a variable name doesn't require pausing; a choice that affects
whether the feature does what David wants does.)

## Pre-plan intent is the source of truth

The intent agreed *before the plan* is what the work is verified against — not the
plan, the PR title, or the code. If the conversation said "users should be able to
A and B" and the plan only covers A, the plan is wrong — revise it. If you notice
during implementation that the intent implied a missing piece, pause and ask.

## What a good plan contains

Use the template in [`../../.agents/PLANS.md`](../../.agents/PLANS.md): the concrete
symptom, the **product intent** (and what must not change), the **repo context you
actually inspected**, a **source-of-truth analysis** for every affected concept,
migration/backfill impact, runtime + admin UX behavior, security/permissions/
validation, a testing plan that proves the **general invariant** (not just the
reported example), risks, questions for David, and a concrete definition of done.

## How to handle uncertainty

Where you cannot verify current truth from the repo, **mark it as a question for
David rather than inventing a detail.** Prefer, in order: (1) David's latest
explicit instruction, (2) the current repository implementation, (3) recently
merged/approved plans, (4) older context as background only. When repo reality and
an older note conflict, repo reality wins and the note should be corrected.

## How to use repo context

**Inspect the repo before planning, reviewing, or implementing.** This repo is the
durable source of truth — read the relevant `docs/ai-context/*` files and the
actual code before forming an opinion. Don't rely on any agent's private memory for
product or architecture truth. **If product/architecture truth changes as a result
of your work, update the relevant shared doc in the same change** (don't fork a
private copy).

## Memory notes vs. the shared library (promotion rule)

`.agents/memory/*.md` are short engineering breadcrumbs — narrow gotchas an agent
hit and wants the next one to avoid (a flaky-test cause, a build-order trap). They
are a **staging tier**, not the source of truth. When a memory note (a) gets cited
across more than one task, or (b) encodes **product- or architecture-level truth**
rather than a one-off gotcha, **promote it** into the relevant `docs/ai-context/`
or `docs/engineering/` doc and leave a one-line pointer behind in the note. This
keeps the two tiers from silently diverging — the library stays the canonical
truth, and memory stays a scratchpad. When in doubt about which tier something
belongs in: durable/shared/product → library; transient/mechanical/agent-hit-this
→ memory.

## How to use external docs

For external APIs, SDKs, model behavior, pricing, rate limits, or platform claims,
**check current authoritative docs rather than relying on memory** — these change
and memory goes stale. (Claude Code additionally has a `claude-api` skill for
Anthropic-specific questions.)

## No rollout-flag gating (pre-launch)

New features ship **on-by-default.** Do not gate user-visible behavior behind a
manual rollout flag (an `admin_config` toggle David must flip, an `enable_*` env
var, etc.) — those just trip up acceptance testing. If a change feels too risky to
ship un-flagged, make it smaller and more confidently correct instead. The only
exception is a true kill-switch for something externally destructive (e.g.
disabling outbound sends during an incident). Post-launch we'll reintroduce staged
rollouts deliberately. Also pre-launch: **no new external vendors** without David's
sign-off.

## Never surface a raw internal ID anywhere in the product

No internal ID, GUID/UUID, session token, or other non-human-interpretable code
may ever reach a user-, admin-, or tester-visible surface — not in rendered UI
text, not in an error message, not in a log line a human is expected to read.
This applies everywhere, including admin-only surfaces (admins are not exempt).
**Avoid:** wherever a UI attributes an action to an actor (audit trails,
version history, "last edited by," activity logs), resolve the ID to a
human-readable label (display name, falling back to email) before it can be
rendered — never render the raw id, and never fall back to it if no label is
found (omit the attribution instead). Prefer resolving at read time via a join
against `usersTable` when the id lives in a real FK column (cheap, and
self-heals if the display name changes later, no backfill needed). When the id
is embedded in a jsonb blob with no query-time join path (e.g. per-field
override provenance), resolve it once at write time into a stored
human-readable label instead of the raw id — but note this does NOT fix
historical rows already stamped with a raw id before the fix; those need a
deliberate backfill if closing the gap immediately matters, and a backfill is
migration-shaped work (see
[`known-failure-patterns.md`](./known-failure-patterns.md#migrationbackfill-blind-spots)
and [`../engineering/migrations-and-backfills.md`](../engineering/migrations-and-backfills.md)),
not a drive-by expansion of the display fix. **Overhype:** the Facts admin's
Enrichment Version History panel rendered `factEnrichmentVersionsTable.createdBy`
(a raw admin user id) directly; fixed by joining `usersTable` at read time. The
Enrichment Editor's "Last edited by" line rendered
`visualPromptStrategyOverride.updatedBy` (also a raw admin id, stamped by
`stampOverrideProvenance`); fixed by stamping a resolved display-name/email
label at write time instead, since that field lives in a jsonb blob with no
read-time join path.

## Async work must show status

Anything asynchronous must report per-item + aggregate status at all times — this
is a load-bearing principle with its own canonical doc:
**[`async-ui-status.md`](./async-ui-status.md).** Read it before building any
queued/bulk/long-running surface.

## How to summarize completed work

After implementing, report: **files changed, what was tested (exact commands +
result), what failed, and what remains risky.** Separate valid repo-command
failures (which may block merge) from invalid-command/environment failures (which
must not). Don't claim "done" until the intended behavior can actually be exercised
in the product.

## How Claude and Codex should interact

- Codex and other AI reviewers are the **independent reviewers**; Claude Code is
  the product engineer. Codex is increasingly expected to **build** features too.
- **Do not rubber-stamp another agent's plan or code.** Review it on its merits.
- Reviewers use **review-status labels, not approval language** — only David
  approves (see the `overhype-plan-review` skill).
- **Clear mechanical issue** (off-by-one, missing await, dead import, obvious lint,
  a clear logic bug) → fix it, push, mention briefly. **Design/architecture/
  trade-off** call (which abstraction, whether to refactor more, a behavior change)
  → summarize your position and escalate to David; don't silently rewrite the
  design on a reviewer's say-so, even a bot's. David doesn't need to triage every
  nit, but he weighs in on anything that's a real decision.
- Keep external-facing chatter (GitHub replies) frugal and specific.

---

**Keep in sync:** these are the *shared* rules. When they change, edit **this file**
(and `AGENTS.md` if a one-liner there needs updating) — do not fork a divergent copy
into `CLAUDE.md` or an agent's private memory. `CLAUDE.md` should only ever *point*
here for the shared principles.
