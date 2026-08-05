import { type Request, type Response, type NextFunction } from "express";
import { rateLimit, ipKeyGenerator, type RateLimitRequestHandler, type Store } from "express-rate-limit";
import { getSessionId } from "./auth";
import { checkSharedRateLimit } from "./sharedRateLimiter";
import { ipFromRequest } from "./transientRenderLog";
import { BoundedMemoryStore, MAX_TRACKED_KEYS } from "./globalRateLimitStore";
import { logger } from "./logger";

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export const RATE_WINDOW_MS = parsePositiveInt(process.env.RATE_WINDOW_MS, 60_000);
export const RATE_MAX = parsePositiveInt(process.env.RATE_MAX, 30);

// Coarse, API-wide backstop satisfying CodeQL's js/missing-rate-limiting check
// (which only recognizes specific npm packages, not this repo's DB-backed
// checkSharedRateLimit — see
// .agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md, which
// records the resolution and its rationale. The plan that derived this
// design lived on a plan-review branch that was never merged, so it is not
// cited here — that memory doc is the durable source).
//
// Default derived from this repo's real polling workload: two 500ms pollers
// (video-jobs, pulid-jobs) at 120 req/min each for one active job, plus
// ordinary browsing by the same users, with a 1.33x margin. This is a
// per-instance, per-IP ceiling (MemoryStore's localKeys = true), not a
// fleet-wide one; the existing narrow, DB-backed limiters
// (checkSharedRateLimit/createRateLimiter) remain the fleet-correct
// per-feature protection and are unchanged by this.
export const GLOBAL_RATE_WINDOW_MS = parsePositiveInt(process.env.GLOBAL_RATE_WINDOW_MS, 60_000);
export const GLOBAL_RATE_MAX = parsePositiveInt(process.env.GLOBAL_RATE_MAX, 12_000);

// Express's default routing is neither strict nor case-sensitive, so
// `/api/healthz/` and `/API/HEALTHZ` both reach the same handler —
// registration and exemption must normalize identically on both axes or the
// exemption silently misses valid spellings.
function normalizeRoutePath(path: string): string {
  const lowered = path.toLowerCase();
  return lowered.length > 1 && lowered.endsWith("/") ? lowered.slice(0, -1) : lowered;
}

// The router dispatches HEAD to a GET handler when no explicit HEAD handler
// exists, so a GET-only exemption would let an uptime probe's `HEAD
// /api/healthz` be blocked at the ceiling.
const SAFE_READ_METHODS = ["GET", "HEAD"] as const;

// Exactly two exemptions, on "the whole request path is cheap" — never "the
// final handler looks cheap." /api/health, /api/health/queues, and the
// public-asset image/OG endpoints all do real work and are deliberately NOT
// exempt; they remain metered like any other traffic.
const EARLY_EXEMPT_ROUTES: ReadonlyArray<{ methods: readonly string[]; path: string }> = [
  { methods: SAFE_READ_METHODS, path: "/api/healthz" },
  { methods: ["POST"], path: "/api/stripe/webhook" }, // own signature gate
];

function isExemptRequest(req: Request): boolean {
  const path = normalizeRoutePath(req.originalUrl.split("?")[0]);
  return EARLY_EXEMPT_ROUTES.some((r) => r.methods.includes(req.method) && r.path === path);
}

// Bounds the *rate* of log lines this handler itself writes to <=1/sec/process.
// This does NOT bound total log volume on its own — pino-http logs every
// response completion independently (see app.ts's pinoHttp customLogLevel),
// and that needs its own suppression for a sustained flood to stay bounded.
const BLOCKED_LOG_INTERVAL_MS = 1_000;
let lastBlockedLogAt = 0;

function logBlockedThrottled(context: Record<string, unknown>, message: string): void {
  const now = Date.now();
  if (now - lastBlockedLogAt < BLOCKED_LOG_INTERVAL_MS) return;
  lastBlockedLogAt = now;
  logger.warn(context, `[rateLimit] ${message}`);
}

/**
 * Marker `logBlockedThrottled`'s handler sets on `res.locals` — and ONLY
 * that handler sets it — so `globalLimiterLogLevel` can identify exactly the
 * responses the global limiter itself blocked. `RateLimit-*` headers are NOT
 * a safe discriminator for this: `standardHeaders: true` sets them on every
 * request the limiter admits too, so an admitted request later rejected by a
 * narrow, DB-backed limiter (e.g. `createFactSubmitRateLimiter`, local-auth
 * throttles) would still carry them and be wrongly silenced (round-17 Codex
 * finding on this PR).
 */
// Exported (only) as a test seam so globalLimiterLogLevel's unit test can
// construct a `res.locals` fixture with the exact same key the real handler
// sets, without needing to intercept pino-http's internal per-request logger.
export const GLOBAL_RATE_LIMIT_BLOCKED = Symbol("globalRateLimitBlocked");

/**
 * pino-http's `customLogLevel` for the app's request logger (see app.ts):
 * silences the per-response completion log ONLY for a response the global
 * limiter itself blocked. `logBlockedThrottled` above already bounds the
 * rate of *its own* log line, but pino-http logs every response completion
 * independently — without this, a sustained flood still produces one log
 * line per rejected request no matter what that helper does.
 *
 * A pure function (not a closure over `res`) so it's directly unit-testable
 * without needing to intercept pino-http's internal per-request logging.
 */
export function globalLimiterLogLevel(res: { statusCode: number; locals?: Record<PropertyKey, unknown> }): "silent" | "info" {
  if (res.statusCode === 429 && res.locals?.[GLOBAL_RATE_LIMIT_BLOCKED] === true) {
    return "silent";
  }
  return "info";
}

export interface GlobalRateLimiterOverrides {
  windowMs?: number;
  limit?: number;
  store?: Store;
}

/**
 * Single-source-of-truth factory for the global limiter — used by both
 * app.ts (mounted at /api) and the integration tests, so the ceiling the
 * tests assert against can never drift from the ceiling actually mounted.
 * Returns a fresh instance (and, unless overridden, a fresh store) on every
 * call — deliberately not a module-level singleton, so tests that need an
 * injected low limit never leak that limit/store into any other test.
 */
export function createGlobalLimiter(overrides: GlobalRateLimiterOverrides = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: overrides.windowMs ?? GLOBAL_RATE_WINDOW_MS,
    limit: overrides.limit ?? GLOBAL_RATE_MAX,
    store: overrides.store ?? new BoundedMemoryStore(MAX_TRACKED_KEYS),
    keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => isExemptRequest(req),
    handler: (req, res) => {
      logBlockedThrottled({ path: req.originalUrl.split("?")[0] }, "global rate limit exceeded");
      (res.locals as Record<PropertyKey, unknown>)[GLOBAL_RATE_LIMIT_BLOCKED] = true;
      res.set("Cache-Control", "no-store");
      res.status(429).json({ error: "Too many requests. Please slow down." });
    },
  });
}

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
