# Migrations and Backfills

> Safe schema and data-change practices. Schema lives in `lib/db/src/schema/*.ts`
> (Drizzle). Apply locally with `pnpm --filter @workspace/db push-force` then
> `pnpm --filter @workspace/db run migrate`. Verify with the test runners in
> [`testing-guide.md`](../tests/testing-guide.md).

## Migration principles

- A migration plan must reason about **every row state** it can produce: old, new,
  partially migrated, failed, skipped, and no-op. Don't assume all rows are fresh.
- **Migrations must be idempotent and observable** — re-running must be safe, and
  the change must expose what it did (counts).
- Prefer **database-backed config** for tunable operational settings over hardcoded
  constants, so operators can adjust without a deploy.
- Guard destructive operations (see rollback/recovery).
- **A migration cannot manufacture a privilege boundary above itself.** It
  runs as the application role, so it owns everything it creates — an
  `OWNER TO`/`CREATE ROLE` sequence written into the migration either
  succeeds only where it buys nothing (the application can take the
  privilege straight back) or actively creates the bypass it's trying to
  close (see the `CREATE ROLE` auto-grant trap below). If a table needs a
  real privilege boundary the application role cannot cross, the migration
  creates the objects and **reports** the residual state
  (`ncmecAuditBoundaryStatus()`-style); closing the boundary is a superuser
  runbook run after the migration applies. See
  [`docs/engineering/ncmec-audit-ledger-hardening.md`](./ncmec-audit-ledger-hardening.md)
  for a worked example and the
  [2026-08-07 `decisions.md` entry](../ai-context/decisions.md#2026-08-07--a-migration-cannot-manufacture-a-privilege-boundary-above-itself--ncmec-audit-ledger-hardening-moved-to-a-superuser-runbook).
- **A migration file already merged into `main` is byte-for-byte immutable.**
  The hash-tracked runner (`lib/db/src/migrate.ts`) decides "already applied"
  by SHA-256 of the whole file, not tag/filename/journal index — editing even
  a comment in an already-merged migration makes any database that already
  ran it replay the whole file on its next `migrate()` call, which is not
  safe by default (a replayed `INSERT` duplicates a row, a replayed
  conditional `DELETE` can remove something a later action restored). Wrong
  comment, wrong behavior, whatever the reason: fix it with a **new**
  forward-only migration, or by editing a different file that talks *about*
  the migration instead of the migration itself. Full incident and the
  hashing mechanism:
  [`known-failure-patterns.md`](../ai-context/known-failure-patterns.md#editing-an-already-merged-migration-file--even-a-comment--makes-the-hash-tracked-runner-replay-it).
- **Don't verify a CHECK constraint's meaning by pattern-matching
  `pg_get_constraintdef()`'s rendered text** — it isn't a fixed point (see
  [`known-failure-patterns.md`'s "PostgreSQL role/constraint verification
  traps"](../ai-context/known-failure-patterns.md#postgresql-roleconstraint-verification-traps-that-look-safe-and-arent)),
  and no amount of pattern-refinement converges against an adversarial
  predicate. If a migration needs a constraint to be exactly right on
  replay, rebuild it unconditionally (`DROP CONSTRAINT IF EXISTS` + `ADD
  CONSTRAINT`) rather than inspecting what's already there, wherever the
  role has permission to — but only once you've confirmed the table has no
  rows that could already violate the new predicate (an empty table, or an
  explicit preflight/repair pass on a populated one). The `DROP` always
  succeeds; the replacement `ADD CONSTRAINT` raises a check violation and
  rolls back the whole migration if a row the current, possibly-drifted
  constraint already admitted would fail the tightened one.

## Drizzle conventions

- One schema file per concern in `lib/db/src/schema/*.ts`.
- **Known caveat — the generator is broken:** `drizzle-kit generate` currently
  fails on a malformed snapshot (around the 0063 snapshot). New migrations rely on
  a **`SNAPSHOT_EXEMPT_TAGS`** workaround plus **hand-written idempotent SQL**
  (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.). Do not assume
  `drizzle-kit generate` will produce a clean snapshot; follow the existing
  hand-authored pattern and check recent migrations for the convention.
- Apply schema to the local public schema first (`push-force`), then run
  `migrate`, then re-clone the test schema (`run-test.sh --setup`) so tests see the
  updated shape (see the api-context memory + `docs/tests/TESTING.md`).

### Adding a value to a Postgres enum

`ALTER TYPE … ADD VALUE` **cannot run inside a transaction block**, but the
hash-based migration runner (`lib/db/src/migrate.ts`) wraps each migration file in
one `BEGIN…COMMIT`. So don't use `ADD VALUE` — recreate the enum via a temporary
text cast (the 0027 precedent), which also lets you place the new label anywhere in
the order and stays idempotent (the whole file re-runs cleanly). For a column that
is `NOT NULL` with a default + an index, the recast is: **drop the default → alter
column `TYPE text USING …::text` → `DROP TYPE` → `CREATE TYPE` with the new label →
alter column back to the enum → re-set the default.** The dependent index is rebuilt
automatically by the type change. Keep the enum labels in sync with the shared
`@workspace/api-zod` values array, and add the hand-authored migration to
`SNAPSHOT_EXEMPT_TAGS`. **Overhype:** `0083_review_workflow_stage_concept_review.sql`
adds `concept_review` between `prep_failed` and `production_review` this way.

### Concurrent PRs claiming the same migration index

Migration numbering is manual (see the drizzle-generator caveat above), so two
PRs opened around the same time can independently pick the same next index
(e.g. both write `0089_*.sql` and append `idx: 89` to
`lib/db/migrations/meta/_journal.json`). Git's merge auto-resolves everything
around it but conflicts exactly on the journal's tail entry. **Resolution: the
PR that merges first keeps its number; the other PR renumbers to the next free
index** (rename the `.sql` file, fix its journal entry, and grep the PR's own
docs for the old number — a TEST_RUN/UAT doc or an inline comment can cite it).
**Also grep the migration file's own SQL for the old number** — a literal
inside a `RAISE NOTICE`/comment string is easy to miss since it isn't the
filename or the journal entry, but it's still a rename site (PR #427 renamed
`0099_membership_sequence_repair.sql` to `0100_...` after colliding with
another PR's `0099`, and the repair migration's own `RAISE NOTICE` text still
needed the update). Never renumber an already-merged migration — per the
immutability rule above, once a migration's PR has merged, its number is
permanent alongside everything else in the file.

## Idempotency

Every migration and backfill must be **safe to run more than once**:

- DDL: `IF NOT EXISTS` / `IF EXISTS` guards.
- Backfills: only touch rows that still need it (filter on the target state), so a
  re-run is a no-op for already-done rows.
- Reference example: `taxonomyHealth/projectionRepair.ts` rewrites only the four
  derived projection columns from the stored JSON, touching nothing else — safe to
  run repeatedly and in bulk.

## Backfill strategy

- Filter to the rows that actually need the change; leave the rest untouched.
- **Preserve human decisions.** The enrichment backfill (`factEnrichmentBackfillJob`)
  **skips admin-edited rows** unless `forceOverwriteAdminEdited` is set — mirror
  that discipline: never let a bulk job silently overwrite manual overrides.
- Run large backfills through the **async job queue** (`async_jobs`) so progress is
  durable and visible, not a fire-and-forget script.

## Dry-run expectations

For any broad data change, be able to report **what would change before changing
it**: counts of rows matched, would-skip, and would-fail. If the change is
risky, land the counting/reporting path first and inspect it before executing.

## Partial migration states

Assume a migration/backfill can be interrupted. Design so a partially-applied run
leaves the system in a coherent state and a re-run completes it. Distinguish
"not yet migrated" from "migrated" with a durable marker (a column/flag/version),
not an in-memory assumption.

## Rollback and recovery

- Avoid destructive operations (drops, irreversible rewrites) unless the plan
  **explicitly** includes recovery/rollback.
- Data deletion is two-phase (soft → hard) with anonymization holds where legally
  required — see `docs/data-lifecycle-retention-matrix.md`. Don't hard-delete where
  the product keeps history (e.g. rejected enrichment candidates are retained, not
  deleted).
- Prefer additive changes (new column/table) over in-place destructive rewrites
  when possible.

## Observability and counts

Broad data changes must **expose counts and failed/skipped records** — how many
processed, succeeded, failed, skipped, no-op. Surface this the same way the rest of
the product does async work: per-item + aggregate status (Taxonomy Health is the
reference). Silent bulk mutation is a bug.

## Tests

- Apply the migration, re-clone the test schema (`run-test.sh --setup`), run the
  affected DB-backed tests.
- Test **idempotency** (run the backfill twice → identical result) and the row-state
  matrix (old/partial/failed/skipped/no-op).
- Confirm new columns/indexes exist and projections stay in sync (e.g.
  `projectionRepair` tests).

## PR checklist

- [ ] Schema change uses idempotent, hand-authored SQL (generator caveat).
- [ ] Local `push-force` + `migrate` applied; test schema re-cloned.
- [ ] Backfill is idempotent and filters to rows that need it.
- [ ] Human/admin-edited data is preserved (skip-unless-forced).
- [ ] Counts / failed / skipped are observable.
- [ ] Row-state matrix reasoned about in the plan.
- [ ] Rollback/recovery described for anything destructive.
- [ ] Tests cover idempotency + the affected states; CI `Build` + `Test` green.
