---
name: Raw-SQL migration additions need a matching schema.ts declaration
description: Why a hand-written migration's CHECK constraint or index can silently vanish from a drizzle-kit push–built database, and how to keep the two in sync.
---

# A hand-authored migration's DDL needs a schema.ts shadow, or `push` and `migrate` diverge

This repo has two ways a database's shape gets built: `drizzle-kit push`
(diffs the live DB against `lib/db/src/schema/*.ts`'s `pgTable` definitions) and
`pnpm --filter @workspace/db run migrate` (replays the hand-authored SQL files
in `lib/db/migrations/`, via the hash-tracking runner in `lib/db/src/migrate.ts`).
Anything a migration creates in raw SQL — a `CHECK` constraint, a `CREATE INDEX`
— that ISN'T also declared as a matching `pgTable` option (a `check()` builder,
an `index()` entry) is invisible to `push`. A `push`-only environment (or one
where `push` runs again after `migrate` already ran) can end up missing it
entirely, or — worse — `push --force` can *drop* a constraint/index that
`migrate` already added, since `push` reconciles the DB to match schema.ts and
doesn't know the extra object is supposed to be there.

**Two real instances, same root cause, both from PR #242 (fact-lifecycle
closure):**

1. **The sandbox's own test-DB drop (`scripts/setup-test-db.sh`).** Step 5 runs
   `drizzle-kit push --force` (needed because `push` doesn't model the CHECK/seed
   DML), then step 6 runs `pnpm migrate` to layer the raw-SQL constraints/seeds
   back on top. `facts_active_requires_concept` (an `ADD CONSTRAINT` in
   migration `0092`) isn't declared in `schema.ts` — so `push --force` on an
   ALREADY-migrated DB (e.g. a persistent sandbox volume across sessions) can
   drop the constraint push doesn't know about, and `migrate`'s hash-based
   tracking then thinks the migration file already ran (its file hash is
   already recorded) and skips re-applying it — the constraint never comes
   back. Hit 3 times in one PR-review session; diagnosed via `\d+ facts` /
   `pg_constraint` showing it genuinely absent, fixed by manually re-running the
   `ALTER TABLE ADD CONSTRAINT` each time. This exact failure mode is sandbox-only
   (Replit and prod never run `push`), but it wastes real debugging time whenever
   it recurs — verify with `pg_constraint`/`\d+ <table>` directly before assuming
   "flaky," and just re-run the `ALTER TABLE` to unblock local verification.
2. **`pending_reviews.parent_fact_id`'s index.** Migration `0091` creates
   `idx_pending_reviews_parent_fact` via `CREATE INDEX`, but `schema.ts`'s
   `pgTable` never declared a matching `index(...)` entry — caught by Codex
   review, not by any automated check. A `push`-built DB (any environment, not
   just the sandbox) would silently never get this index.

**Rule:** whenever a migration adds a raw-SQL `CREATE INDEX` or
`ALTER TABLE ADD CONSTRAINT`, add the equivalent declaration to the table's
`pgTable(...)` definition in the same commit — `index("name").on(table.col)` for
indexes, a `check()` builder for constraints (or a documented note if Drizzle's
`check()` can't express it). `pnpm --filter @workspace/db run validate-snapshots`
does NOT catch this (migrations are snapshot-exempt by convention) — this is a
manual discipline, not something CI currently guards.
