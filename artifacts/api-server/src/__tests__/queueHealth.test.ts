import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { asyncJobsTable, workerLaneHeartbeatsTable } from "@workspace/db/schema";
import { inArray, like } from "drizzle-orm";

import {
  deriveDisplayStatus,
  sanitizeSkipReason,
  staleThresholdMs,
  laneHealth,
  queueHealth,
  queueHealthJobs,
} from "../lib/queueHealth.js";
import { WORKER_PROTOCOL_VERSION } from "../lib/workerHeartbeats.js";
import { __resetHandlersForTest, registerJobHandler, type JobHandler } from "../lib/asyncJobs.js";

const QUEUE_PREFIX = "test_qh_";
const okHandler: JobHandler = { async run() { return { ok: true }; } };

/**
 * The five real lane names.
 *
 * `laneHealth` reports exactly `ALL_LANES`, so the lane tests below cannot use
 * synthetic names — they have to write rows for the real lanes, which makes the
 * heartbeat table shared, order-sensitive state. Each lane test therefore clears
 * *these* rows before it runs rather than trusting cleanup from a previous test.
 *
 * Scoped to these five deliberately: a bare `delete(workerLaneHeartbeatsTable)`
 * would also wipe the `test_lane_*` rows workerHeartbeats.test.ts is asserting
 * on, which is exactly the cross-file failure this replaces.
 */
const REAL_LANES = ["fast", "render", "bulk", "pexels", "ai_meme_backfill"];

async function clearRealLaneHeartbeats(): Promise<void> {
  await db.delete(workerLaneHeartbeatsTable).where(inArray(workerLaneHeartbeatsTable.lane, REAL_LANES));
}

function testQueue(): string {
  return `${QUEUE_PREFIX}${randomUUID().slice(0, 8)}`;
}

async function cleanup(): Promise<void> {
  await db.delete(asyncJobsTable).where(like(asyncJobsTable.queue, `${QUEUE_PREFIX}%`));
  await clearRealLaneHeartbeats();
}

describe("queueHealth — derived statuses", () => {
  it("derives `skipped` from a terminal-ok row whose handler did nothing", () => {
    // async_jobs has no `skipped` status: a skip finishes as `done`. The UI
    // contract makes "skipped" first-class and forbids collapsing it into a
    // checkmark, so it has to be derived or it is unreachable.
    const { displayStatus, skipReason } = deriveDisplayStatus(
      { status: "done", result: { skipped: true, reason: "not_active" }, attempts: 1 },
      5,
    );
    assert.equal(displayStatus, "skipped");
    assert.equal(skipReason, "not_active");
  });

  it("leaves an ordinary success as `done`", () => {
    const { displayStatus } = deriveDisplayStatus(
      { status: "done", result: { factId: 1 }, attempts: 1 },
      5,
    );
    assert.equal(displayStatus, "done");
  });

  it("derives `abandoned_no_retry` only when the effective ceiling is one attempt", () => {
    // fact_ai_meme_backfill is configured never to retry, so its failures are
    // `failed` after a single attempt — a different operator story from
    // "exhausted five attempts", and indistinguishable without this.
    const neverRetried = deriveDisplayStatus({ status: "failed", result: null, attempts: 1 }, 1);
    assert.equal(neverRetried.displayStatus, "abandoned_no_retry");

    const exhausted = deriveDisplayStatus({ status: "failed", result: null, attempts: 5 }, 5);
    assert.equal(exhausted.displayStatus, "failed");
  });

  it("sanitizes skip reasons against the closed set", () => {
    assert.equal(sanitizeSkipReason("not_active"), "not_active");
    assert.equal(sanitizeSkipReason("admin_edited"), "admin_edited");
    // A handler can put anything in `result`. An admin surface must not echo it.
    assert.equal(sanitizeSkipReason("Resend said: <script>alert(1)</script>"), "other");
    assert.equal(sanitizeSkipReason(undefined), null);
    assert.equal(sanitizeSkipReason(42), null);
  });
});

describe("queueHealth — lane liveness", () => {
  afterEach(async () => {
    __resetHandlersForTest();
    await cleanup();
  });

  it("floors the stale threshold at 60s so the fast lane cannot false-alarm", () => {
    // fast polls every 2s; 3× that is 6s, which ordinary scheduler jitter or a
    // brief event-loop pause would breach on a perfectly healthy lane.
    assert.equal(staleThresholdMs(2_000), 60_000);
    assert.equal(staleThresholdMs(60_000), 180_000);
  });

  it("reports a lane healthy when ONE instance is stale but another is scheduling it", async () => {
    // The discriminating case. "Any stale heartbeat" would call this an outage;
    // on an autoscaled deployment it is a routine scale-down next to a healthy
    // peer. A test that only checked the fully-dead case would pass against
    // both the right and the wrong implementation.
    await clearRealLaneHeartbeats();
    const staleInstance = randomUUID();
    const liveInstance = randomUUID();
    await db.insert(workerLaneHeartbeatsTable).values([
      {
        instanceId: staleInstance,
        lane: "bulk",
        workerProtocolVersion: WORKER_PROTOCOL_VERSION,
        lastScheduledAt: new Date(Date.now() - 10 * 60_000),
      },
      {
        instanceId: liveInstance,
        lane: "bulk",
        workerProtocolVersion: WORKER_PROTOCOL_VERSION,
        lastScheduledAt: new Date(),
      },
    ]);

    const lanes = await laneHealth(db, 15);
    const bulk = lanes.find((l) => l.lane === "bulk");
    assert.equal(bulk?.stalled, false, "one healthy instance keeps the lane healthy");
    assert.equal(bulk?.liveInstanceCount, 2, "both rows are inside the 15-minute TTL");
  });

  it("reports a lane stalled when no live instance has scheduled it", async () => {
    await clearRealLaneHeartbeats();
    const lanes = await laneHealth(db, 15);
    assert.ok(lanes.length === 5, "all five lanes are always reported");
    assert.ok(lanes.every((l) => l.stalled), "with no heartbeats at all, every lane is stalled");
    assert.ok(lanes.every((l) => l.liveInstanceCount === 0));
  });

  it("excludes departed instances from the verdict before aggregating", async () => {
    // A row past the TTL must not be able to decide the lane's state — otherwise
    // the first-ever scale-down would leave a lane looking permanently stalled.
    await clearRealLaneHeartbeats();
    await db.insert(workerLaneHeartbeatsTable).values({
      instanceId: randomUUID(),
      lane: "pexels",
      workerProtocolVersion: WORKER_PROTOCOL_VERSION,
      lastScheduledAt: new Date(Date.now() - 60 * 60_000),
    });

    const lanes = await laneHealth(db, 15);
    const pexels = lanes.find((l) => l.lane === "pexels");
    assert.equal(pexels?.liveInstanceCount, 0, "a departed instance is not live");
    assert.equal(pexels?.stalled, true);
  });
});

describe("queueHealth — aggregate and per-item altitudes agree", () => {
  afterEach(async () => {
    __resetHandlersForTest();
    await cleanup();
  });

  it("counts a handler-level skip at BOTH altitudes", async () => {
    // The failure mode this guards: a derived status that is right in the row
    // detail and missing from the aggregate tally (or vice versa) — which is
    // exactly how the plan's first attempt at this was wrong.
    const queue = testQueue();
    registerJobHandler(queue, okHandler, { lane: "bulk" });
    await db.insert(asyncJobsTable).values({
      queue,
      payload: {},
      status: "done",
      result: { skipped: true, reason: "not_active" },
    });

    const agg = (await queueHealth(db)).find((q) => q.queue === queue);
    assert.equal(agg?.skipped, 1, "counted in the aggregate tally");
    assert.equal(agg?.done, 1, "still a `done` row underneath");

    const page = await queueHealthJobs({ queue }, db);
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0]?.displayStatus, "skipped", "rendered with its own state per-item");
    assert.equal(page.rows[0]?.skipReason, "not_active");
  });

  it("counts a never-retried failure at BOTH altitudes", async () => {
    const queue = testQueue();
    registerJobHandler(queue, okHandler, { lane: "bulk" });
    await db.insert(asyncJobsTable).values({
      queue,
      payload: {},
      status: "failed",
      attempts: 1,
      maxAttempts: 1, // explicit per-row ceiling of one attempt
      lastError: "boom",
    });

    const agg = (await queueHealth(db)).find((q) => q.queue === queue);
    assert.equal(agg?.abandonedNoRetry, 1);
    assert.equal(agg?.failed, 1);

    const page = await queueHealthJobs({ queue }, db);
    assert.equal(page.rows[0]?.displayStatus, "abandoned_no_retry");
    assert.equal(page.rows[0]?.effectiveMaxAttempts, 1);
  });

  it("returns all four raw statuses per-item, not only failures", async () => {
    // Restricting the per-item view to failures would leave pending and
    // processing rows with no per-item state at all — the contract violation
    // this endpoint exists to avoid.
    const queue = testQueue();
    registerJobHandler(queue, okHandler, { lane: "bulk" });
    await db.insert(asyncJobsTable).values([
      { queue, payload: {}, status: "pending" },
      { queue, payload: {}, status: "processing" },
      { queue, payload: {}, status: "done" },
      { queue, payload: {}, status: "failed", attempts: 5, lastError: "x" },
    ]);

    const page = await queueHealthJobs({ queue, limit: 100 }, db);
    const seen = new Set(page.rows.map((r) => r.status));
    assert.deepEqual([...seen].sort(), ["done", "failed", "pending", "processing"]);
    assert.equal(page.total, 4);
  });

  it("caps limit at 100 so the per-item endpoint cannot be used to dump the table", async () => {
    const page = await queueHealthJobs({ limit: 100_000 }, db);
    assert.equal(page.limit, 100);
  });

  it("truncates lastError rather than returning a full provider stack trace", async () => {
    const queue = testQueue();
    registerJobHandler(queue, okHandler, { lane: "bulk" });
    await db.insert(asyncJobsTable).values({
      queue, payload: {}, status: "failed", attempts: 5, lastError: "x".repeat(2000),
    });
    const page = await queueHealthJobs({ queue }, db);
    assert.equal(page.rows[0]?.lastError?.length, 500);
  });

  it("reports a registered queue that has never run, rather than omitting it", async () => {
    // A queue absent from the page reads as "fine" when the truth may be that it
    // has never executed once.
    const queue = testQueue();
    registerJobHandler(queue, okHandler, { lane: "fast" });
    const agg = (await queueHealth(db)).find((q) => q.queue === queue);
    assert.ok(agg, "a registered queue with zero rows still appears");
    assert.equal(agg?.pending, 0);
    assert.equal(agg?.lane, "fast");
  });
});
