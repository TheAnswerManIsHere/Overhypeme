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

import { pool as sharedPool, canEffectivelyAssumeRole } from "./index.js";

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
});
