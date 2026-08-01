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
});

/**
 * `ncmecAuditBoundaryStatus()` itself has the identical defect `canEffectivelyAssumeRole` had
 * before `targetPool` existed: called with no argument (every caller outside this file), it
 * queries through this module's own `pool`, a superuser — so `applicationOwnsTable`,
 * `applicationOwnsFunction`, and `applicationCanBypassTrigger` would report `true`
 * unconditionally, regardless of migration 0095's real, current ownership state. This does
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
    // whatever currently owns the table/function/maintenance role in this sandbox, loginRole
    // cannot be a member of it, SET ROLE to it, or hold ADMIN OPTION on it.
    const status = await ncmecAuditBoundaryStatus(loginPool);
    assert.equal(status.applicationOwnsTable, false);
    assert.equal(status.applicationOwnsFunction, false);
    assert.equal(status.applicationCanBypassTrigger, false);
  });

  it("the module's own (superuser) pool reports ownership-equivalent access unconditionally — the gap targetPool exists to bypass", async () => {
    // Same table, same function, same maintenance role, queried through the same connection
    // every real caller uses by default. A superuser satisfies pg_has_role(..., 'usage') for
    // any role with zero explicit grant, so these read true regardless of who actually owns
    // anything — proving why boundaryEnforced can never usefully be asserted true through
    // this default pool (see migrations.0095.test.ts's comment on the same limitation).
    const status = await ncmecAuditBoundaryStatus();
    assert.equal(status.applicationOwnsTable, true);
    assert.equal(status.applicationOwnsFunction, true);
    if (status.maintenanceRoleExists) {
      assert.equal(status.applicationCanBypassTrigger, true);
    }
  });
});
