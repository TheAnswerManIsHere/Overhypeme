import crypto from "crypto";
import { db, rateLimitCountersTable } from "@workspace/db";
import { like, sql } from "drizzle-orm";

export type RateLimitScope = {
  endpoint: string;
  ip?: string | null;
  userId?: string | null;
  recipientEmail?: string | null;
};

export type RateLimitConfig = {
  limit: number;
  windowMs: number;
  nearLimitRatio?: number;
};

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: number;
  nearLimit: boolean;
};

export const rateLimitMetrics = {
  hits: 0,
  nearLimit: 0,
  blocked: 0,
};

export function normalizeRateLimitKey(scope: RateLimitScope): string {
  const endpoint = scope.endpoint.trim().toLowerCase();
  const ip = (scope.ip ?? "unknown").trim().toLowerCase();
  const userId = (scope.userId ?? "anonymous").trim().toLowerCase();
  const recipientEmail = (scope.recipientEmail ?? "none").trim().toLowerCase();
  return ["rl", endpoint, `ip:${ip}`, `uid:${userId}`, `to:${recipientEmail}`].join("|");
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export async function checkSharedRateLimit(scope: RateLimitScope, config: RateLimitConfig): Promise<RateLimitResult> {
  const key = normalizeRateLimitKey(scope);
  const keyHash = hashKey(key);
  const now = new Date();
  const expiresAt = new Date(Date.now() + config.windowMs);
  const nearLimitThreshold = Math.max(1, Math.floor(config.limit * (config.nearLimitRatio ?? 0.8)));

  const result = await db.execute<{ count: number; expires_at: Date }>(sql`
    INSERT INTO rate_limit_counters (key_hash, key_raw, count, expires_at, updated_at)
    VALUES (${keyHash}, ${key}, 1, ${expiresAt}, ${now})
    ON CONFLICT (key_hash)
    DO UPDATE
      SET
        count = CASE
          WHEN rate_limit_counters.expires_at <= ${now} THEN 1
          ELSE rate_limit_counters.count + 1
        END,
        expires_at = CASE
          WHEN rate_limit_counters.expires_at <= ${now} THEN ${expiresAt}
          ELSE rate_limit_counters.expires_at
        END,
        key_raw = EXCLUDED.key_raw,
        updated_at = ${now}
    RETURNING count, expires_at
  `);

  const row = result.rows[0];
  const count = Number(row?.count ?? 1);
  const resetAt = new Date(row?.expires_at ?? expiresAt).getTime();
  const allowed = count <= config.limit;
  const nearLimit = allowed && count >= nearLimitThreshold;

  rateLimitMetrics.hits += 1;
  if (nearLimit) rateLimitMetrics.nearLimit += 1;
  if (!allowed) rateLimitMetrics.blocked += 1;

  return { allowed, count, limit: config.limit, resetAt, nearLimit };
}

/**
 * Expired-row retention lives in `jobs/rateLimitCounterPurger.ts`, not here.
 *
 * There used to be a `purgeExpiredRateLimitCounters()` beside this function: a
 * single unbounded `DELETE ... WHERE expires_at <= now()` that nothing in
 * production ever called, so the table grew without limit — retaining the raw
 * IPs and live session tokens `normalizeRateLimitKey` puts in `key_raw`. It was
 * removed rather than wired up, because running it against the accumulated
 * backlog is the specific thing to avoid: one statement holding locks across
 * every eligible row, on the pool the request path is using. The purger deletes
 * in bounded batches under a whole-run budget instead.
 */
export async function purgeRateLimitCountersByPrefix(rawKeyPrefix: string): Promise<void> {
  await db.delete(rateLimitCountersTable).where(like(rateLimitCountersTable.keyRaw, `${rawKeyPrefix}%`));
}
