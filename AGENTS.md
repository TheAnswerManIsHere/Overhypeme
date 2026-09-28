# Overhype.me Agent Instructions

> Routing file for AI agents. The cross-agent working contract — how to
> behave, plan, review and ship — is in
> [`.agents/core/agents-core.md`](.agents/core/agents-core.md) and applies in
> full. **Read it first.** This file covers what is specific to Overhype.me:
> where its truth lives and how to build and test it. Claude Code's
> `CLAUDE.md` imports its own core the same way and holds only what is
> Claude-specific.

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
- [`docs/manual/`](docs/manual/README.md) — the human-facing narrative manual
  (how the system works and *why*); a companion to `docs/ai-context/`, **not** a
  replacement for it
- [`docs/handoff/`](docs/handoff/README.md) — ephemeral cross-tool coordination
  (Replit ↔ Codex ↔ Claude Code); every file there is in-flight, never a
  record — delete once addressed, per its own contract

For **visual pipeline** work, also read:

- [`docs/ai-context/visual-pipeline.md`](docs/ai-context/visual-pipeline.md)
- [`docs/ai-context/moderation-workflow.md`](docs/ai-context/moderation-workflow.md)
- [`docs/ai-context/known-failure-patterns.md`](docs/ai-context/known-failure-patterns.md)

For **taxonomy, enrichment, or moderation review** work, also read:

- [`docs/ai-context/taxonomy-and-enrichment.md`](docs/ai-context/taxonomy-and-enrichment.md)
- [`docs/ai-context/moderation-workflow.md`](docs/ai-context/moderation-workflow.md)

For **CSAM/abuse scanning, quarantine, evidence retention, or NCMEC
reporting** work — a system entirely separate from content-quality review
— also read:

- [`docs/ai-context/legal-safety-moderation.md`](docs/ai-context/legal-safety-moderation.md)
  — the scanning layers, quarantine, evidence retention, and what is
  live vs. deliberately unwired. **Note its header:** detection specifics
  are deliberately omitted from that doc because this repo is public, and
  must not be added to it.

For **grammar, token rendering, or tokenizer** work, also read:

- [`docs/ai-context/token-rendering-and-grammar.md`](docs/ai-context/token-rendering-and-grammar.md)

For **adding or changing an export under `lib/api-zod/src/`** (a new schema
module, a new named export), also read:

- [`docs/ai-context/known-failure-patterns.md`](docs/ai-context/known-failure-patterns.md)
  — codegen rewrites `lib/api-zod/src/index.ts` from a hardcoded list in
  `lib/api-spec/patch-generated.mjs` on every run; a hand-edit to `index.ts`
  alone is silently reverted the next time codegen runs (CI's `pretest`
  included), surfacing as a broad, unrelated-looking wave of test failures.

For **auth, authorization, object/media serving, Stripe/membership grants,
HTTP headers, or secrets** work, also read:

- [`docs/ai-context/security-model.md`](docs/ai-context/security-model.md) —
  the security posture (auth, object/meme authz, membership grant trust,
  headers, secrets, the dev-admin-login gate)
- [`docs/ai-context/accounts-and-auth.md`](docs/ai-context/accounts-and-auth.md) —
  the operational shape of sign-in, account creation, and the account
  lifecycle (routes, flows, session mechanics, role derivation)

For **the meme/video studio, AI image/video generation entry points, or
media storage** work, also read:

- [`docs/ai-context/meme-and-video-studio.md`](docs/ai-context/meme-and-video-studio.md) —
  the three meme-building paths, the shared recipe/`imageSource` model,
  the two live video-generation systems, tier gates, and where media lives

For **home, search, hashtags, the leaderboard, profiles/library, OG cards,
merch, or sharing** work, also read:

- [`docs/ai-context/public-site-and-sharing.md`](docs/ai-context/public-site-and-sharing.md) —
  the public-facing surfaces, what's actually live vs. dead/unreachable
  code, and the sharing/tracking mechanics

For **billing, Stripe webhooks, or membership** work specifically, also read:

- [`docs/ai-context/membership-entitlements.md`](docs/ai-context/membership-entitlements.md) —
  the entitlement model: derivation, the trust boundary, per-source leases,
  grace episodes, the known reconciliation gap

Engineering practice: [`docs/engineering/`](docs/engineering/) —
[testing](docs/tests/TESTING.md),
[migrations-and-backfills](docs/engineering/migrations-and-backfills.md)
(and its worked example,
[ncmec-audit-ledger-hardening](docs/engineering/ncmec-audit-ledger-hardening.md),
for a migration that cannot enforce its own privilege boundary),
[code-review](docs/engineering/code-review.md),
[test-run-contract](docs/tests/test-run-contract.md) (what a PR's
*Post-merge verification* section must contain — Replit executes it
post-merge against the live DB, driven through the Replit connector),
[deferred-work](docs/engineering/deferred-work.md) (the backlog of parked
maintenance/security/tech-debt items — engineering deferrals only; product
deferrals stay in the roadmap). Subsystem gotchas: `.agents/memory/`.

Agent sandboxes:
[`docs/ai-context/codex-environment.md`](docs/ai-context/codex-environment.md) —
what Codex's container can and cannot do (it boots without a database by
default, so the api-server integration suite is unavailable there unless
`CODEX_SETUP_DB=1`);
[`docs/ai-context/replit-environment.md`](docs/ai-context/replit-environment.md) —
how Replit's live-environment access, auto-commit checkpoints, and direct-to-`main`
push actually work, and why that push path is unguarded on purpose.

## What the shared rules ask this repo

Answered in [`docs/ai-context/overlay-declarations.md`](docs/ai-context/overlay-declarations.md)
— the sensitive subsystems, the modules that generate API-validation schemas,
the async-status reference implementation, and the shared modules a reviewer
should know. `agents-core.md` dereferences these, so an agent entering here has
to be able to reach them; `CLAUDE.md` routes to the same one document.

## Setup, verification, and the CI gate

Full commands, DB isolation, and the production guard are in the canonical
[`docs/tests/TESTING.md`](docs/tests/TESTING.md). The essentials:

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
