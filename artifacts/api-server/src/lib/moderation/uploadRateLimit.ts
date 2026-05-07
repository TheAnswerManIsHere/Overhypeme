/**
 * Per-user daily upload cap.
 *
 *   Free tier (registered/unregistered):  upload_rate_limit_registered_per_day  (default 20)
 *   Legendary tier:                       upload_rate_limit_legendary_per_day   (default 200)
 *   Admins:                               not rate-limited
 *
 * Runs *before* the moderation pipeline so we do not burn Arachnid /
 * NSFW classifier calls on rate-limited users. Counter is shared with
 * the rest of the rate-limit infrastructure via `checkSharedRateLimit`.
 */

import type { Request } from "express";
import { checkSharedRateLimit, type RateLimitResult } from "../sharedRateLimiter";
import { getConfigInt } from "../adminConfig";

const ENDPOINT = "upload-photo-daily";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  registered: 20,
  legendary: 200,
};

export async function getDailyUploadLimit(membershipTier: string | null | undefined, isAdmin: boolean): Promise<number> {
  if (isAdmin) return Number.MAX_SAFE_INTEGER;
  if (membershipTier === "legendary") {
    return getConfigInt("upload_rate_limit_legendary_per_day", DEFAULTS.legendary);
  }
  return getConfigInt("upload_rate_limit_registered_per_day", DEFAULTS.registered);
}

export interface UploadRateLimitResult extends RateLimitResult {
  limit: number;
}

export interface CheckUploadRateLimitArgs {
  userId: string;
  membershipTier: string | null | undefined;
  isAdmin: boolean;
  ip?: string | null;
}

/**
 * Returns the result of a single counter increment. Caller is responsible
 * for translating `!allowed` into a 429 response with `Retry-After`.
 */
export async function checkUploadRateLimit(args: CheckUploadRateLimitArgs): Promise<UploadRateLimitResult> {
  const limit = await getDailyUploadLimit(args.membershipTier, args.isAdmin);
  const result = await checkSharedRateLimit(
    { endpoint: ENDPOINT, ip: args.ip ?? "unknown", userId: args.userId },
    { limit, windowMs: ONE_DAY_MS },
  );
  return { ...result, limit };
}

/** Convenience helper for express handlers. */
export function getRateLimitScopeFromRequest(req: Request, userId: string): {
  ip: string;
  userId: string;
} {
  return { ip: (req.ip ?? "unknown"), userId };
}
