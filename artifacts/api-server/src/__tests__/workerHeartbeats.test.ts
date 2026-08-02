import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { workerLaneHeartbeatsTable, asyncJobsTable } from "@workspace/db/schema";
import { and, eq, like } from "drizzle-orm";

import {
  WORKER_INSTANCE_ID,
  WORKER_PROTOCOL_VERSION,
  stampLaneScheduled,
  stampTickCompleted,
  publishInFlight,
  decrementInFlight,
  pruneDepartedInstances,
} from "../lib/workerHeartbeats.js";
import {
  __resetHandlersForTest,
  asyncJobsTick,
  createLaneRunner,
  enqueueJob,
  registerJobHandler,
  type JobHandler,
} from "../lib/asyncJobs.js";

/** A deferred promise, for holding a handler open at a controlled point. */
function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const tickFlush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const QUEUE_PREFIX = "test_hb_";

/**
 * Poll until `check` is satisfied or the deadline passes, returning the last
 * observed value either way.
 *
 * A single `tickFlush()` only yields one macrotask — enough to let the
 * fire-and-forget heartbeat write's promise start, but not enough to
 * guarantee its DB round-trip has actually landed once the test DB is under
 * concurrent load from sibling test files. Same rationale as the polling
 * loop in "publishes in_flight_count…" below: a fixed delay makes the
 * assertion depend on test-database speed, and a flaky liveness test is
 * worse than none.
 */
async function pollUntil<T>(read: () => Promise<T>, check: (v: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!check(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    value = await read();
  }
  return value;
}

/** Lanes are namespaced per test so parallel files cannot collide on a row. */
function testLane(): string {
  return `test_lane_${randomUUID().slice(0, 8)}`;
}

async function readRow(lane: string, instanceId = WORKER_INSTANCE_ID) {
  const [row] = await db
    .select()
    .from(workerLaneHeartbeatsTable)
    .where(and(
      eq(workerLaneHeartbeatsTable.instanceId, instanceId),
      eq(workerLaneHeartbeatsTable.lane, lane),
    ))
    .limit(1);
  return row;
}

async function cleanup(): Promise<void> {
  await db.delete(workerLaneHeartbeatsTable).where(like(workerLaneHeartbeatsTable.lane, "test_lane_%"));
  await db.delete(asyncJobsTable).where(like(asyncJobsTable.queue, `${QUEUE_PREFIX}%`));
}

describe("workerHeartbeats", () => {
  afterEach(async () => {
    __resetHandlersForTest();
    await cleanup();
  });

  it("mints a per-process instance id that is not a deployment identifier", () => {
    // The whole point of (instance_id, lane) is that two instances of the SAME
    // deployment get different rows. A release identifier would collapse them.
    assert.match(WORKER_INSTANCE_ID, /^[0-9a-f-]{36}$/);
    assert.notEqual(WORKER_INSTANCE_ID, process.env["REPLIT_DEPLOYMENT_ID"] ?? "");
    assert.notEqual(WORKER_INSTANCE_ID, process.env["REPLIT_GIT_COMMIT_SHA"] ?? "");
  });

  it("declares protocol version 1 in Phase 1", () => {
    // Phase 3a bumps this to 2 ("honors the lease fence"). The 3b interlock
    // compares `< 2`, so shipping Phase 1 at anything other than 1 would make
    // that comparison meaningless.
    assert.equal(WORKER_PROTOCOL_VERSION, 1);
  });

  it("upserts one row per (instance, lane) rather than one per lane", async () => {
    const lane = testLane();
    await stampLaneScheduled(lane);
    await stampLaneScheduled(lane);

    const rows = await db
      .select()
      .from(workerLaneHeartbeatsTable)
      .where(eq(workerLaneHeartbeatsTable.lane, lane));
    assert.equal(rows.length, 1, "repeat stamps must update, not accumulate");
    assert.equal(rows[0]?.instanceId, WORKER_INSTANCE_ID);
    assert.equal(rows[0]?.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
  });

  it("keeps a second instance's row separate", async () => {
    const lane = testLane();
    const otherInstance = randomUUID();
    await stampLaneScheduled(lane);
    await db.insert(workerLaneHeartbeatsTable).values({
      instanceId: otherInstance,
      lane,
      workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    });

    const rows = await db
      .select()
      .from(workerLaneHeartbeatsTable)
      .where(eq(workerLaneHeartbeatsTable.lane, lane));
    assert.equal(rows.length, 2, "two instances on one lane must not share a row");
  });

  it("decrement floors at zero rather than going negative", async () => {
    const lane = testLane();
    await publishInFlight(lane, 1);
    await decrementInFlight(lane);
    await decrementInFlight(lane);
    await decrementInFlight(lane);

    const row = await readRow(lane);
    assert.equal(row?.inFlightCount, 0, "a lost publish must not drive the count negative");
  });

  it("clears the in-flight count on tick completion", async () => {
    const lane = testLane();
    await publishInFlight(lane, 4);
    await stampTickCompleted(lane);

    const row = await readRow(lane);
    assert.equal(row?.inFlightCount, 0);
    assert.ok(row?.lastTickCompletedAt, "completion must be stamped");
  });

  it("prunes rows past the TTL and leaves live ones", async () => {
    const staleLane = testLane();
    const liveLane = testLane();
    const staleInstance = randomUUID();

    await db.insert(workerLaneHeartbeatsTable).values({
      instanceId: staleInstance,
      lane: staleLane,
      workerProtocolVersion: WORKER_PROTOCOL_VERSION,
      lastScheduledAt: new Date(Date.now() - 60 * 60_000),
    });
    await stampLaneScheduled(liveLane);

    await pruneDepartedInstances(db, 15);

    assert.equal(await readRow(staleLane, staleInstance), undefined, "departed instance must be pruned");
    assert.ok(await readRow(liveLane), "a live instance must survive the prune");
  });
});

describe("workerHeartbeats — write moments (the part that makes the signals real)", () => {
  afterEach(async () => {
    __resetHandlersForTest();
    await cleanup();
  });

  it("stamps last_scheduled_at even when the re-entrancy guard skips the tick", async () => {
    // A lane whose timer fires while its previous tick is still running is
    // HEALTHY BUT SLOW. If this column were only written on ticks that actually
    // ran, that lane would look dead — conflating a stopped scheduler with a
    // slow handler, which need different remediation.
    const lane = testLane();
    const held = makeDeferred();
    const runner = createLaneRunner(
      { lane: lane as never, intervalMs: 60_000, maxConcurrency: 1, maintenance: false },
      { runTick: () => held.promise, schedule: () => ({ unref() {} }) as never },
    );

    const first = runner.tick();          // enters the body and blocks
    await tickFlush();
    const stampedAfterFirst = await pollUntil(() => readRow(lane), (row) => Boolean(row?.lastScheduledAt));
    assert.ok(stampedAfterFirst?.lastScheduledAt, "first fire stamps the scheduler");

    const before = stampedAfterFirst!.lastScheduledAt!.getTime();
    await new Promise((r) => setTimeout(r, 10));
    await runner.tick();                  // hits `if (ticking) return`
    await tickFlush();

    const afterSkip = await pollUntil(
      () => readRow(lane),
      (row) => Boolean(row?.lastScheduledAt && row.lastScheduledAt.getTime() > before),
    );
    assert.ok(
      afterSkip!.lastScheduledAt!.getTime() > before,
      "a skipped tick must STILL advance last_scheduled_at — the timer fired",
    );
    assert.equal(afterSkip?.lastTickCompletedAt, null, "a tick that never finished must not stamp completion");

    held.resolve();
    await first;
  });

  it("publishes in_flight_count before awaiting handlers, so a wedged tick is visible", async () => {
    // This is the criterion the plan calls load-bearing: publish at claim
    // commit, not at completion. A wedged tick never completes, so a
    // completion-only write leaves the count at zero and the wedge condition
    // (`in_flight_count > 0`) can never be satisfied by the case it exists for.
    const lane = testLane();
    const queue = `${QUEUE_PREFIX}${randomUUID().slice(0, 8)}`;
    const held = makeDeferred();
    const handler: JobHandler = {
      async run() { await held.promise; return { ok: true }; },
    };
    registerJobHandler(queue, handler, { lane: lane as never });
    await enqueueJob({ queue, payload: {} });

    const tickPromise = asyncJobsTick(db, new Date(), {
      queues: [queue],
      maxConcurrency: 1,
      lane: lane as never,
    });
    // Wait for the claim transaction to commit and the publish to land, while
    // the handler is still blocked inside mapWithConcurrency. Polled rather than
    // slept: a fixed delay makes this assertion depend on test-database speed,
    // and a flaky liveness test is worse than none.
    const deadline = Date.now() + 5_000;
    let midFlight = await readRow(lane);
    while ((midFlight?.inFlightCount ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      midFlight = await readRow(lane);
    }
    assert.equal(midFlight?.inFlightCount, 1, "the count must be visible WHILE the handler is still running");
    assert.equal(midFlight?.lastTickCompletedAt, null, "the tick has not completed yet");

    held.resolve();
    await tickPromise;

    const afterDone = await readRow(lane);
    assert.equal(afterDone?.inFlightCount, 0, "the job left the in-flight set");
  });
});
