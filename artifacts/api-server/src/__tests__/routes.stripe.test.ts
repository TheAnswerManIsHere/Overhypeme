/**
 * Integration tests for routes/stripe.ts.
 *
 * Focuses on the surface that doesn't actually hit the Stripe API:
 * - 401 on every authed endpoint
 * - Body/query validation 400s
 * - DB-only success paths (config, membership, payment-history,
 *   access-revocation-notice, the catch-fallback in /stripe/plans)
 *
 * The Stripe-call success paths (POST /checkout, /portal, /subscription/*,
 * /switch-preview, /switch-plan, /checkout/confirm) require a real Stripe
 * test fixture; they're left as a separate batch.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import {
  usersTable,
  membershipHistoryTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import stripeRouter from "../routes/stripe.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";


const USER_PREFIX = "t_routes_st_";

process.env.STRIPE_SECRET_KEY_TEST = process.env.STRIPE_SECRET_KEY_TEST ?? "sk_test_dummy";
process.env.STRIPE_PUBLISHABLE_KEY_TEST = process.env.STRIPE_PUBLISHABLE_KEY_TEST ?? "pk_test_dummy";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(stripeRouter);
  return app;
}

async function createTestUser(opts: {
  isAdmin?: boolean;
  membershipTier?: "unregistered" | "registered" | "legendary";
} = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: opts.isAdmin ?? false,
    membershipTier: opts.membershipTier ?? "registered",
  });
  return id;
}

async function bearerForUser(userId: string): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId } as unknown as SessionData["user"],
    access_token: "test-token",
  };
  return createSession(sessionData, userId);
}

async function cleanupUsers() {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(membershipHistoryTable).where(eq(membershipHistoryTable.userId, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanupUsers);
after(cleanupUsers);

const AUTHED_ENDPOINTS: Array<{ method: "get" | "post"; path: string; body?: object }> = [
  { method: "get",  path: "/stripe/subscription" },
  { method: "post", path: "/stripe/checkout", body: { priceId: "price_x" } },
  { method: "get",  path: "/stripe/payment-history" },
  { method: "get",  path: "/stripe/membership" },
  { method: "get",  path: "/stripe/access-revocation-notice" },
  { method: "post", path: "/stripe/checkout/confirm", body: { sessionId: "cs_test_x" } },
  { method: "post", path: "/stripe/portal" },
  { method: "post", path: "/stripe/subscription/cancel" },
  { method: "post", path: "/stripe/subscription/reactivate" },
  { method: "get",  path: "/stripe/subscription/switch-preview?targetPriceId=price_x" },
  { method: "post", path: "/stripe/subscription/switch-plan", body: { targetPriceId: "price_x" } },
];

describe("auth — every authed endpoint returns 401 for unauthenticated callers", () => {
  for (const ep of AUTHED_ENDPOINTS) {
    it(`${ep.method.toUpperCase()} ${ep.path}`, async () => {
      const r = ep.method === "get"
        ? await request(makeApp()).get(ep.path)
        : await request(makeApp()).post(ep.path).send(ep.body ?? {});
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: "Unauthorized" });
    });
  }
});

describe("GET /stripe/config", () => {
  it("returns the configured publishable key", async () => {
    const res = await request(makeApp()).get("/stripe/config");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.publishableKey, "string");
  });
});

describe("GET /stripe/plans", () => {
  it("never throws — falls back to an empty array on error", async () => {
    const res = await request(makeApp()).get("/stripe/plans");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.plans));
  });
});

describe("GET /stripe/membership", () => {

  it("returns the user's tier", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/stripe/membership")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.tier, "legendary");
  });

  it("returns 'registered' (default) for a fresh user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/stripe/membership")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.body.tier, "registered");
  });
});

describe("GET /stripe/payment-history", () => {

  it("returns an empty history array for a new user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/stripe/payment-history")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.history, []);
  });

  it("returns the user's membership_history rows newest-first", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    await db.insert(membershipHistoryTable).values([
      { userId, event: "subscription_started", createdAt: new Date(Date.now() - 10000) },
      { userId, event: "lifetime_purchase",    createdAt: new Date() },
    ]);

    const res = await request(makeApp())
      .get("/stripe/payment-history")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.history.length, 2);
    assert.equal(res.body.history[0].event, "lifetime_purchase");
  });
});

describe("GET /stripe/access-revocation-notice", () => {

  it("returns { notice: null } for a user with no revocation history", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/stripe/access-revocation-notice")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.notice, null);
  });

  it("returns the notice when the most recent event is a revocation within the window", async () => {
    const userId = await createTestUser({ membershipTier: "registered" });
    const sid = await bearerForUser(userId);

    await db.insert(membershipHistoryTable).values({
      userId,
      event: "refund",
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
    });

    const res = await request(makeApp())
      .get("/stripe/access-revocation-notice")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.notice, "notice should be present");
    assert.equal(res.body.notice.kind, "refund");
    assert.equal(typeof res.body.notice.occurredAt, "string");
  });
});

describe("POST /stripe/checkout — body validation", () => {

  it("returns 400 when priceId is missing from the body", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/stripe/checkout")
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "priceId required" });
  });
});

describe("POST /stripe/checkout/confirm — body validation", () => {

  it("returns 400 when sessionId is missing", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/stripe/checkout/confirm")
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, "string");
  });

  it("returns 400 when sessionId doesn't start with cs_", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/stripe/checkout/confirm")
      .set("authorization", `Bearer ${sid}`)
      .send({ sessionId: "not_cs_anything" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /cs_/);
  });
});

describe("GET /stripe/subscription/switch-preview — query validation", () => {

  it("returns 400 when targetPriceId is missing", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/stripe/subscription/switch-preview")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "targetPriceId required" });
  });
});

describe("POST /stripe/subscription/switch-plan — body validation", () => {

  it("returns 400 when targetPriceId is missing", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/stripe/subscription/switch-plan")
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "targetPriceId required" });
  });
});

describe("POST /stripe/portal — pre-Stripe guard", () => {

  it("returns 400 when the user has no Stripe customer ID yet", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/stripe/portal")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "No billing account found" });
  });
});

describe("payment 5xx responses do not leak provider diagnostics", () => {
  beforeEach(cleanupUsers);
  afterEach(cleanupUsers);

  it("POST /stripe/portal returns a generic message on Stripe failures", async () => {
    const userId = await createTestUser();
    await db.update(usersTable).set({ stripeCustomerId: "cus_test_bad" }).where(eq(usersTable.id, userId));
    const sid = await bearerForUser(userId);

    const res = await request(makeApp())
      .post("/stripe/portal")
      .set("authorization", `Bearer ${sid}`)
      .send({});

    assert.equal(res.status, 500);
    assert.equal(res.body.error, "Unable to open billing portal. Please try again.");
    assert.equal(typeof res.body.requestId, "undefined");
    assert.doesNotMatch(JSON.stringify(res.body), /Invalid API Key|Stripe|sk_test_dummy/i);
  });
});
