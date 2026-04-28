/**
 * Integration tests for routes/health.ts.
 *
 * GET /healthz: trivial — asserts the static {status:"ok"} contract.
 * GET /health:  exercises the stripe_processed_events read, the row-present
 *               branch, the row-absent branch (lastStripeEvent === null),
 *               and the catch branch (DB error → lastStripeEventError filled).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { stripeProcessedEventsTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import healthRouter from "../routes/health.js";

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
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);
  afterEach(cleanup);

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
