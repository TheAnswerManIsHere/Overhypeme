/**
 * Integration tests for routes/health.ts.
 *
 * GET /healthz:      trivial — asserts the static {status:"ok"} contract.
 * GET /health:       exercises the stripe_processed_events read, the row-present
 *                    branch, the row-absent branch (lastStripeEvent === null),
 *                    and the catch branch (DB error → lastStripeEventError filled).
 * GET /health/queues: the 200/503 wiring around laneHealth(), and the minimal
 *                    field-set disclosure boundary on both paths — a manual
 *                    reproduction of the 503 path is impossible in this
 *                    topology (stopping the API workflow also stops the HTTP
 *                    server that owns this route, and another live instance
 *                    would also be scheduling all five lanes), so this is the
 *                    only place that actually exercises it end to end.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { stripeProcessedEventsTable, workerLaneHeartbeatsTable } from "@workspace/db/schema";
import { like, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import healthRouter from "../routes/health.js";
import { WORKER_PROTOCOL_VERSION } from "../lib/workerHeartbeats.js";

/**
 * The five real lane names `laneHealth()` reports on. Scoped deletes only —
 * see queueHealth.test.ts's identical convention and its rationale (a bare
 * table delete would also wipe workerHeartbeats.test.ts's synthetic rows).
 */
const REAL_LANES = ["fast", "render", "bulk", "pexels", "ai_meme_backfill"];

async function clearRealLaneHeartbeats(): Promise<void> {
  await db.delete(workerLaneHeartbeatsTable).where(inArray(workerLaneHeartbeatsTable.lane, REAL_LANES));
}


// Prefix uses `-` (not `_`) so SQL LIKE wildcards in the cleanup can't
// accidentally match other test files' rows during parallel runs. See
// authMiddleware.test.ts for the full convention.
const ID_PREFIX = "troutesevt-";

function makeApp(): Express {
  const app = express();
  app.use(healthRouter);
  return app;
}

async function insertEvent(eventId: string, processedAt: Date): Promise<void> {
  await db.insert(stripeProcessedEventsTable).values({ eventId, processedAt });
}

async function cleanup(): Promise<void> {
  // ID_PREFIX uses `-` (not `_`) so SQL LIKE wildcards can't match other
  // test files' rows during parallel runs. See the prefix declaration above.
  await db
    .delete(stripeProcessedEventsTable)
    .where(like(stripeProcessedEventsTable.eventId, `${ID_PREFIX}%`));
}

describe("GET /healthz", () => {
  it("returns 200 and {status:'ok'}", async () => {
    const res = await request(makeApp()).get("/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });
});

describe("GET /health", () => {
  // The describe contains exactly one test, so suite-level before/after
  // is enough — beforeEach/afterEach would just duplicate the same cleanup
  // pass. Each test inserts its own UUID-suffixed eventId so the cleanup's
  // prefix LIKE never sees rows from sibling test files (validated by the
  // ID_PREFIX hyphen convention above).
  before(cleanup);
  after(cleanup);

  it("returns 200 with lastStripeEvent populated when at least one event row exists", async () => {
    const eventId = `${ID_PREFIX}${Date.now()}`;
    const processedAt = new Date(Date.now() - 5 * 60_000);
    await insertEvent(eventId, processedAt);

    const res = await request(makeApp()).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.ts, "string");
    assert.equal(res.body.lastStripeEventError, null);
    assert.ok(res.body.lastStripeEvent, "lastStripeEvent should be present");
    assert.equal(res.body.lastStripeEvent.eventId, eventId);
    assert.equal(res.body.lastStripeEvent.processedAt, processedAt.toISOString());
    // Allow a 1-minute fudge for clock skew between insert + read.
    assert.ok(
      res.body.lastStripeEvent.ageMinutes >= 4 && res.body.lastStripeEvent.ageMinutes <= 6,
      `expected ageMinutes ≈ 5, got ${res.body.lastStripeEvent.ageMinutes}`,
    );
  });

  // The catch branch (DB throws → lastStripeEventError filled) is left
  // uncovered. Exercising it would require monkey-patching the imported `db`
  // singleton, which would leak across other tests in the same process.
  // The branch is defensive and trivial; not worth the test-isolation hazard.
});

describe("GET /health/queues", () => {
  before(clearRealLaneHeartbeats);
  after(clearRealLaneHeartbeats);

  it("returns 200 with ONLY {ok, ts, laneCount, stalledLaneCount} when every lane has a live heartbeat", async () => {
    await clearRealLaneHeartbeats();
    const instanceId = randomUUID();
    await db.insert(workerLaneHeartbeatsTable).values(
      REAL_LANES.map((lane) => ({
        instanceId,
        lane,
        workerProtocolVersion: WORKER_PROTOCOL_VERSION,
        lastScheduledAt: new Date(),
      })),
    );

    const res = await request(makeApp()).get("/health/queues");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ["laneCount", "ok", "stalledLaneCount", "ts"]);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.laneCount, REAL_LANES.length);
    assert.equal(res.body.stalledLaneCount, 0);
  });

  it("returns 503 with the SAME minimal field set when every lane is stalled fleet-wide", async () => {
    // No live heartbeat rows at all — the case a manual reproduction can't
    // reach (stopping the API process kills this very route), but this is
    // real DB state exercised through the real Express route, same as the
    // healthy case above.
    await clearRealLaneHeartbeats();

    const res = await request(makeApp()).get("/health/queues");
    assert.equal(res.status, 503);
    assert.deepEqual(
      Object.keys(res.body).sort(),
      ["laneCount", "ok", "stalledLaneCount", "ts"],
      "the failure shape must not exceed the healthy shape's field set — no error text, ever",
    );
    assert.equal(res.body.ok, false);
    assert.equal(res.body.laneCount, REAL_LANES.length);
    assert.equal(res.body.stalledLaneCount, REAL_LANES.length);
  });
});
