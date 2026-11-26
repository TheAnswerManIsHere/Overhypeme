-- Launch Phase 15, increment 5b: repair ownership after a publish
-- (docs/engineering/ncmec-audit-ledger-hardening.md, "Repairing ownership after a publish").
-- Run on production as the database owner (neondb_owner), in Replit's production SQL
-- console with editing on: select the whole batch, then Run (one transaction).
--
-- When: the [audit-boundary] start-up line reports ownershipDrift above 0, or a start
-- failed on a permission error naming an object in that line's list. Replit's publish
-- creates new tables as the owner; this hands every such object to overhype_app, except
-- the NCMEC audit ledger, its sequence and its guard function, which stay the owner's.
-- It is safe to run when there is nothing to repair: it then changes nothing.

-- 1. The owner may hand objects to overhype_app only while it can SET to it (PostgreSQL 16).
--    Step 3 takes this back; the owner's INHERIT membership, which Replit's publish needs,
--    is left exactly as it was.
GRANT overhype_app TO CURRENT_USER WITH SET TRUE;

-- 2. Every object the owner holds in the application's schemas moves to overhype_app,
--    except the ledger set. The same object kinds and exclusions as ownershipDrift()
--    (lib/db/src/index.ts), so the start-up line reads 0 afterwards.
DO $$
DECLARE r record;
BEGIN
  -- Tables, views, materialized views, foreign tables and standalone sequences
  -- (a table's indexes and owned sequences follow it).
  FOR r IN
    SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'drizzle', 'stripe')
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND NOT (n.nspname = 'public' AND c.relname IN ('ncmec_safety_audit_log', 'ncmec_safety_audit_log_id_seq'))
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')))
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO overhype_app',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname);
  END LOOP;

  -- Functions and procedures, except the ledger's guard; extension members stay where they are.
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'drizzle', 'stripe')
       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND NOT (n.nspname = 'public' AND p.proname = 'ncmec_safety_audit_log_append_only')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO overhype_app', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.sig);
  END LOOP;

  -- Enums, domains and standalone composite types (not a table's row type, not an extension's).
  FOR r IN
    SELECT t.oid::regtype AS typ, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname IN ('public', 'drizzle', 'stripe')
       AND t.typowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND t.typtype IN ('e', 'd', 'c')
       AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO overhype_app', CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.typ);
  END LOOP;

  -- Last, the schemas the app manages wholly, should Replit ever have created one.
  FOR r IN SELECT nspname FROM pg_namespace
            WHERE nspname IN ('drizzle', 'stripe') AND nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP EXECUTE format('ALTER SCHEMA %I OWNER TO overhype_app', r.nspname); END LOOP;
END $$;

-- 3. Take back step 1's SET. Expect afterwards: the owner's rows for overhype_app read
--    set_option f, with one row inherit_option t (and the admin row unchanged).
GRANT overhype_app TO CURRENT_USER WITH SET FALSE;

SELECT r.rolname AS role, m.rolname AS member, a.admin_option, a.set_option, a.inherit_option
  FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
 WHERE r.rolname = 'overhype_app'
 ORDER BY 2, 3;
