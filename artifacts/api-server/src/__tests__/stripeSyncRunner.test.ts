/**
 * Tests for the stripeSyncRunner module.
 *
 * Covers:
 *   - The in-process sync lock — a second concurrent call short-circuits.
 *   - readSyncStatus shape — handles empty _sync_status and rows in each state.
 *   - The scoped runner invokes products → prices → plans sequentially.
 *   - The full runner extends that to customers/subscriptions/invoices/etc.
 *   - Both runners share the same lock so a scoped+full overlap returns
 *     alreadyRunning:true.
 *
 * The StripeSync driver is a stub — these tests never touch the real Stripe API.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import {
  runScopedSync,
  runFullSync,
  isSyncRunning,
  readSyncStatus,
  _resetSyncRunnerForTests,
  SYNC_RESOURCES,
  type SyncRunnerDriver,
  type SyncResource,
} from "../lib/stripeSyncRunner";

const TEST_ACCOUNT = "acct_syncrunner_test";

interface RecordedDriver extends SyncRunnerDriver {
  calls: string[];
  resolvers: Record<SyncResource, () => void>;
}

/**
 * Build a stub StripeSync driver whose per-resource sync methods are gated
 * on caller-controlled promises. Tests can resolve them in order to assert
 * the runner's sequencing.
 */
function makeDriver(opts: {
  counts?: Partial<Record<SyncResource, number>>;
  throwOn?: SyncResource;
} = {}): RecordedDriver {
  const calls: string[] = [];
  const resolvers = {} as Record<SyncResource, () => void>;
  const promises = {} as Record<SyncResource, Promise<{ synced: number }>>;

  for (const resource of SYNC_RESOURCES) {
    promises[resource] = new Promise<{ synced: number }>(resolve => {
      resolvers[resource] = () => resolve({ synced: opts.counts?.[resource] ?? 0 });
    });
  }

  function makeMethod(resource: SyncResource): () => Promise<{ synced: number }> {
    return async () => {
      calls.push(resource);
      if (opts.throwOn === resource) throw new Error(`boom-${resource}`);
      return promises[resource];
    };
  }

  return {
    calls,
    resolvers,
    async getAccountId() { return TEST_ACCOUNT; },
    syncProducts: makeMethod("products"),
    syncPrices: makeMethod("prices"),
    syncPlans: makeMethod("plans"),
    syncCustomers: makeMethod("customers"),
    syncSubscriptions: makeMethod("subscriptions"),
    syncInvoices: makeMethod("invoices"),
    syncCharges: makeMethod("charges"),
    syncPaymentMethods: makeMethod("payment_methods"),
  };
}

function resolveAll(driver: RecordedDriver): void {
  for (const resource of SYNC_RESOURCES) driver.resolvers[resource]();
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function clearStatusRows() {
  try {
    await db.execute(
      sql`DELETE FROM stripe._sync_status WHERE account_id = ${TEST_ACCOUNT}`,
    );
  } catch {
    // schema may not exist in some test envs; readSyncStatus tolerates that
  }
}

describe("stripeSyncRunner — in-process lock", () => {
  beforeEach(() => _resetSyncRunnerForTests());
  afterEach(() => _resetSyncRunnerForTests());

  it("acquires the lock on the first scoped call and reports inProgress", async () => {
    const driver = makeDriver();
    const result = runScopedSync(driver);
    assert.equal(result.alreadyRunning, false);
    assert.equal(isSyncRunning(), true);
    resolveAll(driver);
    await waitFor(() => !isSyncRunning());
  });

  it("a second scoped call returns alreadyRunning:true without re-invoking", async () => {
    const driver = makeDriver();
    const first = runScopedSync(driver);
    assert.equal(first.alreadyRunning, false);

    const second = runScopedSync(driver);
    assert.equal(second.alreadyRunning, true, "second call must short-circuit while the first is in flight");

    resolveAll(driver);
    await waitFor(() => !isSyncRunning());
    assert.deepEqual(driver.calls, ["products", "prices", "plans"], "only one scoped run should have happened");
  });

  it("a full call concurrent with an in-flight scoped call returns alreadyRunning:true", async () => {
    const driver = makeDriver();
    runScopedSync(driver);
    const fullResult = runFullSync(driver);
    assert.equal(fullResult.alreadyRunning, true, "the full path must share the same lock as the scoped path");

    resolveAll(driver);
    await waitFor(() => !isSyncRunning());
    // Only scoped resources should have been invoked.
    assert.deepEqual(driver.calls, ["products", "prices", "plans"]);
  });

  it("releases the lock even when a sync function throws", async () => {
    const driver = makeDriver({ throwOn: "prices" });
    runScopedSync(driver);
    driver.resolvers.products();
    await waitFor(() => !isSyncRunning());
    assert.equal(isSyncRunning(), false, "lock must release on error so the next run can start");
  });

  it("scoped run invokes products → prices → plans sequentially in that order", async () => {
    const driver = makeDriver();
    runScopedSync(driver);
    await waitFor(() => driver.calls.length >= 1);
    assert.deepEqual(driver.calls, ["products"]);

    driver.resolvers.products();
    await waitFor(() => driver.calls.length >= 2);
    assert.deepEqual(driver.calls, ["products", "prices"]);

    driver.resolvers.prices();
    await waitFor(() => driver.calls.length >= 3);
    assert.deepEqual(driver.calls, ["products", "prices", "plans"]);

    driver.resolvers.plans();
    await waitFor(() => !isSyncRunning());
    // Scoped run must NOT touch customers/subs/invoices/charges/payment_methods.
    assert.equal(driver.calls.includes("customers"), false);
    assert.equal(driver.calls.includes("subscriptions"), false);
  });

  it("full run invokes every tracked resource sequentially in SYNC_RESOURCES order", async () => {
    const driver = makeDriver();
    runFullSync(driver);

    // Walk through the ordered resource list, resolving one at a time and
    // asserting the next resource only fires after the previous resolves.
    for (let i = 0; i < SYNC_RESOURCES.length; i++) {
      await waitFor(() => driver.calls.length >= i + 1);
      assert.deepEqual(
        driver.calls.slice(0, i + 1),
        SYNC_RESOURCES.slice(0, i + 1),
        `resource ${SYNC_RESOURCES[i]} should have been invoked after the previous resolved`,
      );
      driver.resolvers[SYNC_RESOURCES[i]!]();
    }

    await waitFor(() => !isSyncRunning());
    assert.deepEqual(driver.calls, [...SYNC_RESOURCES]);
  });
});

describe("stripeSyncRunner — readSyncStatus", () => {
  beforeEach(async () => {
    _resetSyncRunnerForTests();
    await clearStatusRows();
  });
  afterEach(async () => {
    _resetSyncRunnerForTests();
    await clearStatusRows();
  });

  it("returns idle rows for every tracked resource when _sync_status is empty", async () => {
    const status = await readSyncStatus(TEST_ACCOUNT);
    assert.equal(status.inProgress, false);
    assert.equal(status.resources.length, SYNC_RESOURCES.length);
    const names = status.resources.map(r => r.resource).sort();
    assert.deepEqual(names, [...SYNC_RESOURCES].sort());
    for (const r of status.resources) {
      assert.equal(r.status, "idle");
      assert.equal(r.lastSyncedAt, null);
      assert.equal(r.errorMessage, null);
      assert.equal(r.syncedCount, null);
    }
  });

  it("reflects in-process lock as inProgress=true", async () => {
    const driver = makeDriver();
    runScopedSync(driver);
    const status = await readSyncStatus(TEST_ACCOUNT);
    assert.equal(status.inProgress, true, "the in-process lock alone should drive inProgress to true");
    resolveAll(driver);
    await waitFor(() => !isSyncRunning());
  });

  it("surfaces stored row state (running / complete / error) and synced counts for every resource", async () => {
    // Ensure account row exists (FK constraint from _sync_status.account_id).
    try {
      await db.execute(
        sql`INSERT INTO stripe.accounts (id, raw_data) VALUES (${TEST_ACCOUNT}, ${'{"id":"' + TEST_ACCOUNT + '"}'}::jsonb)
            ON CONFLICT (id) DO NOTHING`,
      );
    } catch {
      // schema not present — skip the row-shape assertion
      return;
    }

    // Mix of states across the new + old resources to prove we surface all of them.
    await db.execute(sql`
      INSERT INTO stripe._sync_status (resource, status, last_synced_at, error_message, account_id)
      VALUES
        ('products',        'complete', now(), NULL,                ${TEST_ACCOUNT}),
        ('prices',          'running',  now(), NULL,                ${TEST_ACCOUNT}),
        ('plans',           'error',    now(), 'Stripe API 500',    ${TEST_ACCOUNT}),
        ('customers',       'complete', now(), NULL,                ${TEST_ACCOUNT}),
        ('subscriptions',   'complete', now(), NULL,                ${TEST_ACCOUNT}),
        ('invoices',        'error',    now(), 'rate limited',      ${TEST_ACCOUNT}),
        ('charges',         'running',  now(), NULL,                ${TEST_ACCOUNT}),
        ('payment_methods', 'complete', now(), NULL,                ${TEST_ACCOUNT})
      ON CONFLICT (resource, account_id) DO UPDATE SET
        status         = EXCLUDED.status,
        last_synced_at = EXCLUDED.last_synced_at,
        error_message  = EXCLUDED.error_message
    `);

    // Run a full sync to exercise the counts cache for every resource.
    const driver = makeDriver({
      counts: {
        products: 7, prices: 11, plans: 1,
        customers: 42, subscriptions: 3, invoices: 99,
        charges: 50, payment_methods: 8,
      },
    });
    runFullSync(driver);
    resolveAll(driver);
    await waitFor(() => !isSyncRunning());

    const status = await readSyncStatus(TEST_ACCOUNT);

    // Every tracked resource must surface, with the stored row's status.
    const get = (r: SyncResource) => status.resources.find(x => x.resource === r)!;
    assert.equal(get("plans").status, "error");
    assert.equal(get("plans").errorMessage, "Stripe API 500");
    assert.equal(get("invoices").status, "error");
    assert.equal(get("invoices").errorMessage, "rate limited");
    assert.equal(get("customers").status, "complete");
    assert.equal(get("subscriptions").status, "complete");
    assert.equal(get("payment_methods").status, "complete");

    // Synced count cache should be populated from the run we just executed.
    assert.equal(get("products").syncedCount, 7);
    assert.equal(get("customers").syncedCount, 42);
    assert.equal(get("invoices").syncedCount, 99);
    assert.equal(get("payment_methods").syncedCount, 8);
  });
});
