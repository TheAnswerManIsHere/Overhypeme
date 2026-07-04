# Agent Working Rules

> How David wants AI agents (Codex, Claude, future agents) to work on
> Overhype.me. The root [`AGENTS.md`](../../AGENTS.md) is the short constitution;
> this is the detail. Claude Code also has a role-specific `CLAUDE.md` — where the
> two overlap they agree; this file is the cross-agent version.

## David's role

David is the **product owner and final approver.** He has strong technical
instincts but does not write code. He verifies work by **testing the product
against the intent agreed *before* the plan** — not by reading diffs. AI agents
are the technical safety net: they plan, implement, review, and test; David
steers product direction and approves plans.

Implication: **product intent is David's to define.** If you're guessing what the
product *should do*, you're guessing wrong by definition — ask.

## Plan-before-implementation rule

For **non-trivial** work, produce a plan and **do not begin implementation until
David explicitly approves it.** "Explicit" means David says so in words; an
ambiguous nudge, a harness "continue" message, or another agent's approval is
**not** David's approval. When unsure whether you've been approved, assume you
have not.

Trivial, well-scoped fixes don't need the full ceremony — but a "bug fix" that is
really a behavior change is feature work and needs a plan + product sign-off.

## What a good plan contains

Use the template in [`../../.agents/PLANS.md`](../../.agents/PLANS.md). A good
plan always includes: the concrete symptom, the **product intent** (and what must
*not* change), the **repo context you actually inspected**, a **source-of-truth
analysis** for every affected concept, migration/backfill impact, runtime + admin
UX behavior, security/permissions/validation, a testing plan that proves the
**general invariant** (not just the reported example), risks, questions for David,
and a concrete definition of done.

## How to ask clarifying questions

- **Ask David** about product behavior, UX, scope, spec ambiguity, and any
  trade-off where a wrong choice could damage the product. He *likes* answering
  trade-off questions — it's how he steers. Give enough context to answer without
  scrolling back.
- **Do not ask David** questions the repo can answer. Naming, file layout, error
  handling, structure, library choice, test approach — decide those yourself and
  put technical questions you resolved into the plan.
- When you hit ambiguity **mid-implementation** that you didn't surface in the
  plan, **stop and ask** — don't best-guess and continue, and don't "flag it in
  the PR later."

## How to handle uncertainty

Where you cannot verify current truth from the repo, **mark it as a question for
David rather than inventing a detail.** Prefer, in order: (1) David's latest
explicit instruction, (2) the current repository implementation, (3) recently
merged/approved plans, (4) older context as background only. When repo reality and
an older note conflict, repo reality wins and the note should be corrected.

## How to use repo context

**Inspect the repo before planning, reviewing, or implementing.** This repo is the
durable source of truth — read the relevant `docs/ai-context/*` files and the
actual code before forming an opinion. Don't rely on another agent's private
memory for product or architecture truth. If product/architecture truth changes as
a result of your work, **update the relevant doc in the same PR.**

## How to use external docs

For external APIs, SDKs, model behavior, pricing, rate limits, or platform claims,
**check current authoritative docs rather than relying on memory** — these change
and memory goes stale. (Claude Code additionally has a `claude-api` skill for
Anthropic-specific questions.)

## How to summarize completed work

After implementing, report: **files changed, what was tested (exact commands +
result), what failed, and what remains risky.** Separate valid repo-command
failures (which may block merge) from invalid-command/environment failures (which
must not). Don't claim "done" until the intended behavior can actually be
exercised in the product.

## How Claude and Codex should interact

- Codex and other AI reviewers are the **independent reviewers**; Claude Code is
  the product engineer. Codex is increasingly expected to **build** features too,
  not just review.
- **Do not rubber-stamp another agent's plan or code.** Review it on its merits.
- Reviewers should use **review-status labels, not approval language** — only
  David approves (see the `overhype-plan-review` skill).
- When a reviewer flags a clear mechanical bug (off-by-one, missing await, dead
  import, lint), fix it. When a reviewer raises a **design/architecture/trade-off**
  question, that's David's call — summarize the position and escalate; don't
  silently rewrite the design on a bot's say-so.
- Keep external-facing chatter (GitHub replies) frugal and specific.
