# How to run tests in this project (for Claude)

This document covers the exact commands and constraints for running tests in
the Replit environment for this project. Read this before proposing any test
commands.

---

## Database isolation — critical background

The project uses a single PostgreSQL server with two schemas:

| Schema | Purpose |
|---|---|
| `public` | Live development database — **never written to by tests** |
| `heliumdb_test` | Isolated test schema — dropped and repopulated on each full test run |

`DATABASE_URL` in the environment always points at the `public` schema:

```
postgresql://postgres:password@helium/heliumdb?sslmode=disable
```

Tests must never use this URL directly. The test tooling constructs a separate
URL that routes all queries through `heliumdb_test` via PostgreSQL's
`search_path` startup parameter.

---

## Running individual test files

**Always use the wrapper script.** Never invoke `node --import tsx/esm --test`
directly against the ambient `DATABASE_URL`.

```bash
cd artifacts/api-server
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/<file>.test.ts
```

Multiple files in one pass:

```bash
cd artifacts/api-server
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh \
  src/__tests__/foo.test.ts \
  src/__tests__/bar.test.ts
```

Force a schema refresh first (required after adding a new migration, or if
the test schema is suspected to be out of date):

```bash
cd artifacts/api-server
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh --setup src/__tests__/<file>.test.ts
```

What `run-test.sh` does:
- Computes `TEST_DATABASE_URL` by appending
  `options=-c search_path=heliumdb_test,public` to `DATABASE_URL`.
- Checks whether `heliumdb_test` has as many tables as `public`; if not,
  auto-runs a `pg_dump --schema-only` clone from `public` into `heliumdb_test`.
- Sets `TEST_DB_ALLOW_EXIT_ON_IDLE=1`, stubs `RESEND_API_KEY*`, and defaults
  `CRON_SECRET` to `test-cron-secret` — matching the full suite's environment.
- Overrides `DATABASE_URL` for the child `node` process before it starts.

---

## Running the full api-server test suite

```bash
pnpm --filter @workspace/api-server run test
```

This runs `scripts/run-tests-sharded.sh` which:
1. Drops and recreates `heliumdb_test` from scratch.
2. Runs two parallel test shards, each getting half the `src/__tests__/**/*.test.ts` files.
3. The full suite takes roughly 60–90 seconds and exits non-zero on any failure.

Do **not** run `node --import tsx/esm --test 'src/__tests__/**/*.test.ts'`
directly — it bypasses schema isolation entirely.

---

## Running other test suites

```bash
# lib/db migration tests (fast, ~2s, always hits public DB — safe, read-only migrations):
pnpm --filter @workspace/db run test

# Frontend unit tests (vitest, ~20s, no DB):
pnpm --filter @workspace/overhype-me run test
# or from the artifact directory:
cd artifacts/overhype-me && pnpm test

# Full repo typechecks (no DB):
pnpm typecheck

# Migration journal + snapshot consistency:
pnpm --filter @workspace/db check-snapshots
```

---

## What NOT to do

```bash
# WRONG — writes test data to the live public schema:
node --import tsx/esm --test src/__tests__/foo.test.ts

# WRONG — same problem even with an explicit URL, because heliumdb has no
# heliumdb_test search_path and the ambient DATABASE_URL has no test schema:
DATABASE_URL=postgresql://postgres:password@helium/heliumdb?sslmode=disable \
  node --import tsx/esm --test src/__tests__/foo.test.ts

# WRONG — omitting BCRYPT_SALT_ROUNDS makes bcrypt slow (~1s/hash vs ~1ms):
bash scripts/run-test.sh src/__tests__/auth.test.ts
```

---

## Known failing tests (not regressions)

`src/__tests__/videoJobs.test.ts` — all tests return 503 or 404. This file
tests video generation routes that call the fal.ai API. The `FAL_AI_API_KEY`
environment variable is not configured in the dev environment so every route
returns 503 (service unavailable). These failures are pre-existing and expected;
do not treat them as a sign that something you changed is broken.

---

## Environment variables used by tests

| Variable | Value in test runs | Notes |
|---|---|---|
| `DATABASE_URL` | overridden to `heliumdb_test` search_path | Set by `run-test.sh` / `run-tests-sharded.sh` |
| `BCRYPT_SALT_ROUNDS` | `4` | Keeps password hashing fast in tests |
| `CRON_SECRET` | `test-cron-secret` (default) | Required by cron-guarded routes |
| `RESEND_API_KEY` | `re_test_dummy` | Prevents real emails in tests |
| `RESEND_API_KEY_DEV` | `""` | Blanked to force the stub key |
| `RESEND_API_KEY_PROD` | `""` | Blanked to force the stub key |
| `TEST_DB_ALLOW_EXIT_ON_IDLE` | `1` | Unrefs pg pool idle timers so Node exits cleanly |

---

## Workspace layout (relevant paths)

```
artifacts/api-server/
  scripts/
    run-test.sh            ← individual file wrapper (use this)
    run-tests-sharded.sh   ← full suite runner (called by pnpm test)
  src/__tests__/           ← all integration test files live here

lib/db/
  src/**/*.test.ts         ← migration unit tests (run via pnpm --filter @workspace/db test)

artifacts/overhype-me/
  src/**/*.test.tsx        ← frontend vitest tests
```

---

## Quick reference cheatsheet

```bash
# Single test file:
cd artifacts/api-server
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/<file>.test.ts

# Full api-server suite:
pnpm --filter @workspace/api-server run test

# Frontend tests:
pnpm --filter @workspace/overhype-me run test

# DB migration tests:
pnpm --filter @workspace/db run test

# Typecheck everything:
pnpm typecheck
```
