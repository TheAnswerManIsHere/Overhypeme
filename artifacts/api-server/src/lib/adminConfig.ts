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
 * Where a resolved config string actually came from. `fallback_default`
 * (DB read failed → emergency code default) is deliberately distinct from
 * `code_default` (DB read succeeded but no row exists → intentional default),
 * so production diagnostics can tell an outage apart from an unconfigured key.
 */
export type ConfigStringSource =
  | "code_default"
  | "admin_config_value"
  | "admin_config_debug_value"
  | "fallback_default";

export interface ConfigStringResolution {
  value: string;
  source: ConfigStringSource;
}

/**
 * Like `getConfigString`, but also reports WHICH source produced the value.
 * Used by provenance-sensitive callers (e.g. the fact-enrichment prompt
 * resolver) that need to surface whether the effective value was the code
 * default, a stored admin-config value, or a debug override.
 */
export async function getConfigStringWithSource(
  key: string,
  defaultValue: string,
): Promise<ConfigStringResolution> {
  try {
    const { byKey } = await loadAll();
    const row = byKey.get(key);
    if (!row) return { value: defaultValue, source: "code_default" };
    const debugActive = byKey.get("debug_mode_active")?.value === "true";
    if (
      row.key !== "debug_mode_active" &&
      debugActive &&
      row.debugValue != null &&
      row.debugValue !== ""
    ) {
      return { value: row.debugValue, source: "admin_config_debug_value" };
    }
    return { value: row.value, source: "admin_config_value" };
  } catch {
    return { value: defaultValue, source: "fallback_default" };
  }
}

/**
 * Get a config float (decimal) value.
 * Returns `defaultValue` if the key is missing, not a number, or the DB is unreachable.
 * Zero DB hits when cache is warm.
 */
export async function getConfigFloat(key: string, defaultValue: number): Promise<number> {
  try {
    const { byKey } = await loadAll();
    const row = byKey.get(key);
    if (!row) return defaultValue;
    const debugActive = byKey.get("debug_mode_active")?.value === "true";
    const parsed = parseFloat(resolveValue(row, debugActive));
    return isNaN(parsed) ? defaultValue : parsed;
  } catch {
    return defaultValue;
  }
}

export interface ConfigFloatResolution {
  value: number;
  source: ConfigStringSource;
}

/**
 * Like `getConfigFloat`, but also reports WHICH source produced the value —
 * the float counterpart of `getConfigStringWithSource`, same precedent, same
 * reason: a provenance-sensitive caller needs to tell "the DB read failed" apart
 * from "no row exists, this default is intentional." Used by `checkBudget` for
 * exactly that (#409 round 1) — a config-read failure must deny the spend gate,
 * not silently price it against the emergency code default.
 */
export async function getConfigFloatWithSource(
  key: string,
  defaultValue: number,
): Promise<ConfigFloatResolution> {
  try {
    const { byKey } = await loadAll();
    const row = byKey.get(key);
    if (!row) return { value: defaultValue, source: "code_default" };
    const debugActive = byKey.get("debug_mode_active")?.value === "true";
    const parsed = parseFloat(resolveValue(row, debugActive));
    if (isNaN(parsed)) return { value: defaultValue, source: "code_default" };
    const source: ConfigStringSource =
      row.key !== "debug_mode_active" && debugActive && row.debugValue != null && row.debugValue !== ""
        ? "admin_config_debug_value"
        : "admin_config_value";
    return { value: parsed, source };
  } catch {
    return { value: defaultValue, source: "fallback_default" };
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

/**
 * Get a config integer reading the `value` column directly, bypassing debug-mode
 * resolution. Use for audit-bearing markers (like `engine_revision`) whose
 * effective value must never be shifted by the debug overlay — a debug value
 * could make the corpus appear stale/fresh under a revision that was never
 * formally bumped + audited.
 */
export async function getConfigIntRaw(key: string, defaultValue: number): Promise<number> {
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
