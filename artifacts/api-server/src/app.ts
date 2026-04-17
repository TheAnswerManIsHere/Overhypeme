import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import * as Sentry from "@sentry/node";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";
import { WebhookHandlers } from "./lib/webhookHandlers";
import { noStore } from "./lib/cacheHeaders";

const app: Express = express();

// Trust the Replit / cloud proxy — required so req.secure is true and
// SameSite=None; Secure cookies are correctly accepted by Express.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
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

app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
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
  "/api/mobile-auth",
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
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, url: req.url, method: req.method }, "Unhandled route error");
  if (res.headersSent) return;
  res.status(500).json({
    error: "Internal server error",
    eventId: (res as Response & { sentry?: string }).sentry,
  });
});

export default app;
