-- Launch Phase 15, 5c: retire overhype_app, the separate application login 5b created
-- (docs/plans/PLAN_PHASE15_5C_OWNER_LOGIN.md, D3; docs/engineering/ncmec-audit-ledger-hardening.md).
--
-- Run ONCE, on production, as the database owner (neondb_owner), in Replit's production SQL
-- console with editing on: select the WHOLE batch, then Run. The console runs a selection as
-- one transaction, so any failure below rolls everything back and changes nothing.
--
-- Run it ONLY after the 5c release (the app connecting with DATABASE_URL) is published and
-- confirmed healthy, and Replit shows the previous release stopped (plan D4).
--
-- It refuses, changing nothing, when:
--   - a session is still connected as overhype_app (an old instance has not stopped);
--   - overhype_app owns, or holds a privilege on, anything outside this database;
--   - a lock it needs is not granted within 5 seconds, or a statement runs past 60 seconds
--     (for example while the media backup's dump holds its transaction). Run it again later.
-- It names no object, so it cannot miss one, and it uses no CASCADE.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Inventory, read-only: what is being retired.
SELECT 'membership' AS item, r.rolname || ' -> ' || m.rolname AS detail,
       format('admin=%s set=%s inherit=%s', a.admin_option, a.set_option, a.inherit_option) AS value
  FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
 WHERE r.rolname = 'overhype_app' OR m.rolname = 'overhype_app'
UNION ALL
SELECT 'owns', c.relkind::text, count(*)::text
  FROM pg_class c WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'overhype_app') GROUP BY c.relkind
UNION ALL
SELECT 'owns', 'function', count(*)::text
  FROM pg_proc p WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'overhype_app')
UNION ALL
SELECT 'owns', 'type', count(*)::text
  FROM pg_type t WHERE t.typowner = (SELECT oid FROM pg_roles WHERE rolname = 'overhype_app') AND t.typtype IN ('e', 'd', 'c')
UNION ALL
SELECT 'owns', 'schema', string_agg(nspname, ', ')
  FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'overhype_app')
UNION ALL
SELECT 'default privileges for', pg_get_userbyid(d.defaclrole) || ' in ' || coalesce(d.defaclnamespace::regnamespace::text, '(all)'), d.defaclobjtype::text
  FROM pg_default_acl d WHERE d.defaclacl::text LIKE '%overhype_app=%'
UNION ALL
SELECT 'sessions connected', 'overhype_app', count(*)::text FROM pg_stat_activity WHERE usename = 'overhype_app';

-- 2. The guards. Any one of them aborts the whole batch.
DO $$
DECLARE
  app oid := (SELECT oid FROM pg_roles WHERE rolname = 'overhype_app');
  sessions int;
  elsewhere int;
BEGIN
  IF app IS NULL THEN
    RAISE EXCEPTION 'overhype_app does not exist: there is nothing to retire';
  END IF;
  SELECT count(*) INTO sessions FROM pg_stat_activity WHERE usename = 'overhype_app';
  IF sessions > 0 THEN
    RAISE EXCEPTION '% session(s) still connected as overhype_app: an old release may still be running. Nothing was changed; investigate, do not terminate them.', sessions;
  END IF;
  -- Ownership or privileges in another database, or on another database itself. REASSIGN
  -- OWNED and DROP OWNED act on this database (and its own grants) only.
  SELECT count(*) INTO elsewhere FROM pg_shdepend d
   WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = app
     AND (d.dbid NOT IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
          OR (d.dbid = 0 AND NOT (d.classid = 'pg_database'::regclass
                                  AND d.objid = (SELECT oid FROM pg_database WHERE datname = current_database()))));
  IF elsewhere > 0 THEN
    RAISE EXCEPTION 'overhype_app has % dependenc(ies) outside this database. Nothing was changed; investigate first.', elsewhere;
  END IF;
END $$;

-- 3. Everything overhype_app owns becomes the owner's again; then its remaining grants and
--    the default privileges naming it go; then the login itself.
REASSIGN OWNED BY overhype_app TO CURRENT_USER;
DROP OWNED BY overhype_app;
DROP ROLE overhype_app;

-- 4. Read-back. Expect: overhype_app_exists f; the ledger, its sequence and its guard function
--    owned by the database owner; both triggers present and enabled (tgenabled 'A').
SELECT 'overhype_app_exists' AS item, (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'overhype_app'))::text AS value
UNION ALL
SELECT 'ledger owner', pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.ncmec_safety_audit_log'::regclass
UNION ALL
SELECT 'guard function owner', pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.ncmec_safety_audit_log_append_only()'::regprocedure
UNION ALL
SELECT 'trigger ' || tgname, tgenabled::text FROM pg_trigger
 WHERE tgrelid = 'public.ncmec_safety_audit_log'::regclass AND NOT tgisinternal;
