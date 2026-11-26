# Plan amendment — Launch Phase 15, increment 5b: the app connects as its own role (Issue #1306)

Draft v3, 2026-11-26 (revised after Astra's assessment 1: C1–C4; assessment 2 found it ready, and its two implementation details are folded in). Amends `docs/plans/PLAN_PHASE15_SECURITY_HARDENING.md` v3 (sha256 `68c27dbc…2eb5`), increment 5, as that increment requires: "a changed deployment or migration operating model returns to David as a concrete plan amendment before 5b starts". Everything else in v3 stands.

## Summary for David

1. **Problem.** The safety ledger (the record of every action on the admin safety screens) is meant to be impossible for the app to alter. Today the app connects to the database as the ledger's owner, so it could switch the ledger's protection off. Pointing Replit's connection setting at a safer login doesn't work, because Replit overrides it.
2. **What you get.**
   - Production connects with its own app login, from a separate secret, and can no longer switch the ledger's protection off.
   - Each start checks whether the protection holds and records it. I quote that record here as proof. If it ever stops holding, an alert reaches us.
   - Development is unchanged.
   - A publish missing the secret fails, and the live site keeps running the previous version.
3. **What it leaves out.** Moving the database off Replit's managed service.
4. **Questions for David.**
   - **Q14 — accept the remaining server-compromise risk.** The app's own database login can no longer rewrite the ledger or switch its guard off, so a bad query, a bug or a misused admin screen cannot either. This change does not protect the owner's database password from an attacker who can run code inside the production server, because Replit places it in that server's environment. 1) accept that remaining risk for Seed; 2) require further isolation work before Seed. **Recommendation: 1.** Running code on the server is what every other control in this phase exists to prevent, and further isolation needs investigation and may mean deployment or database changes well outside this step.
   - **Q15 — if the protection breaks later, keep the site up or take it down?** A future permission change could remove the protection while the site is live. 1) keep the website running, alert us, and repair it, with the audit item not counted as done while the alert stands; 2) refuse to start new copies of the server until it is repaired, which can take the site down under load. **Recommendation: 1.** The ledger only records admin actions, nothing breaks for members, and an outage for a repairable permission slip costs more than it protects.
5. **How you'll check it.** Nothing to click. I quote the log line and production's own record of which login is connected.
6. **Costs and risks that are yours.**
   - Three steps in your hands: paste one SQL batch in the production console, add one production-only secret, and publish.
   - Occasionally, after a publish that adds a table or changes one's structure, the new version may fail to start until you paste a fixed repair batch I supply and publish again. The live site keeps running the previous version meanwhile.
   - Backups stop including Replit's own log of past publishes, which the app never reads. Everything the app needs is still backed up, and a restore test proves it.

## Problem

Increment 5a showed two things on production (#1306, comments of 2026-11-26). The database side of the split works: `overhype_app` owns the app's objects, the ledger and its guard stay with `neondb_owner`, and the catalog reads `owner_member f, dbowner_member f, maint_member f, can_update f`. Pointing the deployment at `overhype_app` through `DATABASE_URL` does not work: Replit supplies production's `DATABASE_URL` for its managed database and ignores an override (builds `c65ffe42` and `147e09e4`, both refused with `permission denied for schema drizzle`, which only `neondb_owner` could hit). Publishing was unblocked by `GRANT overhype_app TO neondb_owner WITH INHERIT TRUE, SET FALSE` (Q13 → 1), so the deployment runs as `neondb_owner` and the boundary is unenforced, as it was before the rehearsal.

Production read again this session (2026-11-26, read-only via the connector):

```
role,member,admin_option,set_option,inherit_option
overhype_app,neondb_owner,t,f,f
overhype_app,neondb_owner,f,f,t
overhype_audit_maintenance,neondb_owner,t,f,f

nspname,owner:  _system neondb_owner · drizzle overhype_app · public pg_database_owner · stripe overhype_app
objects: _system (1 table, 1 sequence, 2 indexes) neondb_owner · public: neondb_owner 1 table + 1 sequence + 3 indexes (the ledger set), overhype_app 64 tables + 46 sequences + 188 indexes · drizzle, stripe: all overhype_app
has_schema_privilege('overhype_app','_system','USAGE') = f
pg_stat_activity usename: neondb_owner (1)
pg_default_acl: only cloud_admin's, on public (granting neon_superuser)
```

## Direction

Unchanged: readiness row 5, through v3's oracle item 7 ("the Phase 3 audit boundary enforced on production or its non-enforcement accepted in words by David") and its Definition of Done line "Audit boundary enforced on production, or its non-enforcement accepted by David in words."

## Product Intent, Must Not Change, Settled Decisions

v3's oracle governs, unchanged. Added by this amendment:

**Product intent (5b).** In a published deployment the app's database connection is `overhype_app`, a role that cannot effectively assume the ledger's owner, the ledger's or guard's schema owner, or `overhype_audit_maintenance`; `ncmecAuditBoundaryStatus()` run on that connection reports `boundaryEnforced: true`, and that output is quoted on #1306 from production.

**Must not change.**
- Development, tests, CI and every operator script keep connecting through `DATABASE_URL` exactly as today.
- A failed start never takes the live site down: Replit does not promote a build that fails to boot (measured 2026-11-26 16:47 UTC: two crash-looping builds, `healthz` 200 throughout on the previous release).
- The ledger, its sequence, indexes and guard function stay owned by `neondb_owner`; nothing in this increment changes them.

**Settled decisions.**
- `DATABASE_URL` cannot carry the app role on production (5a, measured). The app's role arrives in a secret of its own, `APP_DATABASE_URL`, set as a **production-only deployment secret**.
- `neondb_owner` **keeps** its `INHERIT` membership in `overhype_app`. Replit's publish applies its generated schema diff on its own connection, as `neondb_owner` (unable to verify the role directly; the 5a crash, which only `neondb_owner` could produce, is the evidence it connects that way). Altering a table `overhype_app` owns needs the privileges of its owner, which `neondb_owner` has only through that membership, so removing it would fail every publish that changes an existing table. The direction is owner → app. The boundary concerns app → owner, which must stay impossible, and `ncmecAuditBoundaryStatus()` checks exactly that direction.
- **No migration.** Nothing here changes the schema. The privilege steps cannot be run by the app's role by construction, so they are an operator runbook (the class `migrations-and-backfills.md` names "a superuser runbook"). #1018's migration slot is not claimed.
- Affected-surface inventory: `git grep -n "process.env.DATABASE_URL\|env.DATABASE_URL" -- artifacts/api-server/src lib/db/src ':!*.test.ts' ':!*__tests__*' ':!*/testing/*'`, run 2026-11-26 at `9b1fbdb`. Runtime consumers in a deployment: `lib/db/src/index.ts` (the pool, read at import), `stripeInit.ts:253`, `stripeRealDriver.ts:88`, `jobs/mediaBackupJob.ts:48`. Others are not in the deployed runtime: `stripeFakeDriver.ts:362` (the fake, refused in production), and `migrate-cli.ts`, `createStripeFakeDatabase.ts` and `testDatabaseMarker.ts` (operator and test tools).
- Measured here: deleting a variable from `process.env` does not remove it from `/proc/self/environ` (Node, this container: `process.env has it: false`, `/proc/self/environ has it: true`). So the owner credential Replit injects stays readable to code running in the process, whatever the app does. That residual is Q14.
- Rehearsed locally on PostgreSQL 16 (2026-11-26; `r_owner` is a non-superuser `CREATEROLE` owner and `r_app` the app; the memberships match production's two rows exactly: admin with no SET or INHERIT, plus INHERIT with no SET). Results:
  - the owner's `ALTER TABLE users ADD COLUMN` on an app-owned table succeeded through `INHERIT`;
  - after S1's default privileges, the app inserted into a table the owner created afterwards (`count 1`, its serial sequence included);
  - the app's `ALTER` on that table failed with `must be owner of table newt`;
  - the repair batch (`GRANT … WITH SET TRUE`, `ALTER TABLE … OWNER TO`, `GRANT … WITH SET FALSE`) moved the table, its sequence and its key to the app, left the ledger with the owner, and returned both membership rows to their original options;
  - the app's `ALTER` then succeeded.
- **What 5a's evidence does not cover**, carried forward with its limits:
  - its local runner applied zero pending migrations;
  - no Replit start ever succeeded as `overhype_app`;
  - Stripe start-up as `overhype_app` was never observed.

  The Testing Plan covers the first and third locally; production's first start after S3 covers the second.
- Ceremony tier: production phase, **sensitive** (database roles, the NCMEC ledger). Now: 5b as below. Next: the deployment-wide `_system` question, if the media backup needs it (below). Never: pointing `DATABASE_URL` at the app role.

## Proposed Design

**1. One resolver chooses the app's connection, and refuses the unsafe shapes.** Every runtime consumer in the inventory takes its connection string from one function in `@workspace/db`, never from `process.env.DATABASE_URL` directly. Its rules, each a refusal at start-up before any query:
- `APP_DATABASE_URL` set → it is the connection, provided it names the **same host, port and database** as `DATABASE_URL`. A mismatch is refused in every environment. That way a production value copied into a workspace secret can never point the development app at production.
- In a published deployment (`REPLIT_DEPLOYMENT === "1"`, the detector `env.ts` already uses; not `NODE_ENV`, which the local production-mode launcher sets), `APP_DATABASE_URL` is **required**, and its user must differ from `DATABASE_URL`'s. Either failure refuses to start, and Replit does not promote the build.
- Otherwise `DATABASE_URL`, as today.

**2. The owner's credential leaves the app's own environment once resolved.** In a deployment, after the resolver runs, `DATABASE_URL` and the `PG*` connection variables are deleted from `process.env`, before any other module reads them. This keeps the owner's credential out of child processes (`pg_dump` inherits the environment), error reports and anything that serialises `process.env`. It is defence in depth only: `/proc/self/environ` keeps the original (measured above), which is why Q14 exists.

**3. Every start states the boundary, and a bad state raises an alert.**
- **Before migrations**, the server counts `ownershipDrift`: the objects in `public`, `drizzle` and `stripe` that the connected role does not own (relations, sequences, functions, types), with the same exclusions as the repair batch: the ledger set, extension members such as `vector`'s, and objects that follow a parent (a table's indexes and owned sequences). So every count it reports is one the batch can clear. The split-database test shows repaired ownership reads zero (Astra, assessment 2). It logs the count with the objects' names. If `runMigrations()` then fails, its failure handler logs the same diagnostic beside the error before the start aborts. So a start that dies on ownership names its cause in the deployment log.
- **After `ensureSchema()`**, the server runs `ncmecAuditBoundaryStatus()` on its own pool and writes one structured line, `[audit-boundary]`, holding the status object and the drift count. This line is the production quote the oracle asks for, read from the deployment log through the connector.
- **In a deployment, three outcomes raise an explicit Sentry event**, through the SDK's capture call, because the Pino logger does not forward to Sentry (`instrument.ts` configures no log integration): `boundaryEnforced: false`, non-zero drift, and a status query that itself fails. The last is reported as "unable to establish". A test checks each of the three.
- **None of the three stops the start** (Q15, recommendation 1). Autoscale boots instances on demand, so a start-up gate on database state would turn a permission slip into an outage. While such an alert stands, the audit item is not counted as done.

**4. Tables Replit's publish creates stay usable, and their ownership is repaired by a fixed batch.** A new table in a publish's generated diff is created by `neondb_owner`, so the app does not own it. Two parts:
- **Default privileges (operator step S1, once):** `neondb_owner` grants `overhype_app` full table rights (select, insert, update, delete, truncate, references, trigger) on tables it creates in `public`, `drizzle` and `stripe`, and usage, select and update on sequences. With these, a published new table is readable and writable by the app at boot and at runtime, and the boot migration's data steps succeed.
- **What default privileges cannot give is ownership,** and PostgreSQL requires ownership for every `ALTER TABLE`, even one whose effect is already present. This repository's migrations use both `ADD COLUMN IF NOT EXISTS` and unconditional constraint replacement (`0173_member_pictures.sql:58`). So any later migration touching an object `neondb_owner` created fails at boot, whatever Replit applied first. Two paths follow, and the runbook describes both:
  - **the publish succeeds, with drift:** the alert fires and David runs the batch before the next migration needs it;
  - **the start fails:** the publish is not promoted, the pre-migration diagnostic names the objects, David runs the batch, then publishes again.

  The remedy is a fixed batch, committed in `docs/engineering/ncmec-audit-ledger-hardening.md`; its mechanism is rehearsed (Settled decisions), and the full batch is tested before it ships. It gives `neondb_owner` `SET` on `overhype_app` for the batch, moves every non-ledger object `neondb_owner` owns in the three schemas to `overhype_app` (5a's loop, unchanged: relations, standalone sequences, functions and procedures, enums, domains and composite types), then returns the membership to `SET FALSE` with `INHERIT` and admin option intact. David runs it as one selected batch. `migrations-and-backfills.md` gets the rule: after any publish whose diff changed structure, read the drift line, and run the batch if it is non-zero.

**5. The media backup's dump works under the app role, and its restore is proven.** `pg_dump` as `overhype_app` cannot read `_system` (no `USAGE`, measured). Read through the replica, 2026-11-26: `_system` holds one table, `replit_database_migrations_v1` (`id`, `build_id`, `deployment_id`, `statement_count`, `applied_at`), with its key, sequence and one index. Its six catalog dependencies are its own key, index and sequence. Development has no `_system` schema. It is Replit's log of the migrations each publish applied; no app code reads it. Two points follow:
- it is not portable data in the sense of `media-backup-and-restore.md`;
- production's own point-in-time restore, the other recovery path that document names, still carries it.

The dump excludes `_system`. Proof during the build: a dump taken as the restricted role is restored into a disposable database, and there the app's tables, the migration ledger and the safety ledger are present and the restored app starts. A clean `pg_dump` exit alone proves less.

**6. Rotation.** The `overhype_app` password, and with it `APP_DATABASE_URL`, are increment 6 rows (already listed on #1306).

**Operator steps (David's hands, each posted on #1306 before it runs):**
- S1: in the production SQL console, editing on, one selected batch (5a's lesson): the `ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner …` statements from item 4. They are rehearsed locally first, and the batch includes a read-back of `pg_default_acl`.
- S2: Publishing → Production app secrets → **Add deployment secret** `APP_DATABASE_URL`. Its value is production's `DATABASE_URL` with only the user and password replaced, by `overhype_app` and the password David holds. It is never a workspace secret: one would sync to development, where the resolver refuses it.
- S3: publish the merged change.

**My checks after S3 (read-only):** `healthz` 200; `pg_stat_activity` shows `overhype_app` sessions for the app; the boot log's `[audit-boundary]` line, quoted, reads `boundaryEnforced: true` and `ownershipDrift: 0`; the catalog cross-check from 5a reads the same. **Then, at the first later publish whose diff adds a table:** the new table's owner, the drift line and whether the app started, recorded on #1306. That publish is the measurement of item 4.

**Undo:** a corrective PR reverting the code, merged and published. The app is back on `DATABASE_URL` as `neondb_owner`, which still inherits `overhype_app`, so it runs exactly as today. S1 and S2 can stay; neither affects that state.

## Security, Permissions, and Validation

- The only privileges added are owner → app (S1's default privileges, and the repair batch's temporary `SET`). Nothing grants `overhype_app` any membership. `ncmecAuditBoundaryStatus()` is the check that it holds none, and the boot line reports it on every start.
- The repair batch leaves no lasting `SET`. Its last statement restores `SET FALSE`, and its read-back shows the membership row.
- The resolver's refusals are constructs: start-up stops before the first query. A test checks them; it does not stand in for them.

## Testing Plan

- Resolver: each refusal and each fallback (deployment without the secret; host, port or database mismatch; same user as the owner; development without the secret).
- The environment scrub: after resolution in a deployment, `process.env` holds neither `DATABASE_URL` nor `PGPASSWORD`.
- On a locally split database (5a's script on PostgreSQL 16, as a non-superuser `CREATEROLE` owner):
  - the server's database start-up as `overhype_app` logs `boundaryEnforced: true` and drift 0;
  - a table the owner then creates is writable by the app through S1's default privileges, and drift reads 1;
  - the repair batch brings drift to 0, leaves the ledger set with the owner, and leaves the membership at `SET FALSE`, `INHERIT TRUE`;
  - the backup's dump as `overhype_app` succeeds with an owner-only schema present.
- **The real runner across a pending migration:**
  - on the split database, the owner creates a table (standing in for Replit's publish), then a test migration alters it;
  - the start fails, and the failure handler's diagnostic names the table;
  - the repair batch runs, and the retry applies the migration and starts.

  The batch is also tested on an owner-created function and enum, which it must move.
- **Stripe start-up** runs through the resolved app connection after the environment scrub: the real sync migrations and pool construction, with only Stripe's network doubled. It completes; it is not skipped as "nothing to initialize". Both drivers' pools take the resolved connection. If this shows a further privilege is needed, that privilege is weighed against the boundary before it is granted (Astra, assessment 2).
- **The three Sentry outcomes** (unenforced, drift, status query failing) each produce a capture.
- **Backup restore:** a dump as the app role restores into a disposable database, which holds the app's tables, `drizzle.__drizzle_migrations` and the ledger, and the app starts against it.
- No UAT section: nothing is product-visible. The Post-merge verification section carries S1–S3 and my checks above as `live` checks.

## Risks and Mitigations

- **A missing or wrong secret fails the publish.** By design. The live site keeps the previous release; the error names the rule.
- **Replit's publish connects as a role other than `neondb_owner`.** Then S1's default privileges don't apply to its new tables. The drift line shows it at the first such publish, and the repair batch still fixes ownership if its owner is `neondb_owner`. If the owner is a role we cannot act as, the boundary still holds but that publish's tables need a new remedy, brought to David then.
- **The boot line's drift count misleads.** It counts by owner, the property the repair batch acts on, across the same object kinds the batch moves. The ledger set is excluded by name, the same names 5a's script excluded.

## Questions for David

- **Q14 — accept the remaining server-compromise risk.** The app's own database login can no longer rewrite the ledger or switch its guard off, so a bad query, a bug or a misused admin screen cannot either. This change does not protect the owner's database password from an attacker who can run code inside the production server, because Replit places it in that server's environment. What is measured: deleting the variable inside the app leaves it readable in `/proc/self/environ`. Whether a sanitised launcher or other platform isolation could close it is not investigated here. 1) accept that remaining risk for Seed; 2) require further isolation work before Seed. **Recommendation: 1.** Running code on the server is what every other control in this phase exists to prevent, and further isolation needs investigation and may mean deployment or database changes well outside this step.
- **Q15 — if the protection breaks later, keep the site up or take it down?** A future permission change could remove the protection while the site is live. 1) keep the website running, alert us, and repair it, with the audit item not counted as done while the alert stands; 2) refuse to start new copies of the server until it is repaired, which can take the site down under load. **Recommendation: 1.** The ledger only records admin actions, nothing breaks for members, and an outage for a repairable permission slip costs more than it protects.

## Definition of Done

- [ ] The resolver, scrub, start-up diagnostics and alerts, backup exclusion and repair batch merged, with the tests above, through the standard loop.
- [ ] S1–S3 done; `[audit-boundary]` quoted from production with `boundaryEnforced: true` and drift 0; `overhype_app` seen connected.
- [ ] Q14 and Q15 answered in words and recorded on #1306 and in `decisions.md`.
- [ ] The first table-adding publish afterwards measured and recorded.
