# Hardening the NCMEC safety audit ledger

`ncmec_safety_audit_log` records every action taken on `/admin/safety` — retries, manual
filings, backlog-audit dispositions, config writes. Because that surface has no capability
system (settled decision 15: `requireAdmin` only), **this ledger is the sole control over
destructive admin actions**, and it is append-only at the database: `UPDATE`, `DELETE` and
`TRUNCATE` all raise.

Migration `0097` creates the table, the guard function and both triggers. It cannot make that
guarantee a **privilege boundary** — this document is how you do that, and it needs a
superuser.

## Why the migration cannot do this itself

The triggers block row mutation, but `ALTER TABLE ... DISABLE TRIGGER` requires only
**ownership**. The migration runs as the application role, so the application owns everything
the migration creates and can turn its own guard off.

The obvious fix — have the migration transfer ownership to a role the application is not a
member of — does not work, and the reason is structural rather than incidental:

- `ALTER TABLE ... OWNER TO <role>` requires the ability to `SET ROLE` to that role. So the
  transfer succeeds only when the application can become the new owner, which is precisely
  the access that lets it take ownership back and disable the trigger. Where the transfer
  would buy something, it is not permitted; where it is permitted, it buys nothing.
- Having the migration `CREATE ROLE` the owner or maintenance role is worse. On PostgreSQL 16
  a non-superuser `CREATEROLE` role that creates a role is **automatically granted it WITH
  ADMIN OPTION**, and that membership's grantor is the bootstrap superuser. The application
  can therefore re-grant the role to itself at will, and cannot revoke the grant — a `REVOKE`
  issued by anyone but the grantor emits a warning and changes nothing, so the migration
  would report a closed boundary over an open one.

So `0097` creates the objects, leaves the roles to you, and reports the residual state. It
emits a `WARNING` naming the schemas involved on every application.

## What "hardened" means

`ncmecAuditBoundaryStatus()` (`lib/db/src/index.ts`) reports `boundaryEnforced: true` only
when all of the following hold:

1. The application role does **not** own `ncmec_safety_audit_log`.
2. The application role does **not** own `ncmec_safety_audit_log_append_only()`.
3. The application role cannot effectively assume the ledger's owner, the containing schema's
   owner, the guard function's schema owner, or `overhype_audit_maintenance` — where
   "effectively assume" covers `INHERIT` membership, `SET ROLE` membership, and any
   admin-option chain that would let it grant itself the role.
4. Both triggers exist and are enabled in `ALWAYS` mode.

Phase 6's activation gate refuses production filing while this is false. That is deliberate:
it blocks the dangerous **state**, not one path into it, so an unhardened database cannot file
regardless of how it got there.

## The procedure

Run every statement **as a superuser** (`postgres`, or your platform's equivalent), against the
application database, after `0097` has applied.

Substitute:

- `<app>` — the role your application connects as. The migration's warning names it, or
  `SELECT current_user` from an application session.
- `<ledger_schema>` — the schema holding `ncmec_safety_audit_log`. The warning names it.
- `<fn_schema>` — the schema holding `ncmec_safety_audit_log_append_only()`. The warning names
  it; it is usually but not necessarily the same as `<ledger_schema>`.

```sql
-- 1. The two roles. Created BY A SUPERUSER, which is what keeps <app> out of them:
--    a superuser's CREATE ROLE confers no membership on <app>.
CREATE ROLE overhype_audit_owner NOLOGIN;
CREATE ROLE overhype_audit_maintenance NOLOGIN;

-- 2. Move the ledger and its guard out of the application's reach.
ALTER TABLE    <ledger_schema>.ncmec_safety_audit_log            OWNER TO overhype_audit_owner;
ALTER FUNCTION <fn_schema>.ncmec_safety_audit_log_append_only()  OWNER TO overhype_audit_owner;

-- 3. Give the application back exactly what it needs — and nothing else.
--    Ownership carried these implicitly; after the transfer they must be explicit, or every
--    audit-log write fails.
GRANT SELECT, INSERT ON <ledger_schema>.ncmec_safety_audit_log            TO <app>;
GRANT USAGE, SELECT  ON SEQUENCE <ledger_schema>.ncmec_safety_audit_log_id_seq TO <app>;
```

### Verify

```sql
SELECT pg_get_userbyid(relowner) FROM pg_class
 WHERE oid = '<ledger_schema>.ncmec_safety_audit_log'::regclass;
-- expect: overhype_audit_owner

SELECT pg_has_role('<app>', 'overhype_audit_owner',       'usage'),
       pg_has_role('<app>', 'overhype_audit_owner',       'set'),
       pg_has_role('<app>', 'overhype_audit_maintenance', 'usage'),
       pg_has_role('<app>', 'overhype_audit_maintenance', 'set');
-- expect: f, f, f, f

SELECT roleid::regrole, member::regrole, admin_option
  FROM pg_auth_members
 WHERE roleid IN ('overhype_audit_owner'::regrole, 'overhype_audit_maintenance'::regrole);
-- expect: no rows. Any row here — including one carrying only ADMIN OPTION — is a path
-- <app> can use to reach the role, and ncmecAuditBoundaryStatus() will keep reporting it.
```

Then, from the application, `ncmecAuditBoundaryStatus()` must report `boundaryEnforced: true`.
That is the check to trust; the SQL above is how you diagnose it when it does not.

### Schema ownership

Steps 1–3 are sufficient on a deployment where `<app>` does not own `<ledger_schema>` or
`<fn_schema>`. If it does, it can still reach the objects inside them, and
`ncmecAuditBoundaryStatus()` reports that as a bypass. Move the schema too:

```sql
ALTER SCHEMA <ledger_schema> OWNER TO <some role <app> cannot assume>;
```

This is usually only relevant when the application owns `public`, which many managed Postgres
providers arrange by default.

## Production: the application's own login (Launch Phase 15, 5b)

Production does not use the procedure above. Its database is Neon's, managed by Replit, whose
owner `neondb_owner` is a non-superuser `CREATEROLE` role, and Replit supplies the deployment's
`DATABASE_URL` as that owner, ignoring an override. **The app connects with that login**, as
the platform expects (Launch Phase 15, 5c; `docs/plans/PLAN_PHASE15_5C_OWNER_LOGIN.md`;
decision of 2026-11-27):

- **The app's login owns the ledger**, so `boundaryEnforced` reads false. David accepted that
  the guard is not enforced against the application's own login (Q20 → 1): a session that can
  run arbitrary SQL as the app could disable the triggers first. The triggers still refuse
  `UPDATE`, `DELETE` and `TRUNCATE` from every session without `overhype_audit_maintenance`,
  the app's own included, so a bug or stray query cannot change the ledger.
- **Every start logs `[audit-boundary]`** with the full status object. In a deployment the
  `audit_boundary` operational alert (`lib/operationalAlerts.ts`; its Sentry rule pushes to
  David's phone) fires only when the guard itself is damaged (`triggersEnabled` or
  `guardFunctionIntact` false) or the status query fails. The accepted state alerts nothing,
  and nothing stops the start (`artifacts/api-server/src/lib/auditBoundaryReport.ts`).
- **Why not a separate application login.** 5b tried one (`overhype_app`, 2026-11-26). Replit's
  publish applies its schema diff as the owner, so every table a publish created was the
  owner's, and the app's own migration then could not alter it: the first such publish
  crash-looped (`must be owner of table fact_gag_descriptions`, 2026-11-27). The protection it
  bought covered only an attacker with SQL as the app, who can already read and change every
  other table. It was rolled back; the record is `decisions.md`, 2026-11-27.
- **Tamper-evidence beyond the database** (a copy of each entry kept elsewhere, which would
  hold even against code execution on the server) is recorded as next work, to be weighed
  before Full US.

### Retiring 5b's login (once)

`lib/db/runbooks/app-role-retire.sql`, run once as `neondb_owner` in Replit's production SQL
console with editing on, as **one selected batch** (the console runs a selection in one
transaction; its Run button alone runs only the statement under the cursor). Run it only after
the 5c release is published and healthy and Replit shows the previous release stopped. It lists
what is being retired, refuses while any session is still connected as `overhype_app` or while
the role has anything outside this database, gives up after a 5-second lock wait or a 60-second
statement (it rolls back and is simply run again), then runs `REASSIGN OWNED`, `DROP OWNED` and
`DROP ROLE` and reads back the ledger's owner and triggers. The test
`artifacts/api-server/src/__tests__/phase15.appRoleRetire.test.ts` rehearses it on a database
laid out as production was after 5b.

## Correcting the ledger (break-glass)

The ledger is append-only, so a genuine correction is a deliberate, auditable act outside the
application. A session holding `overhype_audit_maintenance` may `UPDATE`, `DELETE` and
`TRUNCATE`; nothing else can.

```sql
SET ROLE overhype_audit_maintenance;
-- ... the correction ...
RESET ROLE;
```

Granting that role is the audit trail. Grant it for the duration of the correction and revoke
it afterwards:

```sql
GRANT overhype_audit_maintenance TO <a named human role> WITH SET TRUE;
-- ... the correction ...
REVOKE overhype_audit_maintenance FROM <that role>;
```

**Do not grant it to `<app>`.** Doing so re-opens the bypass, and
`ncmecAuditBoundaryStatus()` will report `boundaryEnforced: false` until it is revoked —
which, on a grant a superuser issued, only that superuser can do.

## If you skip this

Nothing breaks, and nothing files. The trigger's guard checks `pg_catalog.pg_roles` before it
checks membership, so while `overhype_audit_maintenance` does not exist **no session at all**
can `UPDATE`, `DELETE` or `TRUNCATE` the ledger — it is strictly more locked down than the
hardened state, just not *enforceably* so, since the application still owns the table and can
disable the trigger. Production filing stays blocked by the activation gate until
`boundaryEnforced` is true.
