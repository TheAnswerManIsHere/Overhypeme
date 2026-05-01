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

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import {
  runScopedSync,
  runFullSync,
  isSyncRunning,
  readSyncStatus,
  _resetSyncRunnerForTests,
  _setErrorReporterForTests,
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

/**
 * Best-effort cleanup of test-owned rows from every per-resource data table
 * AND the account row itself. Used by readSyncStatus tests so each test
 * starts with a known empty state for `_account_id = TEST_ACCOUNT`.
 *
 * Tables are cleared in an order that respects FK references to
 * stripe.accounts (FKs from data tables → accounts.id). Each statement is
 * independently try/catch so a missing table doesn't abort the whole reset.
 */
async function clearStripeDataRows() {
  const tables = [
    "payment_methods",
    "charges",
    "invoices",
    "subscriptions",
    "customers",
    "plans",
    "prices",
    "products",
  ] as const;
  for (const t of tables) {
    try {
      await db.execute(sql.raw(`DELETE FROM stripe.${t} WHERE _account_id = '${TEST_ACCOUNT}'`));
    } catch {
      // table may not exist in some test envs
    }
  }
  try {
    await db.execute(sql`DELETE FROM stripe.accounts WHERE id = ${TEST_ACCOUNT}`);
  } catch {
    // schema may not exist in some test envs
  }
}

/**
 * Insert N rows into stripe.<table> for TEST_ACCOUNT. Each row gets a
 * synthetic `_raw_data` jsonb whose `id` is unique within the table. Returns
 * `false` if the schema isn't installed so the caller can `return` to skip
 * row-level assertions in environments without Stripe migrations.
 */
async function seedRows(table: string, count: number, idPrefix: string): Promise<boolean> {
  if (count <= 0) return true;
  try {
    for (let i = 0; i < count; i++) {
      const raw = JSON.stringify({ id: `${idPrefix}_${i}` });
      await db.execute(
        sql.raw(
          `INSERT INTO stripe.${table} (_raw_data, _account_id) VALUES ('${raw}'::jsonb, '${TEST_ACCOUNT}')`,
        ),
      );
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the FK target row for TEST_ACCOUNT exists in stripe.accounts.
 * Returns false on schema-missing so callers can skip data-row assertions.
 *
 * Note: the accounts table has `id` as a GENERATED column derived from
 * `_raw_data->>'id'`, so the insert sets `_raw_data` only.
 */
async function ensureTestAccountRow(): Promise<boolean> {
  try {
    const raw = JSON.stringify({ id: TEST_ACCOUNT });
    await db.execute(
      sql.raw(
        `INSERT INTO stripe.accounts (_raw_data) VALUES ('${raw}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      ),
    );
    return true;
  } catch {
    return false;
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
    await clearStripeDataRows();
  });
  afterEach(async () => {
    _resetSyncRunnerForTests();
    await clearStatusRows();
    await clearStripeDataRows();
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
      // syncedCount is now derived from the per-resource data tables. With
      // no rows for this account it's a real `0` (schema present, empty
      // table) — or `null` if the stripe schema isn't installed at all
      // (count query fails and readSyncedCounts returns nulls). Either
      // outcome renders identically in the UI (`syncedCount ?? 0`).
      assert.ok(
        r.syncedCount === null || r.syncedCount === 0,
        `expected syncedCount to be 0 or null for empty/idle ${r.resource}, got ${r.syncedCount}`,
      );
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

  it("surfaces stored row state (running / complete / error) and per-resource counts derived from the data tables", async () => {
    // Ensure account row exists (FK constraint from _sync_status.account_id
    // and from each data table's _account_id → accounts.id).
    if (!(await ensureTestAccountRow())) {
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

    // Seed real rows in each per-resource table so the count derivation has
    // something to count. Counts intentionally vary per resource so we'd
    // catch a copy-paste bug that returned the same value for every column.
    const seeded =
      (await seedRows("products",        3, "prod"))    &&
      (await seedRows("prices",          5, "price"))   &&
      (await seedRows("plans",           1, "plan"))    &&
      (await seedRows("customers",       4, "cust"))    &&
      (await seedRows("subscriptions",   2, "sub"))     &&
      (await seedRows("invoices",        6, "inv"))     &&
      (await seedRows("charges",         7, "ch"))      &&
      (await seedRows("payment_methods", 8, "pm"));
    if (!seeded) return;

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

    // Synced counts must come from actual row counts in the per-resource
    // tables — not from a per-run cache (which is what this task fixed).
    assert.equal(get("products").syncedCount, 3);
    assert.equal(get("prices").syncedCount, 5);
    assert.equal(get("plans").syncedCount, 1);
    assert.equal(get("customers").syncedCount, 4);
    assert.equal(get("subscriptions").syncedCount, 2);
    assert.equal(get("invoices").syncedCount, 6);
    assert.equal(get("charges").syncedCount, 7);
    assert.equal(get("payment_methods").syncedCount, 8);
  });

  it("preserves syncedCount across a simulated server restart (regression: counts survive process loss)", async () => {
    // The bug this guards against: counts used to live in an in-memory Map
    // that was wiped on every process restart, leaving "0 synced" next to a
    // recent timestamp. Counts are now derived from row counts in the
    // stripe.* tables, so they must survive resetting the runner state.
    if (!(await ensureTestAccountRow())) return;

    const seeded = await seedRows("products", 4, "prod_persist");
    if (!seeded) return;

    // Pretend a sync just completed and recorded its status row.
    await db.execute(sql`
      INSERT INTO stripe._sync_status (resource, status, last_synced_at, error_message, account_id)
      VALUES ('products', 'complete', now(), NULL, ${TEST_ACCOUNT})
      ON CONFLICT (resource, account_id) DO UPDATE SET
        status = EXCLUDED.status,
        last_synced_at = EXCLUDED.last_synced_at
    `);

    const before = await readSyncStatus(TEST_ACCOUNT);
    const productsBefore = before.resources.find(r => r.resource === "products")!;
    assert.equal(productsBefore.syncedCount, 4, "pre-restart count should reflect seeded rows");

    // Simulate a server restart by wiping all in-process state.
    _resetSyncRunnerForTests();

    const after = await readSyncStatus(TEST_ACCOUNT);
    const productsAfter = after.resources.find(r => r.resource === "products")!;
    assert.equal(
      productsAfter.syncedCount,
      4,
      "post-restart count must equal pre-restart count — derived from persisted rows, not in-memory cache",
    );
    assert.equal(productsAfter.status, "complete");
    assert.notEqual(productsAfter.lastSyncedAt, null);
  });
});

describe("stripeSyncRunner — readSyncStatus error handling", () => {
  // Each test installs a stub for db.execute (writable — drizzle returns a
  // plain object) and a stub error reporter (via the module's test seam,
  // because the @sentry/node namespace import is read-only and can't be
  // reassigned from a test). All stubs are restored in afterEach.
  let reporterCalls: Array<{ err: unknown; ctx: { tags?: Record<string, string>; extra?: Record<string, unknown> } }>;

  beforeEach(() => {
    _resetSyncRunnerForTests();
    reporterCalls = [];
    _setErrorReporterForTests((err, ctx) => { reporterCalls.push({ err, ctx }); });
  });
  afterEach(() => {
    _resetSyncRunnerForTests();
    _setErrorReporterForTests(null);
    mock.restoreAll();
  });

  it("degrades to all-idle (no Sentry alert) when the stripe schema is missing", async () => {
    // Pre-migration first-install case: pg raises invalid_schema_name (3F000).
    const schemaMissingErr = Object.assign(
      new Error('schema "stripe" does not exist'),
      { code: "3F000" },
    );
    mock.method(db, "execute", async () => { throw schemaMissingErr; });

    const status = await readSyncStatus(TEST_ACCOUNT);

    // Same shape as the empty-table case: every tracked resource is idle.
    assert.equal(status.inProgress, false);
    assert.equal(status.resources.length, SYNC_RESOURCES.length);
    for (const r of status.resources) {
      assert.equal(r.status, "idle", `${r.resource} should be idle when schema is missing`);
      assert.equal(r.lastSyncedAt, null);
      assert.equal(r.errorMessage, null);
    }

    // Crucially: we did NOT alert. Schema-missing is the legitimate first-
    // install path the runner is allowed to swallow.
    assert.equal(
      reporterCalls.length, 0,
      "schema-missing must not page on-call — it's the documented first-install case",
    );
  });

  it("degrades to all-idle (no Sentry alert) when the _sync_status table is missing", async () => {
    // Schema present, table not yet created: pg raises undefined_table (42P01).
    const tableMissingErr = Object.assign(
      new Error('relation "stripe._sync_status" does not exist'),
      { code: "42P01" },
    );
    mock.method(db, "execute", async () => { throw tableMissingErr; });

    const status = await readSyncStatus(TEST_ACCOUNT);
    assert.equal(status.inProgress, false);
    for (const r of status.resources) assert.equal(r.status, "idle");
    assert.equal(reporterCalls.length, 0);
  });

  it("rethrows AND reports to Sentry on any other DB error so regressions are loud", async () => {
    // The exact class of bug this task is hardening against: a wrong column
    // name (undefined_column / 42703) used to be silently swallowed by the
    // previous broad `console.warn` + return-idle catch.
    const undefinedColumnErr = Object.assign(
      new Error('column "_account_id" does not exist'),
      { code: "42703" },
    );
    mock.method(db, "execute", async () => { throw undefinedColumnErr; });

    await assert.rejects(
      readSyncStatus(TEST_ACCOUNT),
      /column "_account_id" does not exist/,
      "non-schema-missing errors must propagate so the route returns 500",
    );

    assert.equal(
      reporterCalls.length, 1,
      "the regression-class error must be reported to Sentry on first occurrence",
    );
    const reported = reporterCalls[0]!;
    assert.equal(reported.err, undefinedColumnErr);
    assert.equal(reported.ctx.tags?.component, "stripeSyncRunner");
    assert.equal(reported.ctx.tags?.op, "readSyncStatus");
    assert.equal(reported.ctx.extra?.accountId, TEST_ACCOUNT);
  });

  it("treats errors without a pg `code` field as real errors (not schema-missing)", async () => {
    // A plain Error (e.g. connection drop, type coercion bug) must NOT be
    // mistaken for the schema-missing case just because it lacks a SQLSTATE.
    mock.method(db, "execute", async () => {
      throw new Error("connection terminated unexpectedly");
    });

    await assert.rejects(readSyncStatus(TEST_ACCOUNT), /connection terminated/);
    assert.equal(reporterCalls.length, 1);
  });
});

