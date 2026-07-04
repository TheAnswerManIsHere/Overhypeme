# Migrations and Backfills

> Safe schema and data-change practices. Schema lives in `lib/db/src/schema/*.ts`
> (Drizzle). Apply locally with `pnpm --filter @workspace/db push-force` then
> `pnpm --filter @workspace/db run migrate`. Verify with the test runners in
> [`testing-guide.md`](./testing-guide.md).

## Migration principles

- A migration plan must reason about **every row state** it can produce: old, new,
  partially migrated, failed, skipped, and no-op. Don't assume all rows are fresh.
- **Migrations must be idempotent and observable** — re-running must be safe, and
  the change must expose what it did (counts).
- Prefer **database-backed config** for tunable operational settings over hardcoded
  constants, so operators can adjust without a deploy.
- Guard destructive operations (see rollback/recovery).

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
  updated shape (see the api-context memory + `docs/TESTING.md`).

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
