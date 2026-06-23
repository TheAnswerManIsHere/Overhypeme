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

## Reporting failures

When reporting verification results, separate known full-suite fixture or environment failures from the focused checks relevant to the pull request. Do not treat known fixture/environment issues as failures of unrelated PR-focused checks.
