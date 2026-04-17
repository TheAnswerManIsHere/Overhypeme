import { type Request, type Response, type NextFunction } from "express";
import { getSessionId } from "./auth";

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const RATE_WINDOW_MS = parsePositiveInt(process.env.RATE_WINDOW_MS, 60_000);
const RATE_MAX = parsePositiveInt(process.env.RATE_MAX, 30);

function rateLimitKey(req: Request): string {
  const sid = getSessionId(req);
  if (sid) return `sid:${sid}`;
  return `ip:${req.ip ?? "unknown"}`;
}

export function createRateLimiter(): (req: Request, res: Response, next: NextFunction) => void {
  const rateCounts = new Map<string, { count: number; windowStart: number }>();

  setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [key, entry] of rateCounts) {
      if (entry.windowStart < cutoff) rateCounts.delete(key);
    }
  }, RATE_WINDOW_MS).unref();

  function checkRateLimit(key: string): boolean {
    const now = Date.now();
    const entry = rateCounts.get(key);
    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
      rateCounts.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= RATE_MAX) return false;
    entry.count++;
    return true;
  }

  return function requireRateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = rateLimitKey(req);
    if (!checkRateLimit(key)) {
      res.status(429).json({ error: "Too many requests. Please slow down." });
      return;
    }
    next();
  };
}
