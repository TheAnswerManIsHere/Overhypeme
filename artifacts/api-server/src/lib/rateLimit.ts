import { type Request, type Response, type NextFunction } from "express";
import { getSessionId } from "./auth";
import { checkSharedRateLimit } from "./sharedRateLimiter";

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export const RATE_WINDOW_MS = parsePositiveInt(process.env.RATE_WINDOW_MS, 60_000);
export const RATE_MAX = parsePositiveInt(process.env.RATE_MAX, 30);

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
