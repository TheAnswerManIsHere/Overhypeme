/**
 * @purpose The old eval harness (golden set, eval runs, opportunistic ratings) is removed: its routes answer 404, even to an admin.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";

const PREFIX = "t_evalgone_";
let adminSid: string;

async function cleanup() {
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(async () => {
  await cleanup();
  const adminId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary", emailVerifiedAt: new Date(), onboardingCompletedAt: new Date() });
  const data: SessionData = {
    user: { id: adminId, membershipTier: "legendary" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: true,
  };
  adminSid = await createSession(data, adminId);
});

after(cleanup);

describe("the old eval harness routes are gone", () => {
  const gone: Array<[method: "get" | "post", url: string]> = [
    ["post", "/api/admin/facts/1/eval-golden"],
    ["post", "/api/admin/eval/attempts/1/eval"],
    ["post", "/api/admin/eval/runs"],
    ["get", "/api/admin/eval/runs"],
    ["get", "/api/admin/eval/runs/1"],
    ["get", "/api/admin/eval/dashboard"],
    ["get", "/api/admin/eval/attempts/1/image"],
    ["post", "/api/admin/reviews/1/render-scenarios/generic_t2i/attempts/1/eval"],
  ];
  for (const [method, url] of gone) {
    it(`${method.toUpperCase()} ${url} answers 404, even to an admin`, async () => {
      const res = await request(createApp())[method](url).set("Authorization", `Bearer ${adminSid}`).send({});
      assert.equal(res.status, 404);
    });
  }
});
