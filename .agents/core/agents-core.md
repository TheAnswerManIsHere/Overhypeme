<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->
# Agent instructions — portable core (all agents)

<!--
  SYNCED FILE — do not edit in a consumer repo.

  This file is the fleet-wide, cross-agent half of the routing constitution.
  It is maintained in the AI-Handbook repo and vendored into every consumer
  repo by the handbook sync. An edit made here in a consumer repo is
  overwritten by the next sync; change the handbook instead.

  Unlike CLAUDE.md, AGENTS.md does not support eager file imports, so a
  consumer's AGENTS.md LINKS here rather than importing. That matches how
  AGENTS.md already works — it is a routing file whose job is to send an
  agent to the right document — but it means this file must be readable
  standalone, by an agent that arrived from a link with no other context.
  Write it that way.

  What belongs here: the cross-agent working agreement, planning and
  implementation standards, technical priorities, engineering principles.
  What belongs in the consumer's AGENTS.md: the product's context-reading
  routes, its subsystem map, and its setup/verification/CI commands.
-->

> **Who this is for.** Every AI agent working in a repo governed by the
> AI-Handbook — Codex, Claude Code, Replit, and whatever comes next. It tells
> you **how to behave and what is non-negotiable**, independent of which
> product you are working on. The repo's own `AGENTS.md` carries the product
> half: what this product is, where its truth lives, and how to build and
> test it. Read both.

> **One source of truth for all agents.** These rules are shared. Claude
> Code's `CLAUDE.md` holds only Claude-specific ceremony and defers here for
> every cross-agent principle. When a shared rule changes, it changes in the
> handbook — never as a forked copy in one agent's own file or private
> memory.

## Working agreement with David

David is the product owner. **Do not implement major changes from a non-trivial
plan until David has explicitly approved that plan.** An ambiguous nudge or another
agent's approval is not David's approval. Full working rules:
[`docs/ai-context/agent-working-rules.md`](../../docs/ai-context/agent-working-rules.md).

**Two working modes — the ceremony in force is always visible, never silent.**
Default is **feature mode** (plan → approval → full build → PR). **Bugfix
mode** is a lightweight fix-and-commit path. For Codex, David turns it on by
saying so (e.g. a prompt starting **"Bugfix mode:"**); absent an explicit
signal you are in feature mode. (Claude routes by request shape with an
announced, vetoable classification — see the mode-entry section of
working-modes.md.) Read
[`docs/ai-context/working-modes.md`](../../docs/ai-context/working-modes.md) for the full
contract of each and how to switch between them.

**End-of-feature documentation.** Follow
[`docs/ai-context/documentation-workflow.md`](../../docs/ai-context/documentation-workflow.md).
**The per-merge close-out judgement is retired (David, 2026-08-20)** — the
heavyweight harvest now runs **batched at `/maintenance`**, covering every
product feature merged since the last pass, or whenever David asks. What
close-out owes instead is cheap and unconditional: a **harvest-notes comment
on the feature's workstream issue** — decisions and why, alternatives
rejected, gotcha candidates — so the batched pass inherits the session's
context. Process PRs get no harvest. This is distinct from a one-off
"remember this" (immediate targeted persistence), which never waits for a
batch.

**Workstream tracking.** Every unit of work — feature, bugfix, doc harvest —
has a GitHub issue as its spine, tracked on a private Project board and kept
current via `stage:`/`waiting:`/`mode:` labels — with **two** exceptions.
*Sensitive/disclosure-carve-out work* never becomes a public issue and is a
private draft Project item instead. *David's Replit fast-lane tweaks* —
display-only UI changes he makes himself during UAT — carry no issue at all:
the retrospective sweep is their accountability rather than the Project board,
so no agent should demand one for a fast-lane commit retroactively (boundary
and sweep:
[`docs/ai-context/replit-environment.md`](../../docs/ai-context/replit-environment.md)).
What that sweep *finds* is ordinary work and gets an issue like anything
else. Read
[`docs/ai-context/workstream-tracking.md`](../../docs/ai-context/workstream-tracking.md)
before opening or reviewing a PR — it covers the label conventions and what
must never happen (e.g. `Closes #N` in a PR body, which would skip UAT).

When asked to **plan**:
1. Inspect the repo first.
2. Identify source-of-truth boundaries.
3. Call out product ambiguities (ask David; don't guess intent).
4. Propose a phased plan.
5. Include tests and migration/backfill handling where relevant.

When asked to **implement** (an approved plan):
1. Re-read the approved plan + relevant `docs/ai-context/` files.
2. Confirm the affected files.
3. Make the smallest coherent change.
4. Run relevant tests.
5. Summarize what changed, what was tested, and what remains risky.

## Technical priorities

Prefer, in order:
1. Runtime correctness.
2. Durable data and source-of-truth boundaries.
3. Repository fit.
4. Migration and backfill safety.
5. Security, validation, permissions, and auditability.
6. Admin UX clarity.
7. Tests and regression protection.
8. Simplicity and scope control.
9. Observability and debuggability.

## Important product principles

- **Human-moderated decisions must not be silently overwritten by AI reprocessing.**
- **Runtime behavior must match admin preview and debug surfaces.**
- **Avoid duplicate sources of truth.**
- **Do not patch only the latest example — solve the general mechanism.**
- **A check earns its place only when the value can differ from what you
  intended — which requires something outside your control to have produced
  it.** A harness report, a network response, a real user, another program's
  output: observe those and refuse on disagreement. Everything a hand-run
  script gets from its own operator's argv falls into one of two kinds, and
  the rule differs:
  - **Derivable** — the script already holds every input needed to compute
    it (a receipt path from role and head). **Derive it; do not take it as
    input at all.** A check whose two sides you both own carries no
    independent information — it fails only when the code between them is
    wrong, and that code is exactly as likely to be wrong as the check
    (AI-Handbook #73: four review rounds on one flag, then the flag was
    deleted).
  - **A choice** — it encodes intent the script cannot know (`--role`,
    `--timeout`, `sync --to <repo>`). Take it. A cheap check that it is
    well-formed — non-empty, numeric where a number is expected, a path that
    exists — is catching the operator's own mistake, which is exactly the
    threat model, and stays. A defence against a *hostile* value of it — a
    planted symlink, a traversal, a hard link the operator would have to
    create on purpose — is not, and the response to such a finding is to
    decline it, not to guard (AI-Handbook #7: eleven findings and no added
    safety).
  **Ask who produced the value, never which directory the file sits in.** A
  script that parses a hook payload, a fetched document, a webhook body or
  another program's output is reading something it does not control, however
  local it looks — and where that script exists to *constrain* the producer,
  its input is adversarial by construction and validating it is the entire
  job. Getting this backwards disarms exactly the code that matters most.
  **And a consequence nobody would feel is not a consequence** (David,
  2026-09-11). Two classes follow, and findings in them are declined rather
  than fixed: **accounting precision**, where a miscount changes no decision
  — how many review rounds a loop ran is a gut-level trend, not an audit
  history, so machinery making such a count exact is pure cost; and **an
  agent's influence over its own tooling**, where the agent that runs a
  script is the only actor who could subvert its inputs and could equally
  just not run it. The controls against deliberate action are the
  server-side ruleset and the human working alongside, who reads the one
  line every authority-widening PR carries naming what latitude it grants
  (2026-09-14, when the human-merge gate was retired). Neither class is
  fixed because the diff would be small: each fix costs a review round, and the aggregate is never
  weighed at the moment one is chosen.
- **Prefer database-backed config for tunable operational settings.**
- **Migrations must be idempotent and observable.**
- **Async work must show status** at two altitudes (per-item + aggregate) — see
  [`docs/ai-context/async-ui-status.md`](../../docs/ai-context/async-ui-status.md).
- **Ship the surface with the behavior** (no dead UI, no invisible backend), and
  **enforce every permission server-side.**
- Pre-launch: features ship **on-by-default, no rollout flags**; **no new external
  vendors** without David's sign-off.

## Planning standard

For non-trivial implementation work, create or update a plan using
[`.agents/PLANS.md`](../PLANS.md). **Do not begin implementation until David
approves the plan.**

**Planning (not code review).** A planning loop does not run on a pull request
(2026-09-09), and since 2026-09-18 it is not a review: two parties develop the
plan together, one of them holding it. The plan reaches you as a **file in the
checkout you are running in**, named in the instructions you are given, with the
agreed oracle alongside.

[`planning-contract.md`](../../docs/ai-context/planning-contract.md) is the whole
authority. Both parties read it, and the facts that differ by role — who holds
the plan, who may settle a purely technical tie — arrive in the **role block**
the dispatch places above it. This paragraph deliberately does not summarise it:
the summary that used to sit here outlived the rules it summarised by a full
redesign, which is what a summary of a contract does.

What is worth stating outside the contract, because it binds whoever reads this
file: **no agent approves a plan, agreement between agents is not approval, and
neither party implements the work.** Only David approves.

