import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { asyncJobsTable, workerLaneHeartbeatsTable } from "@workspace/db/schema";
import { inArray, like } from "drizzle-orm";

import {
  deriveDisplayStatus,
  sanitizeSkipReason,
  laneHealth,
  queueHealth,
  queueHealthJobs,
} from "../lib/queueHealth.js";
import { WORKER_PROTOCOL_VERSION } from "../lib/workerHeartbeats.js";
import {
  __resetHandlersForTest,
  registerJobHandler,
  staleThresholdMs,
  widestStaleThresholdMs,
  type JobHandler,
} from "../lib/asyncJobs.js";

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
      { status: "done", result: { skipped: true, reason: "not_active" }, attempts: 1, maxAttempts: 5 },
      5,
    );
    assert.equal(displayStatus, "skipped");
    assert.equal(skipReason, "not_active");
  });

  it("leaves an ordinary success as `done`", () => {
    const { displayStatus } = deriveDisplayStatus(
      { status: "done", result: { factId: 1 }, attempts: 1, maxAttempts: 5 },
      5,
    );
    assert.equal(displayStatus, "done");
  });

  it("derives `abandoned_no_retry` when the ceiling is one attempt, OR retries were never exhausted", () => {
    // fact_ai_meme_backfill is configured never to retry, so its failures are
    // `failed` after a single attempt — a different operator story from
    // "exhausted five attempts", and indistinguishable without this.
    // maxAttempts: 1 here is the persisted (non-zero) ceiling PR288's finalize
    // fix writes for a never-retry queue — required even for the single-
    // attempt case, since a LIVE ceiling of 1 does not by itself prove this
    // row only ever had 1 attempt available (see the sentinel-guard test
    // below for the legacy row this would otherwise misclassify).
    const neverRetried = deriveDisplayStatus({ status: "failed", result: null, attempts: 1, maxAttempts: 1 }, 1);
    assert.equal(neverRetried.displayStatus, "abandoned_no_retry");

    const exhausted = deriveDisplayStatus({ status: "failed", result: null, attempts: 5, maxAttempts: 5 }, 5);
    assert.equal(exhausted.displayStatus, "failed");

    // A `terminalFailure()` on a queue whose normal ceiling is 5: the handler
    // gave up deterministically on attempt 1, well short of exhausting its
    // budget. `processClaimedJob`'s exhaustion path can ONLY mark a row
    // `failed` once `attempts >= effectiveMax`, so `attempts < effectiveMax`
    // here proves this row didn't get here via exhaustion — it must be a
    // terminal failure, and the health surface must say so rather than
    // rendering it as an indistinguishable generic "Failed". `maxAttempts: 5`
    // is the persisted (non-zero) ceiling PR288's finalize fix now writes —
    // required for this branch to trust the comparison at all (see the
    // sentinel-guard test below for what happens without it).
    const terminalBeforeCeiling = deriveDisplayStatus(
      { status: "failed", result: null, attempts: 1, maxAttempts: 5 },
      5,
    );
    assert.equal(terminalBeforeCeiling.displayStatus, "abandoned_no_retry");

    // Same shape, but on a LATER attempt — some retries did happen before the
    // handler gave up. Still not exhaustion (2 < 5), so still derived.
    const terminalAfterSomeRetries = deriveDisplayStatus(
      { status: "failed", result: null, attempts: 2, maxAttempts: 5 },
      5,
    );
    assert.equal(terminalAfterSomeRetries.displayStatus, "abandoned_no_retry");
  });

  it("treats a legacy sentinel row conservatively — never derives terminal from a live-config guess", () => {
    // A `failed` row with the `0` sentinel predates PR288's finalize fix
    // (migration 0094 does not backfill existing rows). `effectiveMax` here
    // is only a live admin_config lookup, which may not match the ceiling
    // that was actually in effect when this row failed — an admin raising the
    // queue's ceiling afterward would otherwise retroactively relabel a
    // genuine historical exhaustion as a terminal failure. Render it as plain
    // `failed` instead of risking that false classification.
    const legacyRow = deriveDisplayStatus(
      { status: "failed", result: null, attempts: 3, maxAttempts: 0 },
      5, // resolved from CURRENT config, not necessarily what applied at finalization
    );
    assert.equal(legacyRow.displayStatus, "failed", "a 0-sentinel row must not be derived as terminal");

    // The single-attempt-ceiling case specifically: a legacy row that
    // genuinely exhausted 5 attempts under an OLD higher ceiling, viewed
    // after an admin has since LOWERED the queue's live ceiling to 1. Without
    // the maxAttempts>0 guard on effectiveMax<=1 too, this would relabel a
    // real 5-attempt exhaustion as "terminal, gave up early" — the live
    // ceiling of 1 says nothing about how many attempts this row actually had
    // available when it failed.
    const legacyMultiAttemptExhaustion = deriveDisplayStatus(
      { status: "failed", result: null, attempts: 5, maxAttempts: 0 },
      1, // the CURRENT, since-lowered ceiling — not what applied historically
    );
    assert.equal(
      legacyMultiAttemptExhaustion.displayStatus,
      "failed",
      "a 0-sentinel row must not be derived as terminal even when the live ceiling is 1",
    );
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

  it("computes the widest per-lane stale threshold, for the TTL/prune-cutoff widening", () => {
    // Every real lane's default interval is 2-5s, so every lane floors at the
    // same 60s threshold under default config — this just proves the
    // aggregation itself (max over ALL_LANES) rather than any one lane's math,
    // which staleThresholdMs's own test above already covers.
    assert.equal(widestStaleThresholdMs(), 60_000);
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

  it("never lets the TTL cutoff undercut a lane's own stale threshold", async () => {
    // Every real lane floors at a 60s stale threshold (staleThresholdMs's own
    // 60s floor). A 30s TTL is deliberately shorter than that, to prove the
    // live-instance query filter doesn't prune a heartbeat before the
    // per-lane threshold check below even gets to run.
    await clearRealLaneHeartbeats();
    await db.insert(workerLaneHeartbeatsTable).values({
      instanceId: randomUUID(),
      lane: "fast",
      workerProtocolVersion: WORKER_PROTOCOL_VERSION,
      // 45s old: past a hypothetical 30s TTL, but well within the 60s floor
      // every lane's stale threshold actually uses under default config.
      lastScheduledAt: new Date(Date.now() - 45_000),
    });

    const lanes = await laneHealth(db, 0.5); // 30s TTL
    const fast = lanes.find((l) => l.lane === "fast");
    assert.equal(
      fast?.liveInstanceCount,
      1,
      "a TTL shorter than the stale window must not prune a heartbeat the threshold check still needs",
    );
    assert.equal(fast?.stalled, false, "45s old is still inside the 60s floor — not actually stalled");
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

  it("counts a terminal failure short of its retry ceiling at BOTH altitudes", async () => {
    // Distinct from the never-retried case above: this queue's ceiling is 5,
    // and the row failed on attempt 1 — a terminalFailure() giving up
    // deterministically, not exhaustion (which requires attempts >= 5). The
    // aggregate's `abandonedNoRetry` grouping and the per-item derivation must
    // agree, same failure mode as the skip/never-retried tests above: right at
    // one altitude and silently wrong at the other.
    const queue = testQueue();
    registerJobHandler(queue, okHandler, { lane: "bulk" });
    await db.insert(asyncJobsTable).values({
      queue,
      payload: {},
      status: "failed",
      attempts: 1,
      maxAttempts: 5,
      lastError: "deterministic, will not help to retry",
    });

    const agg = (await queueHealth(db)).find((q) => q.queue === queue);
    assert.equal(agg?.abandonedNoRetry, 1, "a failure short of its ceiling cannot be exhaustion — must be terminal");
    assert.equal(agg?.failed, 1);

    const page = await queueHealthJobs({ queue }, db);
    assert.equal(page.rows[0]?.displayStatus, "abandoned_no_retry");
    assert.equal(page.rows[0]?.effectiveMaxAttempts, 5);
  });

  it("keeps active rows reachable within the page limit even when terminal rows are more recent", async () => {
    // Ordering purely by recency would let a burst of terminal (done/failed)
    // activity crowd every pending/processing row out of a bounded page — the
    // aggregate would report queued work while the drill-down shows none of
    // it, even though it's the exact same work at a different altitude. This
    // asserts the fix: active statuses sort ahead of terminal ones regardless
    // of updatedAt.
    const queue = testQueue();
    registerJobHandler(queue, okHandler, { lane: "bulk" });

    // One pending row, deliberately the OLDEST by updatedAt.
    const now = Date.now();
    await db.insert(asyncJobsTable).values({
      queue,
      payload: {},
      status: "pending",
      updatedAt: new Date(now - 10_000),
    });
    // Three newer terminal rows that would otherwise fill the whole page.
    await db.insert(asyncJobsTable).values(
      [0, 1, 2].map((i) => ({
        queue,
        payload: {},
        status: "done" as const,
        updatedAt: new Date(now - i * 1_000),
      })),
    );

    const page = await queueHealthJobs({ queue, limit: 2 }, db);
    assert.equal(page.rows.length, 2);
    assert.equal(page.rows[0]?.status, "pending", "the active row must be first regardless of recency");
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
