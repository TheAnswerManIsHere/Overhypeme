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
[testing-guide](docs/tests/testing-guide.md),
[migrations-and-backfills](docs/engineering/migrations-and-backfills.md)
(and its worked example,
[ncmec-audit-ledger-hardening](docs/engineering/ncmec-audit-ledger-hardening.md),
for a migration that cannot enforce its own privilege boundary),
[code-review](docs/engineering/code-review.md),
[test-run-contract](docs/tests/test-run-contract.md) (what a per-PR
`TEST_RUN` checklist must contain — Replit executes it post-merge against the
live DB),
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

## Working agreement with David

David is the product owner. **Do not implement major changes from a non-trivial
plan until David has explicitly approved that plan.** An ambiguous nudge or another
agent's approval is not David's approval. Full working rules:
[`docs/ai-context/agent-working-rules.md`](docs/ai-context/agent-working-rules.md).

**Two working modes — the ceremony in force is always visible, never silent.**
Default is **feature mode** (plan → approval → full build → PR). **Bugfix
mode** is a lightweight fix-and-commit path. For Codex, David turns it on by
saying so (e.g. a prompt starting **"Bugfix mode:"**); absent an explicit
signal you are in feature mode. (Claude routes by request shape with an
announced, vetoable classification — see the mode-entry section of
working-modes.md.) Read
[`docs/ai-context/working-modes.md`](docs/ai-context/working-modes.md) for the full
contract of each and how to switch between them.

**End-of-feature documentation.** When David invokes `/document` or asks to lock
in a finished feature's learnings, follow
[`docs/ai-context/documentation-workflow.md`](docs/ai-context/documentation-workflow.md)
(distinct from a one-off "remember this," which is immediate targeted persistence).

**Workstream tracking.** Every unit of work — feature, bugfix, doc harvest —
has a GitHub issue as its spine, tracked on a private Project board and kept
current via `stage:`/`waiting:`/`mode:` labels — *except* sensitive/
disclosure-carve-out work, which never becomes a public issue and is a
private draft Project item instead. Read
[`docs/ai-context/workstream-tracking.md`](docs/ai-context/workstream-tracking.md)
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

**Reviewing a plan (not code).** When asked to review a pull request whose title
is prefixed **`[PLAN REVIEW]`** (a plan document, not a code diff), apply the
[plan-review contract](docs/ai-context/plan-review-contract.md): review the
markdown as an implementation *specification* against the PR body's stated intent
and the repo, return a **complete** assessment even when nothing is critical, and
never implement anything on that PR. **Status labels are a full-document-surface
concept only** (never approval language there either — only David approves); on
your actual GitHub review transport you don't compute or post one — see the
contract's *Output* section for what you do instead.

**On a re-review, the diff is not the scope.** Round 2 onward you are shown a
markdown diff of the plan — re-read the *whole* plan and re-verify it against the
repo anyway, reconcile every finding you raised earlier (Resolved / Still open /
Superseded, where "the wording changed" is never Resolved), attack from a lens
you haven't used yet, and report what you actually inspected — including the
searches you ran — plus what you could not verify and why. **On your actual
GitHub review transport, most of this is carried inside individual findings,
not a separate report** — the contract's *Re-reviews*, *Report what you
verified*, and *Output* sections are the full, surface-scoped rules; this
paragraph is a summary, not the authority.

## Setup, verification, and the CI gate

Full commands, DB isolation, and the production guard are in
[`docs/tests/testing-guide.md`](docs/tests/testing-guide.md) and the
canonical [`docs/tests/TESTING.md`](docs/tests/TESTING.md). The essentials:

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
