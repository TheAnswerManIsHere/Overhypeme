/**
 * Admin Configuration Helper
 *
 * Reads configuration values from the `admin_config` table with a short
 * TTL in-memory cache so pipelines and request handlers never hit the DB
 * on every call. Cache is busted immediately when a value is written.
 *
 * Debug mode: when the `debug_mode_active` config key is "true", every
 * getter prefers the row's `debugValue` over `value` (if `debugValue` is
 * set). The `debug_mode_active` key itself is never redirected to avoid
 * a chicken-and-egg loop.
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
 * Returns true when the `debug_mode_active` config key is set to "true".
 * Always reads the `value` column directly — never the debug value — to
 * avoid a circular dependency.
 */
export async function isDebugModeActive(): Promise<boolean> {
  try {
    const { byKey } = await loadAll();
    return byKey.get("debug_mode_active")?.value === "true";
  } catch {
    return false;
  }
}

/**
 * Resolve the effective value for a row, accounting for debug mode.
 * The `debug_mode_active` key is always returned from `value` regardless
 * of debug mode to prevent circular logic.
 */
function resolveValue(row: AdminConfig, debugActive: boolean): string {
  if (row.key === "debug_mode_active") return row.value;
  if (debugActive && row.debugValue != null && row.debugValue !== "") return row.debugValue;
  return row.value;
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
    const debugActive = byKey.get("debug_mode_active")?.value === "true";
    const parsed = parseInt(resolveValue(row, debugActive), 10);
    return isNaN(parsed) ? defaultValue : parsed;
  } catch {
    return defaultValue;
  }
}

/**
 * Get a config string value.
 * Returns `defaultValue` if the key is missing or the DB is unreachable.
 * Zero DB hits when cache is warm.
 */
export async function getConfigString(key: string, defaultValue: string): Promise<string> {
  try {
    const { byKey } = await loadAll();
    const row = byKey.get(key);
    if (!row) return defaultValue;
    const debugActive = byKey.get("debug_mode_active")?.value === "true";
    return resolveValue(row, debugActive);
  } catch {
    return defaultValue;
  }
}

/**
 * Get a config string value reading the `value` column directly, bypassing
 * debug-mode resolution. Use this for infrastructure settings (like stripe_live_mode)
 * that must be independent of the debug overlay.
 */
export async function getConfigStringRaw(key: string, defaultValue: string): Promise<string> {
  try {
    const { byKey } = await loadAll();
    const row = byKey.get(key);
    return row?.value ?? defaultValue;
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
 * Respects debug mode: public keys with a debugValue set will return
 * the debug value when debug mode is active.
 */
export async function getPublicConfig(): Promise<Record<string, number | string | boolean>> {
  const { rows, byKey } = await loadAll();
  const debugActive = byKey.get("debug_mode_active")?.value === "true";
  const result: Record<string, number | string | boolean> = {};
  for (const row of rows) {
    if (!row.isPublic) continue;
    const effective = resolveValue(row, debugActive);
    if (row.dataType === "integer") result[row.key] = parseInt(effective, 10);
    else if (row.dataType === "boolean") result[row.key] = effective === "true";
    else result[row.key] = effective;
  }
  return result;
}
