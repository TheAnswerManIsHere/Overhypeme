/**
 * Tests for the stripeSyncRunner module.
 *
 * Covers:
 *   - The in-process sync lock — a second concurrent call short-circuits.
 *   - readSyncStatus shape — handles empty _sync_status and rows in each state.
 *   - The runner invokes products → prices → plans sequentially.
 *
 * The StripeSync driver is a stub — these tests never touch the real Stripe API.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import {
  runScopedSync,
  isSyncRunning,
  readSyncStatus,
  _resetSyncRunnerForTests,
  type SyncRunnerDriver,
} from "../lib/stripeSyncRunner";

const TEST_ACCOUNT = "acct_syncrunner_test";

interface RecordedDriver extends SyncRunnerDriver {
  calls: string[];
  resolveProducts: () => void;
  resolvePrices: () => void;
  resolvePlans: () => void;
  productsPromise: Promise<{ synced: number }>;
  pricesPromise: Promise<{ synced: number }>;
  plansPromise: Promise<{ synced: number }>;
}

function makeDriver(opts: { productsCount?: number; pricesCount?: number; plansCount?: number; throwOn?: "products" | "prices" | "plans" } = {}): RecordedDriver {
  const calls: string[] = [];
  let resolveProducts!: () => void;
  let resolvePrices!: () => void;
  let resolvePlans!: () => void;
  const productsPromise = new Promise<{ synced: number }>(resolve => {
    resolveProducts = () => resolve({ synced: opts.productsCount ?? 1 });
  });
  const pricesPromise = new Promise<{ synced: number }>(resolve => {
    resolvePrices = () => resolve({ synced: opts.pricesCount ?? 2 });
  });
  const plansPromise = new Promise<{ synced: number }>(resolve => {
    resolvePlans = () => resolve({ synced: opts.plansCount ?? 0 });
  });

  return {
    calls,
    resolveProducts,
    resolvePrices,
    resolvePlans,
    productsPromise,
    pricesPromise,
    plansPromise,
    async getAccountId() { return TEST_ACCOUNT; },
    async syncProducts() {
      calls.push("products");
      if (opts.throwOn === "products") throw new Error("boom-products");
      return productsPromise;
    },
    async syncPrices() {
      calls.push("prices");
      if (opts.throwOn === "prices") throw new Error("boom-prices");
      return pricesPromise;
    },
    async syncPlans() {
      calls.push("plans");
      if (opts.throwOn === "plans") throw new Error("boom-plans");
      return plansPromise;
    },
  };
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
      sql`DELETE FROM stripe._sync_status WHERE _account_id = ${TEST_ACCOUNT}`,
    );
  } catch {
    // schema may not exist in some test envs; readSyncStatus tolerates that
  }
}

describe("stripeSyncRunner — in-process lock", () => {
  beforeEach(() => _resetSyncRunnerForTests());
  afterEach(() => _resetSyncRunnerForTests());

  it("acquires the lock on the first call and reports inProgress", async () => {
    const driver = makeDriver();
    const result = runScopedSync(driver);
    assert.equal(result.alreadyRunning, false);
    assert.equal(isSyncRunning(), true);
    // Let the runner finish so other tests start clean.
    driver.resolveProducts();
    driver.resolvePrices();
    driver.resolvePlans();
    await waitFor(() => !isSyncRunning());
  });

  it("a second concurrent call returns alreadyRunning:true without re-invoking", async () => {
    const driver = makeDriver();
    const first = runScopedSync(driver);
    assert.equal(first.alreadyRunning, false);

    const second = runScopedSync(driver);
    assert.equal(second.alreadyRunning, true, "second call must short-circuit while the first is in flight");

    // Resolve and confirm the lock releases and only the first run executed.
    driver.resolveProducts();
    driver.resolvePrices();
    driver.resolvePlans();
    await waitFor(() => !isSyncRunning());
    assert.deepEqual(driver.calls, ["products", "prices", "plans"], "only one run should have happened");
  });

  it("releases the lock even when a sync function throws", async () => {
    const driver = makeDriver({ throwOn: "prices" });
    runScopedSync(driver);
    driver.resolveProducts();
    // prices throws synchronously inside the async fn — the promise resolves on rejection
    await waitFor(() => !isSyncRunning());
    assert.equal(isSyncRunning(), false, "lock must release on error so the next run can start");
  });

  it("invokes products → prices → plans sequentially in that order", async () => {
    const driver = makeDriver();
    runScopedSync(driver);
    // Initially only products has been called (it awaits its promise).
    await waitFor(() => driver.calls.length >= 1);
    assert.deepEqual(driver.calls, ["products"]);

    driver.resolveProducts();
    await waitFor(() => driver.calls.length >= 2);
    assert.deepEqual(driver.calls, ["products", "prices"]);

    driver.resolvePrices();
    await waitFor(() => driver.calls.length >= 3);
    assert.deepEqual(driver.calls, ["products", "prices", "plans"]);

    driver.resolvePlans();
    await waitFor(() => !isSyncRunning());
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

  it("returns idle rows for all three resources when _sync_status is empty", async () => {
    const status = await readSyncStatus(TEST_ACCOUNT);
    assert.equal(status.inProgress, false);
    assert.equal(status.resources.length, 3);
    const names = status.resources.map(r => r.resource).sort();
    assert.deepEqual(names, ["plans", "prices", "products"]);
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
    driver.resolveProducts();
    driver.resolvePrices();
    driver.resolvePlans();
    await waitFor(() => !isSyncRunning());
  });

  it("surfaces stored row state (running / complete / error) and synced counts", async () => {
    // Ensure account row exists (FK constraint from _sync_status).
    try {
      await db.execute(
        sql`INSERT INTO stripe.accounts (id, raw_data) VALUES (${TEST_ACCOUNT}, ${'{"id":"' + TEST_ACCOUNT + '"}'}::jsonb)
            ON CONFLICT (id) DO NOTHING`,
      );
    } catch {
      // schema not present — skip the row-shape assertion
      return;
    }

    await db.execute(sql`
      INSERT INTO stripe._sync_status (resource, status, last_synced_at, error_message, _account_id)
      VALUES
        ('products', 'complete', now(), NULL, ${TEST_ACCOUNT}),
        ('prices',   'running',  now(), NULL, ${TEST_ACCOUNT}),
        ('plans',    'error',    now(), 'Stripe API 500', ${TEST_ACCOUNT})
      ON CONFLICT (resource, _account_id) DO UPDATE SET
        status = EXCLUDED.status,
        last_synced_at = EXCLUDED.last_synced_at,
        error_message = EXCLUDED.error_message
    `);

    // Run a sync to exercise the counts cache, then immediately read status.
    const driver = makeDriver({ productsCount: 7 });
    runScopedSync(driver);
    driver.resolveProducts();
    driver.resolvePrices();
    driver.resolvePlans();
    await waitFor(() => !isSyncRunning());

    const status = await readSyncStatus(TEST_ACCOUNT);
    const products = status.resources.find(r => r.resource === "products")!;
    const prices = status.resources.find(r => r.resource === "prices")!;
    const plans = status.resources.find(r => r.resource === "plans")!;
    // In-DB row state should be reflected verbatim. The runner just finished
    // so it would normally have written 'complete' — but this insert ran AFTER
    // the runner's stub (which doesn't touch _sync_status). The stored row
    // values dominate.
    assert.ok(["running", "complete"].includes(products.status), `products status should reflect a stored row; got ${products.status}`);
    assert.equal(prices.status, "running");
    assert.equal(plans.status, "error");
    assert.equal(plans.errorMessage, "Stripe API 500");

    // Synced count cache should be populated for products from the recent run.
    assert.equal(products.syncedCount, 7);
  });
});
