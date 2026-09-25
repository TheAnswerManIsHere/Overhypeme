# Working agreements for Overhype.me (Claude Code)

@.agents/core/claude-core.md

## What Overhype.me is

A **personalized impossible-facts platform**: a community-driven database of
exaggerated, Chuck-Norris-style boasts that render with the visitor's own name
and pronouns, then turn into shareable image and video memes starring them.
David is the product owner. The core loop is personalize → submit → moderate
and enrich → render a meme → share → a new visitor personalizes.

## Product truth lives here

- **Brief, direction, roadmap:**
  [`product-brief.md`](docs/ai-context/product-brief.md),
  [`product-direction.md`](docs/ai-context/product-direction.md),
  [`current-roadmap.md`](docs/ai-context/current-roadmap.md).
- **Architecture:** [`architecture-map.md`](docs/ai-context/architecture-map.md).
- **Glossary:** [`glossary.md`](docs/ai-context/glossary.md).
- **Settled decisions and why:** [`decisions.md`](docs/ai-context/decisions.md).
- **Subsystems:** the visual pipeline, moderation, taxonomy and enrichment,
  token rendering, security and auth, membership, the studio, and the public
  site, all under `docs/ai-context/`. [`AGENTS.md`](AGENTS.md) says which to
  read before which kind of work.
- **The Manual:** [`docs/manual/`](docs/manual/README.md), the human-facing
  account of how the system works and why.

## Product-specific skills

`.claude/skills/overhype-*`. Use them for design (`overhype-design`),
implementation (`overhype-implementation`), migration review
(`overhype-migration-review`), this product's planning lens
(`overhype-plan-review`), token rendering (`overhype-token-rendering`) and
the visual pipeline (`overhype-visual-pipeline`).

## What the shared rules ask this repo

Answered in
[`docs/ai-context/overlay-declarations.md`](docs/ai-context/overlay-declarations.md):
sensitive subsystems, the generated API-validation schemas, the async-status
reference panel, and the shared modules a reviewer should know.

## Environment

- **The app runs from the Overhype.me Repl**, which tracks `main`. Close-out
  syncs it. How the Repl, its database and its direct-to-`main` push path
  actually work: [`replit-environment.md`](docs/ai-context/replit-environment.md).
- **A local Postgres test database** (`overhype_test`) is provisioned at
  session start by `scripts/setup-test-db.sh`, the `SessionStart` hook in
  `.claude/settings.json`. `DATABASE_URL` points at it. Commands and the
  production guard: [`docs/tests/TESTING.md`](docs/tests/TESTING.md).
- **Codex's sandbox** boots without a database by default:
  [`codex-environment.md`](docs/ai-context/codex-environment.md).
- **Build, test and the CI gate:** [`AGENTS.md`](AGENTS.md), *Setup,
  verification, and the CI gate*.
