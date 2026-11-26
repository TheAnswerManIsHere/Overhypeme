-- Launch Phase 15, increment 5a part 2 (run on production 2026-11-26, #1306), kept here
-- as the record of production's role setup and so the 5b tests build the same shape.
-- Run as the database owner (neondb_owner on production), in one transaction.
-- CHOOSE-A-PASSWORD is replaced by the operator; it never leaves their hands.
-- Production then also ran Q13's grant (the last statement), which keeps Replit's
-- publish working: the owner acts with overhype_app's rights. Owner -> app only.

-- 1. The application's role, and the break-glass role the ledger's guard checks for.
CREATE ROLE overhype_app LOGIN PASSWORD 'CHOOSE-A-PASSWORD';
CREATE ROLE overhype_audit_maintenance NOLOGIN;

-- 2. The owner may hand objects to overhype_app (PostgreSQL 16 needs SET on the new owner).
GRANT overhype_app TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;

-- 3. Connect, and create in public (and new schemas); public itself stays the database owner's.
DO $$ BEGIN EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO overhype_app', current_database()); END $$;
GRANT USAGE, CREATE ON SCHEMA public TO overhype_app;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT nspname FROM pg_namespace WHERE nspname IN ('drizzle', 'stripe')
  LOOP EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO overhype_app', r.nspname); END LOOP;
END $$;

-- 4. Everything the app owns moves to overhype_app, except the ledger and its guard.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'drizzle', 'stripe')
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND NOT (n.nspname = 'public' AND c.relname IN ('ncmec_safety_audit_log', 'ncmec_safety_audit_log_id_seq'))
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO overhype_app',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'drizzle', 'stripe')
       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND p.proname <> 'ncmec_safety_audit_log_append_only'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO overhype_app', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.sig);
  END LOOP;
  FOR r IN
    SELECT t.oid::regtype AS typ, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname IN ('public', 'drizzle', 'stripe')
       AND t.typowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND t.typtype IN ('e', 'd', 'c')
       AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO overhype_app', CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.typ);
  END LOOP;
  FOR r IN SELECT nspname FROM pg_namespace
            WHERE nspname IN ('drizzle', 'stripe') AND nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP EXECUTE format('ALTER SCHEMA %I OWNER TO overhype_app', r.nspname); END LOOP;
END $$;

-- 5. What the app may do to the ledger: read it and append to it. Nothing else.
GRANT SELECT, INSERT ON public.ncmec_safety_audit_log TO overhype_app;
GRANT USAGE, SELECT ON SEQUENCE public.ncmec_safety_audit_log_id_seq TO overhype_app;

-- 6. The owner gives back what step 2 lent it.
REVOKE overhype_app FROM CURRENT_USER;

-- 7. Q13 → 1 (2026-11-26): the owner acts with overhype_app's rights, so Replit's publish,
--    which connects as the owner, can still alter the app's tables.
GRANT overhype_app TO CURRENT_USER WITH INHERIT TRUE, SET FALSE;
