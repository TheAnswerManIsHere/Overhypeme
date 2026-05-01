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

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";
const ORIGIN_EXEMPT_PATHS = new Set(["/api/stripe/webhook"]);

function isOriginExempt(req: Request): boolean {
  return ORIGIN_EXEMPT_PATHS.has(req.path);
}


function parseAllowedOrigins(): Set<string> {
  return new Set(
    (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
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

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url != null ? scrubUrl(req.url) : req.url,
          body: Buffer.isBuffer(req.raw?.body) ? "[Buffer]" : scrubObject(req.raw?.body),
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

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

app.use((req: Request, res: Response, next: NextFunction) => {
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
  if (!source || !allowedOrigins.has(source)) {
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
