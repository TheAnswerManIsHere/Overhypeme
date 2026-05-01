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
 * Why we cache counts in memory:
 *   - The library's `_sync_status` table records timestamps, status, and
 *     error messages — but NOT the per-run synced count. The status endpoint
 *     needs counts ("5 prices synced") so we keep the latest count per
 *     account+resource here. Persists in-process so a resource that wasn't
 *     touched by the most recent run still shows its previous count.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

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

// Most recently observed synced counts, keyed by `${accountId}::${resource}`.
// Persists across runs in-process so a row that has not been re-synced still
// shows the count from its last successful run.
const countsCache = new Map<string, number>();

function countsKey(accountId: string, resource: SyncResource): string {
  return `${accountId}::${resource}`;
}

export function getCachedSyncedCount(accountId: string, resource: SyncResource): number | null {
  const v = countsCache.get(countsKey(accountId, resource));
  return v === undefined ? null : v;
}

export function setCachedSyncedCount(accountId: string, resource: SyncResource, count: number): void {
  countsCache.set(countsKey(accountId, resource), count);
}

export function isSyncRunning(): boolean {
  return lock !== null && lock.finishedAt === null;
}

export function getLockSnapshot(): { startedAt: number | null; finishedAt: number | null } {
  if (!lock) return { startedAt: null, finishedAt: null };
  return { startedAt: lock.startedAt, finishedAt: lock.finishedAt };
}

/**
 * Reset all in-process state. Test-only.
 */
export function _resetSyncRunnerForTests(): void {
  lock = null;
  countsCache.clear();
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
      const accountId = await driver.getAccountId();
      // Sequential so the library's _sync_status rows update one-at-a-time
      // and the polling UI can show meaningful progression.
      for (const resource of resources) {
        const result = await invokeResource(driver, resource);
        setCachedSyncedCount(accountId, resource, result.synced);
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
  // that gracefully by returning all-idle.
  let rows: StatusRow[] = [];
  try {
    // Drizzle's `sql` template expands a JS array into a parenthesised
    // parameter list (`($1, $2, ...)`), which is the row-tuple form Postgres
    // expects after `IN`. Using `ANY(...)` here would require an actual
    // ARRAY[...] literal and fail with "op ANY/ALL (array) requires array on
    // right side".
    const result = await db.execute(
      sql`SELECT resource, status, last_synced_at, error_message
          FROM stripe._sync_status
          WHERE account_id = ${accountId}
            AND resource IN ${SYNC_RESOURCES as unknown as string[]}`,
    );
    rows = result.rows as unknown as StatusRow[];
  } catch (err) {
    console.warn("[stripeSyncRunner] readSyncStatus failed, returning idle", err);
  }

  const byResource = new Map<string, StatusRow>();
  for (const r of rows) byResource.set(r.resource, r);

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
      syncedCount: getCachedSyncedCount(accountId, resource),
    };
  });

  const snap = getLockSnapshot();
  const startedAt = snap.startedAt !== null ? new Date(snap.startedAt).toISOString() : null;
  const finishedAt = snap.finishedAt !== null ? new Date(snap.finishedAt).toISOString() : null;
  const durationMs =
    snap.startedAt !== null && snap.finishedAt !== null ? snap.finishedAt - snap.startedAt : null;

  return { inProgress, resources, startedAt, finishedAt, durationMs };
}
