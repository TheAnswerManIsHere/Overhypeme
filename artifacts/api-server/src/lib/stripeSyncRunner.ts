/**
 * In-process orchestration for the admin "Sync Stripe data" button.
 *
 * Why this exists:
 *   - The admin UI needs scoped, fast syncing of *just* products/prices/plans.
 *     Customers/subscriptions/invoices/etc. are kept current by webhooks.
 *   - The UI polls a status endpoint to render real-time progress.
 *   - We must guard against two concurrent runs of the manual sync (a single
 *     in-memory lock is sufficient for this single-instance setup).
 *   - The library's `_sync_status` table only records last-run timestamps and
 *     status — it does NOT persist per-run synced counts. We cache the latest
 *     counts in memory keyed by accountId+resource so the status endpoint can
 *     surface "5 prices synced" alongside the green check.
 *
 * Lock granularity: a single boolean. Even though products/prices/plans are
 * three separate sync calls, they always run sequentially under one lock so
 * the status endpoint can be polled without races.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type SyncResource = "products" | "prices" | "plans";

export const SYNC_RESOURCES: readonly SyncResource[] = ["products", "prices", "plans"] as const;

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
 * can pass a stub without pulling in the real client.
 */
export interface SyncRunnerDriver {
  getAccountId(): Promise<string>;
  syncProducts(): Promise<{ synced: number }>;
  syncPrices(): Promise<{ synced: number }>;
  syncPlans(): Promise<{ synced: number }>;
}

export interface RunScopedSyncResult {
  alreadyRunning: boolean;
  startedAt: number;
}

/**
 * Kicks off a scoped sync run if one is not already in progress. The actual
 * sync runs on a detached promise; this function returns synchronously after
 * acquiring the lock so the HTTP request can respond immediately.
 *
 * The detached run is responsible for clearing the lock and capturing counts
 * regardless of success or failure.
 */
export function runScopedSync(driver: SyncRunnerDriver): RunScopedSyncResult {
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
      const productsResult = await driver.syncProducts();
      setCachedSyncedCount(accountId, "products", productsResult.synced);
      const pricesResult = await driver.syncPrices();
      setCachedSyncedCount(accountId, "prices", pricesResult.synced);
      const plansResult = await driver.syncPlans();
      setCachedSyncedCount(accountId, "plans", plansResult.synced);
    } catch (err) {
      console.error("[stripeSyncRunner] scoped sync failed", err);
    } finally {
      if (lock) lock.finishedAt = Date.now();
    }
  })();

  return { alreadyRunning: false, startedAt };
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
 */
export async function readSyncStatus(accountId: string): Promise<SyncStatus> {
  // The schema may not exist yet (first install before migrations) — handle
  // that gracefully by returning all-idle.
  let rows: StatusRow[] = [];
  try {
    const result = await db.execute(
      sql`SELECT resource, status, last_synced_at, error_message
          FROM stripe._sync_status
          WHERE _account_id = ${accountId}
            AND resource = ANY(${SYNC_RESOURCES as unknown as string[]})`,
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
