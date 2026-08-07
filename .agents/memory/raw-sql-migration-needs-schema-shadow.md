---
name: Raw-SQL migration additions need a matching schema.ts declaration
description: Why a hand-written migration's CHECK constraint or index can silently vanish from a drizzle-kit push–built database, and how to keep the two in sync.
---

# A hand-authored migration's DDL needs a schema.ts shadow, or `push` and `migrate` diverge

This repo has two ways a database's shape gets built: `drizzle-kit push`
(diffs the live DB against `lib/db/src/schema/*.ts`'s `pgTable` definitions) and
`pnpm --filter @workspace/db run migrate` (replays the hand-authored SQL files
in `lib/db/migrations/`, via the hash-tracking runner in `lib/db/src/migrate.ts`).
Anything a migration creates in raw SQL — a `CHECK` constraint, a `CREATE INDEX`,
a standalone `CREATE SEQUENCE` — that ISN'T also declared with a matching
schema.ts declaration (a `check()` builder or `index()` entry on the owning
`pgTable` for the first two, a `pgSequence` for the third — no `pgTable` can
shadow a sequence) is invisible to `push`. A `push`-only environment (or one
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
   `ALTER TABLE ADD CONSTRAINT` each time. Verify with `pg_constraint`/`\d+
   <table>` directly before assuming "flaky," and just re-run the
   `ALTER TABLE` to unblock local verification.

**Not sandbox-only — confirmed in GitHub Actions CI too (PR #293).** The
original version of this note scoped the failure mode to the sandbox
("Replit and prod never run `push`"), reasoning that only a sandbox session
runs `push` a second time against an already-migrated database. That scoping
was wrong: `build.yml`'s `Test` job ran `push-force` + `migrate` for
`@workspace/db`'s **own** test suite directly against `overhype_test` — the
same database api-server's sharded tests clone *from*. api-server's own
`pretest` then runs `push-force` **again** as part of its normal setup. The
second `push` reconciled an already-migrated database to the Drizzle
snapshot and silently dropped every object that exists only in raw migration
SQL and has no `schema.ts` shadow (in this case, `facts_active_requires_concept`
and migration `0095`'s two standalone sequences, `membership_source_state_seq`
and `membership_lease_fence_seq` — runtime code calls `nextval()` on both, but
`membershipEntitlements.ts` declares neither as a `pgSequence`, so `push` has
never known either one is supposed to exist) — and the `migrate` that followed could not repair it, because
its hash-based tracking already recorded those migrations as applied. 19
unrelated test failures across four suites resulted, with no schema-shadow
gap of this PR's own to blame. Fixed by giving `@workspace/db`'s own suite a
**separate** database (`overhype_db_test`) so its push+migrate cycle never
touches the database api-server's tests are cloned from. **The lesson
generalizes beyond CI, but only for migrations without a complete,
accurate `schema.ts` shadow.** If every raw-SQL object a migration creates
has a matching schema.ts declaration (a `pgTable` option for a
table-scoped index/constraint, a `pgSequence` for a standalone sequence),
`push` reconciles the database to
that declared state and won't drop it — the shadow prevents the loss
outright, not just the unrecoverability. The exposure is real whenever
that shadow is missing or doesn't match (a stale index predicate, a CHECK
whose Drizzle-rendered form diverges from the migration's), and it fires on
**any** `push` run against a database where an unshadowed migration has
already applied — not specifically a *second* push. A database built by
`migrate` alone, with no prior `push` at all, is just as exposed on its
very first `push` afterward; the mechanism only needs `migrate` then
`push`, in that order, once. Not only across sandbox sessions, and not only
in this repo's specific CI shape.
2. **`pending_reviews.parent_fact_id`'s index.** Migration `0091` creates
   `idx_pending_reviews_parent_fact` via `CREATE INDEX`, but `schema.ts`'s
   `pgTable` never declared a matching `index(...)` entry — caught by Codex
   review, not by any automated check. A `push`-built DB (any environment, not
   just the sandbox) would silently never get this index.

**Rule:** whenever a migration adds a raw-SQL `CREATE INDEX` or
`ALTER TABLE ADD CONSTRAINT`, add the equivalent declaration to the table's
`pgTable(...)` definition in the same commit — `index("name").on(table.col)` for
indexes, a `check()` builder for constraints (or a documented note if Drizzle's
`check()` can't express it). A standalone `CREATE SEQUENCE` needs its own
`pgSequence(...)` declaration instead — no `pgTable` option can shadow an
object that isn't scoped to a table. `pnpm --filter @workspace/db run validate-snapshots`
does NOT catch either shape (migrations are snapshot-exempt by convention) —
this is a manual discipline, not something CI currently guards.
