# Plan — Launch Phase 3: Data and environments (#770; parent #628)

```plan-oracle
# Oracle — Launch Phase 3: Data and environments

Agreed with David 2026-10-27 ("Agreed", replying to the scope banner of
2026-10-24; read as agreement to the scope and to option 1 of the reset-timing
question). Parent: #628, plan `docs/plans/PLAN_GET_TO_LAUNCH.md` v7, Phase 3
(lines 409–433). Readiness criterion 2 of `docs/ai-context/launch-definition.md`.

## Direction

Production can be built from code alone, upgraded, and restored. Seed opens on
a fresh production database before any real user contributes (concern S2:
the 2026-08-28 disposable-production decision expires when real user
accounts, content, payments or safety records exist, so the reset belongs
before those contributions).

## Done when (exit evidence)

1. A clean environment boots from code alone and passes the acceptance
   workflow.
2. The legacy fixture (a copy of today's dev data) upgrades cleanly to the
   current code.
3. A restore into an isolated target succeeds for the database AND the stored
   media, with recovery time and the data-loss bound recorded.
4. The four-excluded-classes checklist (sessions purged, non-terminal jobs
   drained, child-safety records inventoried, live Stripe obligations
   verified) is signed off on every run.

## In scope

- A private snapshot of the dev database.
- A schema baseline (migration 0001 presumes existing tables; CI's
  push-then-migrate route proves nothing here).
- Bootstrap from code: extensions, roles, the baseline, the migration ledger,
  configuration seeds, the admin bootstrap, DB protections.
- A diff of config tables against a freshly seeded DB; every gap becomes a
  seed or a migration.
- The upgrade proof on the legacy fixture.
- Backup and media restore rehearsed, times recorded.
- The four-excluded-classes procedure applied before production is replaced.
- The Repl's dev DB rebuilt from code.
- A non-Replit storage test substitute for CI.
- A written backward-compatible migration policy.

## Must not change

- Child-safety records are never assumed synthetic; there is never an admin
  viewer for quarantined evidence (`legal-safety-moderation.md`).
- Production is not touched before the reset moment. Publishing stays
  David's per-use action.
- `drizzle-kit push` never runs (`.claude/settings.json` deny).
- Existing migrations keep their numbers and behaviour.

## Settled decisions

- 2026-08-28: production's product data is disposable until launch, with its
  four excluded row classes; Seed's fresh production database is that
  decision's inversion (`decisions.md`; `launch-definition.md` *Must not
  change*).
- The dev database survives as a fixture.
- The non-Replit storage test substitute is in this phase.

## Now / next / never

- **Now:** everything above, including replacing production with the
  code-built database **as soon as Phase 3's rehearsal passes** (David,
  2026-10-27, option 1: every later publish then upgrades a real, freshly
  built production; production carries no dev data until Seed).
- **Next:** anything the config diff finds that lives nowhere else goes to
  David's batch.
- **Never (here):** Seed's invite gate, Phase 15's key rotation, Phase 16's
  read-only mode and zero-window release policy.

## Ceremony tier

Sensitive (migrations): full plan, Astra plan review, `overhype-migration-review`,
one PR per increment, Codex review on every changed head, a UAT section per
product-visible increment.
```

## Problem

No database of this product has ever been built from its code. Every database
today gets its core tables from `drizzle-kit push` (`lib/db/package.json`
`push-force`; `scripts/setup-test-db.sh`; `build.yml`; the acceptance builder
`artifacts/api-server/scripts/acceptance-run.ts`), and the migrations only make
sense on top of it: `0001_soft_delete_facts_users.sql` is
`ALTER TABLE "facts" ADD COLUMN …`, and 42 `CREATE TABLE` statements exist
across the migrations against 52 `pgTable(` declarations in `lib/db/src/schema`
(survey, 2026-10-27). `push` itself drops objects that exist only in migration
SQL (the `build.yml` comment beside its push-then-migrate step), so it cannot
build production either. Production was last made by copying dev into it
(2026-08-28). The `vector` extension and the child-safety audit roles live
outside every migration. No old database has ever been migrated forward in a
test, and nothing backs up or restores the stored media. Seed needs a fresh
production that is built, upgradable and recoverable before the first real
user contributes.

## Direction

Readiness criterion 2 (`launch-definition.md`): *"Production database built
from code alone; backup and media restore rehearsed with recovery time
recorded."* This phase makes it true, and ends by replacing production with
the code-built database.

## Product Intent, Must Not Change, Settled Decisions

As the oracle block above, verbatim. **"`drizzle-kit push` never runs" is
taken literally: no bootstrap path and no verification path executes it**:
production, dev, CI, acceptance, the test databases and every check in this
plan alike (P3-S1). The existing snapshot scripts
(`lib/db/scripts/check-migration-snapshots.ts`,
`validate-migration-snapshots.ts`) read saved snapshots and never run push,
so they stay as they are.

## Repo Context Inspected

`lib/db/src/migrate.ts`, `lib/db/src/index.ts` (`runMigrations`,
`ncmecAuditBoundaryStatus`), `lib/db/src/testDatabaseMarker.ts`,
`lib/db/migrations/` (0001, 0043, 0095, 0097, 0099, 0108, 0110, `meta/_journal.json`),
`lib/db/package.json`, `scripts/setup-test-db.sh`, `.github/workflows/build.yml`,
`.github/workflows/acceptance.yml`, `artifacts/api-server/src/index.ts`
(boot order), `artifacts/api-server/src/lib/seed.ts` (`ensureSchema`,
`seedIfEmpty`), `artifacts/api-server/src/lib/engines/reconcile.ts`,
`artifacts/api-server/src/lib/objectStorage.ts`, `localObjectStorage.ts`,
`objectAcl.ts`, `lib/doubleSelection.ts`, `src/lib/bootChecks.ts`,
`src/lib/adminIdentity.ts`, `src/lib/devAdminLogin.ts`,
`scripts/lib/bootstrapAdmin.ts`, `src/testing/legacyFixture/*`,
`scripts/export-legacy-fixture.ts`, `scripts/load-legacy-fixture.ts`,
`scripts/db-sync-prod.mjs`, root `package.json` (`db:pull-prod`),
`docs/ai-context/decisions.md` (2026-08-28), `replit-environment.md`,
`launch-definition.md`, `legal-safety-moderation.md`,
`docs/engineering/ncmec-audit-ledger-hardening.md`,
`docs/engineering/migrations-and-backfills.md`, `docs/tests/TESTING.md`.
Replit's own documentation, read 2026-10-27:
`docs.replit.com/features/data-and-storage/development-and-production` and
`…/data-recovery`.

## Current Behavior

- **Schema.** `runMigrations()` (`migrate.ts`) applies every journal entry
  whose SHA-256 is absent from `drizzle.__drizzle_migrations`, in journal
  order, each statement in a savepoint that swallows "already exists" and
  "already absent" errors (`42P07, 42701, 42710, 42P16, 42P12, 42703, 42P01`),
  then verifies that every journal hash is recorded. Boot runs it, then
  `ensureSchema()` (`index.ts:234`, `:237`), which creates some tables and
  inserts about 80 config rows with `ON CONFLICT DO NOTHING` and catches DDL
  errors (`seed.ts:576`).
- **Extensions and roles.** `CREATE EXTENSION vector` appears in no
  migration; CI, the sandbox setup and the test builders create it.
  Migration 0097 deliberately creates no role; the audit ledger's privilege
  boundary needs a superuser per its runbook and is reported, not enforced,
  by `ncmecAuditBoundaryStatus()`.
- **Config.** It comes from migration INSERTs (admin_config, feature_flags,
  engines, look_styles, the permission grid in 0099), from `ensureSchema()`,
  and from engine reconciliation, which overwrites code-owned engine fields
  and keeps admin-owned ones. `seedIfEmpty()` has no caller, so a fresh
  database has no facts; Seed wants exactly that (no CSV seeding,
  `launch-definition.md`).
- **Admin.** Three grants: `users.is_admin`, `ADMIN_USER_IDS`, and the
  bootstrap email `overhypeme+admin@gmail.com` (`lib/auth.ts:26`). The
  dev-admin login is refused in production.
- **The legacy fixture** is scrubbed rows of 28 tables at migration head 0101;
  its loader refuses a target lacking any current migration (`load.ts:102`),
  so it tests today's code against old rows, never migrations against an old
  database.
- **Storage.** Production and dev use Replit object storage through the
  sidecar; `LocalObjectStorage` (`STORAGE_BACKEND=local-double`, Phase 2) is
  the CI and acceptance substitute and is refused in a production boot. Object
  ACLs live in object metadata (`objectAcl.ts`, key `custom:aclPolicy`).
- **Production.** A Replit-managed Neon database (`replit-environment.md`).
  Replit offers point-in-time restore (7 days by default on Core) and optional
  daily scheduled backups, both from its Database tool; removing a production
  database is soft for 7 days, then permanent; publishing creates a
  production database when none exists (Replit docs, read 2026-10-27).
- **Copy tools.** `db:pull-prod` copies production into dev; `db-sync-prod.mjs`
  copies dev into production through two server routes that no longer exist.

## Source-of-Truth Analysis

| Concept | Source of truth after this phase | Duplicate to retire or bound |
|---|---|---|
| Schema of a fresh database | The baseline at a named cutoff, then the migrations after it | `drizzle-kit push` as a builder (retired); `ensureSchema()`'s DDL (bounded: it may only no-op on a baseline-built database, checked) |
| Schema history of an existing database | Its own `__drizzle_migrations` ledger | none |
| TypeScript schema | `lib/db/src/schema`, held equal to what the migrations build by a CI check | the drizzle snapshot (kept as today) |
| Config row values | The owner named in a committed ownership classification: code (seed or migration), admin (operator setting, never overwritten on boot), or runtime (regenerated) | dev-only values with no seed (become seeds, migrations or David's batch) |
| Which tables hold product data, config, runtime state or an excluded class | One committed classification, read by the diff, the inventory and the snapshot tools | the legacy fixture allowlist keeps its own export rules; the classification must agree with it, checked |
| Production's backup | Replit's point-in-time restore and scheduled backups for the database; this phase's media backup for objects | none |

No new source of truth is introduced beyond the baseline and the table
classification, and each of those replaces a duplicate rather than adding one.

## Proposed Design

### 1. One bootstrap path (P3-S1)

- **The baseline** is one committed SQL artifact: the full catalog (tables,
  indexes, constraints, CHECKs, triggers and functions, enums, the `vector`
  extension) plus the rows migrations themselves insert, as they stand after
  every migration up to a **cutoff** named in it (the journal head when the
  baseline lands; today 0110). Historical migration files stay byte-for-byte
  unchanged.
- **The runner decides by state, not by flag:**
  - an empty database (no public tables, no ledger) gets the baseline, then
    a ledger entry for every journal migration up to the cutoff, then the
    migrations after it;
  - a database with a ledger gets only its pending migrations, as today;
  - a database with public tables and no ledger is **refused** at boot, with
    the reason. That refusal is the construct that keeps a database pre-built
    by anything else (a platform schema copy, a push) from being silently
    adopted as "built from code".
- **Equivalence is checked against a historical reference, never against a
  push build.** Before the bootstrap change lands, the current schema and
  ledger are captured once from the frozen dev snapshot (increment 1). That
  is a database that already exists, so capturing it executes no push. That capture is a
  committed, reviewed artifact holding the catalog and the ledger, with no
  rows of any person's data. Migration-seeded defaults get explicit expected
  values, written by hand, never copied from dev's operator values.
  - The baseline is verified against that reference before merge. Every
    intentional difference is listed in the PR and reconciled.
  - A standing CI check restores the reference, applies every migration
    after the cutoff, and fails on any catalog difference from a
    baseline-built database at the same commit.
  - The private frozen snapshot separately proves the upgrade of real
    historical data (§2).
- **Every builder moves to the new path:** CI's Test and E2E Smoke jobs, the
  api-server `pretest`, `scripts/setup-test-db.sh`, the acceptance builder,
  and the Stripe-fake and legacy-fixture template builders. A second CI check
  compares the migration-built catalog with `lib/db/src/schema` by read-only
  inspection, which is the parity that push used to supply as a side effect.
- **The baseline is atomic and retry-safe.** State detection runs under the
  runner's existing advisory lock. Creating the ledger is inside the same
  transaction as the baseline. Today the runner creates the ledger before
  its migration transactions (`migrate.ts:154`), so an empty ledger left by a
  failed attempt would send the next boot into the historical migrations;
  that case must instead retry the baseline. A test shows a failed baseline
  rolling back fully and the next boot succeeding.
- **`ensureSchema()`** is left as it is, but a check proves that on a
  baseline-built database its DDL changes nothing. Any table it alone creates
  moves into a migration (and so into the next baseline). Its config inserts
  are classified like every other config source (§3). No wholesale startup
  refactor.
- **A second boot preserves everything.** The acceptance run boots twice on
  the same database and shows that data, operator settings and protections
  survive the second boot.

### 2. The upgrade proof (P3-S2)

- **Three things, kept apart:**
  - the **private snapshot**: today's dev database, schema, data and ledger,
    frozen before this phase changes dev;
  - the **committed scrubbed fixture**: unchanged, still the acceptance
    fixture;
  - the **upgrade rehearsal**: it restores the frozen snapshot into an
    isolated database, runs the new code's migrations and boot, and asserts:
    - nothing is lost: row counts per table, the counts of rows held back
      apart;
    - relationships resolve;
    - sequences are usable: an insert succeeds;
    - operator settings are kept;
    - the acceptance journeys pass.
- **A failed rehearsal is fixed in the migration or the code, never by
  refreshing the snapshot.**
- **The standing CI form** is the case every real database hits once: the
  historical reference (§1), with its full ledger, boots under the new runner,
  takes no baseline, applies only the migrations after the cutoff, and comes
  out with the same catalog as a baseline-built database. No push anywhere.

### 3. Configuration by ownership; admin by normal sign-in (P3-S3)

- **One committed classification** names every table as product data, config,
  runtime state or an excluded class, and, for config tables, the owner of
  each column group (code, admin or runtime). A CI test fails on an
  unclassified table, so a table added later cannot slip past the diff.
- **The config diff** compares the frozen snapshot after a full boot against a
  baseline-built database after a full boot (seeds, `ensureSchema`,
  reconciliation). It reports three kinds of difference:
  - **missing:** a code-owned value with no seed, which becomes a seed or a
    migration;
  - **operator-set:** an admin value that differs from the default. Each one
    goes to David's batch only where it records an unsettled product choice;
    otherwise it is left to be set again by an admin;
  - **runtime:** ignored.
- **No boot overwrites an admin-owned value.** A test sets one, reboots and
  reads it back.
- **Admin access is proven the normal way.** On a freshly built database,
  David signs up through the ordinary sign-in and reaches the admin console
  through `ADMIN_USER_IDS` or the bootstrap email. The dev-admin login stays
  as it is (Phase 15 redesigns it).

### 4. Recovery of a usable, protected pair (P3-S4)

- **What is backed up:**
  - **database:** Replit's point-in-time restore and daily scheduled backups,
    the mechanism an incident would actually use;
  - **database, portable:** a logical dump, so the rehearsal can restore into
    an isolated target the platform's in-place restore cannot give;
  - **media:** the objects with their metadata (the ACL policy included),
    copied to a second storage bucket in the same project, which the
    application never serves.
- **Why the media backup has to track changes.** Media is not immutable:
  - an upload's delete removes its stored object before its database row
    (`routes/users.ts:701`);
  - an admin hard-delete removes several kinds of media (`routes/admin.ts:577`);
  - setting a profile image rewrites the ACL of an existing object
    (`routes/users.ts:598`).

  A database restore point taken before such a change, paired with a later
  media copy, would reference bytes or permissions that no longer exist.
  Replit's App Storage offers no object versioning or retention policy, but it
  does allow further buckets inside the same project (Replit docs,
  `features/data-and-storage/object-storage`, read 2026-10-27).
- **The recurring recovery contract** (Astra's wording, round 2, adopted):
  recurring recovery supports explicitly **completed** database and media
  pairs, and promises nothing about the instants between them.
  - **Each pair has a manifest.** It is durable, kept with the backup, and
    links an identifiable database restore point to immutable copies of the
    bytes and metadata that point needs.
  - **Scheduled capture covers new and changed object states.** Changed means
    changed bytes or changed metadata, identified by the object's generation
    and metageneration. It is not limited to new objects.
  - **Preservation and mutation act on the same identified state.** Each
    change is conditional on the generation it preserved, so a conflicting
    change is retried or prevents the pair from completing. Genuinely new
    uploads are made write-once, including the signed direct upload
    (`routes/storage.ts:33` through `getObjectEntityUploadURL()`,
    `objectStorage.ts:125`), so a reused or retried URL cannot replace an
    existing object. An intentional replacement goes through preservation.
  - **A failed or incomplete capture leaves the previous completed pair** as
    the recovery point. The data-loss bound is measured from the latest
    completed pair, with failures counted.
  - **Preserving matters only where a needed state is at risk.** A change
    that would destroy an unpreserved state is delayed or refused with an
    accurate, retryable result (Question 2). A first creation, where no
    earlier state exists, never depends on the backup. The profile-image
    handlers' habit of catching ACL errors after their database change is
    corrected where it would otherwise report a false success
    (`routes/users.ts:579`).
  - **Ordinary media copies expire** once no retained pair needs them; the
    window is Question 3. Replit has no lifecycle policy, so this phase owns
    the expiry job. Child-safety evidence keeps its own preservation rules
    and never expires by this job.
  - **Increment 1 verifies the conditional operations** through this app's
    Replit storage credentials (Cloud Storage generation and metageneration
    preconditions). If they are unavailable, this contract comes back to
    David as an amendment.
  - **No scheduled pause and no nightly outage.** A coordinated nightly pause
    was the alternative, and it was rejected for that reason.
- **The first rehearsal is a paired capture with writes stopped.** The
  app's workflows and workers are stopped, and the database dump and media
  copy are taken in that window. The pair is restored into the isolated
  targets: a database the live app never reads, and a separate bucket or
  prefix. No Phase 16 read-only feature is needed for this.
- **The isolated rehearsal:**
  - boot the app against the restored pair in an environment built for the
    rehearsal. The acceptance launcher requires the local storage double
    (`acceptanceGuard.ts:20`), so it cannot be reused for real storage;
  - the environment carries no live credentials:
    - Stripe is left unconfigured, because the fake driver's partition
      (`stripeDatabasePartition.ts:64`) is deliberately incompatible with
      copied real-Stripe history;
    - email and AI keys are absent, because `doubleSelection.ts` does not
      cover email;
    - workers that would act externally are off;
  - verify that a public object reads, its owner reads a private one, a
    non-owner is refused, and quarantined evidence stays excluded;
  - record the recovery time, from start to passing verification.
- **The platform drill.** Once production is replaced and before Seed,
  David runs one point-in-time restore of the fresh production from the
  Database tool, timed. The drill follows the §5 sequence too: production's
  protected state is captured first, and the restore point is checked
  **before** restoring, so it is known in advance whether that point omits
  any protected record. The restore point he picks contains any records
  carried forward (§5). Afterwards, a check confirms nothing protected
  changed after that point: carried child-safety rows, the audit ledger and
  entitlements.
- **The audit boundary on production.** After the reset,
  `ncmecAuditBoundaryStatus()` runs on production and its result is recorded.
  Whether the platform grants the privileges that enforcement needs is
  established in increment 1. If it does not, the boundary stays reported,
  not enforced, and goes to Phase 15 by name. This phase does not claim it.

### 5. The excluded classes, as a tool

A read-only inventory reports each of the four classes for a given database:
- unexpired sessions;
- non-terminal jobs;
- child-safety rows, with their supporting bytes;
- payment entitlements, checked against Stripe's live mode, since an empty
  local table proves nothing.

It runs before every destructive replacement: the dev rebuild, the
production reset, and any rehearsal copy. **Inventory is not disposal.** The
sequence for each replacement is fixed:

1. **Capture and inventory.** The current source is captured and inventoried
   immediately before replacement. The dispositions are written to #770.
2. **Carry forward.** Child-safety records, live payment linkage and anything
   else the inventory finds go into a verified carry-forward artifact. The
   artifact keeps the records' required relationships: safety rows reference
   users, memes and each other (`lib/db/src/schema/moderation.ts:28`). It
   also keeps their supporting bytes and protections, and is checked to be
   complete before anything is destroyed.
3. **Stripe blocks.** A positive or incomplete live-mode Stripe inventory
   blocks the destructive replacement. It stays blocked until every
   obligation has a verified preservation or reconciliation path, as the
   2026-08-28 decision already requires (`decisions.md:869`).
4. **Clean before serving.** On the replacement, sessions and auth state are
   cleared and non-terminal jobs disposed of before it serves a request or
   starts a worker.
5. **Restore and verify before exposure.** The carried records are restored
   and verified before the replacement is exposed: relationships resolve,
   bytes are present, and `ncmecAuditBoundaryStatus()` is re-run.

An empty inventory skips steps 2 and 5, and says so on #770.

### 6. Policy and the retired copy path

- **The migration policy** goes into `docs/engineering/migrations-and-backfills.md`
  as a written rule: a migration must leave the previous release working
  (expand, then contract in a later release). It covers how a fresh database
  and an existing one each receive a change, and how a new baseline is cut.
- **The dev-to-production copy stops being a route:** `db-sync-prod.mjs`
  (whose routes no longer exist) and `db:pull-prod` (after Seed, production
  holds real users' data, which dev must not receive) are deleted.
  `decisions.md` records the 2026-08-28 decision as fulfilled by the reset
  and closed.

### 7. Rebuilding dev, then production

- **Dev:** rebuilt from code on the Repl, through the §5 sequence. If David
  keeps his content (Question 1), it comes from a **fresh capture taken
  immediately before the rebuild**, not from increment 1's frozen snapshot.
  The frozen snapshot stays unchanged as the upgrade fixture, and reloading
  it would lose everything made in dev since.
- **Production,** through the §5 sequence:
  1. capture, inventory, carry forward; a Stripe obligation blocks here;
  2. David replaces the database by the route increment 1 establishes. The
     documented route is to remove it in Replit's Database tool and let the
     next publish create an empty one. A non-empty database with no ledger is
     refused at boot;
  3. carried records are restored and verified;
  4. admin access is proven: David signs in, and a script checks that his
     session reaches an admin endpoint;
  5. the audit-boundary status is recorded;
  6. the platform restore drill runs.
- **Later publishes must leave the schema to the runner.** Replit documents
  that a publish applies dev's schema changes to production, and the
  2026-08-28 deploy cancelled exactly such a push (`decisions.md:892`). The
  no-ledger refusal cannot catch that on a database that already has a
  ledger. Increment 1 establishes how this app's publishes behave. Until it
  does, steps 2–6 above are a stated design, not an established route, and
  they return to David as an amendment if the facts change them.

## Data Model and Migration Impact

- **No product table changes shape** in this phase. New migrations appear
  only where the config diff or `ensureSchema()`'s own tables require one,
  each idempotent and capture-first like Phase 4's.
- **The migration ledger changes meaning for fresh databases only.** Entries
  up to the cutoff are written by the baseline step, not by running the
  files. Their hashes are still the files' hashes, so verification is
  unchanged.
- **Row states for the runner change:**

| Database state at boot | Result |
|---|---|
| empty (no public tables, no ledger) | baseline + ledger to cutoff + later migrations |
| ledger present, all applied | no-op (as today) |
| ledger present, some pending | pending applied (as today) |
| ledger present, baseline-era file edited | as today: re-runs, which the edit rule in `migrations-and-backfills.md` already forbids |
| public tables, no ledger | **refused** at boot with the reason |
| baseline step fails part-way | the step runs in one transaction; nothing is recorded and boot fails |

- **Rollback.**
  - **Increment 2** is reverted by its PR: existing databases never take the
    baseline, so nothing on them changes.
  - **The dev rebuild** is reversible from the fresh capture taken just before
    it (§7).
  - **The production reset** is reversible for 7 days through Replit's soft
    delete, and after that **not at all**. That puts it on the irreversible
    list, and it is David's action (*Items for David's approval*, 1).
- **Observability.** Each path logs what it did (baseline applied at
  cutoff N, or K pending applied, or the refusal). Every inventory and
  rehearsal writes its counts and times to #770.

## Runtime Behavior

- **On an existing database** a boot is unchanged.
- **On an empty database** a boot builds it and then serves.
- **On a database built by anything else** a boot stops with the reason, and
  the server does not start. That is louder than today, on purpose.
- **Production after the reset** serves an empty catalogue with config seeded
  from code: no facts, no users until David signs up.

## Admin/User UX Impact

- **Users** see none of this until the reset. After it, production is empty
  by design, and that is what Seed starts from.
- **No admin screen changes.** Admin settings that only ever lived in dev's
  database come back as seeded defaults or wait in David's batch. The diff
  report on #770 is where he reads which.

## Security, Permissions, and Validation

- **The private snapshot and every dump** are stored outside git and outside
  any served path. Each is encrypted at rest by the platform and deleted when
  its use ends; the snapshot is deleted after Seed, with its deletion
  recorded.
- **Rehearsal boots** never run with production credentials for email, AI or
  Stripe. Their environment is built without those credentials (§4), since
  `doubleSelection.ts` does not cover email. A production boot still refuses
  doubles.
- **The new boot refusal** (public tables, no ledger) fails closed.
- **The bootstrap admin email** keeps granting admin on the fresh production,
  as today. Whoever controls that mailbox controls admin. That is recorded
  for Phase 15's review, not changed here.

## Testing Plan

- **Unit and integration** (api-server and `@workspace/db` suites):
  - every runner state in the table above, including the refusal and a
    baseline step failing part-way;
  - a second boot preserving data and admin-owned values;
  - an unclassified table failing the classification test.
- **CI checks**, none of which runs push:
  - the historical reference, upgraded through the post-cutoff migrations,
    equals a baseline-built database (§1);
  - schema-TS parity by read-only inspection;
  - a failed baseline rolls back and the next boot retries it;
  - every media delete and ACL write goes through the preserve-first path
    (§4).
- **The recurring recovery, exercised** (on the isolated targets, real storage):
  - make a pair, change one existing object's ACL, delete another, and make
    another pair;
  - restore each supported pair, with correct bytes and access rules;
  - a failed capture and an overlapping change must neither produce a
    falsely completed pair nor advance the reported recovery point;
  - the recovery time and data-loss bound recorded on #770 include a pair
    made by the recurring mechanism, not only the paused capture.
- **Acceptance** (`acceptance.yml`, both variants) on baseline-built databases,
  booted twice.
- **Rehearsals with recorded evidence on #770:**
  - the upgrade rehearsal on the frozen snapshot;
  - the isolated restore of the database and media pair, with times;
  - the platform drill;
  - each inventory.
- **UAT** (judgement residue only):
  - David signs in on the new production and reaches admin;
  - David runs the platform restore drill and confirms it;
  - David reads the config diff's operator-set items.
- **Runner commands** are as in `docs/tests/TESTING.md`.

## Implementation Steps

One PR per increment, in this order. Each increment's PR names what it makes
true.

1. **Preserve, inventory, and discovery.** This increment is approved as
   discovery (P3-R2).
   - Freeze the private snapshot of dev: schema, data, ledger, plus a media
     manifest.
   - Capture the historical schema-and-ledger reference (§1).
   - Build the read-only excluded-classes inventory and run it on dev.
   - Record these platform facts on #770, each with its evidence, from this
     app's own settings, not documentation alone:
     - whether workspace and deployment share one storage bucket, and which
       bucket can receive an isolated restore;
     - which role privileges production grants, for the audit-ledger
       ownership arrangement;
     - how this app gets an actually empty production database;
     - what a later publish does to an existing production schema.

   Where a fact changes this plan's design, the change comes to David as an
   amendment before the increment that depends on it.
2. **The bootstrap path.** The baseline, verified against the historical
   reference; the runner states, with the atomic retry; the reference and
   parity checks; every builder moved off push; the `ensureSchema()` no-op
   check; and acceptance booted twice.
3. **Configuration and admin.** The table classification and its test, the
   config diff and its report, gaps turned into seeds or migrations, and the
   admin-value preservation test.
4. **The upgrade proof.** The rehearsal on the frozen snapshot, and the standing
   CI form.
5. **Recovery.**
   - The backup bucket.
   - Write-once new uploads.
   - The conditional preserve-before-change path with its call-site test.
   - The scheduled capture of new and changed states, with pair manifests.
   - The expiry job.
   - The recurring-recovery exercise.
   - The logical dump.
   - The paired capture with writes stopped, and the isolated restore
     rehearsal in its credential-free environment, with times and bound
     recorded.

   A runbook goes in `docs/engineering/`.
6. **Policy and the retired copy path.** The migration policy, the two copy
   tools deleted, and the `decisions.md` entry.
7. **Dev rebuilt from code** on the Repl, through the §5 sequence. If David
   chooses to keep his content, it comes from a fresh capture.
8. **Production reset,** through the §5 sequence and §7's steps, by the route
   increment 1 established:
   - David's go on the checklist;
   - his database replacement and publish;
   - carried records verified;
   - the scripted admin check;
   - the audit-boundary status;
   - the platform drill.

## Risks and Mitigations

- **The baseline drifts from the migrations it summarises.** The
  equivalence check fails CI on any catalog or seeded-row difference.
- **Replit pre-builds or copies schema into a new production database.** The
  boot refusal stops it loudly, and increment 1 establishes the behaviour
  first.
- **The audit boundary cannot be enforced on Replit's Neon.** It is reported
  and handed to Phase 15 by name, never claimed.
- **Dev and production share one storage bucket,** so a dev rebuild or a
  rehearsal could touch production's media. Increment 1 establishes this. If
  they share, every restore targets an isolated prefix or bucket, and no tool
  deletes objects.
- **A publish quietly changes production's schema.** Increment 1 establishes
  how publishes behave, and the dependent steps return as an amendment.
- **The reset destroys something real.** Capture, inventory and a verified
  carry-forward come first. A Stripe obligation blocks the reset. The action
  is David's, inside a 7-day undo window.
- **A new delete or ACL path skips the media preservation.** The call-site
  test fails CI.
- **Phases 5–17 add migrations meanwhile.** Each runs on both kinds of
  database by construction. A new baseline is cut only by the documented
  procedure, never by hand.

## Items for David's approval

1. **The production reset is irreversible after 7 days and is yours to
   perform.** It comes at the end of increment 8, after the inventory and the
   rehearsals pass. I ask for your go at that moment, with the checklist.
2. **Recurring backups need two switches only you can flip.** In Replit's
   Database tool: turn on daily scheduled backups and keep point-in-time
   restore at 7 days. Storage cost is currently discounted to $0 (Replit docs,
   read 2026-10-27). My recommendation is both on, from the reset.
3. **The audit boundary may stay unenforced on production** if Replit grants
   no superuser. This phase records the status, and Phase 15 owns enforcing
   it. It is named so it is never read as done.

## Questions for David

1. **When dev is rebuilt from code, should it keep its test content?**
   - **Recommendation:** yes. A fresh capture of dev, taken just before the
     rebuild, has its product data reloaded into the code-built dev. Your
     facts, memes and test accounts stay, with sessions cleared and queued
     jobs drained.
   - **The alternative:** dev starts empty with only the scrubbed fixture,
     which is closer to what production will be but leaves you nothing to
     click.
2. **If the backup is down, should a change that would destroy an
   unbacked-up photo state wait?** This covers a photo's deletion, or a
   private photo becoming a profile picture before its private state is
   backed up.
   - **Recommendation:** yes. That one action fails with "try again shortly"
     until the backup recovers. New uploads are never held up.
   - **The alternative:** let the change through and accept a recovery gap,
     so a restore could bring back a photo without its right privacy setting,
     or without its bytes.
3. **How long should a deleted photo stay recoverable in the backup?**
   Today a deleted photo's bytes are removed at once; the backup would keep
   a private copy.
   - **Recommendation:** 7 days, matching the database's restore window,
     then it is erased. Child-safety evidence is excluded and keeps its own
     legal retention.
   - **The alternative:** a longer window, up to 28 days on Replit's paid
     plans, which keeps deleted photos longer for the same benefit.

## Definition of Done

- [ ] A database built by the new path passes acceptance, twice-booted, in CI.
- [ ] CI fails on drift from the historical reference, on schema-TS drift, on
      an unclassified table, and on a media delete or ACL write that skips
      preservation.
- [ ] No bootstrap or verification path executes `drizzle-kit push`.
- [ ] Increment 1's platform facts are on #770, with evidence, and any
      amendment they forced has been approved.
- [ ] The frozen dev snapshot upgrades under the new code with every
      assertion in §2 passing, and the evidence is on #770.
- [ ] An isolated restore of the database and media pair passes its access
      checks, with recovery time and data-loss bound recorded on #770.
- [ ] Every destructive replacement has its inventory dispositions on #770.
- [ ] The migration policy is written, and the two copy tools are gone.
- [ ] Dev is rebuilt from code, and David's test content is there (if he
      chose that).
- [ ] Production is replaced. David signs in and reaches admin. The
      audit-boundary status is recorded, and the platform restore drill is
      timed.
