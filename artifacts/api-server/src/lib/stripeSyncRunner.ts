/**
 * In-process orchestration for Stripe data syncs (admin Billing UI).
 *
 * Two entry points share the same lock + status surface:
 *   - runScopedSync  → products/prices/plans (the manual "Sync Stripe data"
 *                      button — fast, refreshes only what the Plans block uses).
 *   - runFullSync    → the scoped resources PLUS customers, subscriptions,
 *                      invoices, charges, and payment methods. Used after a
 *                      live/test mode toggle (and any future "Sync everything"
 *                      button) so the new mode's data lands without waiting
 *                      for webhooks.
 *
 * Why both share one lock:
 *   - There is exactly one Stripe account active at a time, and the library
 *     (`stripe-replit-sync`) writes to a single `_sync_status` row per
 *     resource. Running two backfills in parallel would race on those rows
 *     and on the cached counts. A single boolean lock is enough for this
 *     single-instance setup; concurrent attempts return alreadyRunning:true
 *     and the HTTP layer maps that to 409.
 *
 * Why we derive counts from the data tables:
 *   - The library's `_sync_status` table records timestamps, status, and
 *     error messages — but NOT the per-run synced count. The status endpoint
 *     needs counts ("5 prices synced"). We previously kept these counts in
 *     an in-process Map (countsCache) populated from each `result.synced`,
 *     but that cache is wiped on every server restart/redeploy — so until
 *     the next manual sync, the panel would show "0 synced" next to a
 *     perfectly valid "5m ago" timestamp.
 *   - Instead we count rows directly from `stripe.<resource>` filtered by
 *     the account. The library upserts rows as part of each sync, so the
 *     row count is updated the moment a sync completes (no regression in
 *     the live flow) AND it persists across restarts.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Sentry from "@sentry/node";

export type SyncResource =
  | "products"
  | "prices"
  | "plans"
  | "customers"
  | "subscriptions"
  | "invoices"
  | "charges"
  | "payment_methods";

/**
 * The full set of resources the UI tracks. Order matters — it's also the
 * sequential order of the full backfill, and the order resources render in
 * the progress panel. Plan-related resources first (Products → Prices →
 * Plans), then customer-graph resources (Customers → Subscriptions → ...).
 */
export const SYNC_RESOURCES: readonly SyncResource[] = [
  "products",
  "prices",
  "plans",
  "customers",
  "subscriptions",
  "invoices",
  "charges",
  "payment_methods",
] as const;

/** Resources synced by the manual "Sync Stripe data" button. */
const SCOPED_RESOURCES: readonly SyncResource[] = ["products", "prices", "plans"] as const;

/** Resources synced by the full backfill (live/test toggle, future "Sync everything"). */
const FULL_RESOURCES: readonly SyncResource[] = SYNC_RESOURCES;

export interface SyncResourceStatus {
  resource: SyncResource;
  status: "idle" | "running" | "complete" | "error";
  lastSyncedAt: string | null;
  errorMessage: string | null;
  syncedCount: number | null;
}

export interface SyncStatus {
  inProgress: boolean;
  resources: SyncResourceStatus[];
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

interface LockState {
  startedAt: number;
  finishedAt: number | null;
}

let lock: LockState | null = null;

export function isSyncRunning(): boolean {
  return lock !== null && lock.finishedAt === null;
}

export function getLockSnapshot(): { startedAt: number | null; finishedAt: number | null } {
  if (!lock) return { startedAt: null, finishedAt: null };
  return { startedAt: lock.startedAt, finishedAt: lock.finishedAt };
}

/**
 * Reset all in-process state. Test-only. Simulates a server restart for the
 * purposes of asserting that sync state survives restarts.
 */
export function _resetSyncRunnerForTests(): void {
  lock = null;
}

/**
 * Per-resource → table name. Resources happen to share their name with the
 * underlying `stripe.<table>` the library writes to, but kept explicit so a
 * future divergence (e.g. a derived view) wouldn't silently break counts.
 */
const RESOURCE_TABLES: Readonly<Record<SyncResource, string>> = {
  products:        "products",
  prices:          "prices",
  plans:           "plans",
  customers:       "customers",
  subscriptions:   "subscriptions",
  invoices:        "invoices",
  charges:         "charges",
  payment_methods: "payment_methods",
};

/**
 * Read the current row count per resource from `stripe.<table>` for the given
 * account. This is the source of truth for the "X synced" label in the admin
 * Billing UI — derived from the data tables themselves so the value persists
 * across server restarts (the previous in-memory cache was wiped on every
 * redeploy, leaving "0 synced" next to a recent timestamp).
 *
 * If the stripe schema isn't installed yet (first install before migrations)
 * the whole query fails and we return all-null — same idle posture the
 * status reader takes for missing `_sync_status`.
 *
 * NOTE: data tables use `_account_id` (with leading underscore). The
 * metadata table `_sync_status` uses `account_id` (without). See migration
 * 0049 for the underscore-removal on metadata tables only.
 */
export async function readSyncedCounts(
  accountId: string,
): Promise<Map<SyncResource, number | null>> {
  const counts = new Map<SyncResource, number | null>();
  for (const r of SYNC_RESOURCES) counts.set(r, null);

  try {
    // Single batched UNION query so polling stays O(1) round-trips.
    // Each branch is a separate scalar `count(*)` filtered by `_account_id`.
    const result = await db.execute(sql`
      SELECT 'products'::text        AS resource, count(*)::bigint AS n FROM stripe.products        WHERE _account_id = ${accountId}
      UNION ALL SELECT 'prices',          count(*)::bigint FROM stripe.prices          WHERE _account_id = ${accountId}
      UNION ALL SELECT 'plans',           count(*)::bigint FROM stripe.plans           WHERE _account_id = ${accountId}
      UNION ALL SELECT 'customers',       count(*)::bigint FROM stripe.customers       WHERE _account_id = ${accountId}
      UNION ALL SELECT 'subscriptions',   count(*)::bigint FROM stripe.subscriptions   WHERE _account_id = ${accountId}
      UNION ALL SELECT 'invoices',        count(*)::bigint FROM stripe.invoices        WHERE _account_id = ${accountId}
      UNION ALL SELECT 'charges',         count(*)::bigint FROM stripe.charges         WHERE _account_id = ${accountId}
      UNION ALL SELECT 'payment_methods', count(*)::bigint FROM stripe.payment_methods WHERE _account_id = ${accountId}
    `);
    for (const row of result.rows as unknown as Array<{ resource: string; n: string | number }>) {
      const resource = row.resource as SyncResource;
      if (!RESOURCE_TABLES[resource]) continue;
      // pg returns bigint as string; coerce to number (safe for any plausible row count).
      const n = typeof row.n === "string" ? Number(row.n) : row.n;
      counts.set(resource, Number.isFinite(n) ? n : null);
    }
  } catch (err) {
    console.warn("[stripeSyncRunner] readSyncedCounts failed, returning nulls", err);
  }

  return counts;
}

/**
 * Minimal interface of `StripeSync` we depend on. Defined locally so tests
 * can pass a stub without pulling in the real client. Each method matches
 * one entry in `SyncResource`.
 */
export interface SyncRunnerDriver {
  getAccountId(): Promise<string>;
  syncProducts(): Promise<{ synced: number }>;
  syncPrices(): Promise<{ synced: number }>;
  syncPlans(): Promise<{ synced: number }>;
  syncCustomers(): Promise<{ synced: number }>;
  syncSubscriptions(): Promise<{ synced: number }>;
  syncInvoices(): Promise<{ synced: number }>;
  syncCharges(): Promise<{ synced: number }>;
  syncPaymentMethods(): Promise<{ synced: number }>;
}

export interface RunScopedSyncResult {
  alreadyRunning: boolean;
  startedAt: number;
}

function invokeResource(driver: SyncRunnerDriver, resource: SyncResource): Promise<{ synced: number }> {
  switch (resource) {
    case "products":        return driver.syncProducts();
    case "prices":          return driver.syncPrices();
    case "plans":           return driver.syncPlans();
    case "customers":       return driver.syncCustomers();
    case "subscriptions":   return driver.syncSubscriptions();
    case "invoices":        return driver.syncInvoices();
    case "charges":         return driver.syncCharges();
    case "payment_methods": return driver.syncPaymentMethods();
  }
}

/**
 * Acquire the single in-process lock and run the given resources sequentially
 * on a detached promise. Returns synchronously after acquiring the lock so
 * the HTTP request can respond immediately.
 *
 * The detached run is responsible for clearing the lock and capturing counts
 * regardless of success or failure.
 */
function runWithResources(
  driver: SyncRunnerDriver,
  resources: readonly SyncResource[],
): RunScopedSyncResult {
  if (isSyncRunning()) {
    return { alreadyRunning: true, startedAt: lock!.startedAt };
  }
  const startedAt = Date.now();
  lock = { startedAt, finishedAt: null };

  void (async () => {
    try {
      // We resolve the account up-front so a future change can pre-fetch
      // counts or status per-account if needed; not needed for the loop today.
      await driver.getAccountId();
      // Sequential so the library's _sync_status rows update one-at-a-time
      // and the polling UI can show meaningful progression.
      for (const resource of resources) {
        // The library upserts rows into stripe.<resource> as part of each
        // sync, which is what readSyncedCounts reads — so the count surfaces
        // automatically without any extra bookkeeping here.
        await invokeResource(driver, resource);
      }
    } catch (err) {
      console.error("[stripeSyncRunner] sync failed", err);
    } finally {
      if (lock) lock.finishedAt = Date.now();
    }
  })();

  return { alreadyRunning: false, startedAt };
}

/**
 * Manual button path: refresh products + prices + plans only.
 * Customers/subscriptions/invoices/etc. stay current via webhooks, so this
 * is the fast path the admin reaches for to refresh the Plans block.
 */
export function runScopedSync(driver: SyncRunnerDriver): RunScopedSyncResult {
  return runWithResources(driver, SCOPED_RESOURCES);
}

/**
 * Full-backfill path: refresh every tracked resource. Used after a live/test
 * mode toggle so the new mode's data lands without waiting for webhooks,
 * and reusable for any future "Sync everything" button. Shares the same lock
 * as runScopedSync — a concurrent call returns alreadyRunning:true.
 */
export function runFullSync(driver: SyncRunnerDriver): RunScopedSyncResult {
  return runWithResources(driver, FULL_RESOURCES);
}

interface StatusRow {
  resource: string;
  status: string | null;
  last_synced_at: string | Date | null;
  error_message: string | null;
}

/**
 * Postgres SQLSTATE codes we treat as the "schema not migrated yet" first-
 * install case. Anything else is a real bug we want to hear about loudly.
 *   - 3F000 invalid_schema_name → `stripe` schema doesn't exist
 *   - 42P01 undefined_table     → `stripe._sync_status` table doesn't exist
 *     (schema present but the library hasn't run its migrations yet)
 */
const SCHEMA_MISSING_PG_CODES = new Set(["3F000", "42P01"]);

function isSchemaMissingError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SCHEMA_MISSING_PG_CODES.has(code);
}

/**
 * Indirection so tests can swap in a spy. We can't `mock.method` the imported
 * `Sentry` namespace directly — ESM module namespace exports are read-only,
 * so attempting to redefine `captureException` throws. Routing through this
 * variable keeps the production path identical (a thin wrapper around
 * `Sentry.captureException`) while giving tests a writable seam.
 */
type ErrorReporter = (
  err: unknown,
  context: { tags?: Record<string, string>; extra?: Record<string, unknown> },
) => void;

const defaultReportError: ErrorReporter = (err, context) => {
  Sentry.captureException(err, context);
};

let reportError: ErrorReporter = defaultReportError;

/**
 * Test-only: swap the Sentry reporter for a spy. Pass `null` to restore the
 * default. Always pair with the corresponding restore in afterEach.
 */
export function _setErrorReporterForTests(fn: ErrorReporter | null): void {
  reportError = fn ?? defaultReportError;
}

/**
 * Read per-resource sync status rows for the given account from
 * stripe._sync_status. Returns an idle row for any tracked resource that
 * has no row yet (first-ever sync).
 *
 * Note: the library's `_sync_status` table uses the column name `account_id`
 * (without the leading underscore that the per-resource tables use). See
 * stripe-replit-sync migrations 0048→0049 for the rename history.
 */
export async function readSyncStatus(accountId: string): Promise<SyncStatus> {
  // The schema may not exist yet (first install before migrations) — handle
  // that single case gracefully by returning all-idle. Anything else is a
  // real bug (wrong column name, bad parameter binding, connection failure)
  // and we MUST surface it loudly — the previous broad `console.warn` hid
  // two such bugs for months.
  let rows: StatusRow[] = [];
  try {
    // NOTE: column is `account_id` (migration 0049 renamed it from
    // `_account_id`). Using the wrong name here was a silent bug — the
    // previous broad catch swallowed the "column does not exist" error and
    // returned all-idle.
    //
    // We intentionally do NOT filter by `resource = ANY(...)` here — drizzle's
    // `sql` template expands a JS array into a tuple `($2, $3, $4)` rather
    // than a Postgres array, which trips `op ANY/ALL (array) requires array
    // on right side`. Filtering in JS via `byResource.get(...)` is fine since
    // the table only ever has a handful of rows per account.
    const result = await db.execute(
      sql`SELECT resource, status, last_synced_at, error_message
          FROM stripe._sync_status
          WHERE account_id = ${accountId}`,
    );
    rows = result.rows as unknown as StatusRow[];
  } catch (err) {
    if (isSchemaMissingError(err)) {
      // First-install / pre-migration: legitimately degrade to all-idle and
      // stay quiet so the UI can render a clean empty state.
      console.info(
        "[stripeSyncRunner] readSyncStatus: stripe._sync_status not present yet, returning idle",
      );
    } else {
      // Anything else is a regression. Log at error level AND report to
      // Sentry so we hear about it the first time it happens in production.
      console.error("[stripeSyncRunner] readSyncStatus failed", err);
      reportError(err, {
        tags: { component: "stripeSyncRunner", op: "readSyncStatus" },
        extra: { accountId },
      });
      throw err;
    }
  }

  const byResource = new Map<string, StatusRow>();
  for (const r of rows) byResource.set(r.resource, r);

  // Counts come from row counts in the per-resource stripe.* tables (see
  // readSyncedCounts). They survive restarts because they are derived from
  // persisted data, not an in-memory cache.
  const counts = await readSyncedCounts(accountId);

  const inProgress = isSyncRunning() || rows.some(r => r.status === "running");
  const resources: SyncResourceStatus[] = SYNC_RESOURCES.map(resource => {
    const row = byResource.get(resource);
    const lastSyncedAt = row?.last_synced_at
      ? (row.last_synced_at instanceof Date ? row.last_synced_at.toISOString() : String(row.last_synced_at))
      : null;
    return {
      resource,
      status: (row?.status as SyncResourceStatus["status"]) ?? "idle",
      lastSyncedAt,
      errorMessage: row?.error_message ?? null,
      syncedCount: counts.get(resource) ?? null,
    };
  });

  const snap = getLockSnapshot();
  const startedAt = snap.startedAt !== null ? new Date(snap.startedAt).toISOString() : null;
  const finishedAt = snap.finishedAt !== null ? new Date(snap.finishedAt).toISOString() : null;
  const durationMs =
    snap.startedAt !== null && snap.finishedAt !== null ? snap.finishedAt - snap.startedAt : null;

  return { inProgress, resources, startedAt, finishedAt, durationMs };
}
