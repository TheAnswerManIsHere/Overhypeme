import express, { type Express, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import * as Sentry from "@sentry/node";
import { scrubObject, scrubUrl } from "@workspace/redact";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";
import { WebhookHandlers } from "./lib/webhookHandlers";
import { noStore } from "./lib/cacheHeaders";
import { fallbackErrorHandler } from "./lib/errorHandler";
import { SESSION_COOKIE } from "./lib/auth";
import { securityHeaders } from "./lib/securityHeaders";
import { isDevAdminLoginEnabled } from "./lib/devAdminLogin";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";
const ORIGIN_EXEMPT_PATHS = new Set([
  "/api/stripe/webhook",
  // Apple Sign In uses response_mode=form_post: Apple's servers POST the
  // authorization code from appleid.apple.com, which is not in our allowed
  // origins list. CSRF protection for this route is provided by Apple's own
  // `state` parameter (PKCE), so origin-checking here is redundant and wrong.
  "/api/callback/apple",
  // Route-stats is a pure analytics endpoint that records which pages were
  // visited. It accepts only a fixed allowlist of route keys, carries no
  // auth-sensitive mutation, and is intentionally open to unauthenticated
  // callers. CSRF-protecting it provides no security benefit and causes a
  // race condition: the POST fires on page load before the CSRF cookie issued
  // by a concurrent GET has been received back by the browser.
  "/api/route-stats",
]);
// dev-admin-login is origin-exempt ONLY while the backdoor is enabled (a
// non-production preview). When disabled it is subject to the normal
// origin/CSRF checks, and the handler 404s anyway. Fail-closed (C1).
if (isDevAdminLoginEnabled()) {
  ORIGIN_EXEMPT_PATHS.add("/api/auth/dev-admin-login");
}

function isOriginExempt(req: Request): boolean {
  return ORIGIN_EXEMPT_PATHS.has(req.path);
}


function parseAllowedOrigins(): Set<string> {
  const origins = new Set(
    (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  // Always allow the Replit dev-preview domain when running inside a Replit
  // environment.  REPLIT_DEV_DOMAIN is injected automatically by the platform
  // and is stable for the lifetime of a given Repl.
  if (process.env.REPLIT_DEV_DOMAIN) {
    origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }
  return origins;
}

function isCookieSessionRequest(req: Request): boolean {
  const hasSidCookie = typeof req.cookies?.[SESSION_COOKIE] === "string";
  const authHeader = req.headers["authorization"];
  const isBearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ");
  return hasSidCookie && !isBearer;
}

const app: Express = express();

// Trust the Replit / cloud proxy — required so req.secure is true and
// SameSite=None; Secure cookies are correctly accepted by Express.
app.set("trust proxy", 1);

// Application security headers (C5). Mounted first so EVERY response — including
// the Stripe webhook, /api/config, and error responses — carries the baseline
// headers. CSP is Report-Only and the frame/HSTS policy is env-aware; see
// lib/securityHeaders.ts for the full rationale.
app.disable("x-powered-by");
app.use(...securityHeaders());

// pino-http calls `logger.info()` on response finish. If the pino-pretty
// transport worker has exited, that write would throw synchronously and kill
// the response lifecycle. The `logger` exported from ./lib/logger is already
// wrapped to swallow such errors, but we still wrap the request-logger
// middleware itself so that any synchronous throw from pino-http or our
// custom serializers (e.g. scrubUrl/scrubObject choking on an exotic body)
// can never bubble out and crash the process.
const requestLogger = pinoHttp({
  logger,
  serializers: {
    req(req) {
      try {
        return {
          id: req.id,
          method: req.method,
          url: req.url != null ? scrubUrl(req.url) : req.url,
          body: Buffer.isBuffer(req.raw?.body) ? "[Buffer]" : scrubObject(req.raw?.body),
        };
      } catch {
        return { id: req.id, method: req.method };
      }
    },
    res(res) {
      try {
        return { statusCode: res.statusCode };
      } catch {
        return {};
      }
    },
  },
});

app.use((req: Request, res: Response, next: NextFunction) => {
  try {
    requestLogger(req, res, next);
  } catch (err) {
    // Transport dead or some other logging-pipeline failure. Swallow so the
    // request can still be served; the safe logger has already written the
    // error to stderr. Note: this only catches synchronous setup-time
    // throws from pino-http itself. Throws from the response-finish hook
    // (`onResFinished` -> `logger.info`) are caught upstream by the safe
    // logger Proxy in ./lib/logger.
    try {
      process.stderr.write(
        JSON.stringify({
          level: 50,
          time: Date.now(),
          pid: process.pid,
          msg: "request logger middleware failed (transport may have exited)",
          err: err instanceof Error
            ? { type: err.name, message: err.message }
            : { type: typeof err, message: String(err) },
        }) + "\n",
      );
    } catch {
      // Nothing more we can do.
    }
    next();
  }
});

// Stripe webhook MUST be registered BEFORE express.json() to get raw Buffer
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) { res.status(400).json({ error: "Missing stripe-signature" }); return; }
    const sig = Array.isArray(signature) ? signature[0] : signature;
    try {
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err) {
      logger.error({ err }, "Stripe webhook error");
      res.status(400).json({ error: "Webhook processing error" });
    }
  },
);

// Dev admin login needs permissive CORS so the POST fetch works from any
// preview context (Replit canvas iframes, direct mobile browser, etc.).
// Registered before the global cors() so it handles preflights too. Mounted
// ONLY while the backdoor is enabled (a non-production preview) — when disabled
// the path falls through to the global origin-allowlist CORS. Fail-closed (C1).
if (isDevAdminLoginEnabled()) {
  app.use("/api/auth/dev-admin-login", cors({ origin: true, credentials: true }));
}

const allowedOrigins = parseAllowedOrigins();
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
}));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, res: Response, next: NextFunction) => {
  if (isOriginExempt(req)) return next();
  const origin = req.get("origin");
  if (!origin) return next();
  if (allowedOrigins.has(origin)) return next();

  res.status(403).json({ error: "Origin not allowed" });
});

// Public asset endpoints that social crawlers (Twitter/X, Facebook,
// Discord, Slack, iMessage) fetch when unfurling links. These responses
// MUST NOT carry a Set-Cookie header — Twitter/X explicitly treats any
// response with Set-Cookie as user-specific content and refuses to use it
// as an OG image (you get the small "no preview" card instead of the
// summary_large_image card). The csrf_token cookie is only needed by the
// SPA for double-submit CSRF protection on mutations; crawlers never
// mutate, so issuing it on these paths is pure breakage.
//
// Also: when a Set-Cookie header is present, Cloudflare downgrades
// `Cache-Control: public` to `private`, which makes the image
// uncacheable at the edge — a second-order disaster for OG performance.
const PUBLIC_ASSET_PATH_PATTERNS: RegExp[] = [
  /^\/api\/og\//,                  // OG shell endpoint (consumed by crawlers)
  /^\/api\/memes\/[^/]+\/image$/,  // meme image endpoint (the actual og:image)
  /^\/api\/memes\/templates\//,    // template image endpoint (also publicly cached)
];

function isPublicAssetRequest(req: Request): boolean {
  if (!SAFE_METHODS.has(req.method)) return false;
  return PUBLIC_ASSET_PATH_PATTERNS.some((re) => re.test(req.path));
}

app.use((req: Request, res: Response, next: NextFunction) => {
  // Skip csrf_token cookie issuance on public asset GETs — see comment above.
  if (isPublicAssetRequest(req)) return next();
  const token = req.cookies?.[CSRF_COOKIE];
  if (!token) {
    res.cookie(CSRF_COOKIE, crypto.randomUUID(), {
      httpOnly: false,
      secure: true,
      sameSite: "none",
      path: "/",
    });
  }
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (SAFE_METHODS.has(req.method) || isOriginExempt(req)) return next();
  if (!isCookieSessionRequest(req)) return next();

  const origin = req.get("origin");
  const referer = req.get("referer");
  let source = origin ?? null;
  if (!source && referer) {
    try {
      source = new URL(referer).origin;
    } catch {
      source = null;
    }
  }
  // Only reject when an origin/referer is *present* and not in the allowlist.
  // If no origin can be determined (e.g. the Replit proxy strips the header),
  // we fall through to the double-submit cookie token check, which is the
  // primary CSRF defence and is sufficient on its own.
  if (source && !allowedOrigins.has(source)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }

  const csrfCookie = req.cookies?.[CSRF_COOKIE];
  const csrfHeader = req.get(CSRF_HEADER);
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    res.status(403).json({ error: "Invalid CSRF token" });
    return;
  }

  next();
});
app.use(authMiddleware);

// Attach the authenticated user (id only — no PII) to the per-request Sentry
// isolation scope so every reported error/transaction in this request can be
// filtered by user. Using the isolation scope (not setUser on the global scope)
// ensures concurrent requests don't leak each other's user context.
app.use((req: Request, _res: Response, next: NextFunction) => {
  const scope = Sentry.getIsolationScope();
  if (req.user?.id) {
    scope.setUser({ id: req.user.id });
  } else {
    scope.setUser(null);
  }
  next();
});

// Ensure auth, admin, mutation, and webhook routes are never cached
app.use([
  "/api/auth",
  "/api/login",
  "/api/logout",
  "/api/callback",
  "/api/admin",
  "/api/stripe/checkout",
  "/api/stripe/portal",
  "/api/stripe/subscription",
  "/api/stripe/webhook",
  "/api/share",
  "/api/storage/uploads",
  "/api/storage/upload-avatar",
  "/api/storage/upload-meme",
  "/api/memes/stock-photo",
  "/api/videos/generate",
], noStore);

// Public config endpoint — registered BEFORE the main router so nothing can intercept it
app.get("/api/config", async (_req, res) => {
  try {
    const { getPublicConfig } = await import("./lib/adminConfig");
    const config = await getPublicConfig();
    res.json(config);
  } catch {
    res.json({});
  }
});

app.use("/api", router);

// Sentry's express error handler — must be registered AFTER all routes/middleware.
// Captures any error thrown in a route handler (including async handlers in Express 5)
// and forwards it to Sentry before passing to the next error handler.
Sentry.setupExpressErrorHandler(app);

// Final fallback error handler — returns a clean JSON 500 instead of leaking
// HTML stack traces. Sentry has already captured the error by this point.
// Any structured details attached to the error (which may echo request body
// data) are passed through scrubObject so that passwords, tokens, and other
// PII are never returned to the client verbatim.
app.use(fallbackErrorHandler);

export default app;
