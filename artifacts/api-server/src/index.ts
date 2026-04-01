import app from "./app";
import { logger } from "./lib/logger";
import { ensureSchema, backfillWilsonScores } from "./lib/seed";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
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
  } catch (err) {
    logger.error({ err }, "Stripe init failed — continuing without payments");
  }
}

await initStripe();

// Ensure all schema columns exist — safe to run on every boot (ADD COLUMN IF NOT EXISTS)
await ensureSchema().catch((err: unknown) => logger.error({ err }, "Schema migration failed"));

// Backfill Wilson scores for any facts that have votes but no score yet
await backfillWilsonScores().catch((err: unknown) => logger.error({ err }, "Wilson backfill failed"));

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});
