/**
 * Launch Phase 3, increment 3 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §3, "admin access is proven the normal way"): on a database built from the
 * schema baseline, an account made through the ordinary sign-up reaches the
 * admin console once its id is in ADMIN_USER_IDS — and not before. No seeded
 * admin row, no dev-admin login: the path a freshly reset production offers.
 *
 * (The bootstrap-email grant is the other route; routes.admin.test.ts and
 * adminLockout.integration.test.ts already exercise it, and signing up as that
 * one address here would collide with them in a shared shard database.)
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";

import { db, usersTable } from "@workspace/db";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import localAuthRouter from "../routes/localAuth.js";
import adminRouter from "../routes/admin.js";

const email = `t_p3signin_${randomUUID()}@test.local`;
const priorAdminIds = process.env.ADMIN_USER_IDS;

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.headers["cf-connecting-ip"] ??= `172.31.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    next();
  });
  app.use(express.json());
  app.use(authMiddleware);
  app.use(localAuthRouter);
  app.use(adminRouter);
  return app;
}

describe("admin by the ordinary sign-in", () => {
  after(async () => {
    if (priorAdminIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdminIds;
    await db.delete(usersTable).where(eq(usersTable.email, email));
  });

  it("an account made by sign-up reaches the admin console through ADMIN_USER_IDS, and only through it", async () => {
    const app = makeApp();
    const signup = await request(app).post("/auth/register").send({
      email,
      password: "a-long-enough-password",
      displayName: "Phase Three",
      firstName: "Phase",
      lastName: "Three",
      pronouns: "they/them",
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const id = (signup.body.user as { id: string }).id;
    // The session the sign-up set, carried as the bearer form the middleware also
    // accepts: the cookie is Secure, and this harness speaks plain HTTP.
    const raw = signup.headers["set-cookie"];
    const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const sid = /^sid=([^;]+)/.exec(cookies.find((c) => c.startsWith("sid=")) ?? "")?.[1];
    assert.ok(sid, "the sign-up set a session");
    const asUser = () => request(app).get("/admin/config").set("authorization", `Bearer ${sid}`);

    const before = await asUser();
    assert.equal(before.status, 403, "a new account is not an admin");

    process.env.ADMIN_USER_IDS = [priorAdminIds, id].filter(Boolean).join(",");
    const granted = await asUser();
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
  });
});
