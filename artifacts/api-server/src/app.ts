import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
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
], noStore);

app.use("/api", router);

// Public config endpoint — no auth required, returns only is_public=true values
app.get("/api/config", async (_req, res) => {
  try {
    const { getPublicConfig } = await import("./lib/adminConfig");
    const config = await getPublicConfig();
    res.json(config);
  } catch {
    res.json({});
  }
});

export default app;
