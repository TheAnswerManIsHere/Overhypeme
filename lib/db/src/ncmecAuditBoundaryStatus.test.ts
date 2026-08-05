/**
 * `canEffectivelyAssumeRole()` — the three ways a session can end up with a role's
 * privileges (INHERIT, SET, or ADMIN OPTION), tested from a genuinely restricted,
 * non-superuser connection.
 *
 * This function's own module (`index.ts`) always connects via `pool`, which is a
 * superuser in every environment this suite runs in — and a superuser holds every
 * role's privileges unconditionally, regardless of any explicit grant. Two real defects
 * in this exact function (the `usage`-vs-`SET` gap, and the `ADMIN OPTION` gap) were
 * found by review rather than by a test, because nothing exercising it through `pool`
 * could ever have caught either one. `targetPool` exists on `canEffectivelyAssumeRole`
 * (and `canAssumeRole`, which it delegates to) specifically so this file can pass a
 * `Pool` authenticated as a role with no elevated privileges at all.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

import { pool as sharedPool, canEffectivelyAssumeRole, ncmecAuditBoundaryStatus } from "./index.js";

describe("canEffectivelyAssumeRole — from a genuinely restricted connection", () => {
  if (!process.env.DATABASE_URL) {
    it("skipped — DATABASE_URL not set", (t) => t.skip());
    return;
  }

  const runId = crypto.randomBytes(4).toString("hex");
  const targetRole = `nab_target_${runId}`;
  const loginRole = `nab_login_${runId}`;
  const password = crypto.randomBytes(16).toString("hex");
  let loginPool: pg.Pool;

  before(async () => {
    await sharedPool.query(`CREATE ROLE "${targetRole}" NOLOGIN`);
    await sharedPool.query(`CREATE ROLE "${loginRole}" LOGIN PASSWORD '${password}'`);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = loginRole;
    url.password = password;
    loginPool = new pg.Pool({ connectionString: url.toString() });
  });

  after(async () => {
    await loginPool.end();
    await sharedPool.query(`DROP OWNED BY "${loginRole}"`).catch(() => {});
    await sharedPool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    await sharedPool.query(`DROP OWNED BY "${targetRole}"`).catch(() => {});
    await sharedPool.query(`DROP ROLE IF EXISTS "${targetRole}"`);
  });

  it("reports false with no relationship to the target role at all", async () => {
    assert.equal(await canEffectivelyAssumeRole(targetRole, loginPool), false);
  });

  it("reports true for INHERIT-only membership (ordinary usage)", async () => {
    await sharedPool.query(`GRANT "${targetRole}" TO "${loginRole}" WITH INHERIT TRUE, SET FALSE`);
    try {
      assert.equal(await canEffectivelyAssumeRole(targetRole, loginPool), true);
    } finally {
      await sharedPool.query(`REVOKE "${targetRole}" FROM "${loginRole}"`);
    }
  });

  it("reports true for SET-only membership (no inherit) — the usage-check gap this function replaced", async () => {
    await sharedPool.query(`GRANT "${targetRole}" TO "${loginRole}" WITH INHERIT FALSE, SET TRUE`);
    try {
      assert.equal(await canEffectivelyAssumeRole(targetRole, loginPool), true);
    } finally {
      await sharedPool.query(`REVOKE "${targetRole}" FROM "${loginRole}"`);
    }
  });

  it("reports true for ADMIN-only membership — can self-grant SET then assume it", async () => {
    await sharedPool.query(
      `GRANT "${targetRole}" TO "${loginRole}" WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
    );
    try {
      assert.equal(await canEffectivelyAssumeRole(targetRole, loginPool), true);
    } finally {
      await sharedPool.query(`REVOKE "${targetRole}" FROM "${loginRole}"`);
    }
  });

  it("reports true for INHERITED ADMIN OPTION — a helper role's admin option propagates through ordinary membership", async () => {
    // Verified directly against this repository's PostgreSQL 16 target: loginRole here holds
    // no direct relationship to targetRole at all — only an ordinary INHERIT TRUE membership
    // in helperRole, which itself holds ADMIN TRUE, INHERIT FALSE, SET FALSE on targetRole.
    // loginRole can still run `GRANT targetRole TO loginRole WITH SET TRUE` (self-granting,
    // which admin option always permits) and then SET ROLE succeeds — the admin option
    // propagates through the same inheritance chain as any other privilege. A direct
    // `m.member = current_user` lookup on pg_auth_members would miss this: no row ever names
    // loginRole as the member on targetRole's own admin grant.
    const helperRole = `nab_helper_${runId}`;
    await sharedPool.query(`CREATE ROLE "${helperRole}" NOLOGIN`);
    await sharedPool.query(
      `GRANT "${targetRole}" TO "${helperRole}" WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
    );
    await sharedPool.query(`GRANT "${helperRole}" TO "${loginRole}" WITH INHERIT TRUE, SET FALSE`);
    try {
      assert.equal(await canEffectivelyAssumeRole(targetRole, loginPool), true);
    } finally {
      await sharedPool.query(`REVOKE "${helperRole}" FROM "${loginRole}"`);
      await sharedPool.query(`REVOKE "${targetRole}" FROM "${helperRole}"`);
      await sharedPool.query(`DROP OWNED BY "${helperRole}"`).catch(() => {});
      await sharedPool.query(`DROP ROLE IF EXISTS "${helperRole}"`);
    }
  });

  it("reports true for SET-REACHABLE ADMIN OPTION — a helper role reachable only via SET ROLE still propagates its admin option", async () => {
    // Round 8 finding: the admin-option traversal originally checked the grantee of the
    // target's admin-option grant with a bare `pg_has_role(current_user, helper, 'usage')` —
    // INHERIT-reachability only. A helper role reachable ONLY via `SET ROLE` (INHERIT FALSE,
    // SET TRUE), not ordinary inheritance, was missed entirely: `usage` reports false for
    // loginRole against helperRole, yet loginRole can still `SET ROLE` to helperRole,
    // self-grant `SET TRUE` on targetRole as helperRole (admin option always permits
    // self-granting), and `SET ROLE` to targetRole — a real, immediate escalation path.
    // Verified directly against this repository's PostgreSQL 16 target before this fix: the
    // old traversal reported `false` here even though the escalation succeeds manually.
    const helperRole = `nab_helper2_${runId}`;
    await sharedPool.query(`CREATE ROLE "${helperRole}" NOLOGIN`);
    await sharedPool.query(
      `GRANT "${targetRole}" TO "${helperRole}" WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
    );
    await sharedPool.query(`GRANT "${helperRole}" TO "${loginRole}" WITH INHERIT FALSE, SET TRUE`);
    try {
      assert.equal(await canEffectivelyAssumeRole(targetRole, loginPool), true);
    } finally {
      await sharedPool.query(`REVOKE "${helperRole}" FROM "${loginRole}"`);
      await sharedPool.query(`REVOKE "${targetRole}" FROM "${helperRole}"`);
      await sharedPool.query(`DROP OWNED BY "${helperRole}"`).catch(() => {});
      await sharedPool.query(`DROP ROLE IF EXISTS "${helperRole}"`);
    }
  });

  it("is not fooled by a session-level search_path shadow of pg_has_role", async () => {
    // Round 9 finding: this function's own runtime queries were left unqualified, unlike the
    // trigger body fixed in round 8 — but `targetPool` is meant to be usable as a genuinely
    // restricted connection representing the CHECKED role itself (per this describe block's
    // whole premise), which means that role fully controls its own session's search_path. A
    // role that genuinely has INHERIT usage of the target, but wants this check to
    // under-report its own bypass capability, can create a schema it owns, shadow
    // `pg_has_role` there to always return false, and put that schema ahead of an
    // explicitly-named `pg_catalog` on its own search_path. Verified directly against this
    // repository's PostgreSQL 16 target before the fix: the unqualified form read `false`
    // where the real privilege (and `pg_catalog.pg_has_role`) both read `true`.
    const shadowSchema = `nab_shadow_${runId}`;
    await sharedPool.query(`GRANT "${targetRole}" TO "${loginRole}" WITH INHERIT TRUE, SET FALSE`);
    await sharedPool.query(`CREATE SCHEMA "${shadowSchema}" AUTHORIZATION "${loginRole}"`);
    try {
      await loginPool.query(`SET search_path = "${shadowSchema}", pg_catalog`);
      await loginPool.query(
        `CREATE FUNCTION "${shadowSchema}".pg_has_role(name, text, text) RETURNS boolean AS $$ SELECT false $$ LANGUAGE sql`,
      );
      assert.equal(await canEffectivelyAssumeRole(targetRole, loginPool), true);
    } finally {
      await loginPool.query(`RESET search_path`).catch(() => {});
      await sharedPool.query(`DROP SCHEMA IF EXISTS "${shadowSchema}" CASCADE`).catch(() => {});
      await sharedPool.query(`REVOKE "${targetRole}" FROM "${loginRole}"`).catch(() => {});
    }
  });
});

/**
 * `ncmecAuditBoundaryStatus()` itself has the identical defect `canEffectivelyAssumeRole` had
 * before `targetPool` existed: called with no argument (every caller outside this file), it
 * queries through this module's own `pool`, a superuser — so `applicationOwnsTable`,
 * `applicationOwnsFunction`, and `applicationCanBypassTrigger` would report `true`
 * unconditionally, regardless of migration 0097's real, current ownership state. This does
 * not mutate `ncmec_safety_audit_log`'s actual ownership (a shared, migration-owned object) —
 * it only compares what two different connections report about whatever state it is already
 * in, which is enough to prove the injected pool is actually driving these fields rather than
 * being accepted and ignored.
 */
describe("ncmecAuditBoundaryStatus — pool injection", () => {
  if (!process.env.DATABASE_URL) {
    it("skipped — DATABASE_URL not set", (t) => t.skip());
    return;
  }

  const runId = crypto.randomBytes(4).toString("hex");
  const loginRole = `nabs_login_${runId}`;
  const password = crypto.randomBytes(16).toString("hex");
  let loginPool: pg.Pool;

  before(async () => {
    await sharedPool.query(`CREATE ROLE "${loginRole}" LOGIN PASSWORD '${password}'`);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = loginRole;
    url.password = password;
    loginPool = new pg.Pool({ connectionString: url.toString() });
  });

  after(async () => {
    await loginPool.end();
    await sharedPool.query(`DROP OWNED BY "${loginRole}"`).catch(() => {});
    await sharedPool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
  });

  it("a role with no relationship to any owner role never reports ownership-equivalent access", async () => {
    // loginRole was just created and has never been granted membership in anything, so
    // whatever currently owns the table/function/schema/maintenance role in this sandbox,
    // loginRole cannot be a member of it, SET ROLE to it, or hold ADMIN OPTION on it — and it
    // is not the database owner, so it holds no implicit membership in pg_database_owner
    // (the real owner of `public` on PostgreSQL 15+) either.
    const status = await ncmecAuditBoundaryStatus(loginPool);
    assert.equal(status.applicationOwnsTable, false);
    assert.equal(status.applicationOwnsFunction, false);
    assert.equal(status.applicationOwnsSchema, false);
    assert.equal(status.applicationOwnsFunctionSchema, false);
    assert.equal(status.applicationCanBypassTrigger, false);
  });

  it("the module's own (superuser) pool reports ownership-equivalent access unconditionally — the gap targetPool exists to bypass", async () => {
    // Same table, same function, same schema, same maintenance role, queried through the same
    // connection every real caller uses by default. A superuser satisfies
    // pg_has_role(..., 'usage') for any role with zero explicit grant, so these read true
    // regardless of who actually owns anything — proving why boundaryEnforced can never
    // usefully be asserted true through this default pool (see migrations.0097.test.ts's
    // comment on the same limitation).
    const status = await ncmecAuditBoundaryStatus();
    assert.equal(status.applicationOwnsTable, true);
    assert.equal(status.applicationOwnsFunction, true);
    assert.equal(status.applicationOwnsSchema, true);
    assert.equal(status.applicationOwnsFunctionSchema, true);
    if (status.maintenanceRoleExists) {
      assert.equal(status.applicationCanBypassTrigger, true);
    }
  });

  it("reports the boundary NOT enforced when the application owns only the containing SCHEMA, not the table — the DROP-TABLE bypass round 8 found", async () => {
    // Round 8 finding: boundaryEnforced only ever checked table ownership, function
    // ownership, and maintenance-role access — never the containing SCHEMA's ownership. A
    // schema owner can DROP TABLE any object inside that schema regardless of the object's
    // own relowner (verified directly against this repository's PostgreSQL 16 target: a role
    // holding ONLY schema ownership successfully dropped a table owned by a different,
    // unrelated role in the same schema). So even a database whose ledger TABLE and FUNCTION
    // were both fully transferred to overhype_audit_owner is still bypassable by
    // drop-and-recreate if the application (or a role it can become) still effectively owns
    // the schema the ledger lives in — which `applicationOwnsSchema` must now catch and
    // `boundaryEnforced` must now refuse to report true over.
    const status = await ncmecAuditBoundaryStatus(loginPool);
    assert.equal(status.schemaOwner, "pg_database_owner", "the shared test sandbox's ledger lives in public, owned by pg_database_owner on PostgreSQL 15+");
    // loginRole is not the database owner, so it holds no membership in pg_database_owner —
    // this branch only proves the field and formula wiring; the actual bypass reproduction
    // (a role that DOES own the schema dropping a table it doesn't own) was verified by hand
    // against the live sandbox, not re-encoded here, since granting a fresh role database
    // ownership is not something this suite can safely do to a shared sandbox database.
    assert.equal(status.applicationOwnsSchema, false);

    const superuserStatus = await ncmecAuditBoundaryStatus();
    // The module's own pool connects as this sandbox's actual database owner, so it DOES
    // effectively own `public` via pg_database_owner — proving applicationOwnsSchema tracks
    // real reachability, and that boundaryEnforced now factors it in rather than only
    // reporting on table/function ownership.
    assert.equal(superuserStatus.applicationOwnsSchema, true);
    assert.equal(superuserStatus.boundaryEnforced, false);
  });

  it("is not fooled by a session-level search_path shadow of to_regclass/to_regprocedure themselves", async () => {
    // Round 10 finding: pg_has_role/pg_roles/etc. were qualified in round 9, but
    // to_regclass/to_regprocedure were deliberately left bare on the theory that they exist
    // specifically to resolve an unqualified NAME via search_path, so qualifying them would
    // change that resolution — wrong: qualifying the FUNCTION CALL only pins down which
    // function runs, not how it resolves its string argument (that still goes through
    // search_path exactly as before). What was actually left open is that the checked role
    // can create its OWN same-named, same-signature to_regclass/to_regprocedure function in
    // a schema ahead of pg_catalog, which shadows the real function entirely and returns an
    // ATTACKER-CHOSEN object regardless of the argument. Verified directly against this
    // repository's PostgreSQL 16 target before the fix: an unqualified
    // to_regclass('ncmec_safety_audit_log') call resolved to a decoy table via exactly this
    // shadow, ignoring its argument entirely.
    const shadowSchema = `nabs_shadow2_${runId}`;
    const decoySchema = `nabs_decoy_${runId}`;
    await sharedPool.query(`CREATE SCHEMA "${shadowSchema}" AUTHORIZATION "${loginRole}"`);
    await sharedPool.query(`CREATE SCHEMA "${decoySchema}" AUTHORIZATION "${loginRole}"`);
    try {
      await loginPool.query(`CREATE TABLE "${decoySchema}".decoy_ledger (id int)`);
      await loginPool.query(
        `CREATE FUNCTION "${decoySchema}".decoy_guard() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`,
      );
      // shadowSchema leads, pg_catalog is named explicitly, and public trails so the REAL
      // functions (once correctly qualified) can still resolve the real ledger by its
      // unqualified name — same technique as the migrations.0097.test.ts search_path test.
      await loginPool.query(`SET search_path = "${shadowSchema}", pg_catalog, public`);
      await loginPool.query(
        `CREATE FUNCTION "${shadowSchema}".to_regclass(text) RETURNS regclass AS $$ SELECT '${decoySchema}.decoy_ledger'::regclass $$ LANGUAGE sql`,
      );
      await loginPool.query(
        `CREATE FUNCTION "${shadowSchema}".to_regprocedure(text) RETURNS regprocedure AS $$ SELECT '${decoySchema}.decoy_guard()'::regprocedure $$ LANGUAGE sql`,
      );
      const status = await ncmecAuditBoundaryStatus(loginPool);
      // If either shadow had taken effect, tableOwner/functionOwner would resolve to
      // loginRole (the decoy objects' owner) instead of the real ledger's actual owner.
      assert.notEqual(status.tableOwner, loginRole);
      assert.notEqual(status.functionOwner, loginRole);
    } finally {
      await loginPool.query(`RESET search_path`).catch(() => {});
      await sharedPool.query(`DROP SCHEMA IF EXISTS "${shadowSchema}" CASCADE`).catch(() => {});
      await sharedPool.query(`DROP SCHEMA IF EXISTS "${decoySchema}" CASCADE`).catch(() => {});
    }
  });
});
