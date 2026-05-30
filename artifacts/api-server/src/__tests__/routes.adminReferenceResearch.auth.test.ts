/**
 * Auth coverage for POST /admin/references/research.
 *
 * Confirms 401 for unauthenticated requests, 403 for authenticated non-admin,
 * and 400 for valid admin with a missing-input body (proves the route reaches
 * the handler under admin auth without invoking the OpenAI Responses path).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import adminReferenceResearchRouter from "../routes/adminReferenceResearch.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "trr-auth-";

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

describe("POST /admin/references/research — auth", () => {
  let adminUserId: string;
  let nonAdminUserId: string;

  before(async () => {
    adminUserId = await createUser({ isAdmin: true });
    nonAdminUserId = await createUser({ isAdmin: false });
  });

  after(async () => {
    await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  });

  it("returns 401 for unauthenticated", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, adminReferenceResearchRouter);
    const res = await request(app).post("/api/admin/references/research").send({});
    assert.equal(res.status, 401);
  });

  it("returns 403 for non-admin", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: nonAdminUserId }, adminReferenceResearchRouter);
    const res = await request(app).post("/api/admin/references/research").send({});
    assert.equal(res.status, 403);
  });

  it("returns 400 for admin with missing factText", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminReferenceResearchRouter);
    const res = await request(app)
      .post("/api/admin/references/research")
      .send({ sourcePhrase: "Victoria's secret", referenceType: "brand_or_cultural_reference" });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /factText/);
  });

  it("returns 400 for admin with neither sourcePhrase nor canonicalReference", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminReferenceResearchRouter);
    const res = await request(app)
      .post("/api/admin/references/research")
      .send({ factText: "David knows Victoria's secret.", referenceType: "brand_or_cultural_reference" });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /sourcePhrase|canonicalReference/);
  });
});
