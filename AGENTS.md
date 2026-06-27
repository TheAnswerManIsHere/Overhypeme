# Codex Verification Instructions

These instructions apply to the entire repository.

## Canonical setup and typecheck order

After installing dependencies, build generated API artifacts and referenced workspace libraries before running package-local checks:

```sh
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
```

For general typechecking, prefer the repo-level command:

```sh
pnpm typecheck
```

Do not use isolated package typechecks as standalone verification in a cold environment unless the referenced libraries have already been generated and built. In particular, `@workspace/overhype-me` has TypeScript project references to workspace libraries such as `lib/api-client-react`, `lib/replit-auth-web`, and `lib/api-zod`, so `pnpm --filter @workspace/overhype-me run typecheck` can produce false negatives before those referenced outputs exist.

## Frontend-only changes

For frontend-only changes, use this safe verification sequence:

```sh
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
pnpm --filter @workspace/overhype-me run typecheck
pnpm --filter @workspace/overhype-me exec vitest run <relevant test file if known>
```

## API DB-backed tests

For API database-backed tests, use the package test script:

```sh
pnpm --filter @workspace/db push-force
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/api-server test
```

Do not run these tests with raw `node --test`. The full-suite runner isolates each parallel worker in its **own** throwaway database (per-worker databases cloned from a structure-only template, by default; per-worker schemas as a fallback when `CREATE DATABASE` is denied), and seeds only required boot-time, code-owned rows such as the engine catalogue reconciliation. (The targeted `run-test.sh` runner uses a single cached `heliumdb_test` schema instead — see below.) `docs/TESTING.md` is the canonical reference for all of this: isolation modes, the production guard, the DB-name glossary, and the CI gate.

The DB setup commands above must be run before api-server tests so the branch's current Drizzle schema and migration SQL have been applied to the local public schema that the runner clones from. The runner must not copy development or production data into the test databases; tests that need facts, pending reviews, Pexels image JSON, moderation state, pricing rows, or other domain data must create those rows explicitly in the test or in a focused helper/factory. External services such as Pexels, object storage, pricing APIs, embeddings, and image generation must be stubbed/mocked or disabled with test-mode helpers so Codex/local tests do not require real credentials or real network calls.

**Production guard:** the runner refuses to run when `DATABASE_URL` points at `heliumdb` (Overhype's prod *and* dev share that exact name) or when `NODE_ENV=production`. Point `DATABASE_URL` at the test database — `heliumdb_test` on Replit (via `TEST_DATABASE_URL`), `overhype_test` in CI/sandbox — never at `heliumdb`.

**GitHub CI is the authoritative gate.** Every PR to `main` runs required `Build` (typecheck + build + migration-snapshot validation) and `Test` (the api-server suite against Postgres + pgvector) checks; both must pass before merge. If a sandbox cannot run a DB-backed test (no Postgres, or only an invalid raw-`node` command is available), report it as an environment/command failure **deferred-to-CI** — not as a product or test failure. See "Reporting failures" below.

## Codex review-fix verification rules

When fixing a Codex review comment, run the repository's own verification commands before reporting test status. Never run raw `node --test` against api-server TypeScript test files — plain Node does not load this repo's `tsx/esm` setup, so it fails to even read a `.ts` file even when the code is correct. A command that fails that way is an invalid command, not a failing test.

For a targeted api-server test file, use the existing isolated runner:

```sh
bash artifacts/api-server/scripts/run-test.sh src/__tests__/<file>.test.ts
```

It loads the TypeScript loader, points `DATABASE_URL` at the isolated `heliumdb_test` schema (the live/public schema is never touched), stubs the test env vars, clones the schema when it is stale, and seeds the boot-time engine-catalogue rows — so a single-file run sets up the same baseline as the full suite. It is runnable from the repo root or from `artifacts/api-server`.

After adding or changing a DB migration, apply it to the local public schema first, then force a fresh clone of that updated schema into the test schema:

```sh
pnpm --filter @workspace/db push-force
pnpm --filter @workspace/db run migrate
bash artifacts/api-server/scripts/run-test.sh --setup src/__tests__/<file>.test.ts
```

(`--setup` only re-clones the test schema from the already-updated public schema; it does not apply migrations itself.)

For the full api-server suite, use the package test runner, which sets up the isolated schema and boot-time seed rows for you:

```sh
pnpm --filter @workspace/api-server test
```

A command that was typed incorrectly and then corrected is not a product or test failure. Do not report a self-corrected invalid-command attempt as a failure. In final testing summaries, separate valid repo-command failures (which may block merge) from invalid-command/environment failures (which must not block if the valid command passed).

Use PR #130 as a concrete example:

Invalid (raw Node cannot load the `.ts` file):

```sh
pnpm --filter @workspace/api-server exec node --test src/__tests__/autoConjugatePersonSubjectVerbs.test.ts
```

Valid (the isolated targeted runner):

```sh
bash artifacts/api-server/scripts/run-test.sh src/__tests__/autoConjugatePersonSubjectVerbs.test.ts
```

## Reporting failures

When reporting verification results, separate known full-suite fixture or environment failures from the focused checks relevant to the pull request. Do not treat known fixture/environment issues as failures of unrelated PR-focused checks. See `docs/TESTING.md` ("How to report test failures") for the valid-failure vs invalid-command/environment-failure distinction and the deferred-to-CI rule.
