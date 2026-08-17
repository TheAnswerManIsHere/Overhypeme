// Sentry must be the very first import so its hooks register before any other
// module loads. Because we bundle with esbuild, OTel can't intercept express
// via the module loader — but setupExpressErrorHandler in app.ts captures all
// unhandled errors, which is all we need.
import "./instrument";
// MUST stay here, second only to ./instrument: this module asserts required
// production configuration at IMPORT time, so it has to be evaluated before
// the imports below pull in the database-backed module graph. See
// lib/bootChecks.ts for why a call in the body of this file is too late.
import "./lib/bootChecks.js";
import * as Sentry from "@sentry/node";
import { createApp } from "./app";
import { logger } from "./lib/logger";
import { absorbFatalStreamError } from "./lib/stdioGuard";
import { backfillWilsonScores, ensureSchema } from "./lib/seed";
import { runMigrations } from "@workspace/db";
import { backfillEmbeddings } from "./lib/embeddings";
import { refreshPricingCache } from "./lib/falPricing";
import { getConfigString, getConfigInt } from "./lib/adminConfig";
import { attachShutdownHandlers } from "./shutdown";
import { registerEmailHandler } from "./lib/email.js";
import { registerEnrichmentJobHandlers } from "./lib/enrichmentJobs.js";
import { registerImagePromptHandlers } from "./lib/imagePromptJobs.js";
import { registerReviewRenderScenarioHandlers } from "./lib/reviewRenderScenarios.js";
import { registerProjectionRepairHandler } from "./lib/projectionRepairJob.js";
import { registerFactEnrichmentBackfillHandler } from "./lib/factEnrichmentBackfillJob.js";
import { registerFactSendBackHandler } from "./lib/factSendBackJob.js";
import { registerFactPexelsJobHandler } from "./lib/factPexelsJobs.js";
import { registerFactAiMemeBackfillHandler } from "./lib/aiMemeBackfillJobs.js";
import { registerVisualConceptJobHandlers } from "./lib/visualConceptJobs.js";
import { runAsyncJobsWorker } from "./lib/asyncJobs.js";
import { reconcileEngines, ALL_ENGINES } from "./lib/engines";
import { ensureFalConfigured, getFalApiKey } from "./lib/falClient";

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

    // Validate the connected Stripe account matches the expected account ID for this mode.
    // Catches misconfigured API keys early so the wrong account is never silently used.
    const { isLiveMode } = await import("./lib/stripeClient");
    const currentlyLive = await isLiveMode();
    const expectedAccountId = currentlyLive
      ? process.env.STRIPE_ACCOUNT_ID_LIVE
      : process.env.STRIPE_ACCOUNT_ID_TEST;
    if (expectedAccountId) {
      const actualAccountId = await stripeSync.getAccountId();
      if (actualAccountId !== expectedAccountId) {
        logger.error(
          { expected: expectedAccountId, actual: actualAccountId, liveMode: currentlyLive },
          "STRIPE ACCOUNT MISMATCH — API keys are pointing at the wrong account. Check STRIPE_SECRET_KEY_TEST / STRIPE_SECRET_KEY_LIVE in Secrets.",
        );
      } else {
        logger.info({ accountId: actualAccountId, liveMode: currentlyLive }, "Stripe account verified");
      }
    }

    stripeSync.syncBackfill({ object: "all" })
      .then(() => logger.info("Stripe backfill complete"))
      .catch((err: unknown) => logger.error({ err }, "Stripe backfill error"));

  } catch (err) {
    logger.error({ err }, "Stripe init failed — continuing without payments");
  }
}

// The boot-time tier reconciler is gone.
//
// It scanned for "an active subscription row but tier != legendary" and set the
// tier directly — a seventh writer of the field this model derives, and one that
// could only ever UPGRADE. It had no notion of the allowlist, of a lost dispute,
// of a refunded purchase or of an expired grace window, so under the new model it
// would have re-granted access the derivation had just correctly withdrawn.
//
// Its actual job — catching webhook gaps — is what reconciliation does, on a
// cadence, against authoritative Stripe state rather than against local rows.

// ── fal.ai Pricing Cache ────────────────────────────────────────────────────
//
// The pricing cache covers every fal endpoint the platform calls. We seed it
// from three sources, deduped:
//   1. The `fal_active_endpoints` admin_config string (legacy override list).
//   2. The engines table — every active engine's endpoint is automatically
//      included so admins don't have to keep two lists in sync.
//   3. A hardcoded baseline so the cache works even on a fresh DB.
//
// Runtime callers (videoPipelineRunner, etc.) read from this cache via
// getCachedPrice(). fal is the source of truth for pricing — code-side
// `estimatedCostUsdPerSecond` on EngineDefinition is only a fallback for
// when the cache hasn't been populated yet (boot race, new engine just added).
async function resolveActiveEndpoints(): Promise<string[]> {
  const overrideJson = await getConfigString("fal_active_endpoints", "[]");
  let overrideIds: string[] = [];
  try {
    overrideIds = JSON.parse(overrideJson);
    if (!Array.isArray(overrideIds)) overrideIds = [];
  } catch {
    logger.warn({ overrideJson }, "fal_active_endpoints config is not valid JSON — ignoring override list");
    overrideIds = [];
  }
  const engineIds = ALL_ENGINES.map((e) => e.endpointId);
  const baseline = ["fal-ai/flux-pro/v1.1"];
  // Dedupe preserving insertion order.
  return Array.from(new Set([...overrideIds, ...engineIds, ...baseline]));
}

async function initPricingCache(): Promise<void> {
  try {
    const endpointIds = await resolveActiveEndpoints();
    logger.info({ count: endpointIds.length }, "Refreshing fal.ai pricing cache");
    await refreshPricingCache(endpointIds);
    logger.info("fal.ai pricing cache warmed");

    // Schedule hourly refresh from config (default 1h = 3600000ms)
    const intervalMs = await getConfigInt("pricing_refresh_interval_ms", 3_600_000);
    setInterval(async () => {
      try {
        const ids = await resolveActiveEndpoints();
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

// Hourly: purge transient_renders rows older than the configured TTL.
// The job sleeps until the next top-of-hour, runs the purger, then reschedules
// itself. Failures are logged but never crash the server — the audit table
// growing slightly larger for one hour is preferable to a deploy bouncing on
// a transient DB hiccup.
function scheduleTransientRenderPurger() {
  const schedule = () => {
    const now = new Date();
    const nextHour = new Date(now.getTime());
    nextHour.setUTCMinutes(0, 0, 0);
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    const msUntilNext = nextHour.getTime() - now.getTime();
    logger.info({ nextRunAt: nextHour.toISOString(), msUntilNext }, "transient_renders purger scheduled");
    setTimeout(async () => {
      try {
        const { runTransientRenderPurger } = await import("./jobs/transientRenderPurger");
        const result = await runTransientRenderPurger();
        if (result.deleted > 0) logger.info(result, "transient_renders purger run");
      } catch (err) {
        logger.error({ err }, "transient_renders purger failed");
      }
      schedule();
    }, msUntilNext).unref();
  };
  schedule();
}

// Hourly: delete expired `rate_limit_counters` rows in bounded batches.
//
// That table had no production cleanup at all, so the first run after this
// deploys faces the entire accumulated backlog — which is why the purger works
// in batches under a budget rather than one statement. When a run stops on that
// budget with rows still eligible it comes back in a minute instead of an hour,
// so the one-time backlog drains promptly; steady state is one cheap hourly
// pass. Every instance on autoscale runs this, which is safe: batches take
// their rows FOR UPDATE SKIP LOCKED, so concurrent runs divide the work instead
// of serializing on it.
function scheduleRateLimitCounterPurger() {
  const HOURLY_MS = 60 * 60 * 1000;
  const BACKLOG_FOLLOW_UP_MS = 60 * 1000;
  const schedule = (delayMs: number) => {
    setTimeout(async () => {
      let nextDelayMs = HOURLY_MS;
      try {
        const { runRateLimitCounterPurger } = await import("./jobs/rateLimitCounterPurger");
        // The purger logs its own counts; a second log line here would double
        // every run in the output.
        const result = await runRateLimitCounterPurger();
        if (result.budgetExhausted) nextDelayMs = BACKLOG_FOLLOW_UP_MS;
      } catch (err) {
        logger.error({ err }, "rate_limit_counters purge failed");
      }
      schedule(nextDelayMs);
    }, delayMs).unref();
  };
  // Deliberately not at boot — the first minute is the busiest this process
  // ever is, and nothing about this job is urgent to that degree.
  schedule(BACKLOG_FOLLOW_UP_MS);
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

// Configure the fal.ai client once at boot. Every fal-calling code path
// (videoPipelineRunner, falAutoSubtitle, aiMemePipeline, userImageUpload,
// adminEngines, /videos/generate, …) imports from lib/falClient.ts and
// relies on this module-level config rather than calling fal.config()
// individually. Boot fails loudly when the key is missing so we don't
// surface a misleading "Unauthorized" from fal at the first request.
if (getFalApiKey()) {
  ensureFalConfigured();
} else {
  logger.warn(
    "[falClient] FAL_AI_API_KEY not set — fal.ai integration disabled. " +
      "Image/video generation routes will return 503 until the key is provided.",
  );
}

// Bind the port now — deployment health checks can pass immediately.
const app = createApp();
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
  // Stream-teardown errors on stdout/stderr are not application bugs — they
  // happen when the parent pipe goes away (workflow restart, terminal
  // disconnect, container log-pipe overrun). The stdio guard absorbs them
  // when emitted as async `error` events, but a synchronous throw from a TTY
  // write can still land here. absorbFatalStreamError() reports the first
  // occurrence to Sentry and returns true so we skip process.exit and keep
  // serving requests.
  const absorbed = absorbFatalStreamError(err, { kind }, {
    captureException: (e, ctx) => Sentry.captureException(e, ctx),
    warn: (obj, msg) => logger.warn(obj, msg),
  });
  if (absorbed) return;

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
// Grace convergence + authoritative reconciliation. The first is cosmetic if it
// dies (the read path already enforces the deadline); the second is this model's
// answer to "regardless of whether the event arrives at all".
import("./lib/membershipSchedules")
  .then((m) => m.scheduleMembershipJobs())
  .catch((err: unknown) => logger.error({ err }, "Membership job scheduling failed"));
backfillWilsonScores().catch((err: unknown) => logger.error({ err }, "Wilson backfill failed"));
backfillEmbeddings()
  .then(({ processed, failed }) => {
    if (processed > 0 || failed > 0) logger.info({ processed, failed }, "Embedding backfill complete");
  })
  .catch((err: unknown) => logger.warn({ err }, "Embedding backfill skipped (no OpenAI key?)"));
scheduleDailyFactJob();
scheduleTransientRenderPurger();
scheduleRateLimitCounterPurger();
// Engines: reconcile the typed code catalogue into the DB before pricing
// cache so the active engines drive the cache refresh.
reconcileEngines()
  .then((result) =>
    logger.info(result, "Engine reconciliation complete"),
  )
  .catch((err: unknown) => logger.error({ err }, "Engine reconciliation failed"))
  .finally(() => {
    initPricingCache().catch((err: unknown) =>
      logger.warn({ err }, "Pricing cache init error"),
    );
  });
// Register all async-job handlers before starting the worker. New queues
// (future fal_*) call their own register* function here.
registerEmailHandler();
registerEnrichmentJobHandlers();
registerImagePromptHandlers();
registerProjectionRepairHandler();
registerFactEnrichmentBackfillHandler();
registerFactSendBackHandler();
registerFactPexelsJobHandler();
registerFactAiMemeBackfillHandler();
registerReviewRenderScenarioHandlers();
registerVisualConceptJobHandlers();
runAsyncJobsWorker();
