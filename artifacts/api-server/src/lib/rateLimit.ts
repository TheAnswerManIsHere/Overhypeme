import { type Request, type Response, type NextFunction } from "express";
import { getSessionId } from "./auth";
import { checkSharedRateLimit } from "./sharedRateLimiter";

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export const RATE_WINDOW_MS = parsePositiveInt(process.env.RATE_WINDOW_MS, 60_000);
export const RATE_MAX = parsePositiveInt(process.env.RATE_MAX, 30);

// Fact submission is deliberately stricter than the global limiter: a submission
// now lands a candidate in the moderation queue (and a provisional approval
// spends money), so we throttle harder. Tier-aware: admins/legendary bypass.
export const FACT_SUBMIT_WINDOW_MS = parsePositiveInt(process.env.FACT_SUBMIT_WINDOW_MS, 60_000);
export const FACT_SUBMIT_MAX = parsePositiveInt(process.env.FACT_SUBMIT_MAX, 5);
// Max simultaneously-unresolved submissions a single user may have in the queue
// (stages: triage_pending / prep_pending / prep_failed / production_review).
export const FACT_SUBMIT_PENDING_CAP = parsePositiveInt(process.env.FACT_SUBMIT_PENDING_CAP, 10);

function rateLimitScope(req: Request): { ip: string; userId?: string } {
  const sid = getSessionId(req);
  return {
    ip: req.ip ?? "unknown",
    userId: sid,
  };
}

export function createRateLimiter(routeName = "global", max = RATE_MAX, windowMs = RATE_WINDOW_MS) {
  return async function requireRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const scope = rateLimitScope(req);
    const result = await checkSharedRateLimit({ endpoint: routeName, ip: scope.ip, userId: scope.userId }, { limit: max, windowMs });

    if (!result.allowed) {
      res.status(429).json({ error: "Too many requests. Please slow down." });
      return;
    }

    next();
  };
}

/**
 * Dedicated, tier-aware limiter for fact submission. Admins and legendary
 * members bypass it (they already bypass captcha/onboarding); everyone else is
 * throttled at the stricter `fact_submit` window. The per-user unresolved cap is
 * enforced transactionally at the route (see reviews.ts), not here.
 */
export function createFactSubmitRateLimiter(
  max = FACT_SUBMIT_MAX,
  windowMs = FACT_SUBMIT_WINDOW_MS,
) {
  return async function requireFactSubmitRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const user = (req as Request & { user?: { isRealAdmin?: boolean; membershipTier?: string } }).user;
    if (user?.isRealAdmin || user?.membershipTier === "legendary") {
      next();
      return;
    }

    const scope = rateLimitScope(req);
    const result = await checkSharedRateLimit({ endpoint: "fact_submit", ip: scope.ip, userId: scope.userId }, { limit: max, windowMs });

    if (!result.allowed) {
      res.status(429).json({ error: "You're submitting facts too quickly. Please slow down." });
      return;
    }

    next();
  };
}
