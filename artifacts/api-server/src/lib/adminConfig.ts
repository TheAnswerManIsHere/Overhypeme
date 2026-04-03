/**
 * Admin Configuration Helper
 *
 * Reads configuration values from the `admin_config` table with a short
 * TTL in-memory cache so pipelines and request handlers never hit the DB
 * on every call. Cache is busted immediately when a value is written.
 *
 * Flow:
 *   - First call (or after a write/expiry): fetches all rows from DB → stores in module-level Map
 *   - Subsequent calls within 60 s: served from the Map (zero DB round-trips)
 *   - After admin PATCH: bustConfigCache() sets _cache = null → next read re-fetches
 */

import { db } from "@workspace/db";
import { adminConfigTable, type AdminConfig } from "@workspace/db/schema";

const CACHE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
  rows: AdminConfig[];
  byKey: Map<string, AdminConfig>;
  expiresAt: number;
}

let _cache: CacheEntry | null = null;

async function loadAll(): Promise<CacheEntry> {
  if (_cache && Date.now() < _cache.expiresAt) {
    return _cache;
  }
  const rows = await db.select().from(adminConfigTable).orderBy(adminConfigTable.key);
  const byKey = new Map(rows.map(r => [r.key, r]));
  _cache = { rows, byKey, expiresAt: Date.now() + CACHE_TTL_MS };
  return _cache;
}

/** Bust the in-memory cache immediately (call after any config write). */
export function bustConfigCache(): void {
  _cache = null;
}

/**
 * Get a config integer value.
 * Returns `defaultValue` if the key is missing, not an integer, or the DB is unreachable.
 * Zero DB hits when cache is warm.
 */
export async function getConfigInt(key: string, defaultValue: number): Promise<number> {
  try {
    const { byKey } = await loadAll();
    const row = byKey.get(key);
    if (!row) return defaultValue;
    const parsed = parseInt(row.value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  } catch {
    return defaultValue;
  }
}

/** Get all config rows ordered by key (for the admin list endpoint). */
export async function getAllConfig(): Promise<AdminConfig[]> {
  const { rows } = await loadAll();
  return rows;
}

/**
 * Get only public config values (for the unauthenticated /api/config endpoint).
 * Also served from cache — no extra DB hit.
 */
export async function getPublicConfig(): Promise<Record<string, number | string | boolean>> {
  const { rows } = await loadAll();
  const result: Record<string, number | string | boolean> = {};
  for (const row of rows) {
    if (!row.isPublic) continue;
    if (row.dataType === "integer") result[row.key] = parseInt(row.value, 10);
    else if (row.dataType === "boolean") result[row.key] = row.value === "true";
    else result[row.key] = row.value;
  }
  return result;
}
