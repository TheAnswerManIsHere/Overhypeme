# Plan amendment 2 — Launch Phase 3, increment 8: production's first database is adopted with proof, not built empty

Amends `docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md` (sha256 `fb1fd6b31475fa4bc07f885709f4d276cb48c416333d00627121fdebcc4a8e56`) §7 step 2, as already amended by `docs/plans/PLAN_PHASE3_AMENDMENT_1.md` (sha256 `6df15b855368d9af86f41c33bd41268039cf004384dd93766e212e074b8d62cd`) Part C step 3. Workstream: Issue #770.

```plan-oracle
# Oracle — Launch Phase 3, amendment 2: production's first database is adopted with proof

Agreed with David 2026-10-30 ("Approved.", replying to the banner that offered:
"adopt Replit's structure with proof, as plan amendment 2 … What changes in
principle: 'production is built from code' becomes 'built from code, or proven
identical to what the code builds', for this one moment only. The runner's
refusal stays in place for every future case."). Parent plan
docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md §7 step 2 assumed "the next publish
creates an empty one"; that is measured false on Replit (below).

## Direction (unchanged from the parent plan)

Production can be built from code alone, upgraded, and restored. Seed opens on
a fresh production database before any real user contributes.

## Product intent of this amendment

1. Production comes back up on a database whose structure is exactly what the
   code builds, holding no pre-reset data, and its first boot seeds settings
   from code as any fresh database's does.
2. Nothing is adopted on trust: the structure is proven identical to a
   database the code built, and any difference, or any row of data, refuses
   and changes nothing.
3. The runner's refusal of "tables but no migration record" stays exactly as
   it is for every boot. The adoption is a one-time operator step, run on
   David's go, never something the server does on its own.

## Must not change

- Amendment 1's decisions (D1–D3) and its case record; the final capture stays
  where it is.
- The runner's three database states and its refusal (`lib/db/src/migrate.ts`).
- No copy of dev's data into production; no `drizzle-kit push`.
- Existing migrations keep their numbers and behaviour.
- Publishing stays David's.

## Settled decisions

- The parent plan's and amendment 1's settled decisions.
- At publish, approve Replit's generated migration
  (`docs/engineering/migrations-and-backfills.md`, *How a database receives a
  change*; `decisions.md`, 2026-10-28).
- Route chosen: adopt with proof (David, 2026-10-30, "Approved.").
- D4: dev's two empty test-cache schemas (`heliumdb_test`, `drizzle_test`) are
  kept in production for this adoption, outside the application schema's
  equality claim, verified empty; their removal at source is a follow-up
  (David, 2026-10-30, "Approved, D4 keep").

## Ceremony tier

Sensitive (production database, migration ledger). Astra plan review, one PR,
Codex review on every changed head, `overhype-migration-review` lens.
```

## What was measured, 2026-10-30, that changes §7 step 2

All through the connector, recorded on Issue #770 (comments of ~03:20 to ~04:45 UTC).

1. **No publish leaves production's database empty.** After David deleted the old database, a resume and two republishes crash-looped against its disabled endpoint. A third publish, with "Create production database" ticked and the dev-data copy unticked, created a new database. Replit's publish then put **dev's schema** into it: 128 tables across `public` (50), `stripe` (29), `heliumdb_test` (47), `drizzle` (1) and `drizzle_test` (1), with **every row count 0**. The `heliumdb_test` and `drizzle_test` schemas are dev's test-runner caches, which shows that the source was dev and not the code.
2. **There is no skip.** The publish shows *Generated migrations to apply to production database*, with only **Approve and publish**, **Create preview deploy** or **Cancel** (David's screenshot, 22:40 local). Replit's own documentation, as the connector relayed it: *"Replit Agent does not support provisioning an empty production database separately from the publishing process"*. `docs/ai-context/replit-platform.md` (*The two databases*): *"At publish, production's schema is brought to the development database's … a repo whose app also runs guarded migrations at boot must tolerate a schema Replit already applied."*
3. **The runner refuses exactly that state**, by design (`lib/db/src/migrate.ts`): *"tables present but no ledger rows: REFUSE. Something other than this runner built the schema (a schema push, a platform copy)"*.
4. **The Stripe mirror already handles it.** `stripe-replit-sync`'s `runMigrations` treats an existing `stripe` schema whose `_migrations` table is empty by cleaning the schema and running its own migrations (`node_modules/…/stripe-replit-sync/dist/index.js`, `runMigrations`: *"if (isEmpty) { await cleanupSchema(client, schema, …) }"*). So the `stripe` schema needs nothing from us.

So on Replit, production's first database always arrives carrying dev's structure and no migration record. Building it empty from code is not available. Proving it equal to what the code builds is.

## The change

**A one-time operator command, `scripts/production-adopt.ts`, run through the connector against `RESET_PRODUCTION_DATABASE_URL` (now the new database), after David has approved Replit's migration on a publish.** It builds a reference database from the code, proves that production's structure equals it, and installs what the code's migrations install: the rows and the migration record. On Replit, that makes production the database a first boot from code would have produced.

**1. The reference.** A scratch database on dev's server, built by the runner itself (`runMigrations`: the baseline, then every later migration) and nothing else, so it holds exactly the migrations' output: their structure, the rows they insert (the baseline's configuration, feature permissions, look styles and the entitlement-grid singleton; 0113's `nsfw_classifier_fail_open`; any other), the sequence positions, and the ledger. `ensureSchema` and the engine reconcile are not run, because the server's own boot runs them afterwards, as on any fresh database. The scratch database is dropped at the end.

**2. Eligibility, rechecked under the runner's lock.** The command holds the runner's advisory lock (`MIGRATION_LOCK_KEY`, `lib/db/src/migrate.ts`) on production from the first check to the commit, so a crash-looping server cannot race it: its runner blocks on the lock and, once the lock is released, finds the ledger and proceeds. Under the lock it refuses, changing nothing, unless every one of these holds:
- the migration ledger is empty;
- **every table in every non-system schema has zero rows**;
- the schemas present are exactly `public`, `drizzle`, `stripe`, and the two test caches `heliumdb_test` and `drizzle_test` (D4, below). Any other schema refuses.

**3. The structural proof.** The `public` and `drizzle` schemas of production and the reference are compared object by object. Every object that does not match refuses and is named. The comparison covers:
- **an inventory of every relation by kind** (table, partitioned table, index, sequence, view, materialized view, foreign table, composite type) with its **persistence** (logged or unlogged). An object kind the reference does not have refuses rather than going uncompared;
- `catalogFingerprint`'s columns (type, nullability, default, identity), constraints, indexes, functions (body hash), triggers and enums (`lib/db/src/baseline.ts`);
- **every trigger's firing mode** (`pg_trigger.tgenabled`), which matters because the child-safety audit log's append-only guards must be `ALWAYS`;
- **every sequence's full definition** (data type, start, increment, minimum, maximum, cache, cycle) **and its ownership** (the column that owns it, if any);
- the extensions installed and their schemas.

**Normalised, and nothing else:**
- column order;
- object owners and grants, which are environment-specific role names;
- the extension's *version*, since Neon and dev's server may ship different `vector` builds. The extension set and schema must still match, and both versions are printed.

The comparison is not byte-for-byte catalog equality, and the plan does not claim that it is.

**4. Installation, in one transaction.** Only after 2 and 3 pass, on the same production connection that holds the lock, inside one transaction:
- **The reference's rows go in by ordinary inserts**, in foreign-key dependency order, with every constraint and trigger enabled. That covers its `public` rows and its complete ledger, with column values and identifiers kept exactly. The reference is the source of every row. No replication setting is changed, and no trigger mode either, so the load needs no superuser privilege; Neon gives none. Through 0113 the populated tables are `admin_config`, `entitlement_grid_revision`, `feature_flags`, `feature_permissions_migration_log`, `look_styles` and `tier_feature_permissions`. None has a user trigger, and the only foreign key between them puts `feature_flags` before `tier_feature_permissions` (Astra, round 2). The order is computed from the catalog, never hard-coded.
- **Every sequence is moved to the reference's next value** with `ALTER SEQUENCE … RESTART`, which a rollback undoes. `setval()` would survive one.

Before the commit, inside the same transaction:
- every `public` table's rows are hashed and compared with the reference's;
- the ledger is compared with the reference's;
- each sequence's next value is checked against the reference's.

Any difference rolls back the whole transaction, so there is never a partial adoption. The rows are the code's output only; nothing is read from dev. Dev's database is read only for diagnosis (5).

**5. On any refusal, a three-way diagnosis.** The same comparison is run between production and dev, and between dev and the reference. The report says whether the difference came from dev drifting from the code (fixed in dev by a migration) or from Replit's copy (production differs where dev matches the code). Neither case ever loosens the comparison.

**6. One report and an exit code.** The report covers the checks, the inventory counts, the rows and ledger entries installed, the extension versions, and the verdict. Exit 0 only on adoption.

**What it leaves alone:**
- The `stripe` schema. `stripe-replit-sync` drops and rebuilds it when its `_migrations` is empty (above).
- The two empty test caches (D4).

**The runner is unchanged.** Its three states and its refusal stay exactly as they are. This exception lives only in an operator command run on David's go.

**The sequence, from where production stands now.** Step 1 is done: David approved Replit's migration and published, and the server refuses at boot (`2026-10-30T04:47:57Z Refusing to migrate: … 50 table(s) … records no migrations`).

2. Through the connector: `production-adopt.ts`. The crash-looping server's next boot finds the ledger and proceeds. Or David republishes. Either way, the runner finds nothing pending, `ensureSchema` seeds the remaining configuration from code, and the server starts.
3. Amendment 1's remaining steps: the admin proof, the audit-boundary record, the platform drill, and the secret deleted.

**Docs, in the same PR:**
- `docs/engineering/production-reset.md`: the measured route (Replit always copies dev's structure into a new production database; the adoption step).
- `docs/engineering/migrations-and-backfills.md`: one paragraph on the one-time exception, next to the runner's three states. It says the runner's refusal still holds for every boot.

## D4 — for David's approval

**Keep dev's two empty test-cache schemas (`heliumdb_test`, `drizzle_test`) in production for this adoption?** They are outside the application schema's equality claim. The tool still verifies they hold no rows, and any other unrecognised schema refuses.

**Recommendation: keep them.** They are empty, the runner never reads them, and removing them from production now is pointless: Replit's next publish copies them back from dev. The real fix is removing them from dev at their source, which is a write to the shared dev database (on the irreversible list) and a separate small change, tracked as a follow-up. Astra concurs.

## David's decisions (2026-10-30) — amendment approved ("Approved, D4 keep")

- The plan as written.
- **D4: keep** the two empty test-cache schemas for this adoption.

## Verification

- **A test with two scratch databases on the test server.** The first is a "Replit-shaped" production made by restoring a schema-only dump of a code-built database: tables, no rows, no ledger. The second is the reference.
  - **Adoption succeeds** and then matches a normally built database after the same boot steps: the same rows in every `public` table (configuration, feature permissions, look styles, the entitlement-grid singleton and 0113's setting) and the same ledger. A feature-access read succeeds, and a fresh insert into a seeded table gets the next sequence value.
  - **Every refusal changes nothing:**
    - a single row anywhere;
    - an existing ledger row;
    - an unrecognised schema;
    - a dropped column;
    - an extra index;
    - a trigger's firing mode changed from `ALWAYS` to `ORIGIN`;
    - a sequence's increment changed;
    - a table made unlogged;
    - an extra materialized view;
    - a missing extension.
  - **An installation failure, forced after the sequences have been moved,** leaves production exactly as it was, including every sequence's `last_value` and `is_called`, the ledger's included.
  - **The adoption test runs as a non-superuser owner** with no privilege to change replication settings, as production's operator role is.
- **The runner's existing tests keep passing unchanged**, which shows the refusal still holds for every boot.
- **Live, after step 2:**
  - the deployment is healthy;
  - `__drizzle_migrations` holds one row per journal entry;
  - the entitlement-grid singleton exists;
  - the audit log's triggers read `A`.

## Risks

- **Production differs from the reference.** The tool refuses, and its three-way diagnosis says whether dev drifted from the code or Replit's copy changed something. Neither case loosens the comparison: dev drift is fixed by a migration, and a transfer difference comes back to David with the evidence.
- **The site stays down until step 3.** Acceptable pre-launch.
- **`RESET_PRODUCTION_DATABASE_URL` now holds the new database's connection string** for the window. David deletes it at the end, as amendment 1 already says.
