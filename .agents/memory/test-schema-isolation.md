---
name: Test schema isolation (heliumdb_test)
description: How api-server tests are isolated from the dev DB via a cloned test schema
---

## Rule
api-server tests run against `heliumdb_test` schema, not `public`. The dev DB public schema is **never touched** during test runs.

**Why:** Prevents test data from polluting dev data, and dev data from affecting test results.

## How it works
`run-tests-sharded.sh` at the start of each run:
1. `DROP SCHEMA heliumdb_test CASCADE` + `CREATE SCHEMA heliumdb_test` — clean slate
2. `pg_dump --schema=public --schema-only` piped through sed to clone structure:
   - Protects `public.vector` (pgvector extension type) with `__PGVECTOR__` placeholder
   - Rewrites all other `public.` → `heliumdb_test.`
   - Restores `__PGVECTOR__` → `public.vector`
3. Verifies ≥5 tables exist in heliumdb_test before running tests

`TEST_DATABASE_URL` uses `options=-c search_path=heliumdb_test,public`
- heliumdb_test first (all application tables)
- public as fallback (extension types like `vector`)

## Critical sed gotcha
`pg_dump` uses empty `search_path` + fully-qualified `public.tablename` names (NOT the old `SET search_path = public` + unqualified names format). The `public.vector` type MUST stay as `public.vector` — it cannot be moved to heliumdb_test.

## No seed data
Only schema structure is cloned — no data. Tests that need config rows (e.g. `admin_config`) must use `INSERT ... ON CONFLICT DO UPDATE` instead of plain `UPDATE`, so the row is created if absent.

## information_schema queries in tests
Any test querying `information_schema.columns` or `pg_indexes` must filter by `table_schema = current_schema()` (or `schemaname = current_schema()` for pg_indexes). Without this filter, both `public` and `heliumdb_test` rows are returned, doubling counts.

## How to apply
- Adding a new test that reads system catalog tables: always add schema filter
- Adding a test that relies on admin_config seed data: use upsert pattern
- Adding a new table to public schema: it will be automatically cloned on next test run (pg_dump picks it up)
