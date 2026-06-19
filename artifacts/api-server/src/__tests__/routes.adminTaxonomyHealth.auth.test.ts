/**
 * Auth coverage for /admin/taxonomy-health routes.
 *
 * Confirms 401 unauthenticated + 403 non-admin for both the GET endpoints
 * and the POST action endpoints. Admin happy paths are exercised
 * elsewhere; here we only want to prove the gate is wired.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import adminTaxonomyHealthRouter from "../routes/adminTaxonomyHealth.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "tth-auth-";

async function createUser(opts: { isAdmin: boolean }): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@example.test`,
    profileImageUrl: null,
    isAdmin: opts.isAdmin,
  });
  return id;
}

const ROUTES: Array<{ method: "get" | "post"; path: string }> = [
  { method: "get",  path: "/admin/taxonomy-health/summary" },
  { method: "get",  path: "/admin/taxonomy-health/facts" },
  { method: "post", path: "/admin/taxonomy-health/actions/backfill-enrichment" },
  { method: "post", path: "/admin/taxonomy-health/actions/repair-projections" },
];

describe("/admin/taxonomy-health — auth", () => {
  let adminUserId: string;
  let nonAdminUserId: string;

  before(async () => {
    adminUserId = await createUser({ isAdmin: true });
    nonAdminUserId = await createUser({ isAdmin: false });
  });

  after(async () => {
    await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  });

  for (const route of ROUTES) {
    it(`${route.method.toUpperCase()} ${route.path} returns 401 for unauthenticated`, async () => {
      const app = buildTestApp({ kind: "unauthenticated" }, adminTaxonomyHealthRouter);
      const res = await request(app)[route.method](`/api${route.path}`).send({});
      assert.equal(res.status, 401);
    });
    it(`${route.method.toUpperCase()} ${route.path} returns 403 for non-admin`, async () => {
      const app = buildTestApp({ kind: "authenticated", userId: nonAdminUserId }, adminTaxonomyHealthRouter);
      const res = await request(app)[route.method](`/api${route.path}`).send({});
      assert.equal(res.status, 403);
    });
  }

  it("admin gets 200 on summary even with an empty DB", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminTaxonomyHealthRouter);
    const res = await request(app).get("/api/admin/taxonomy-health/summary");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.totalFacts, "number");
  });

  it("admin gets 400 on invalid mode for repair-projections", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminTaxonomyHealthRouter);
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/repair-projections")
      .send({ mode: "not_a_real_mode" });
    assert.equal(res.status, 400);
  });
});
