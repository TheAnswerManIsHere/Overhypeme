// Sentry must be the very first import so its hooks register before any other
// module loads. Because we bundle with esbuild, OTel can't intercept express
// via the module loader — but setupExpressErrorHandler in app.ts captures all
// unhandled errors, which is all we need.
import "./instrument";
import * as Sentry from "@sentry/node";
import app from "./app";
import { logger } from "./lib/logger";
import { backfillWilsonScores, ensureSchema } from "./lib/seed";
import { runMigrations } from "@workspace/db";
import { backfillEmbeddings } from "./lib/embeddings";
import { refreshPricingCache } from "./lib/falPricing";
import { getConfigString, getConfigInt } from "./lib/adminConfig";
import { attachShutdownHandlers } from "./shutdown";
import { runEmailOutboxWorker } from "./lib/email.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Boot-time visibility for the per-mode Stripe env vars. Both mode-specific
// secret keys and webhook signing secrets are required so that flipping the
// stripe_live_mode toggle never lands on an unconfigured mode at runtime.
// Webhook signature verification still works without the webhook secret (it
// falls back to the per-account managed-webhook secret stored in
// stripe._managed_webhooks), so the webhook-secret check is informational.
// The secret-key check is also a warning rather than fatal so the server can
// still boot for non-Stripe routes; getCredentials() throws when invoked.
const missingStripeSecretVars: string[] = [];
if (!process.env.STRIPE_SECRET_KEY_TEST) missingStripeSecretVars.push("STRIPE_SECRET_KEY_TEST");
if (!process.env.STRIPE_SECRET_KEY_LIVE) missingStripeSecretVars.push("STRIPE_SECRET_KEY_LIVE");
if (missingStripeSecretVars.length > 0) {
  logger.warn(
    { missing: missingStripeSecretVars },
    "Missing Stripe secret-key env var(s) — Stripe calls in the affected mode will throw until they are set.",
  );
}

const missingWebhookSecretVars: string[] = [];
if (!process.env.STRIPE_WEBHOOK_SECRET_TEST) missingWebhookSecretVars.push("STRIPE_WEBHOOK_SECRET_TEST");
if (!process.env.STRIPE_WEBHOOK_SECRET_LIVE) missingWebhookSecretVars.push("STRIPE_WEBHOOK_SECRET_LIVE");
if (missingWebhookSecretVars.length > 0) {
  logger.warn(
    { missing: missingWebhookSecretVars },
    "Missing Stripe webhook-signing-secret env var(s) — falling back to the managed-webhook signing secret stored in the database for the affected mode(s). Set the mode-specific env vars to use a Stripe-Dashboard-issued signing secret instead.",
  );
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

    const { getSiteBaseUrl } = await import("./lib/siteUrl");
    const webhookUrl = `${getSiteBaseUrl()}/api/stripe/webhook`;
    // findOrCreateManagedWebhook registers the webhook endpoint and subscribes it to all
    // event types returned by getSupportedEventTypes() in stripe-replit-sync.  That list
    // must include every event that webhookHandlers.ts handles (currently:
    //   charge.refunded, charge.dispute.created, charge.dispute.closed,
    //   plus subscription/invoice events).
    // When adding a new handler, ensure the matching event type is also present in
    // getSupportedEventTypes() so Stripe actually delivers the event to this endpoint.
    await stripeSync.findOrCreateManagedWebhook(webhookUrl);
    logger.info({ webhookUrl }, "Stripe webhook configured");

    stripeSync.syncBackfill({ object: "all" })
      .then(() => logger.info("Stripe backfill complete"))
      .catch((err: unknown) => logger.error({ err }, "Stripe backfill error"));

    // Ensure membership products are tagged with metadata.membership = "true"
    // so isMembershipPrice() can identify them. Idempotent — safe on every boot.
    // These IDs are test-mode only — skip in live mode (live products have different IDs).
    const { isLiveMode } = await import("./lib/stripeClient");
    const currentlyLive = await isLiveMode();
    if (!currentlyLive) {
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
    }
  } catch (err) {
    logger.error({ err }, "Stripe init failed — continuing without payments");
  }
}

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

// ── Startup sequence ─────────────────────────────────────────────────────────
// Only the two DB steps run before listen() so the port opens in seconds.
// Everything else (Stripe, membership reconcile, backfills) runs in the
// background and does not block port binding.

// Apply any pending database migrations before accepting requests
await runMigrations();

// Idempotent schema & config seed (ADD COLUMN IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING)
await ensureSchema();

// Bind the port now — deployment health checks can pass immediately.
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

const shutdown = attachShutdownHandlers(server, {
  onClose: () => logger.info("Server closed"),
  onTimeout: () => logger.warn("Graceful shutdown timed out — forcing exit"),
});

process.on("SIGTERM", () => {
  logger.info({ signal: "SIGTERM" }, "Received signal, shutting down gracefully");
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  logger.info({ signal: "SIGINT" }, "Received signal, shutting down gracefully");
  shutdown("SIGINT");
});

// Catch-all for crashes that aren't already wrapped in try/catch.
// Without these, an unhandled async error tears the process down silently
// (no Sentry capture, no log of *what* crashed). We capture, flush, and exit
// non-zero so the dev-supervisor.sh wrapper restarts the process and the
// production deployment runtime restarts the container.
//
// Re-entrancy guard: cascading failures (e.g. an uncaughtException that
// triggers an unhandledRejection during Sentry.flush) must not race two
// flush/exit paths against each other. The first call wins; subsequent
// fatal events are logged but ignored, and a hard 5s safety timeout
// guarantees we never block forever inside flush.
let fatalExitInProgress = false;
async function fatalExit(err: unknown, kind: "uncaughtException" | "unhandledRejection") {
  if (fatalExitInProgress) {
    logger.error({ err, kind }, "Additional fatal error during shutdown — ignoring (already exiting)");
    return;
  }
  fatalExitInProgress = true;
  const safetyTimer = setTimeout(() => process.exit(1), 5_000);
  safetyTimer.unref();
  try {
    logger.fatal({ err, kind }, "Fatal error — capturing to Sentry and exiting");
    Sentry.captureException(err, { tags: { fatal: kind } });
    await Sentry.flush(2000);
  } catch (flushErr) {
    logger.error({ err: flushErr }, "Sentry flush failed during fatal exit");
  } finally {
    clearTimeout(safetyTimer);
    process.exit(1);
  }
}
process.on("uncaughtException", (err) => { void fatalExit(err, "uncaughtException"); });
process.on("unhandledRejection", (reason) => { void fatalExit(reason, "unhandledRejection"); });

// Boot-time visibility into Stripe webhook freshness. Logs the most recently
// processed Stripe event so a stalled webhook (signing-secret rotation, server
// down for hours, etc.) is obvious in the workflow logs without having to
// query the DB. Warns if the latest event is more than 24h old.
async function logLastStripeEvent(): Promise<void> {
  try {
    const { db } = await import("@workspace/db");
    const { stripeProcessedEventsTable } = await import("@workspace/db/schema");
    const { desc } = await import("drizzle-orm");
    const [row] = await db
      .select()
      .from(stripeProcessedEventsTable)
      .orderBy(desc(stripeProcessedEventsTable.processedAt))
      .limit(1);
    if (!row) {
      logger.warn("No Stripe webhook events have ever been processed — webhook may not be configured");
      return;
    }
    const processedAt = new Date(row.processedAt);
    const ageHours = (Date.now() - processedAt.getTime()) / 3_600_000;
    const summary = {
      eventId: row.eventId,
      processedAt: processedAt.toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
    };
    if (ageHours > 24) {
      logger.warn(summary, "Last Stripe webhook is more than 24h old — webhook delivery may be stale");
    } else {
      logger.info(summary, "Last Stripe webhook event");
    }
  } catch (err) {
    logger.warn({ err }, "Could not query last Stripe webhook event for boot summary");
  }
}
void logLastStripeEvent();

// Non-blocking background tasks — failures are logged but never crash the server.
initStripe().catch((err: unknown) => logger.error({ err }, "Stripe init error"));
reconcileMembershipTiers().catch((err: unknown) => logger.error({ err }, "Membership reconciliation error"));
backfillWilsonScores().catch((err: unknown) => logger.error({ err }, "Wilson backfill failed"));
backfillEmbeddings()
  .then(({ processed, failed }) => {
    if (processed > 0 || failed > 0) logger.info({ processed, failed }, "Embedding backfill complete");
  })
  .catch((err: unknown) => logger.warn({ err }, "Embedding backfill skipped (no OpenAI key?)"));
scheduleDailyFactJob();
initPricingCache().catch((err: unknown) => logger.warn({ err }, "Pricing cache init error"));
runEmailOutboxWorker();
