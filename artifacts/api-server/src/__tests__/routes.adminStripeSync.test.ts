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
import { like, sql } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import adminRouter from "../routes/admin.js";
import { createSession, type SessionData } from "../lib/auth.js";
import {
  runScopedSync,
  isSyncRunning,
  _resetSyncRunnerForTests,
  type SyncRunnerDriver,
} from "../lib/stripeSyncRunner.js";
import { __resetVerificationStateForTests } from "../lib/stripeAccountGuard.js";
import { clearStripeEnv, describeStripeEnvRestored, snapshotStripeEnv, stubAccountRetriever } from "./helpers/stripeGuardHarness.js";
import { invalidateStripeSync, __endCachedSyncForTests } from "../lib/stripeClient.js";
import { __setStripeDriverForTests } from "../lib/stripeDriver.js";
import { realStripeDriver } from "../lib/stripeRealDriver.js";


const USER_PREFIX = "tadminstrsync-";

let restoreRetriever: (() => void) | null = null;

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

// Everything in this file is scoped inside ONE describe, deliberately.
// `node --test` runs with `--test-isolation=none`, so a hook declared at a
// file's top level attaches to the ROOT suite and runs around every test in the
// process. The STRIPE_* values this file needs are set in that suite's `before`
// and restored in its `after`, for the same reason: set at file load, they were
// seen by every other suite and never put back.
let stripeEnvAtSuiteStart: Record<string, string | undefined> = {};

describe("admin Stripe sync routes", () => {
let restoreStripeEnv: (() => void) | null = null;

before(() => {
  stripeEnvAtSuiteStart = snapshotStripeEnv();
  restoreStripeEnv = clearStripeEnv();
  process.env.STRIPE_SECRET_KEY_TEST = "sk_test_dummy";
  process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_dummy";
  // The account guard sits in front of every client construction, so the route
  // under test cannot reach its lock check unless this environment declares an
  // expected account and the account read is stubbed to match it.
  process.env.STRIPE_ACCOUNT_ID_TEST = "acct_admin_sync_test";
});
after(() => {
  restoreStripeEnv?.();
  restoreStripeEnv = null;
});

before(async () => {
  restoreRetriever = stubAccountRetriever(() => process.env.STRIPE_ACCOUNT_ID_TEST!);
  await cleanup();
  const adminId = await createTestUser({ isAdmin: true });
  const userId = await createTestUser({ isAdmin: false });
  adminSid = await sessionFor(adminId, true);
  userSid = await sessionFor(userId, false);
});

after(async () => {
  restoreRetriever?.();
  restoreRetriever = null;
  __resetVerificationStateForTests();
  _resetSyncRunnerForTests();
  await cleanup();
});

beforeEach(() => {
  _resetSyncRunnerForTests();
  __resetVerificationStateForTests();
  invalidateStripeSync();
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

describe("GET /admin/stripe/sync/status — persisted state", () => {
  const SEEDED_SYNC_AT = "2026-01-02T03:04:05.000Z";
  let createdStatusTable = false;
  let createdStripeSchema = false;

  // The `stripe` schema is owned by the sync library's own migrations, so a
  // bare test database may not have it. Create just the status table when it is
  // absent (and remove only what this suite created) so the assertion below is
  // never skipped for want of a table.
  before(async () => {
    const [{ schema_exists }] = (await db.execute(
      sql`SELECT to_regnamespace('stripe') IS NOT NULL AS schema_exists`,
    )).rows as Array<{ schema_exists: boolean }>;
    const [{ table_exists }] = (await db.execute(
      sql`SELECT to_regclass('stripe._sync_status') IS NOT NULL AS table_exists`,
    )).rows as Array<{ table_exists: boolean }>;
    if (!table_exists) {
      if (!schema_exists) {
        await db.execute(sql`CREATE SCHEMA stripe`);
        createdStripeSchema = true;
      }
      await db.execute(sql`
        CREATE TABLE stripe._sync_status (
          resource text NOT NULL, status text, last_synced_at timestamptz,
          error_message text, account_id text NOT NULL, PRIMARY KEY (resource, account_id)
        )`);
      createdStatusTable = true;
    }
  });

  after(async () => {
    if (createdStatusTable) await db.execute(sql`DROP TABLE stripe._sync_status`);
    else await db.execute(sql`DELETE FROM stripe._sync_status WHERE account_id = ${process.env.STRIPE_ACCOUNT_ID_TEST ?? ""}`);
    if (createdStripeSchema) await db.execute(sql`DROP SCHEMA stripe`);
  });

  it("still returns the seeded products row's lastSyncedAt after the in-process runner state is reset", async () => {
    const accountId = process.env.STRIPE_ACCOUNT_ID_TEST!;
    try {
      // A real _sync_status table keys account_id to stripe.accounts.
      await db.execute(sql.raw(
        `INSERT INTO stripe.accounts (_raw_data) VALUES ('${JSON.stringify({ id: accountId })}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      ));
    } catch { /* minimal table created above has no accounts FK */ }
    await db.execute(sql`
      INSERT INTO stripe._sync_status (resource, status, last_synced_at, error_message, account_id)
      VALUES ('products', 'complete', ${SEEDED_SYNC_AT}::timestamptz, NULL, ${accountId})
      ON CONFLICT (resource, account_id) DO UPDATE SET status = EXCLUDED.status, last_synced_at = EXCLUDED.last_synced_at
    `);

    // Simulate a server restart: the in-memory run snapshot is gone.
    _resetSyncRunnerForTests();

    // The route resolves the account through the sync library, which would ask
    // Stripe for it. Keep the real driver but answer that one call locally.
    const restoreDriver = __setStripeDriverForTests({
      ...realStripeDriver,
      async buildSync(params) {
        const sync = await realStripeDriver.buildSync(params);
        (sync as { getAccountId: () => Promise<string> }).getAccountId = async () => accountId;
        return sync;
      },
    });
    let res;
    try {
      res = await request(makeApp())
        .get("/admin/stripe/sync/status")
        .set("authorization", `Bearer ${adminSid}`);
    } finally {
      restoreDriver();
      await __endCachedSyncForTests();
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.finishedAt, null, "no in-process run has finished since the reset");
    const products = (res.body.resources as Array<{ resource: string; lastSyncedAt: string | null }>)
      .find((r) => r.resource === "products");
    assert.ok(products, "products resource present in the status");
    assert.notEqual(products.lastSyncedAt, null, "the persisted last-synced stamp must survive the reset");
    assert.equal(new Date(products.lastSyncedAt!).toISOString(), SEEDED_SYNC_AT);
  });
});
});

describeStripeEnvRestored("the admin Stripe sync suite", () => stripeEnvAtSuiteStart);
