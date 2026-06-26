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

Do not run these tests with raw `node --test`; the package test runner creates the isolated `heliumdb_test` schema and seeds only required boot-time, code-owned rows such as the engine catalogue reconciliation.

The DB setup commands above must be run before api-server tests so the branch's current Drizzle schema and migration SQL have been applied to the local public schema that the test runner clones from. The sharded test runner must not copy development or production data into `heliumdb_test`; tests that need facts, pending reviews, Pexels image JSON, moderation state, pricing rows, or other domain data must create those rows explicitly in the test or in a focused helper/factory. External services such as Pexels, object storage, pricing APIs, embeddings, and image generation must be stubbed/mocked or disabled with test-mode helpers so Codex/local tests do not require real credentials or real network calls.

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

When reporting verification results, separate known full-suite fixture or environment failures from the focused checks relevant to the pull request. Do not treat known fixture/environment issues as failures of unrelated PR-focused checks.
