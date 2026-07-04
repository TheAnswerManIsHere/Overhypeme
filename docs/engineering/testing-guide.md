# Testing Guide

> How to verify changes in this repo. **`docs/TESTING.md` is the canonical
> reference** for DB isolation modes, the production guard, the DB-name glossary,
> and the CI gate — this is the orientation layer. Do **not** invent commands;
> the ones below are verified against the repo. **GitHub CI is the authoritative
> gate** (required `Build` + `Test` on PRs to `main`).

## Canonical setup and typecheck order

Generated API artifacts and workspace libs must be built before package-local
checks, or you get false negatives (project references to `lib/*` that don't exist
yet in a cold environment):

```sh
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
pnpm typecheck          # repo-level; prefer this for general typechecking
```

## Test commands

**Frontend-only changes** (safe sequence):

```sh
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
pnpm --filter @workspace/overhype-me run typecheck
pnpm --filter @workspace/overhype-me exec vitest run <relevant test file>
```

**API DB-backed suite** (full):

```sh
pnpm --filter @workspace/db push-force
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/api-server test
```

**A single API test file** (isolated targeted runner):

```sh
bash artifacts/api-server/scripts/run-test.sh src/__tests__/<file>.test.ts
```

After adding/changing a migration, apply then re-clone the test schema:

```sh
pnpm --filter @workspace/db push-force
pnpm --filter @workspace/db run migrate
bash artifacts/api-server/scripts/run-test.sh --setup src/__tests__/<file>.test.ts
```

**Never run api-server tests with raw `node --test`** — plain Node can't load this
repo's `tsx/esm` setup and fails to even read a `.ts` file. That's an *invalid
command*, not a failing test.

## Test database setup

Replit owns its own DB connection — **do not hardcode `DATABASE_URL` in docs**.
The runners point `DATABASE_URL` at the isolated test DB themselves:

- The full-suite runner isolates each worker in its own throwaway DB (cloned from a
  structure-only template) and seeds only boot-time, code-owned rows (e.g. engine
  catalogue reconciliation).
- The targeted `run-test.sh` uses a single cached test schema; the live/public
  schema is never touched.
- **Production guard:** the runner refuses to run when `DATABASE_URL` points at
  `heliumdb` (prod *and* dev share that name) or `NODE_ENV=production`. Use
  `heliumdb_test` on Replit (`TEST_DATABASE_URL`), `overhype_test` in CI/sandbox.
- Tests **create their own domain rows** (facts, reviews, pricing, moderation
  state, etc.) — the runner does not copy dev/prod data. External services (Pexels,
  object storage, pricing, embeddings, image/video generation, Stripe) must be
  stubbed/mocked or disabled with test-mode helpers — no real credentials or
  network.

See `.agents/memory/test-db-isolation.md`, `test-schema-isolation.md`,
`test-idle-drain-timeout.md`, `running-long-test-suites.md` for gotchas.

## Unit tests

Pure-logic tests live alongside the suite (e.g. tokenizer/grammar:
`factTokenizer.test.ts`, `autoConjugatePersonSubjectVerbs.test.ts`; enrichment
resolver: `enrichmentOverridesResolver.test.ts`; taxonomy health:
`taxonomyHealth.evaluate.test.ts`). Assert **invariants**, not just the reported
example, with negative cases.

## Integration / API tests

`artifacts/api-server/src/__tests__/*.test.ts`, run via the runners above against
Postgres + pgvector. They exercise routes + domain logic end to end with
DB-backed fixtures created in-test.

## Admin UI tests

Frontend tests via Vitest under `artifacts/overhype-me`. For admin surfaces,
prioritize the async-status contract (per-item + aggregate states) and
preview/runtime parity where relevant.

## Async job tests

Test the terminal state, not the enqueue. Assert `pending → processing → done |
failed` transitions and that per-item/aggregate status is reported. The image
preview bench must **not** read the production `aiScenePrompts` cache (tests assert
this) — see `.agents/memory/image-prompt-preview-parity.md`.

## Migration / backfill tests

Apply the migration to the local public schema, re-clone the test schema
(`run-test.sh --setup`), then run the affected tests. Backfills should be tested
for **idempotency** (run twice == once) and for old/partial/failed/skipped/no-op
rows. See [`migrations-and-backfills.md`](./migrations-and-backfills.md).

## Regression fixtures

When you fix a bug, add a regression case that proves the **general** invariant.
Tokenizer/grammar regressions in particular should include `They keep`,
`Sharks have`, name possessives, and the pronoun sets exercising the changed
branch.

## Manual QA / UAT

Product-visible behavior needs a click-through check against intent (David tests
the product, not the diff). "Done" = the intended behavior can be exercised in the
app. Claude Code additionally ships paired `TEST_RUN` + `UAT` docs per PR (see
`CLAUDE.md`); Codex should at minimum describe the manual steps to observe the
change.

## What to report after running tests

- Exact commands run and their result (pass/fail counts).
- **Separate** valid repo-command failures (may block merge) from
  invalid-command/environment failures (must not block if the valid command
  passed). If a sandbox can't run a DB-backed test, report it as
  environment/command failure **deferred-to-CI** — not a product/test failure.
- A self-corrected mistyped command is not a failure — don't report it as one.
