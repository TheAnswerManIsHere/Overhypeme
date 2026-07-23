# Testing Guide

> How to verify changes in this repo. **`docs/TESTING.md` is the canonical
> reference** for DB isolation modes, the production guard, the DB-name glossary,
> and the CI gate — this is the orientation layer. Do **not** invent commands;
> the ones below are verified against the repo. **GitHub CI is the authoritative
> gate**: `.github/workflows/build.yml` runs four jobs on every PR to `main` —
> `Build` (typecheck, docs-accuracy, migration-snapshot, and codegen-drift
> checks, then the app build), `Test` (the api-server integration suite),
> `Frontend Test` (the overhype-me vitest suite), and `E2E Smoke` (the
> Playwright route-load smoke suite against a real dev stack). Whether all
> four are configured as *required* status checks is a branch-protection
> setting, separate from whether they run.

## Canonical setup and typecheck order

Generated API artifacts and workspace libs must be built before package-local
checks, or you get false negatives (project references to `lib/*` that don't exist
yet in a cold environment):

```sh
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
pnpm typecheck          # repo-level; prefer this for general typechecking
```

## Build gate parity

GitHub's required **Build** check runs the repo-level build:

```sh
pnpm run build
```

That command is broader than package-local typechecks: after typechecking it
recursively runs each workspace package's build script, including Vite production
config loading. Run it before PRs that touch frontend code, package/workspace
scripts, Vite/build config, or any environment-variable handling used during
build. Do not replace it with `tsc`-only checks for those changes — typecheck can
pass while a production build fails.

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

## End-to-end / route-load smoke tests

`artifacts/overhype-me/e2e/*.spec.ts`, run via Playwright against a **real
dev stack** — not a mock. `routeLoadSmoke.spec.ts` in particular is the
regression net for the crash/reload-loop bug class (see
`known-failure-patterns.md` → "Self-retriggering recovery with no bounded
exit"): it asserts each heavy route actually renders, doesn't loop, and
doesn't hit the Sentry error boundary.

Locally (both servers already running, e.g. via Replit's workflows):

```sh
pnpm --filter @workspace/overhype-me run e2e:smoke
```

Outside Replit (CI, or a bare Claude Code environment) there's no platform
path-router splitting `/api` from the SPA, so two env-gated escape hatches in
`vite.config.ts` / `playwright.config.ts` stand in:

- `E2E_API_PROXY_TARGET` — points Vite's dev-server proxy at the api-server
  (e.g. `http://localhost:8080`). Inert when unset.
- `E2E_CHROMIUM_PATH` — pins Playwright to a system-provided Chromium binary
  instead of its managed download (needed where browser downloads are
  disabled and the pinned Playwright version may not match what's
  preinstalled). Inert when unset.

The suite authenticates via `POST /api/auth/dev-admin-login`, which looks up
a specific bootstrap admin row — seed it first with
`pnpm --filter @workspace/api-server exec tsx scripts/seed-dev-admin.ts`
(idempotent; imports the canonical email from `src/lib/auth.ts` so it can't
drift from the login route). See the `E2E Smoke` job in
`.github/workflows/build.yml` for the full sequence CI runs.

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
