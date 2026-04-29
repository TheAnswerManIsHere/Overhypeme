/**
 * Integration tests for admin API routes (routes/admin.ts).
 *
 * Mounts authMiddleware + adminRouter on an ephemeral Express app and drives
 * requests via supertest against the real test DB.
 *
 * For each key route the test matrix is:
 *   1. No credentials → 401 Unauthorized
 *   2. Authenticated as a non-admin user → 403 admin_required
 *   3. Authenticated as an admin → 200 with expected response shape
 *
 * Routes exercised:
 *   GET /admin/stats
 *   GET /admin/users
 *   GET /admin/facts
 *   GET /admin/comments/pending   (moderation)
 *   GET /admin/comments/flagged   (moderation)
 *
 * Prefix uses `-` (not `_`) so SQL LIKE wildcards in cleanup cannot
 * accidentally match other test files' rows during parallel runs. See
 * authMiddleware.test.ts for the full convention.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import adminRouter from "../routes/admin.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "troutesadmin-";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(adminRouter);
  return app;
}

async function createTestUser(opts: {
  isAdmin?: boolean;
  tier?: "unregistered" | "registered" | "legendary";
} = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: opts.tier ?? "registered",
    isAdmin: opts.isAdmin ?? false,
  });
  return id;
}

async function sessionFor(userId: string, isAdmin: boolean): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin,
  };
  return createSession(sessionData, userId);
}

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

// ── Shared test state ─────────────────────────────────────────────────────────

let adminSid: string;
let userSid: string;

before(async () => {
  await cleanup();
  const adminId = await createTestUser({ isAdmin: true });
  const userId = await createTestUser({ isAdmin: false, tier: "legendary" });
  adminSid = await sessionFor(adminId, true);
  userSid = await sessionFor(userId, false);
});

after(cleanup);

// ── GET /admin/stats ──────────────────────────────────────────────────────────

describe("GET /admin/stats", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/stats");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/stats")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with totalFacts and totalUsers for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/stats")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok("totalFacts" in res.body, "response should have totalFacts");
    assert.ok("totalUsers" in res.body, "response should have totalUsers");
    assert.equal(typeof res.body.totalFacts, "number");
    assert.equal(typeof res.body.totalUsers, "number");
  });
});

// ── GET /admin/users ──────────────────────────────────────────────────────────

describe("GET /admin/users", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/users");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/users")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with users array, total, page, and limit for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/users")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.users), "users should be an array");
    assert.equal(typeof res.body.total, "number");
    assert.equal(typeof res.body.page, "number");
    assert.equal(typeof res.body.limit, "number");
  });

  it("filters results via ?search and still returns the standard shape", async () => {
    const res = await request(makeApp())
      .get("/admin/users")
      .query({ search: USER_PREFIX })
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.users));
    assert.ok(
      (res.body.users as Array<{ email: string }>).every((u) =>
        u.email.includes(USER_PREFIX),
      ),
      "every returned user email should match the search prefix",
    );
  });

  it("respects ?limit and ?page pagination params", async () => {
    const res = await request(makeApp())
      .get("/admin/users")
      .query({ limit: "1", page: "1" })
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.users.length <= 1, "should return at most 1 user");
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 1);
  });
});

// ── GET /admin/facts ──────────────────────────────────────────────────────────

describe("GET /admin/facts", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/facts");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/facts")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with facts array, total, page, and limit for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/facts")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.facts), "facts should be an array");
    assert.equal(typeof res.body.total, "number");
    assert.equal(typeof res.body.page, "number");
    assert.equal(typeof res.body.limit, "number");
  });

  it("each fact row exposes the expected fields", async () => {
    const res = await request(makeApp())
      .get("/admin/facts")
      .query({ limit: "1" })
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    if ((res.body.facts as unknown[]).length === 0) return;
    const fact = res.body.facts[0] as Record<string, unknown>;
    for (const key of ["id", "text", "isActive", "upvotes", "downvotes", "createdAt"]) {
      assert.ok(key in fact, `fact should have field "${key}"`);
    }
  });
});

// ── GET /admin/comments/pending (moderation) ──────────────────────────────────

describe("GET /admin/comments/pending", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/comments/pending");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/comments/pending")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with comments array and total for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/comments/pending")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.comments), "comments should be an array");
    assert.equal(typeof res.body.total, "number");
  });
});

// ── GET /admin/comments/flagged (moderation) ──────────────────────────────────

describe("GET /admin/comments/flagged", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/comments/flagged");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/comments/flagged")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("returns 200 with comments array for an admin", async () => {
    const res = await request(makeApp())
      .get("/admin/comments/flagged")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.comments), "comments should be an array");
  });
});

// ── PATCH /admin/users/:id ────────────────────────────────────────────────────

describe("PATCH /admin/users/:id", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp())
      .patch("/admin/users/some-id")
      .send({ isActive: true });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .patch("/admin/users/some-id")
      .set("authorization", `Bearer ${userSid}`)
      .send({ isActive: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});

// ── DELETE /admin/users/:id ───────────────────────────────────────────────────

describe("DELETE /admin/users/:id", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).delete("/admin/users/some-id");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .delete("/admin/users/some-id")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});

// ── POST /admin/users/:id/grant-lifetime ──────────────────────────────────────

describe("POST /admin/users/:id/grant-lifetime", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp())
      .post("/admin/users/some-id/grant-lifetime")
      .send({});
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .post("/admin/users/some-id/grant-lifetime")
      .set("authorization", `Bearer ${userSid}`)
      .send({});
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});

// ── PATCH /admin/facts/:id ────────────────────────────────────────────────────

describe("PATCH /admin/facts/:id", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp())
      .patch("/admin/facts/some-id")
      .send({ isActive: true });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .patch("/admin/facts/some-id")
      .set("authorization", `Bearer ${userSid}`)
      .send({ isActive: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});

// ── DELETE /admin/facts/:id ───────────────────────────────────────────────────

describe("DELETE /admin/facts/:id", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).delete("/admin/facts/some-id");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .delete("/admin/facts/some-id")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});

// ── PATCH /admin/config/:key ──────────────────────────────────────────────────

describe("PATCH /admin/config/:key", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp())
      .patch("/admin/config/some-key")
      .send({ value: "test" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .patch("/admin/config/some-key")
      .set("authorization", `Bearer ${userSid}`)
      .send({ value: "test" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});
