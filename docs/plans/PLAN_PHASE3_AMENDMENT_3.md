# Plan amendment 3 — Launch Phase 3, increment 8: adoption creates the ledger's table and tolerates Replit's own record

Amends `docs/plans/PLAN_PHASE3_AMENDMENT_2.md` (sha256 `339d593965d2010209cc2010228d404bbe5cdbabb5cf20c27b4461f379f282a2`), steps 2 to 4. Workstream: Issue #770.

```plan-oracle
# Oracle — Launch Phase 3, amendment 3: adoption creates the ledger's table and tolerates Replit's own record

Agreed with David 2026-10-30 ("Go with option 1", replying to the banner whose
option 1 read: "Amendment 3: adoption creates the migration record itself, then
proves it. It creates the drizzle schema and the migration-record table using
the runner's exact statements (lib/db/src/migrate.ts:263-265), the same ones
every fresh database gets. It also allows Replit's _system record, excluding it
only from the 'no rows anywhere' check, and allows stripe and the test caches
to be absent. The structure proof is otherwise unchanged. public is compared
before anything is written, and drizzle is compared inside the transaction,
before the commit. The crash becomes a clean refusal.").

## Why

The live run of 2026-10-30 (~05:40 UTC) changed nothing. Production, measured
read-only at ~05:50 UTC, holds `public` (50 tables, 0 rows, owned by the
operator role) and `_system` (Replit's publish record,
`replit_database_migrations_v1`, 1 row). It has no `drizzle` schema, so no
ledger table, and no `stripe` or test-cache schemas. Amendment 2's eligibility
expected `drizzle` and refused anything unknown, so it could only ever refuse;
and a missing compared schema crashed the comparison instead of refusing.

## Product intent of this amendment

1. Amendment 2's intent stands unchanged: production comes back up on a
   database whose structure is exactly what the code builds, holding no
   pre-reset data, and nothing is adopted on trust.
2. When production has no ledger table, adoption creates it with the runner's
   own statements, and proves it equal to the reference's before the commit.
3. Replit's own publish record (`_system`) is left alone: tolerated, never
   compared, and exempt from the zero-row check only.
4. A missing schema refuses with a reason; nothing crashes before a report.

## Must not change

- Amendment 2's must-not-change list, in full.
- The runner (`lib/db/src/migrate.ts`) is not edited.
- `public` is compared before anything is written; any difference refuses.
- Nothing is copied from dev.

## Settled decisions

- Amendment 2's settled decisions, D4 included.
- Option 1, as quoted above (David, 2026-10-30).
- `stripe`, `heliumdb_test` and `drizzle_test` may be absent; if present they
  must hold no rows (amendment 2, D4).

## Ceremony tier

Sensitive. One PR, Codex review on every changed head. No separate Astra plan
round (recommended in the banner David approved).
```

## The change

- **Schemas.** Required: `public`. Optional and compared: `drizzle`. Tolerated:
  `stripe`, `heliumdb_test`, `drizzle_test`, `_system`. Anything else refuses.
- **Zero rows** in every table of every schema except `_system`.
- **Comparison.** A compared schema that is absent contributes the line
  `<schema>: schema absent`, so a missing `public` refuses with a named
  difference rather than an error. When production has no `drizzle`, the
  pre-write comparison covers `public` and the extensions only.
- **Installation.** When `drizzle` is absent, the transaction first runs the
  runner's two statements (`CREATE SCHEMA IF NOT EXISTS "drizzle"`, and the
  `__drizzle_migrations` table: `id SERIAL PRIMARY KEY, hash text NOT NULL,
  created_at bigint`). It then compares the `drizzle` schema with the
  reference's, and any difference rolls back. Everything after that is
  amendment 2's step 4.

## Verification

- The adoption test gains Replit's measured shape: no `drizzle` schema, plus
  `_system` with one row. Adoption succeeds; `_system`'s row is untouched; the
  ledger matches the reference's.
- A forced failure after the sequences move, in that shape, leaves no
  `drizzle` schema behind.
- A missing `public` refuses with a reason and does not throw.
- Every amendment 2 case still passes.
- Live: the run through the connector on David's go, then amendment 2's live
  checks.
