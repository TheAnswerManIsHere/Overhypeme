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
import { stripeDriver } from "./lib/stripeDriver.js";
import { absorbFatalStreamError } from "./lib/stdioGuard";
import { backfillWilsonScores, ensureSchema } from "./lib/seed";
import { runMigrations } from "@workspace/db";
import { reportAuditBoundary, runMigrationsReporting } from "./lib/auditBoundaryReport";
import { backfillEmbeddings } from "./lib/embeddings";
import { refreshPricingCache } from "./lib/falPricing";
import { getConfigString, getConfigInt } from "./lib/adminConfig";
import { beginTaskMonitoring } from "./lib/recurringTasks";
import { msUntilNextTopOfHour, scheduleRecurringTask } from "./lib/taskScheduler";
import { factOfTheDayStep, msUntilNextSend } from "./jobs/factOfTheDay";
import { attachShutdownHandlers } from "./shutdown";
import { registerEmailHandler } from "./lib/email.js";
import { registerEnrichmentJobHandlers } from "./lib/enrichmentJobs.js";
import { registerReadingJobHandlers } from "./lib/readingJobs.js";
import { registerImagePromptHandlers } from "./lib/imagePromptJobs.js";
import { registerComparisonHandlers } from "./lib/comparison/runs.js";
import { registerGagFoldHandler } from "./lib/gags/foldJob.js";
import { registerVisualConceptJobHandlers } from "./lib/visualConceptJobs.js";
import { registerGagPrefillJobHandler } from "./lib/gags/prefill.js";
import { registerOperationsDrillHandler } from "./lib/operationsDrill.js";
import { runAsyncJobsWorker } from "./lib/asyncJobs.js";
import { ALL_ENGINES } from "./lib/engines";
import { ensureFalConfigured, getFalApiKey } from "./lib/falClient";
import { runStripeBootVerification, startStripeAfterBoot } from "./lib/stripeInit.js";

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
// Without a mode's webhook signing secret every delivery in that mode is
// REFUSED — there is no fallback to the managed-webhook row any more (launch
// Phase 15, increment 4) — and Stripe setup reports the mode as not set up.
// The secret-key check is also a warning rather than fatal so the server can
// still boot for non-Stripe routes; getCredentials() throws when invoked.
// The fake driver holds no credentials by design (#566), so it gets one info
// line instead of warnings describing a misconfiguration that is not there.
const isFakeStripe = stripeDriver().kind === "fake";
const stripePresence = stripeDriver().credentialPresence();
if (isFakeStripe) {
  logger.info("Stripe: the FAKE driver is selected (STRIPE_BACKEND=fake-double) — test mode only, no real account");
}
const missingStripeSecretVars: string[] = [];
if (!isFakeStripe && !stripePresence.secretKeyTest) missingStripeSecretVars.push("STRIPE_SECRET_KEY_TEST");
if (!isFakeStripe && !stripePresence.secretKeyLive) missingStripeSecretVars.push("STRIPE_SECRET_KEY_LIVE");
if (missingStripeSecretVars.length > 0) {
  logger.warn(
    { missing: missingStripeSecretVars },
    "Missing Stripe secret-key env var(s) — Stripe calls in the affected mode will throw until they are set.",
  );
}

const missingWebhookSecretVars: string[] = [];
if (!isFakeStripe && !stripePresence.webhookSecretTest) missingWebhookSecretVars.push("STRIPE_WEBHOOK_SECRET_TEST");
if (!isFakeStripe && !stripePresence.webhookSecretLive) missingWebhookSecretVars.push("STRIPE_WEBHOOK_SECRET_LIVE");
if (!isFakeStripe && !stripePresence.webhookEndpointTest) missingWebhookSecretVars.push("STRIPE_WEBHOOK_ENDPOINT_ID_TEST");
if (!isFakeStripe && !stripePresence.webhookEndpointLive) missingWebhookSecretVars.push("STRIPE_WEBHOOK_ENDPOINT_ID_LIVE");
if (missingWebhookSecretVars.length > 0) {
  logger.warn(
    { missing: missingWebhookSecretVars },
    "Missing Stripe webhook env var(s) — the affected mode(s) are not set up: without a signing secret every delivery is refused, and without an endpoint id Stripe setup cannot check the endpoint. The operator provisions one endpoint per environment and mode in Stripe and sets both, unsynced per environment.",
  );
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

// Every recurring task below runs on the shared scheduler (lib/taskScheduler.ts):
// its first run comes when the inventory says (recurringTasks.ts, firstRunMs),
// a failed run or an unrecorded completion is tried again in minutes, and
// otherwise it waits its cadence. Each task here is safe to run again soon.
const HOURLY_MS = 60 * 60 * 1000;

// The fal.ai pricing cache: warmed at boot (the first run, at once), then
// refreshed on the configured interval (default one hour).
async function initPricingCache(): Promise<void> {
  let intervalMs = 3_600_000;
  try {
    intervalMs = await getConfigInt("pricing_refresh_interval_ms", 3_600_000);
  } catch (err) {
    logger.warn({ err }, "fal.ai pricing refresh interval unreadable — using one hour");
  }
  scheduleRecurringTask({
    cadenceMs: intervalMs,
    steps: [
      {
        id: "pricing_refresh",
        run: async () => {
          const ids = await resolveActiveEndpoints();
          await refreshPricingCache(ids);
          logger.info({ count: ids.length }, "fal.ai pricing cache refreshed");
        },
        failureMessage: "fal.ai pricing cache refresh failed — continuing on the cache it has",
      },
    ],
  });
}

// Hourly at the top of the hour: purge transient_renders rows older than the
// configured TTL, and image provenance past its retention (a no-op while that
// setting is 0). Also once a couple of minutes after a start, so a restart
// that straddles the top of the hour never skips an hour's run.
function scheduleTransientRenderPurger() {
  scheduleRecurringTask({
    cadenceMs: HOURLY_MS,
    nextMarkMs: () => msUntilNextTopOfHour(),
    steps: [
      {
        id: "transient_render_purge",
        run: async () => {
          const { runTransientRenderPurger } = await import("./jobs/transientRenderPurger");
          const result = await runTransientRenderPurger();
          if (result.deleted > 0) logger.info(result, "transient_renders purger run");
        },
        failureMessage: "transient_renders purger failed",
      },
      {
        id: "provenance_retention_purge",
        run: async () => {
          const { runProvenanceRetentionPurge } = await import("./jobs/provenanceRetentionPurger");
          await runProvenanceRetentionPurge();
        },
        failureMessage: "image provenance retention purge failed",
      },
    ],
  });
}

// Hourly: delete expired `rate_limit_counters` rows in bounded batches. A run
// that stops on its budget with rows still eligible comes back in a minute,
// so a backlog drains promptly. Safe on several instances at once: batches
// take their rows FOR UPDATE SKIP LOCKED.
// Every minute: settle members' AI pictures that will not be delivered (failed,
// abandoned or stranded), returning their credits. Settlement never waits on
// the queue's best-effort abandonment hook (launch Phase 7, increment 2).
function scheduleMemberPictureSettlement() {
  scheduleRecurringTask({
    cadenceMs: 60_000,
    steps: [
      {
        id: "member_picture_settlement",
        run: async () => {
          const { runMemberPictureSettlementPass } = await import("./lib/memberPictures/settlement");
          await runMemberPictureSettlementPass();
        },
        failureMessage: "member picture settlement pass failed",
      },
    ],
  });
}

function scheduleRateLimitCounterPurger() {
  scheduleRecurringTask({
    cadenceMs: HOURLY_MS,
    steps: [
      {
        id: "rate_limit_counter_purge",
        run: async () => {
          const { runRateLimitCounterPurger } = await import("./jobs/rateLimitCounterPurger");
          // The purger logs its own counts.
          const result = await runRateLimitCounterPurger();
          return result.budgetExhausted ? { followUpMs: 60 * 1000 } : undefined;
        },
        failureMessage: "rate_limit_counters purge failed",
      },
    ],
  });
}

// Hourly: remove the photos, generated images and memes their owners deleted
// more than the restore window ago (jobs/contentPurger.ts). Safe on several
// instances at once: each row is claimed under its owner's lock and re-read.
function scheduleContentPurger() {
  scheduleRecurringTask({
    cadenceMs: HOURLY_MS,
    steps: [
      {
        id: "content_purge",
        run: async () => {
          const { runContentPurger } = await import("./jobs/contentPurger");
          await runContentPurger();
        },
        failureMessage: "[content-purger] run failed",
      },
      {
        // Picture files still on the durable cleanup list (lib/storedFileDeletions.ts):
        // retried until gone. A batch a run; a run that leaves a full batch
        // comes back in a minute, so a backlog drains promptly.
        id: "stored_file_cleanup",
        run: async () => {
          const { runStoredFileCleanup } = await import("./lib/storedFileDeletions");
          const result = await runStoredFileCleanup();
          return result.deleted >= 200 ? { followUpMs: 60 * 1000 } : undefined;
        },
        failureMessage: "[stored-file-deletions] sweep failed",
      },
    ],
  });
}

// Hourly: fill what fal billed for each gag render (lib/renderBilling.ts),
// with the billing-read key, so viewing a render's history calls nobody. Its
// own timer: a fal outage retries this alone, not its neighbours.
function scheduleRenderBillingFill() {
  scheduleRecurringTask({
    cadenceMs: HOURLY_MS,
    steps: [
      {
        id: "render_billing_fill",
        run: async () => {
          const { runRenderBillingFill } = await import("./lib/renderBilling");
          await runRenderBillingFill();
        },
        failureMessage: "[render-billing] fill failed",
      },
    ],
  });
}

// Hourly (and a few minutes after a start): fill the duplicate fingerprint of
// every approved fact that lacks one, live or deactivated, a bounded batch a
// run (plan PLAN_FACT_LIFECYCLE_REBUILD.md 2C: "Missing fingerprints are
// filled automatically; nothing else runs on its own"). A fact whose embedding
// fails is logged and tried again next run; the run itself completes.
function scheduleFingerprintFill() {
  scheduleRecurringTask({
    cadenceMs: HOURLY_MS,
    steps: [
      {
        id: "fingerprint_fill",
        run: async () => {
          const { processed, failed } = await backfillEmbeddings();
          if (processed > 0 || failed > 0) logger.info({ processed, failed }, "Duplicate fingerprint fill run");
        },
        failureMessage: "duplicate fingerprint fill failed",
      },
    ],
  });
}

// Hourly: advance every pending account deletion (lib/accountDeletion.ts).
// Safe on several instances at once: every stage is a compare-and-set, and the
// purge runs under the owner's lock.
function scheduleAccountDeletionWorker() {
  scheduleRecurringTask({
    cadenceMs: HOURLY_MS,
    steps: [
      {
        id: "account_deletion",
        run: async () => {
          const { runAccountDeletionWorker } = await import("./lib/accountDeletion");
          await runAccountDeletionWorker();
        },
        failureMessage: "[account-deletion] worker run failed",
      },
    ],
  });
}

// Hourly: delete expired sign-in sessions (lib/sessionSweep.ts), and the
// retention windows' expired rows (lib/dataLifecycle.ts). The daily
// maintenance call runs both too. Safe on several instances at once: the
// session sweep takes its rows SKIP LOCKED, and the windows' deletes are
// idempotent. One failing does not stop the other.
function scheduleSessionAndRetentionWindowJobs() {
  scheduleRecurringTask({
    cadenceMs: HOURLY_MS,
    steps: [
      {
        id: "session_sweep",
        run: async () => {
          const { sweepExpiredSessions } = await import("./lib/sessionSweep");
          const result = await sweepExpiredSessions();
          if (result.deleted > 0) logger.info(result, "[session-sweep] run");
        },
        failureMessage: "[session-sweep] run failed",
      },
      {
        id: "retention_windows",
        run: async () => {
          const { runRetentionWindowJobs } = await import("./lib/dataLifecycle");
          const result = await runRetentionWindowJobs();
          if (Object.values(result).some((n) => n > 0)) logger.info(result, "[retention-windows] run");
        },
        failureMessage: "[retention-windows] run failed",
      },
    ],
  });
}

// Once per boot, a couple of minutes in: bake every recipe meme saved before
// memes were baked at save (launch Phase 5, plan S16; lib/memeBake.ts). A
// no-op once every meme is a file, and safe on several instances at once: a
// file already stored counts as baked, and baked_at is set only when null.
function scheduleMemeBakeBackfill() {
  setTimeout(async () => {
    try {
      const { backfillMemeBakes } = await import("./lib/memeBake");
      const counts = await backfillMemeBakes();
      if (counts.selected > 0) logger.info(counts, "[meme-bake] backfill");
    } catch (err) {
      logger.error({ err }, "[meme-bake] backfill failed");
    }
  }, 2 * 60 * 1000).unref();
}

// Hourly, in the published deployment only: one media-backup pair (the
// database point and the media states it needs), and once a day the backup's
// expiry (jobs/mediaBackupJob.ts). A retry is safe: the capture takes an
// advisory lock and skips when a recent pair exists.
function scheduleMediaBackup() {
  // Said once at boot, loudly when a published deployment has no backup: every
  // photo delete and ACL change is then refused (lib/mediaBackup/config.ts).
  import("./lib/mediaBackup/config")
    .then(({ preservation }) => {
      const p = preservation();
      if (p.mode === "unavailable") logger.error({ reason: p.reason }, "[media-backup] not configured: photo deletes and access changes are refused until it is");
      else logger.info({ mode: p.mode }, "[media-backup] preservation");
    })
    .catch((err: unknown) => logger.error({ err }, "[media-backup] misconfigured: photo deletes and access changes will fail"));
  if (process.env.REPLIT_DEPLOYMENT !== "1") return;
  scheduleRecurringTask({
    cadenceMs: HOURLY_MS,
    steps: [
      {
        id: "media_backup",
        run: async () => {
          const { runScheduledMediaBackup } = await import("./jobs/mediaBackupJob");
          const outcome = await runScheduledMediaBackup();
          // A skip is a completed run that had nothing to do.
          if (outcome.startsWith("skipped")) logger.info({ outcome }, "[media-backup] capture");
        },
        failureMessage: "[media-backup] capture failed",
      },
    ],
  });
}

// Daily at 09:00 UTC, and a few minutes after a start: Fact of the Day.
// runDailyFactOfTheDay queues the day's emails and writes the day's mark in one
// transaction, so the scheduler's retry after a failure, its catch-up after a
// start and the jobs route never email anyone twice (Issue #1092).
function scheduleDailyFactJob() {
  scheduleRecurringTask({
    cadenceMs: 24 * HOURLY_MS,
    nextMarkMs: () => msUntilNextSend(),
    steps: [factOfTheDayStep()],
  });
}

// ── Startup sequence ─────────────────────────────────────────────────────────
// Only the two DB steps run before listen() so the port opens in seconds.
// Everything else (Stripe, membership reconcile, backfills) runs in the
// background and does not block port binding.

// Apply any pending database migrations before accepting requests. The wrapper names any
// application object the app's login does not own (Replit's publish creates new tables as
// the database owner), first and beside a failure (Launch Phase 15, 5b).
await runMigrationsReporting(runMigrations);

// Idempotent schema & config seed (ADD COLUMN IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING)
await ensureSchema();

// One [audit-boundary] line: whether the NCMEC ledger's privilege boundary holds on this
// connection. A bad state alerts in a deployment and never stops the start (Q15 → 1), so
// the port does not wait for it; it never throws.
void reportAuditBoundary();

// Configure the fal.ai client once at boot. Every fal-calling code path
// (videoPipelineRunner, falAutoSubtitle, aiMemePipeline, userImageUpload,
// the comparison runs, …) imports from lib/falClient.ts and
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

// ── The Stripe account guard's boot phase ────────────────────────────────────
// This is deliberately the LAST thing before the port is bound, and its
// position is the requirement — not "outside initStripe()", not "earlier in the
// file". A confirmed wrong account must never serve a request, and a process
// that binds its port and then exits is a crash loop that serves requests in
// between. See lib/stripeInit.ts.
//
// It is bounded by a timeout, so an unreachable Stripe delays boot by at most
// that bound rather than blocking it: only a CONFIRMED mismatch is fatal.
const stripeBootOutcome = await runStripeBootVerification();
if (stripeBootOutcome.kind === "fatal") {
  logger.error(
    { reason: stripeBootOutcome.reason },
    "REFUSING TO START — the Stripe credentials do not belong to the account this environment declared. No Stripe mutation was attempted and the port was never bound.",
  );
  process.exit(1);
}

// Bind the port now — deployment health checks can pass immediately.
const app = createApp();
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  // Load the watermark marker now (under half a second) rather than on the first meme; a failure here is logged and
  // the first meme retries the load, refusing to send the meme if it still fails (image tracing, #912).
  void import("./lib/provenance/watermark")
    .then((m) => m.warmWatermarkMarker())
    .then(() => logger.info("[provenance] watermark marker loaded"))
    .catch((err) => logger.error({ err }, "[provenance] watermark marker failed to load"));
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
//
// The Stripe REFUSAL is no longer one of them: it was decided above, before the
// port was bound. What is left here is the remaining initialization (webhook
// registration, then backfill), which runs only for a verified account — or the
// retry loop, when the boot answer was indefinite.
startStripeAfterBoot(stripeBootOutcome);
// Grace convergence + authoritative reconciliation. The first is cosmetic if it
// dies (the read path already enforces the deadline); the second is this model's
// answer to "regardless of whether the event arrives at all".
import("./lib/membershipSchedules")
  .then((m) => m.scheduleMembershipJobs())
  .catch((err: unknown) => logger.error({ err }, "Membership job scheduling failed"));
backfillWilsonScores().catch((err: unknown) => logger.error({ err }, "Wilson backfill failed"));
scheduleFingerprintFill();
// When monitoring of each recurring task began (launch Phase 16): the health
// check's reference for a task that has not completed a run yet.
void beginTaskMonitoring();
// The render-approval boundary (lib/renderApprovalAudit.ts): set once, by the
// first boot of the release that records approvals with their pick.
void import("./lib/renderApprovalAudit").then((m) => m.markRenderApprovalAuditBoundary());
scheduleDailyFactJob();
scheduleTransientRenderPurger();
scheduleMemberPictureSettlement();
scheduleRateLimitCounterPurger();
scheduleContentPurger();
scheduleRenderBillingFill();
scheduleAccountDeletionWorker();
scheduleSessionAndRetentionWindowJobs();
scheduleMediaBackup();
scheduleMemeBakeBackfill();
// Engines live in the code catalogue (decisions.md 2026-11-14); the pricing
// cache warms from it directly.
initPricingCache().catch((err: unknown) =>
  logger.warn({ err }, "Pricing cache init error"),
);
// Register all async-job handlers before starting the worker. New queues
// (future fal_*) call their own register* function here.
registerEmailHandler();
registerEnrichmentJobHandlers();
registerReadingJobHandlers();
registerImagePromptHandlers();
registerGagFoldHandler();
registerComparisonHandlers();
registerVisualConceptJobHandlers();
registerGagPrefillJobHandler();
registerOperationsDrillHandler();
runAsyncJobsWorker();
