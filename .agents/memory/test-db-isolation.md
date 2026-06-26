---
name: Test database isolation
description: PR132 per-DB test runner setup — how TEST_DATABASE_URL wires into pretest and the sharded runner.
---

## Rule
Run api-server tests with `TEST_DATABASE_URL` pointing to `heliumdb_test` (a separate Postgres database on the same cluster), never against `heliumdb`.

## Setup (already done)
- `heliumdb_test` database exists on the cluster (created from template0 + pgvector + full schema sync).
- `TEST_DATABASE_URL = postgresql://postgres:password@helium/heliumdb_test?sslmode=disable` is stored in `.replit` under `[userenv.development]`.

## How it flows
1. **pretest** (`package.json`): wrapped in `bash -c 'export DATABASE_URL="${TEST_DATABASE_URL:-$DATABASE_URL}"; pnpm push-force && pnpm migrate ...'` — syncs schema to `heliumdb_test`.
2. **test runner** (`run-tests-sharded.sh` / `run-test.sh`): sources `scripts/lib/test-db.sh`, which runs `if [ -n "${TEST_DATABASE_URL:-}" ]; then export DATABASE_URL="$TEST_DATABASE_URL"; fi` — overrides DATABASE_URL before `assert_not_production` fires.
3. `assert_not_production` blocks `heliumdb` (exact match) but allows `heliumdb_test`.
4. Runner creates per-worker clone databases named `heliumdb_w_<stamp>_*` and a template `heliumdb_t_<stamp>_*`; all dropped on exit.

## After a migration
Schema in `heliumdb_test` stays current automatically: `pretest` runs `push-force + migrate` against it every test run.

**Why:** The PR132 guard `assert_not_production` denies `DATABASE_URL=heliumdb` to prevent accidental destructive ops on the dev/prod database. `heliumdb_test` is the safe source for cloning.

**How to apply:** Whenever touching the test runner setup or adding new test infrastructure, ensure `TEST_DATABASE_URL` is set (it's in [userenv.development] in .replit). The single-file runner `run-test.sh` also picks it up automatically — run it as: `BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/foo.test.ts`.
