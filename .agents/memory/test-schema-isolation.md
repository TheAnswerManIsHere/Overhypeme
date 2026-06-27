---
name: Api-server test database isolation
description: Full-suite api-server tests use per-worker throwaway databases; targeted tests use the cached heliumdb_test schema. The dev/prod public schema is never touched.
---

> Canonical reference: **`docs/TESTING.md`**. This memory captures the gotchas an
> agent most often trips on; read `docs/TESTING.md` for the full picture
> (isolation modes, production guard, DB-name glossary, CI gate).

## Rule
api-server tests never touch the live `public` schema. There are **two** runners,
which isolate differently:

- **Full suite** (`pnpm --filter @workspace/api-server test` →
  `run-tests-sharded.sh`): each parallel worker gets its **own** throwaway
  database — per-worker databases cloned from a structure-only template by
  default (`CREATE DATABASE … TEMPLATE`), or per-worker schemas
  (`heliumdb_s_*`) as a fallback when `CREATE DATABASE` is denied. It does **not**
  drop/recreate a single shared `heliumdb_test` schema.
- **Targeted** (`bash artifacts/api-server/scripts/run-test.sh <file>`): uses a
  single **cached** `heliumdb_test` schema, re-cloned from `public` only when
  stale or when `--setup` is passed. This is the inner-loop runner, not the gate.

Only structure is cloned — **no data**. Tests create the rows they need.

## Production guard
Both runners refuse to run against `heliumdb` (Overhype's prod *and* dev DB) or
with `NODE_ENV=production`. Point `DATABASE_URL` at the test DB (`heliumdb_test`
on Replit via `TEST_DATABASE_URL`, `overhype_test` in CI/sandbox).

## Gotcha: information_schema / pg_indexes queries
Any test querying `information_schema.columns` or `pg_indexes` must filter by
`table_schema = current_schema()` (or `schemaname = current_schema()` for
`pg_indexes`). Without the filter, both `public` and the test schema rows come
back, doubling counts — this matters in the per-schema fallback and the targeted
`heliumdb_test` schema, where `public` is still on the search_path.

## Gotcha: seed data must upsert
Only structure is cloned, so any test that relies on config rows (e.g.
`admin_config`) must use `INSERT … ON CONFLICT DO UPDATE`, not a plain `UPDATE`,
so the row is created if absent.

## How to apply
- New test reading system catalogs → add the `current_schema()` filter.
- New test relying on seed data → use the upsert pattern.
- New table in `public` → it's cloned automatically on the next test run.
