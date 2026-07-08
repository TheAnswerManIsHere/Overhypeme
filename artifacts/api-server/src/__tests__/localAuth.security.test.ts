/**
 * Security regression tests for the local-auth surface (PR-1 auth hardening).
 *
 *   C4 — brute-force / credential-stuffing throttles on login (per-IP and
 *        per-email) and signup spam throttle on register.
 *   C8 — password reset invalidates ALL of a user's sessions, including legacy
 *        rows whose id lives only in the jsonb blob (no `userId` column), via a
 *        single DB-side delete rather than a full-table scan.
 *   C7 — admin set-password enforces an 8-char minimum (was 6).
 *
 * (The dev-admin-login backdoor, C1, is intentionally deferred to pre-launch
 * per product decision — see the SECURITY TODO at that route.)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";
import bcrypt from "bcryptjs";

import { db } from "@workspace/db";
import {
  usersTable,
  sessionsTable,
  passwordResetTokensTable,
  rateLimitCountersTable,
} from "@workspace/db/schema";
import { like, sql, inArray } from "drizzle-orm";

import localAuthRouter from "../routes/localAuth.js";
import adminRouter from "../routes/admin.js";
import { createSession, SESSION_TTL, type SessionData } from "../lib/auth.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const PREFIX = "tsec_la_";

// Plain app with NO auto-IP injection — these tests control CF-Connecting-IP
// explicitly to exercise the per-IP vs per-email limiter behaviour.
function plainApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(localAuthRouter);
  return app;
}

async function cleanup() {
  await db.delete(rateLimitCountersTable).where(sql`${rateLimitCountersTable.keyRaw} LIKE 'rl|auth.local-login|%'`);
  await db.delete(rateLimitCountersTable).where(sql`${rateLimitCountersTable.keyRaw} LIKE 'rl|auth.register|%'`);
  await db.delete(passwordResetTokensTable).where(like(passwordResetTokensTable.userId, `${PREFIX}%`));
  await db.delete(sessionsTable).where(like(sessionsTable.sid, `tsec-%`));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("C4: login/register throttling", () => {
  it("throttles local-login per IP after the limit", async () => {
    const app = plainApp();
    const ip = "203.0.113.7";
    let throttled = false;
    // Vary the email each attempt so the per-email limiter never fires first —
    // isolate the per-IP limiter.
    for (let i = 0; i < 13; i++) {
      const res = await request(app)
        .post("/auth/local-login")
        .set("CF-Connecting-IP", ip)
        .send({ email: `${PREFIX}ip${i}@nope.test`, password: "long-enough-pw" });
      if (res.status === 429) { throttled = true; break; }
    }
    assert.ok(throttled, "expected a 429 after exceeding the per-IP login limit");
  });

  it("throttles local-login per email across many IPs", async () => {
    const app = plainApp();
    const email = `${PREFIX}target@nope.test`;
    let throttled = false;
    for (let i = 0; i < 34; i++) {
      const res = await request(app)
        .post("/auth/local-login")
        .set("CF-Connecting-IP", `198.51.100.${i}`) // distinct IP each time
        .send({ email, password: "long-enough-pw" });
      if (res.status === 429) { throttled = true; break; }
    }
    assert.ok(throttled, "expected a 429 after exceeding the per-email login limit");
  });

  it("throttles register per IP after the limit", async () => {
    const app = plainApp();
    const ip = "203.0.113.9";
    let throttled = false;
    for (let i = 0; i < 13; i++) {
      const res = await request(app)
        .post("/auth/register")
        .set("CF-Connecting-IP", ip)
        .send({ email: `${PREFIX}reg${i}@nope.test`, password: "long-enough-pw", displayName: "Pat", firstName: "Pat", lastName: "Doe" });
      if (res.status === 429) { throttled = true; break; }
    }
    assert.ok(throttled, "expected a 429 after exceeding the per-IP register limit");
  });
});

describe("C8: password reset invalidates every session", () => {
  it("deletes both userId-column sessions and legacy jsonb-only sessions", async () => {
    const app = plainApp();
    const id = `${PREFIX}${randomUUID()}`;
    const email = `${id}@nope.test`;
    await db.insert(usersTable).values({
      id,
      email,
      passwordHash: await bcrypt.hash("old-password-x", 4),
      isActive: true,
    });

    // Modern session — userId column populated.
    const modernSid = await createSession({ user: { id } as SessionData["user"], access_token: "" }, id);
    // Legacy session — userId column NULL, id only in the jsonb blob.
    const legacySid = `tsec-legacy-${randomUUID().replace(/-/g, "")}`;
    await db.insert(sessionsTable).values({
      sid: legacySid,
      sess: { user: { id }, access_token: "" } as unknown as Record<string, unknown>,
      expire: new Date(Date.now() + SESSION_TTL),
      userId: null,
    });

    const rawToken = randomUUID().replace(/-/g, "");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(passwordResetTokensTable).values({
      userId: id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(app)
      .post("/auth/reset-password")
      .send({ token: rawToken, newPassword: "brand-new-password-1" });
    assert.equal(res.status, 200);

    const remaining = await db
      .select({ sid: sessionsTable.sid })
      .from(sessionsTable)
      .where(inArray(sessionsTable.sid, [modernSid, legacySid]));
    assert.equal(remaining.length, 0, "both modern and legacy sessions must be invalidated");
  });
});

describe("C7: admin set-password minimum length", () => {
  const TEST_KEY = "tsec-admin-key-la-do-not-reuse";
  let prevKey: string | undefined;
  before(() => { prevKey = process.env.ADMIN_API_KEY; process.env.ADMIN_API_KEY = TEST_KEY; });
  after(() => { if (prevKey === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = prevKey; });

  it("rejects a 7-char password and accepts 8", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, adminRouter);
    const id = `${PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({ id, email: `${id}@nope.test`, isActive: true });

    const short = await request(app)
      .post("/api/admin/users/set-password")
      .set("x-api-key", TEST_KEY)
      .send({ email: `${id}@nope.test`, password: "7chars!" });
    assert.equal(short.status, 400);
    assert.match(String(short.body.error ?? ""), /at least 8/);

    const ok = await request(app)
      .post("/api/admin/users/set-password")
      .set("x-api-key", TEST_KEY)
      .send({ email: `${id}@nope.test`, password: "8char-ok" });
    assert.equal(ok.status, 200);
  });
});
