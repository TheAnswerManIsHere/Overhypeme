# Working agreements for Overhype.me (Claude Code)

@.agents/core/claude-core.md

## What Overhype.me is

A personalized impossible-facts platform: a community-driven catalogue of
exaggerated, Chuck-Norris-style boasts, each authored once as a tokenized
template and rendered on demand with the visitor's own name and pronouns, then
turned into shareable image and video memes starring them. David is the product
owner; the loop is personalize → submit → moderate and enrich → render → share.
The brief below is the current truth and wins over anything remembered.

## Product truth lives here

- **Brief / direction / roadmap** —
  [`product-brief.md`](docs/ai-context/product-brief.md),
  [`product-direction.md`](docs/ai-context/product-direction.md),
  [`current-roadmap.md`](docs/ai-context/current-roadmap.md).
- **Architecture** — [`architecture-map.md`](docs/ai-context/architecture-map.md).
- **Glossary** — [`glossary.md`](docs/ai-context/glossary.md).
- **Settled decisions and why** — [`decisions.md`](docs/ai-context/decisions.md).
- **Subsystems** — the visual pipeline, moderation, taxonomy and enrichment,
  legal-safety moderation, token rendering and grammar, security model,
  accounts and auth, the meme and video studio, the public site, membership
  entitlements: all under `docs/ai-context/`, routed by kind of work from
  [`AGENTS.md`](AGENTS.md) *Project context*.
- **The Manual** — [`docs/manual/`](docs/manual/README.md), the human-facing
  narrative of how the system works and why; a companion to `docs/ai-context/`,
  not a replacement for it.
- **Engineering practice** — [`docs/engineering/`](docs/engineering/) and
  [`docs/tests/TESTING.md`](docs/tests/TESTING.md); subsystem gotchas in
  `.agents/memory/`.

## Product-specific skills

- `overhype-design` — frontend work: components, pages, fact cards, meme
  layouts; brand tokens.
- `overhype-implementation` — building an approved Overhype.me plan.
- `overhype-plan-review` — the product lens handed to the shared
  `plan-review-loop`; it reviews nothing itself.
- `overhype-migration-review` — schema, Drizzle, migration and backfill work.
- `overhype-token-rendering` — the grammar, the tokenizer, personalization
  tokens, pronouns, `render-fact`.
- `overhype-visual-pipeline` — the planner, the compiler, render policy,
  candidate concepts, moderation renders.
- `domain-modeling` — the domain model and the glossary.

## What the shared rules ask this repo

Answered in [`docs/ai-context/overlay-declarations.md`](docs/ai-context/overlay-declarations.md)
— the sensitive subsystems, the modules that generate API-validation schemas,
the async-status reference implementation, and the shared modules a reviewer
should know. One document, routed from here and from `AGENTS.md`, because the
rules that dereference it live in both cores.

## Environment

- **The Repl tracks `main`**; how its git pane, checkpoints and direct push
  behave is
  [`replit-environment.md`](docs/ai-context/replit-environment.md). Codex's
  sandbox is [`codex-environment.md`](docs/ai-context/codex-environment.md).
- **`.claude/settings.json`** points `DATABASE_URL` at the local test database
  and runs `scripts/setup-test-db.sh` at session start; its `permissions.deny`
  refuses `drizzle-kit push` in every spelling and any `.env*` read. Test
  isolation and the production guard: [`TESTING.md`](docs/tests/TESTING.md).
- **CI** requires `Build` and `Test` on every PR to `main`. The workflow runs
  on `pull_request: [opened, synchronize, reopened, edited]` with
  `cancel-in-progress`, so editing a PR body while a run is in flight cancels
  it and starts a replacement — a restart, nothing worse.
- **`.mcp.json`** declares Firecrawl; the key policy is the core's.
