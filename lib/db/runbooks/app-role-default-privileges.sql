-- Launch Phase 15, increment 5b, operator step S1 (docs/plans/PLAN_PHASE15_5B_AUDIT_BOUNDARY.md).
-- Run ONCE on production, as the database owner (neondb_owner), in Replit's production
-- SQL console with editing on: select the whole batch, then Run (the console wraps a
-- selected batch in one transaction).
--
-- Replit's publish applies its generated schema diff as the database owner, so a table it
-- creates belongs to the owner, not to overhype_app. These default privileges let the app
-- read and write such a table from its first start. Ownership is not granted by this; a
-- later ALTER on such a table needs the ownership repair (app-role-ownership-repair.sql).
-- Every privilege here points owner -> app; nothing gives overhype_app any membership.
-- Each of the three schemas that exists (stripe appears once Stripe start-up has run).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT nspname FROM pg_namespace WHERE nspname IN ('public', 'drizzle', 'stripe') LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO overhype_app', r.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO overhype_app', r.nspname);
  END LOOP;
END $$;

-- Read-back: expect two rows for the current user in each of those schemas
-- (objtype r = tables, S = sequences), each granting overhype_app. Production has all
-- three, so six rows.
SELECT pg_get_userbyid(defaclrole) AS for_role, defaclnamespace::regnamespace AS schema, defaclobjtype AS objtype, defaclacl
  FROM pg_default_acl
 WHERE defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
 ORDER BY 2, 3;
