import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { stripeProcessedEventsTable } from "@workspace/db/schema";
import { desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Richer health endpoint intended for external uptime monitors (UptimeRobot,
// BetterStack, etc). Cheap: one indexed read against stripe_processed_events
// so the uptime check doubles as a webhook-staleness signal. Never fails on
// optional metadata — the metadata being unavailable is reported in-band so
// the monitor still sees a 200 (the API server itself is up).
router.get("/health", async (_req, res) => {
  let lastStripeEvent: { eventId: string; processedAt: string; ageMinutes: number } | null = null;
  let lastStripeEventError: string | null = null;
  try {
    const [row] = await db
      .select()
      .from(stripeProcessedEventsTable)
      .orderBy(desc(stripeProcessedEventsTable.processedAt))
      .limit(1);
    if (row) {
      const processedAt = new Date(row.processedAt);
      lastStripeEvent = {
        eventId: row.eventId,
        processedAt: processedAt.toISOString(),
        ageMinutes: Math.round((Date.now() - processedAt.getTime()) / 60_000),
      };
    }
  } catch (err) {
    lastStripeEventError = err instanceof Error ? err.message : String(err);
  }
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    lastStripeEvent,
    lastStripeEventError,
  });
});

export default router;
