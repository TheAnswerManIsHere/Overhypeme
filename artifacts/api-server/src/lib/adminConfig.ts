/**
 * Admin Configuration Helper
 *
 * Reads configuration values from the `admin_config` table with a short
 * TTL in-memory cache so pipelines and request handlers never hit the DB
 * on every call. Cache is busted immediately when a value is written.
 *
 * Every getter reads the row's `value`: it is the only value a key has.
 * (Debug mode, a second `debug_value` set that a global toggle swapped in,
 * was removed in launch Phase 4; docs/retired/debug-mode.md.)
 *
 * Flow:
 *   - First call (or after a write/expiry): fetches all rows from DB → stores in module-level Map
 *   - Subsequent calls within 60 s: served from the Map (zero DB round-trips)
 *   - After admin PATCH: bustConfigCache() sets _cache = null → next read re-fetches
 */

import { eq } from "drizzle-orm";
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
    return row.value;
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
  | "fallback_default";

export interface ConfigStringResolution {
  value: string;
  source: ConfigStringSource;
}

/**
 * Like `getConfigString`, but also reports WHICH source produced the value.
 * Used by provenance-sensitive callers (e.g. the fact-enrichment prompt
 * resolver) that need to surface whether the effective value was the code
 * default or a stored admin-config value.
 */
export async function getConfigStringWithSource(
  key: string,
  defaultValue: string,
): Promise<ConfigStringResolution> {
  try {
    const { byKey } = await loadAll();
    const row = byKey.get(key);
    if (!row) return { value: defaultValue, source: "code_default" };
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
    const parsed = parseFloat(row.value);
    return isNaN(parsed) ? defaultValue : parsed;
  } catch {
    return defaultValue;
  }
}

/**
 * Get a config string value reading the `value` column directly. Since Debug
 * mode went this returns what `getConfigString` returns; it stays as the named
 * entry point the Stripe mode readers use, so their call sites did not move.
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
 * Read one config value STRICTLY: no cache, no TTL, and no default on failure.
 *
 * The fourth sibling in this family, and the two things that make it different
 * are the two hazards its caller could not survive:
 *
 *   - **It propagates.** `getConfigStringRaw` answers with its default for both
 *     "the stored value is that" and "the lookup threw", so a gate reading its
 *     precondition through it cannot tell a stored value from a failure.
 *   - **It does not touch `loadAll()`.** That cache has no in-flight tracking,
 *     so a read started before a write can complete after `bustConfigCache()`
 *     and repopulate the cache with pre-write rows for another ~60 seconds
 *     (documented at `docs/engineering/deferred-work.md:500-506`). A reader that
 *     must not act on a superseded value therefore has to go to the row.
 *
 * This is a targeted bypass for callers that need it, NOT a fix for the cache:
 * the single-flight repair for `loadAll()` is its own tracked work, and every
 * other reader still goes through the cache with its documented behavior. One
 * query per call, so use it where calls are bounded — not on a hot path.
 *
 * Returns `undefined` when the row is absent, which is a readable answer; a
 * failed lookup throws.
 */
export async function getConfigStringStrict(key: string): Promise<string | undefined> {
  const rows = await db
    .select({ value: adminConfigTable.value })
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, key))
    .limit(1);
  return rows[0]?.value;
}

/**
 * Get a config integer reading the `value` column directly. Since Debug mode
 * went this returns what `getConfigInt` returns; it stays as the named entry
 * point for the audit-bearing `engine_revision` marker.
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
 */
export async function getPublicConfig(): Promise<Record<string, number | string | boolean>> {
  const { rows } = await loadAll();
  const result: Record<string, number | string | boolean> = {};
  for (const row of rows) {
    if (!row.isPublic) continue;
    const effective = row.value;
    if (row.dataType === "integer") result[row.key] = parseInt(effective, 10);
    else if (row.dataType === "boolean") result[row.key] = effective === "true";
    else result[row.key] = effective;
  }
  return result;
}
