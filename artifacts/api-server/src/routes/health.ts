import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { stripeProcessedEventsTable } from "@workspace/db/schema";
import { desc } from "drizzle-orm";
import { laneHealth } from "../lib/queueHealth";
import { logger } from "../lib/logger";

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

/**
 * Unauthenticated worker-liveness probe for an external monitor.
 *
 * This route dies with the process like any other — it does not itself
 * survive anything. What makes it the right thing to point a monitor at is
 * that an in-process watchdog can never detect its own absence, so only an
 * *external* caller polling this endpoint can turn total process death into
 * a signal (a connection failure), closing the blind spot the alerting built
 * in later phases would otherwise have. While the process IS up, it also
 * adds a meaningful non-200 no other endpoint has: 503 when every worker has
 * stopped scheduling a lane fleet-wide. Point any uptime monitor here.
 *
 * **Mounted under `/api`** (`app.ts`: `app.use("/api", router)`), so the real
 * path is `/api/health/queues`, not the bare route path below — a monitor
 * configured against the wrong one silently never checks anything.
 *
 * Two deliberate constraints:
 *
 * 1. **It leaks nothing.** No queue names, no payloads, no error text, no
 *    instance ids — only a status code and per-lane counts. It is reachable
 *    without auth, so anything richer would be a disclosure surface, and the
 *    detail belongs on the authenticated page anyway.
 * 2. **A lane is unhealthy only when it is stalled FLEET-WIDE.** Not "any stale
 *    heartbeat": on an autoscaled deployment one instance pausing or scaling
 *    down while another keeps scheduling the lane is completely normal, and
 *    reporting that as an outage would page an operator for a healthy fleet —
 *    training them to ignore the page, which is worse than not having it.
 */
router.get("/health/queues", async (_req, res) => {
  try {
    const lanes = await laneHealth();
    const stalled = lanes.filter((l) => l.stalled);
    res.status(stalled.length > 0 ? 503 : 200).json({
      ok: stalled.length === 0,
      ts: new Date().toISOString(),
      laneCount: lanes.length,
      stalledLaneCount: stalled.length,
    });
  } catch (err) {
    // A failure to *evaluate* health is itself unhealthy — reporting 200 here
    // would be the looks-fine-while-broken shape this endpoint exists to catch.
    // The response still carries NO error text — that stays server-side in the
    // log line above — so the failure shape never exceeds the same minimal
    // field set as the healthy one.
    logger.error({ err }, "[health] queue liveness evaluation failed");
    res.status(503).json({ ok: false, ts: new Date().toISOString(), laneCount: 0, stalledLaneCount: 0 });
  }
});

export default router;
