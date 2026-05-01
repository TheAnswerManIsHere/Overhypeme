/**
 * Integration tests for the admin Stripe sync endpoints:
 *   POST /admin/stripe/sync         — kicks off a scoped sync, 409 if one is in flight
 *   GET  /admin/stripe/sync/status  — admin-only, returns 401/403 for non-admins
 *
 * These tests cover the auth gates and the in-process lock behavior at the
 * route level. The unit-level shape tests for readSyncStatus and the runner
 * lock semantics live in stripeSyncRunner.test.ts.
 *
 * No real Stripe API calls are made: the lock-conflict test acquires the lock
 * directly via runScopedSync with a stub driver before hitting the route, so
 * the route hits the alreadyRunning short-circuit before any Stripe call.
 */

import { describe, it, before, after, beforeEach } from "node:test";
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
import {
  runScopedSync,
  isSyncRunning,
  _resetSyncRunnerForTests,
  type SyncRunnerDriver,
} from "../lib/stripeSyncRunner.js";


const USER_PREFIX = "tadminstrsync-";

// Minimal env so dynamic imports of stripeClient don't throw on module load.
process.env.STRIPE_SECRET_KEY_TEST = process.env.STRIPE_SECRET_KEY_TEST ?? "sk_test_dummy";
process.env.STRIPE_PUBLISHABLE_KEY_TEST = process.env.STRIPE_PUBLISHABLE_KEY_TEST ?? "pk_test_dummy";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(adminRouter);
  return app;
}

async function createTestUser(opts: { isAdmin?: boolean } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
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

async function cleanup() {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

let adminSid: string;
let userSid: string;

before(async () => {
  await cleanup();
  const adminId = await createTestUser({ isAdmin: true });
  const userId = await createTestUser({ isAdmin: false });
  adminSid = await sessionFor(adminId, true);
  userSid = await sessionFor(userId, false);
});

after(async () => {
  _resetSyncRunnerForTests();
  await cleanup();
});

beforeEach(() => {
  _resetSyncRunnerForTests();
});

describe("POST /admin/stripe/sync — auth", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).post("/admin/stripe/sync");
    assert.equal(res.status, 401);
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .post("/admin/stripe/sync")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});

describe("POST /admin/stripe/sync — concurrency", () => {
  it("returns 409 with alreadyRunning:true when a sync is already in flight", async () => {
    // Pre-acquire the lock with a stub driver whose promises never resolve
    // until we let them. The route's runScopedSync call will see the lock
    // held and short-circuit without touching Stripe.
    const driver: SyncRunnerDriver = {
      async getAccountId() { return "acct_lockheld_test"; },
      syncProducts() {
        return new Promise(() => { /* never resolves during this test */ });
      },
      async syncPrices() { return { synced: 0 }; },
      async syncPlans() { return { synced: 0 }; },
      // The expanded driver shape includes the customer-graph resources so
      // both runScopedSync and runFullSync compile against the stub. They
      // are unreachable here because syncProducts never resolves, holding
      // the lock for the duration of the test.
      async syncCustomers() { return { synced: 0 }; },
      async syncSubscriptions() { return { synced: 0 }; },
      async syncInvoices() { return { synced: 0 }; },
      async syncCharges() { return { synced: 0 }; },
      async syncPaymentMethods() { return { synced: 0 }; },
    };
    runScopedSync(driver);
    assert.equal(isSyncRunning(), true, "test setup: lock should be held");

    const res = await request(makeApp())
      .post("/admin/stripe/sync")
      .set("authorization", `Bearer ${adminSid}`);

    assert.equal(res.status, 409);
    assert.equal(res.body.success, false);
    assert.equal(res.body.alreadyRunning, true);
    assert.match(res.body.message as string, /already in progress/i);

    // Reset clears the lock so other tests start clean.
    _resetSyncRunnerForTests();
  });
});

describe("GET /admin/stripe/sync/status — auth", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(makeApp()).get("/admin/stripe/sync/status");
    assert.equal(res.status, 401);
  });

  it("returns 403 admin_required for a non-admin user", async () => {
    const res = await request(makeApp())
      .get("/admin/stripe/sync/status")
      .set("authorization", `Bearer ${userSid}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});
