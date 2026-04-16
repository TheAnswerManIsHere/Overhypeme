import app from "./app";
import { logger } from "./lib/logger";
import { backfillWilsonScores, ensureSchema } from "./lib/seed";
import { runMigrations } from "@workspace/db";
import { backfillEmbeddings } from "./lib/embeddings";
import { refreshPricingCache } from "./lib/falPricing";
import { getConfigString, getConfigInt } from "./lib/adminConfig";
import type { Socket } from "net";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  logger.warn("STRIPE_WEBHOOK_SECRET is not set — webhook signature verification is DISABLED. Forged webhooks may be accepted.");
}

async function initStripe() {
  try {
    const { runMigrations } = await import("stripe-replit-sync");
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      logger.warn("DATABASE_URL not set, skipping Stripe init");
      return;
    }

    await runMigrations({ databaseUrl });
    logger.info("Stripe schema ready");

    const { getStripeSync } = await import("./lib/stripeClient");
    const stripeSync = await getStripeSync();

    const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
    if (domain) {
      const webhookUrl = `https://${domain}/api/stripe/webhook`;
      await stripeSync.findOrCreateManagedWebhook(webhookUrl);
      logger.info({ webhookUrl }, "Stripe webhook configured");
    }

    stripeSync.syncBackfill()
      .then(() => logger.info("Stripe backfill complete"))
      .catch((err: unknown) => logger.error({ err }, "Stripe backfill error"));

    // Ensure membership products are tagged with metadata.membership = "true"
    // so isMembershipPrice() can identify them. Idempotent — safe on every boot.
    const stripe = stripeSync.stripe;
    const membershipProductIds = ["prod_UIcJvpLFJwiKaH", "prod_UIcKBQY3i1dRpq", "prod_UJXQaM9DqVyrJr"];
    for (const prodId of membershipProductIds) {
      try {
        const product = await stripe.products.retrieve(prodId);
        if (product.metadata?.membership !== "true") {
          await stripe.products.update(prodId, { metadata: { membership: "true" } });
          logger.info({ productId: prodId }, "Tagged Stripe product with membership metadata");
        }
      } catch (err) {
        logger.warn({ err, productId: prodId }, "Could not verify/tag Stripe product metadata");
      }
    }
  } catch (err) {
    logger.error({ err }, "Stripe init failed — continuing without payments");
  }
}

await initStripe();

// Apply any pending database migrations before accepting requests
await runMigrations();

// Idempotent schema & config seed (ADD COLUMN IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING)
await ensureSchema();

// Reconcile membership tiers: any user with an active subscription but membership_tier != 'legendary'
// should be upgraded. This catches webhook gaps (e.g. isMembershipPrice blocked the grant before
// products were tagged, or the webhook handler crashed mid-flight).
async function reconcileMembershipTiers() {
  try {
    const { db } = await import("@workspace/db");
    const { usersTable, subscriptionsTable } = await import("@workspace/db/schema");
    const { eq, and, ne } = await import("drizzle-orm");

    const mismatched = await db
      .select({
        userId: usersTable.id,
        email: usersTable.email,
        currentTier: usersTable.membershipTier,
        subStatus: subscriptionsTable.status,
      })
      .from(usersTable)
      .innerJoin(subscriptionsTable, eq(usersTable.id, subscriptionsTable.userId))
      .where(and(
        eq(subscriptionsTable.status, "active"),
        ne(usersTable.membershipTier, "legendary"),
      ));

    if (mismatched.length === 0) return;

    for (const row of mismatched) {
      await db.update(usersTable)
        .set({ membershipTier: "legendary" })
        .where(eq(usersTable.id, row.userId));
      logger.info(
        { userId: row.userId, email: row.email, previousTier: row.currentTier },
        "Reconciled membership tier → legendary (active subscription found)",
      );
    }
    logger.info({ count: mismatched.length }, "Membership tier reconciliation complete");
  } catch (err) {
    logger.error({ err }, "Membership tier reconciliation failed");
  }
}

await reconcileMembershipTiers();

// Backfill Wilson scores for any facts that have votes but no score yet
await backfillWilsonScores().catch((err: unknown) => logger.error({ err }, "Wilson backfill failed"));

// Non-blocking: generate embeddings for any facts that are missing them (e.g. after a DB seed/restore)
backfillEmbeddings()
  .then(({ processed, failed }) => {
    if (processed > 0 || failed > 0) logger.info({ processed, failed }, "Embedding backfill complete");
  })
  .catch((err: unknown) => logger.warn({ err }, "Embedding backfill skipped (no OpenAI key?)"));

// Daily cron: send Fact of the Day at 9:00 UTC
function scheduleDailyFactJob() {
  const schedule = () => {
    const now = new Date();
    const next9am = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0, 0));
    if (next9am <= now) next9am.setUTCDate(next9am.getUTCDate() + 1);
    const msUntilNext = next9am.getTime() - now.getTime();
    logger.info({ nextRunAt: next9am.toISOString(), msUntilNext }, "Fact of the Day scheduled");
    setTimeout(async () => {
      try {
        const { runFactOfTheDayJob } = await import("./jobs/factOfTheDay");
        const result = await runFactOfTheDayJob();
        logger.info(result, "Fact of the Day sent");
      } catch (err) {
        logger.error({ err }, "Fact of the Day job failed");
      }
      schedule(); // reschedule for next day
    }, msUntilNext);
  };
  schedule();
}

scheduleDailyFactJob();

// ── fal.ai Pricing Cache ────────────────────────────────────────────────────
async function initPricingCache(): Promise<void> {
  try {
    const endpointsJson = await getConfigString(
      "fal_active_endpoints",
      '["fal-ai/flux-pro/v1.1","xai/grok-imagine-video/image-to-video"]',
    );
    let endpointIds: string[] = [];
    try {
      endpointIds = JSON.parse(endpointsJson);
    } catch {
      logger.warn({ endpointsJson }, "fal_active_endpoints config is not valid JSON — using defaults");
      endpointIds = ["fal-ai/flux-pro/v1.1", "xai/grok-imagine-video/image-to-video"];
    }
    logger.info({ count: endpointIds.length }, "Refreshing fal.ai pricing cache");
    await refreshPricingCache(endpointIds);
    logger.info("fal.ai pricing cache warmed");

    // Schedule hourly refresh from config (default 1h = 3600000ms)
    const intervalMs = await getConfigInt("pricing_refresh_interval_ms", 3_600_000);
    setInterval(async () => {
      try {
        const idsJson = await getConfigString(
          "fal_active_endpoints",
          JSON.stringify(endpointIds),
        );
        const ids: string[] = JSON.parse(idsJson);
        await refreshPricingCache(ids);
        logger.info({ count: ids.length }, "fal.ai pricing cache refreshed");
      } catch (err) {
        logger.warn({ err }, "fal.ai pricing cache refresh failed");
      }
    }, intervalMs).unref();
  } catch (err) {
    logger.warn({ err }, "fal.ai pricing cache init failed — continuing without pre-warmed cache");
  }
}

// Non-blocking: warm pricing cache in background, don't block server start
initPricingCache().catch((err: unknown) => logger.warn({ err }, "Pricing cache init error"));


const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

type TrackedSocket = Socket & { _destroyOnIdle?: boolean };

const sockets = new Set<TrackedSocket>();
const socketInflight = new Map<TrackedSocket, number>();

server.on("connection", (socket: TrackedSocket) => {
  sockets.add(socket);
  socketInflight.set(socket, 0);
  socket.once("close", () => {
    sockets.delete(socket);
    socketInflight.delete(socket);
  });
});

server.on("request", (_req, res) => {
  const socket = _req.socket as TrackedSocket;
  socketInflight.set(socket, (socketInflight.get(socket) ?? 0) + 1);
  res.once("finish", () => {
    const remaining = (socketInflight.get(socket) ?? 1) - 1;
    socketInflight.set(socket, remaining);
    if (remaining === 0 && socket._destroyOnIdle) {
      socket.destroy();
    }
  });
});

function shutdown(signal: string) {
  logger.info({ signal }, "Received signal, shutting down gracefully");

  const forceExitTimer = setTimeout(() => {
    logger.warn("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close(() => {
    clearTimeout(forceExitTimer);
    logger.info("Server closed");
    process.exit(0);
  });

  for (const socket of sockets) {
    if ((socketInflight.get(socket) ?? 0) > 0) {
      socket._destroyOnIdle = true;
    } else {
      socket.destroy();
    }
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
