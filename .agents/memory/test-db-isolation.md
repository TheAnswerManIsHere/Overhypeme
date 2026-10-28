---
name: Test database isolation
description: PR132 per-DB test runner setup — how TEST_DATABASE_URL wires into pretest and the sharded runner.
---

## Rule
Run api-server tests with `TEST_DATABASE_URL` pointing to `heliumdb_test` (a separate Postgres database on the same cluster), never against `heliumdb`.

## Setup (already done)
- `heliumdb_test` database exists on the cluster (created from template0 + pgvector; `migrate` keeps its schema current).
- `TEST_DATABASE_URL = postgresql://postgres:password@helium/heliumdb_test?sslmode=disable` is stored in `.replit` under `[userenv.development]`.

## How it flows
1. **pretest** (`package.json`): wrapped in `bash -c 'export DATABASE_URL="${TEST_DATABASE_URL:-$DATABASE_URL}"; pnpm run require-test-db && pnpm run migrate ...'` — the guard, then the schema ([`migrations-and-backfills.md`, *How a database receives a change*](../../docs/engineering/migrations-and-backfills.md#how-a-database-receives-a-change)).
2. **test runner** (`run-tests-sharded.sh` / `run-test.sh`): sources `scripts/lib/test-db.sh`, which runs `if [ -n "${TEST_DATABASE_URL:-}" ]; then export DATABASE_URL="$TEST_DATABASE_URL"; fi` — overrides DATABASE_URL before `assert_not_production` fires.
3. `assert_not_production` refuses any database without the test-database marker (`overhype.test_database = 'yes'`, a stored database setting). `heliumdb_test` is marked; `heliumdb` and production never are. `require-test-db` checks the same marker before pretest migrates.
4. Runner creates per-worker clone databases named `heliumdb_w_<stamp>_*` and a template `heliumdb_t_<stamp>_*`; all dropped on exit.

## After a migration
Schema in `heliumdb_test` stays current automatically: `pretest` runs `migrate` against it every test run.

**Why:** `assert_not_production` refuses an unmarked database to prevent destructive ops on the dev or production database. (Until 2026-10-10 it matched database names; see TESTING.md for why that was replaced.) `heliumdb_test` is the safe source for cloning.

**How to apply:** Whenever touching the test runner setup or adding new test infrastructure, ensure `TEST_DATABASE_URL` is set (it's in [userenv.development] in .replit). The single-file runner `run-test.sh` also picks it up automatically — run it as: `BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/foo.test.ts`.

## Gotcha: a doc-instructed `DATABASE_URL` export doesn't survive `pretest`/`run-test.sh`
If a TEST_RUN doc or any other written instruction tells someone to `export
DATABASE_URL=<some other database>` and then run `pnpm --filter
@workspace/api-server test` or anything routed through `run-test.sh`, that
export is silently discarded: line 15 above means `TEST_DATABASE_URL`
always wins whenever it's set (which it is, on Replit). The instruction
looks correct and does something else entirely — in PR #356 (2026-08-08)
this cost 4 review rounds writing "disposable database" isolation for a
live-workspace TEST_RUN checklist before the override was found as the
actual reason none of the isolation attempts could have worked.

**In a TEST_RUN doc, this is not a case for careful wording — it's a case
for not writing the instruction at all.** Per
[`test-run-contract.md`](../../docs/engineering/test-run-contract.md),
a TEST_RUN checklist never sets `DATABASE_URL`, `TEST_DATABASE_URL`, or any
other test-DB env var — Replit owns that connection, full stop. The suites
this gotcha is about already passed in CI on the merged code, so the
correct fix is cutting the re-run instruction, never repointing either
variable to make it "safely" isolated.

Outside a TEST_RUN doc — ordinary engineering work on the test runner
itself, where setting up an isolated database on purpose is the actual
task — the fix is different: repoint `TEST_DATABASE_URL` itself, not just
`DATABASE_URL` (line 15 above is why `DATABASE_URL` alone never sticks).
