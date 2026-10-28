# Migrations and Backfills

> Safe schema and data-change practices. Schema lives in `lib/db/src/schema/*.ts`
> (Drizzle). Apply locally with `pnpm --filter @workspace/db run migrate`; how
> every database is built and changed is *How a database receives a change*,
> below. Verify with the test runners in
> [`TESTING.md`](../tests/TESTING.md).

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

## The migration policy: every migration leaves the previous release working

Launch Phase 3, #770 (plan `docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md` §6).
This section is the rule's only statement; the rest of this file is how to
write a migration well, and this is what one is allowed to do.

### Why the previous release matters

Migrations run at boot, before the server listens
(`artifacts/api-server/src/index.ts`: `runMigrations()`, then `ensureSchema()`,
then `listen()`), and only forward: the runner has no down step. Two things
follow, and neither needs a fault to happen:

- **During a publish, the old code runs on the new schema.** The deployment is
  autoscale (`.replit`, `deploymentTarget = "autoscale"`): instances of the new
  release boot and migrate the one shared database while instances of the
  previous release are still serving.
- **Going back to the previous release leaves the schema where it is.**
  Reverting the code, by any route, puts the old code on the migrated
  database.

So a migration that only the new code can live with breaks the product for
the length of every rollout, and makes going back a second outage.

**When it binds: from Seed, the first real user.** Until then the fleet's
pre-launch latitude holds
([`agent-working-rules.md`](../ai-context/agent-working-rules.md), *be
brave*: destructive migrations are fine when simpler), because a broken
rollout harms no one: a contract may ship in the same release as the code
that stops using it. What binds now is the rest of this section: a migration
is right on both paths a database takes, and nothing is built any other way.

### Expand, then contract

- **Expand — any release.** Add a table; add a column that is nullable or has
  a default; add an index; add an enum label (by the recast below); add a
  constraint **only if every write the previous release makes already
  satisfies it**. Insert or update config rows the previous release ignores or
  reads compatibly. The code that uses the new shape ships with it.
- **Contract — a later release, in its own migration.** Drop a table or
  column, rename one, make a column `NOT NULL`, narrow a type, remove an enum
  label, or tighten a constraint the previous release can violate — only once
  the release currently published neither reads nor writes what is removed.
  A rename is therefore three steps over at least two releases: add the new
  name and write both, switch reads to the new one, then drop the old one.
- **A backfill tolerates the previous release.** Rows the old code writes
  after the migration ran are one more row state in the matrix (*Migration
  principles*): the new code reads them correctly, or a later idempotent pass
  converts them.
- **A migration says which it is.** The PR body names each migration as
  expand or contract; a contract names the published release that stopped
  using what it removes.

### How a database receives a change

The runner (`lib/db/src/migrate.ts`, under its advisory lock) decides by the
database's state, never by a flag:

| Database at boot | What it receives |
|---|---|
| empty: no tables in the schema, no ledger | the baseline (`lib/db/migrations/baseline/`), the ledger rows of every migration up to its cutoff, in one transaction; then every later migration |
| ledger present | its pending migrations only, in journal order, each in its own transaction |
| tables but no ledger | **refused**, with the reason; the server does not start |

- **A new migration must be right on both paths.** On a fresh database it
  runs on top of the baseline: every earlier migration's structure and seed
  rows, and no product rows. On a long-lived one it runs on whatever rows
  that database holds. CI's `Test` job builds fresh;
  `lib/db/src/baseline.test.ts` upgrades the historical reference; the
  upgrade rehearsal (*Tests*, below) runs it over real dev data.
- **No database is built or changed any other way.** `drizzle-kit push`
  never runs (`.claude/settings.json` denies it; `baseline.test.ts` fails on a
  script that invokes it), and no database's schema or rows are copied into
  another to stand in for its migrations: the dev-to-production copy tools
  were deleted when production became code-built (`decisions.md`,
  2026-10-28). When Replit's publish offers to apply dev's schema differences
  to production, the answer is to keep production as it is: the published app
  migrates itself at boot.
- **A live repair is still a migration.** Replit Agent may repair a schema
  problem against the running environment
  ([`replit-environment.md`](../ai-context/replit-environment.md), settled
  2026-08-09); what it applies is a migration file run by the runner, and it
  reaches `main` through a pull request like every other change.
- **A test runner's clone is a cache, not a route.** The api-server runners
  copy the structure of a test database that `migrate` has just built (the
  per-worker template databases, `run-test.sh`'s cached schema;
  [`TESTING.md`](../tests/TESTING.md)). The source is migration-built in the
  same run, so the copy stands in for nothing. It is never taken from dev or
  production.
- **A hand-written constraint or index needs no `schema.ts` shadow to
  survive.** That rule existed because a push rebuilt databases from the
  TypeScript schema and dropped what only a migration created; no push runs
  now. Declaring the object in `schema.ts` remains good practice for
  readability, and `baseline.test.ts` holds tables and columns (not indexes or
  checks) to parity with the TypeScript schema.

### Cutting a new baseline

The baseline is a cache of the history: the catalog and seed rows every
migration up to its cutoff produces. A fresh database built from it, then
upgraded, equals one built from an older baseline, then upgraded, so cutting a
new one changes no database's shape. Existing databases never read it.

- **When.** Only for a reason the PR names: the migrations after the cutoff
  have made fresh builds (CI, every test database, acceptance) measurably
  slower, or a post-cutoff migration does expensive work a fresh database
  should not repeat. Never on a schedule, and never inside a PR that also
  changes a migration or the schema.
- **How.** Its own PR, holding only the regenerated
  `lib/db/migrations/baseline/` (`baseline.sql`, `baseline.json`):

  ```
  DATABASE_URL=postgres://<local superuser>/… pnpm --filter @workspace/db exec tsx scripts/generate-baseline.ts
  ```

  The generator (`lib/db/scripts/generate-baseline.ts`) takes the journal head
  as the new cutoff, builds the structure by upgrading the historical
  reference (`lib/db/baseline-reference/`) through the real runner, takes the
  seed rows from a full replay, and runs no push. It refuses a deployment.
- **Never by hand.** `baseline.sql` is never edited: `migrate.ts` checks its
  sha256 against `baseline.json` and refuses a mismatch. The historical
  reference is never regenerated or replaced; it is dev's real catalog and
  ledger before Phase 3, and the standing check upgrades it to the baseline.
- **Every migration file stays.** A fresh database's ledger rows carry the
  sha256 of each migration file up to the cutoff, read from the file, so no
  migration is deleted or squashed when the cutoff moves past it.
- **Verified by:** `baseline.test.ts` (the reference upgraded equals the
  baseline's catalog; the baseline holds every object the full history
  creates; a migration after the cutoff still runs), the full `Test` job on a
  fresh build, and a `baseline.sql` diff that shows only the folded-in
  migrations' objects and rows plus the seed rows' generation timestamps.

## Drizzle conventions

- One schema file per concern in `lib/db/src/schema/*.ts`.
- **Known caveat — the generator is broken:** `drizzle-kit generate` currently
  fails on a malformed snapshot (around the 0063 snapshot). New migrations rely on
  a **`SNAPSHOT_EXEMPT_TAGS`** workaround plus **hand-written idempotent SQL**
  (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.). Do not assume
  `drizzle-kit generate` will produce a clean snapshot; follow the existing
  hand-authored pattern and check recent migrations for the convention.
- Run `migrate` against the local public schema, then re-clone the test schema
  (`run-test.sh --setup`) so tests see the updated shape (see the api-context
  memory + `docs/tests/TESTING.md`).

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
docs for the old number — a UAT doc, the PR body's verification section, or an inline comment can cite it).
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
- **Standing upgrade checks run in CI** (`lib/db/src/baseline.test.ts`): dev's
  historical catalog and ledger upgrade to exactly the baseline's catalog,
  applying only the migrations written since, and a replay of every migration
  creates nothing the baseline lacks.
- **The upgrade rehearsal on a real database** runs on the Repl, where the
  frozen snapshot is: `artifacts/api-server/scripts/upgrade-rehearsal.ts`
  restores it into a scratch database, boots the current code on it, and fails
  on a lost row, an orphaned relationship, a sequence behind its column, or a
  changed operator setting; `acceptance-run.ts --mode replay --variant fresh
  --source-dump <file>` runs the journeys over the same upgraded snapshot. A
  failure is fixed in the migration or the code, never by refreshing the
  snapshot.

## PR checklist

- [ ] Each migration is named expand or contract, and leaves the previous
      release working (*The migration policy*); a contract names the release
      that stopped using what it removes.
- [ ] Schema change uses idempotent, hand-authored SQL (generator caveat).
- [ ] Local `migrate` applied; test schema re-cloned.
- [ ] Backfill is idempotent and filters to rows that need it.
- [ ] Human/admin-edited data is preserved (skip-unless-forced).
- [ ] Counts / failed / skipped are observable.
- [ ] Row-state matrix reasoned about in the plan.
- [ ] Rollback/recovery described for anything destructive.
- [ ] A new table is classified in `lib/db/src/tableClassification.ts` (product,
      config, runtime or an excluded class), and a new column on a config table
      is given an owner (code, admin or runtime); `tableClassification.test.ts`
      fails until it is. A code-owned config value comes from a migration or a
      boot seed, never only from a database it was typed into: the config diff
      (`artifacts/api-server/scripts/config-diff.ts`) is how a gap is found.
- [ ] Tests cover idempotency + the affected states; CI `Build` + `Test` green.
