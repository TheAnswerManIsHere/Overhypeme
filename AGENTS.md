# Overhype.me Agent Instructions

> Short root-level constitution and routing file for AI agents (Codex, Claude,
> future agents). It tells you **where to look, how to behave, and what's
> non-negotiable** — it is deliberately not the full product bible. The detail
> lives in `docs/ai-context/` (product/architecture truth) and `docs/engineering/`
> (test/migration/review). Keep this file concise.
>
> **One source of truth for all agents.** These docs are shared by Codex, Claude
> Code, and future agents. Claude Code's `CLAUDE.md` holds only Claude-specific
> ceremony (plan-mode delivery, its PR/squash-merge workflow, TEST_RUN/UAT,
> auto-watch) and defers to these shared docs for every cross-agent principle. When
> shared product/architecture/principle truth changes, edit the shared doc here —
> do not fork a divergent copy into any agent's own file or private memory.

## Project context

Before architecture, data-model, moderation, visual-pipeline, taxonomy,
AI-generation, or product-direction work, read the relevant files in
`docs/ai-context/`.

Start with:

- [`docs/ai-context/product-brief.md`](docs/ai-context/product-brief.md)
- [`docs/ai-context/architecture-map.md`](docs/ai-context/architecture-map.md)
- [`docs/ai-context/current-roadmap.md`](docs/ai-context/current-roadmap.md)
- [`docs/ai-context/glossary.md`](docs/ai-context/glossary.md) — term lookup
- [`docs/ai-context/decisions.md`](docs/ai-context/decisions.md) — why settled decisions are settled

For **visual pipeline** work, also read:

- [`docs/ai-context/visual-pipeline.md`](docs/ai-context/visual-pipeline.md)
- [`docs/ai-context/moderation-workflow.md`](docs/ai-context/moderation-workflow.md)
- [`docs/ai-context/known-failure-patterns.md`](docs/ai-context/known-failure-patterns.md)

For **taxonomy, enrichment, or moderation review** work, also read:

- [`docs/ai-context/taxonomy-and-enrichment.md`](docs/ai-context/taxonomy-and-enrichment.md)
- [`docs/ai-context/moderation-workflow.md`](docs/ai-context/moderation-workflow.md)

For **grammar, token rendering, or tokenizer** work, also read:

- [`docs/ai-context/token-rendering-and-grammar.md`](docs/ai-context/token-rendering-and-grammar.md)

Engineering practice: [`docs/engineering/`](docs/engineering/) —
[testing-guide](docs/engineering/testing-guide.md),
[migrations-and-backfills](docs/engineering/migrations-and-backfills.md),
[code-review](docs/engineering/code-review.md). Subsystem gotchas: `.agents/memory/`.

## Working agreement with David

David is the product owner. **Do not implement major changes from a non-trivial
plan until David has explicitly approved that plan.** An ambiguous nudge or another
agent's approval is not David's approval. Full working rules:
[`docs/ai-context/agent-working-rules.md`](docs/ai-context/agent-working-rules.md).

**Two working modes — David picks explicitly.** Default is **feature mode** (plan
→ approval → full build → PR). **Bugfix mode** is a lightweight fix-and-commit path
David turns on by saying so (e.g. a prompt starting **"Bugfix mode:"**); absent an
explicit signal you are in feature mode. Read
[`docs/ai-context/working-modes.md`](docs/ai-context/working-modes.md) for the full
contract of each and how to switch between them.

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
- **Prefer database-backed config for tunable operational settings.**
- **Migrations must be idempotent and observable.**
- **Async work must show status** at two altitudes (per-item + aggregate) — see
  [`docs/ai-context/async-ui-status.md`](docs/ai-context/async-ui-status.md).
- **Ship the surface with the behavior** (no dead UI, no invisible backend), and
  **enforce every permission server-side.**
- Pre-launch: features ship **on-by-default, no rollout flags**; **no new external
  vendors** without David's sign-off.

## Planning standard

For non-trivial implementation work, create or update a plan using
[`.agents/PLANS.md`](.agents/PLANS.md). **Do not begin implementation until David
approves the plan.**

## Setup, verification, and the CI gate

Full commands, DB isolation, and the production guard are in
[`docs/engineering/testing-guide.md`](docs/engineering/testing-guide.md) and the
canonical [`docs/TESTING.md`](docs/TESTING.md). The essentials:

- Build generated artifacts + libs before package checks:
  `pnpm --filter @workspace/api-spec run codegen` → `pnpm run typecheck:libs` →
  `pnpm typecheck`.
- API DB-backed tests: `pnpm --filter @workspace/db push-force` →
  `pnpm --filter @workspace/db run migrate` → `pnpm --filter @workspace/api-server
  test`. Single file: `bash artifacts/api-server/scripts/run-test.sh
  src/__tests__/<file>.test.ts`.
- **Never** run api-server tests with raw `node --test` (can't load the `tsx/esm`
  setup — an invalid command, not a failing test).
- **GitHub CI is the authoritative gate** — required `Build` + `Test` on every PR
  to `main`; both must pass before merge. If a sandbox can't run a DB-backed test,
  report it as an environment/command failure **deferred-to-CI**, not a product
  failure. Separate valid repo-command failures from invalid-command/environment
  failures in every summary.
