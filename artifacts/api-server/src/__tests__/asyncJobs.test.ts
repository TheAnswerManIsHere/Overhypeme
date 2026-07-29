import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { adminConfigTable, asyncJobsTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";

import {
  __resetHandlersForTest,
  asyncJobsTick,
  createLaneRunner,
  enqueueJob,
  queuesForLane,
  recoverStuckProcessing,
  registerJobHandler,
  terminalFailure,
  RECOVER_STUCK_CUTOFF_MIN,
  type JobHandler,
} from "../lib/asyncJobs.js";
import { bustConfigCache } from "../lib/adminConfig.js";

/** A deferred promise, for holding a handler open at a controlled point. */
function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Yield a macrotask so pending immediate ticks settle to their first await/return. */
const tickFlush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const okHandler: JobHandler = { async run() { return { ok: true }; } };

const QUEUE_PREFIX = "test_async_jobs_";

async function cleanupQueues(): Promise<void> {
  await db.delete(asyncJobsTable).where(like(asyncJobsTable.queue, `${QUEUE_PREFIX}%`));
}

async function cleanupJobs(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.id, ids));
}

async function cleanupConfig(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, keys));
  bustConfigCache();
}

async function setConfigInt(key: string, value: number): Promise<void> {
  await db
    .insert(adminConfigTable)
    .values({
      key,
      value: String(value),
      dataType: "integer",
      label: `${key} (test override)`,
    })
    .onConflictDoUpdate({
      target: adminConfigTable.key,
      set: { value: String(value) },
    });
  bustConfigCache();
}

function clearResendEnv(): Record<string, string | undefined> {
  const previous = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_API_KEY_DEV: process.env.RESEND_API_KEY_DEV,
    RESEND_API_KEY_PROD: process.env.RESEND_API_KEY_PROD,
  };
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY_DEV;
  delete process.env.RESEND_API_KEY_PROD;
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function getJob(id: number) {
  const [row] = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.id, id)).limit(1);
  assert.ok(row, `Expected async job ${id} to exist`);
  return row;
}

describe("asyncJobs worker", () => {
  const configKeys: string[] = [];
  const jobIds: number[] = [];
  const envStack: Array<Record<string, string | undefined>> = [];

  afterEach(async () => {
    __resetHandlersForTest();
    await cleanupJobs(jobIds.splice(0));
    await cleanupQueues();
    await cleanupConfig(configKeys.splice(0));
    while (envStack.length > 0) restoreEnv(envStack.pop()!);
  });

  it("leaves queued email pending when delivery is not configured", async () => {
    envStack.push(clearResendEnv());
    const queue = "email";
    let called = false;
    registerJobHandler(queue, {
      async run() {
        called = true;
        return { ok: true };
      },
    });

    const [row] = await db
      .insert(asyncJobsTable)
      .values({
        queue,
        payload: { to: "test@example.com", subject: "Test", text: "Body" },
        status: "pending",
        attempts: 2,
        maxAttempts: 0,
        nextAttemptAt: new Date(Date.now() - 1000),
      })
      .returning();
    assert.ok(row);
    jobIds.push(row.id);

    await asyncJobsTick(db, new Date(), { queues: [queue] });

    const after = await getJob(row.id);
    assert.equal(called, false, "email handler should not run when delivery is disabled");
    assert.equal(after.status, "pending");
    assert.equal(after.attempts, 2, "disabled delivery must not burn a retry attempt");
    assert.match(after.lastError ?? "", /not configured/);
  });

  it("returns a concrete job id and reuses it on a dedupe hit", async () => {
    const queue = `${QUEUE_PREFIX}${randomUUID()}`;
    const dedupeKey = `dedupe-${randomUUID()}`;

    const first = await enqueueJob({ queue, payload: { n: 1 }, dedupeKey });
    jobIds.push(first.jobId);
    assert.equal(typeof first.jobId, "number");
    assert.equal(first.inserted, true);
    assert.equal(first.status, "pending");

    // Same (queue, dedupeKey) while the first job is still pending → reuse it.
    const second = await enqueueJob({ queue, payload: { n: 2 }, dedupeKey });
    assert.equal(second.jobId, first.jobId);
    assert.equal(second.inserted, false);
  });

  it("creates a NEW job when the prior dedupe job is already terminal", async () => {
    const queue = `${QUEUE_PREFIX}${randomUUID()}`;
    const dedupeKey = `dedupe-${randomUUID()}`;

    const first = await enqueueJob({ queue, payload: {}, dedupeKey });
    jobIds.push(first.jobId);
    // Mark it done — the partial unique index no longer covers it.
    await db.update(asyncJobsTable).set({ status: "done" }).where(eq(asyncJobsTable.id, first.jobId));

    const second = await enqueueJob({ queue, payload: {}, dedupeKey });
    jobIds.push(second.jobId);
    assert.notEqual(second.jobId, first.jobId, "a finished job must not block a fresh enqueue");
    assert.equal(second.inserted, true);
  });

  it("uses the queue-level max-attempts config when no per-job override is set", async () => {
    const queue = `${QUEUE_PREFIX}${randomUUID()}`;
    const configKey = `async_job_${queue}_max_attempts`;
    configKeys.push(configKey);
    await setConfigInt(configKey, 2);

    registerJobHandler(queue, {
      async run() {
        return { ok: false, error: "simulated failure" };
      },
    });

    await enqueueJob({ queue, payload: {} });
    const [inserted] = await db
      .select()
      .from(asyncJobsTable)
      .where(eq(asyncJobsTable.queue, queue))
      .limit(1);
    assert.ok(inserted);
    jobIds.push(inserted.id);

    await db
      .update(asyncJobsTable)
      .set({ attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(asyncJobsTable.id, inserted.id));

    await asyncJobsTick(db, new Date(), { queues: [queue] });

    const after = await getJob(inserted.id);
    assert.equal(after.maxAttempts, 0, "0 sentinel should mean queue config, not a hard-coded override");
    assert.equal(after.attempts, 2);
    assert.equal(after.status, "failed");
  });

  it("terminalFailure marks the row failed on the FIRST attempt, ignoring maxAttempts (§12)", async () => {
    const queue = `${QUEUE_PREFIX}${randomUUID()}`;
    const configKey = `async_job_${queue}_max_attempts`;
    configKeys.push(configKey);
    await setConfigInt(configKey, 5); // plenty of retries left — a retryable failure would NOT fail yet

    registerJobHandler(queue, {
      async run() {
        return terminalFailure("style_snapshot_invalid", "deterministic: frozen style snapshot invalid");
      },
    });

    await enqueueJob({ queue, payload: {} });
    const [inserted] = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.queue, queue)).limit(1);
    assert.ok(inserted);
    jobIds.push(inserted.id);

    await db.update(asyncJobsTable).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(asyncJobsTable.id, inserted.id));
    await asyncJobsTick(db);

    const after = await getJob(inserted.id);
    assert.equal(after.status, "failed", "a terminal failure fails immediately");
    assert.equal(after.attempts, 1, "terminal failure does not burn extra retry attempts");
    assert.match(after.lastError ?? "", /frozen style snapshot invalid/);
  });

  it("a plain (retryable) failure still retries under maxAttempts — terminal path is opt-in", async () => {
    const queue = `${QUEUE_PREFIX}${randomUUID()}`;
    const configKey = `async_job_${queue}_max_attempts`;
    configKeys.push(configKey);
    await setConfigInt(configKey, 5);

    registerJobHandler(queue, {
      async run() {
        return { ok: false, error: "transient hiccup" }; // no retryable flag → historical retry behavior
      },
    });

    await enqueueJob({ queue, payload: {} });
    const [inserted] = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.queue, queue)).limit(1);
    assert.ok(inserted);
    jobIds.push(inserted.id);

    await db.update(asyncJobsTable).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(asyncJobsTable.id, inserted.id));
    await asyncJobsTick(db);

    const after = await getJob(inserted.id);
    assert.equal(after.status, "pending", "retryable failure stays pending for another attempt");
    assert.equal(after.attempts, 1);
  });

  // ─── Lane split ───────────────────────────────────────────────────────────

  it("assigns lanes (default bulk), replaces on re-register, clears on reset", async () => {
    const qFast = `${QUEUE_PREFIX}${randomUUID()}`;
    const qRender = `${QUEUE_PREFIX}${randomUUID()}`;
    const qBulk = `${QUEUE_PREFIX}${randomUUID()}`;

    registerJobHandler(qFast, okHandler, { lane: "fast" });
    registerJobHandler(qRender, okHandler, { lane: "render" });
    registerJobHandler(qBulk, okHandler); // unannotated → bulk

    assert.ok(queuesForLane("fast").includes(qFast));
    assert.ok(queuesForLane("render").includes(qRender));
    assert.ok(queuesForLane("bulk").includes(qBulk));
    assert.ok(!queuesForLane("bulk").includes(qFast));

    // Re-registering with no lane reclassifies it to bulk (replace semantics).
    registerJobHandler(qFast, okHandler);
    assert.ok(!queuesForLane("fast").includes(qFast));
    assert.ok(queuesForLane("bulk").includes(qFast));

    // Reset clears the lane registry too (test isolation).
    __resetHandlersForTest();
    assert.deepEqual(queuesForLane("fast"), []);
    assert.deepEqual(queuesForLane("render"), []);
    assert.deepEqual(queuesForLane("bulk"), []);
  });

  it("claims only the lane's queues, in nextAttemptAt/id order; empty lane claims nothing", async () => {
    const qA = `${QUEUE_PREFIX}${randomUUID()}`;
    const qB = `${QUEUE_PREFIX}${randomUUID()}`;
    const ranA: number[] = [];
    registerJobHandler(qA, {
      async run(payload) { ranA.push((payload as { n: number }).n); return { ok: true }; },
    }, { lane: "fast" });
    registerJobHandler(qB, okHandler, { lane: "bulk" });

    // Two due qA jobs (distinct nextAttemptAt) + one due qB job.
    const [a1] = await db.insert(asyncJobsTable).values({
      queue: qA, payload: { n: 1 }, status: "pending", nextAttemptAt: new Date(Date.now() - 2000),
    }).returning();
    const [a2] = await db.insert(asyncJobsTable).values({
      queue: qA, payload: { n: 2 }, status: "pending", nextAttemptAt: new Date(Date.now() - 1000),
    }).returning();
    const [b1] = await db.insert(asyncJobsTable).values({
      queue: qB, payload: {}, status: "pending", nextAttemptAt: new Date(Date.now() - 1000),
    }).returning();
    jobIds.push(a1!.id, a2!.id, b1!.id);

    // An empty queue set matches nothing — b1 stays pending, no throw.
    await asyncJobsTick(db, new Date(), { queues: [], maxConcurrency: 1 });
    assert.equal((await getJob(b1!.id)).status, "pending");

    // Restrict to qA (concurrency 1 so claim order is observable).
    await asyncJobsTick(db, new Date(), { queues: [qA], maxConcurrency: 1 });

    assert.deepEqual(ranA, [1, 2], "claimed in nextAttemptAt asc order");
    assert.equal((await getJob(a1!.id)).status, "done");
    assert.equal((await getJob(a2!.id)).status, "done");
    assert.equal((await getJob(b1!.id)).status, "pending", "other lane's job untouched");
  });

  it("honors per-call maxConcurrency", async () => {
    const q = `${QUEUE_PREFIX}${randomUUID()}`;
    let inFlight = 0;
    let maxSeen = 0;
    registerJobHandler(q, {
      async run() {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        await sleep(25);
        inFlight--;
        return { ok: true };
      },
    }, { lane: "bulk" });

    const enqueue = async (count: number): Promise<void> => {
      for (let i = 0; i < count; i++) {
        const [row] = await db.insert(asyncJobsTable).values({
          queue: q, payload: { i }, status: "pending", nextAttemptAt: new Date(Date.now() - 1000),
        }).returning();
        jobIds.push(row!.id);
      }
    };

    await enqueue(3);
    await asyncJobsTick(db, new Date(), { queues: [q], maxConcurrency: 1 });
    assert.equal(maxSeen, 1, "maxConcurrency:1 never runs two handlers at once");

    maxSeen = 0;
    await enqueue(3);
    await asyncJobsTick(db, new Date(), { queues: [q], maxConcurrency: 3 });
    assert.ok(maxSeen > 1, "a higher bound permits overlap");
  });

  it("runs lanes independently — a blocked bulk lane never suppresses the fast lane", async () => {
    const bulkGate = makeDeferred();
    let bulkStarts = 0;
    let fastRuns = 0;
    // No-op scheduler: only the returned `tick` runs, no real interval fires.
    const noopSchedule = (): NodeJS.Timeout => {
      const h = setTimeout(() => {}, 1_000_000);
      h.unref();
      return h;
    };

    const bulkRunner = createLaneRunner(
      { lane: "bulk", intervalMs: 1_000_000, maxConcurrency: 1, maintenance: false },
      { schedule: noopSchedule, runTick: async () => { bulkStarts++; await bulkGate.promise; } },
    );
    const fastRunner = createLaneRunner(
      { lane: "fast", intervalMs: 1_000_000, maxConcurrency: 1, maintenance: false },
      { schedule: noopSchedule, runTick: async () => { fastRuns++; } },
    );

    // Let both immediate ticks settle: bulk parks on its gate, fast completes.
    await tickFlush();
    assert.equal(bulkStarts, 1, "bulk tick is in flight (parked on the gate)");
    assert.ok(fastRuns >= 1, "fast lane completed while bulk is blocked");

    // A second bulk tick is suppressed while the first is still in flight.
    await bulkRunner.tick();
    assert.equal(bulkStarts, 1, "re-entrant bulk tick suppressed by bulk's own guard");

    // Fast re-entrancy is governed only by fast's own closure — it ticks again.
    await fastRunner.tick();
    assert.ok(fastRuns >= 2, "fast lane ticks again independently of bulk");

    // Release bulk and confirm it resumes (guard reset in finally).
    bulkGate.resolve();
    await tickFlush();
    await bulkRunner.tick();
    assert.equal(bulkStarts, 2, "bulk resumes once unblocked");

    clearTimeout(bulkRunner.handle);
    clearTimeout(fastRunner.handle);
  });

  // ── Stuck-row reclaim cutoff ────────────────────────────────────────────
  // Regression guard for the autoscale double-execution defect: this
  // deployment is `deploymentTarget = "autoscale"` and every instance starts
  // the worker, so recovery runs against rows OTHER live instances are
  // actively processing. Because finalize matches on row id alone (no fencing
  // token yet — Phase 3a), reclaiming a still-running row means both runs
  // execute and one silently overwrites the other.

  it("does not reclaim a processing row younger than the cutoff", async () => {
    // 12 minutes: inside the OLD 10-minute cutoff's reclaim window, outside the
    // new one. This is the row a scaling-up instance would have stolen from a
    // healthy peer mid-render.
    const claimedAt = new Date(Date.now() - 12 * 60_000);
    const [row] = await db
      .insert(asyncJobsTable)
      .values({
        queue: `test_stuck_${randomUUID().slice(0, 8)}`,
        payload: {},
        status: "processing",
        updatedAt: claimedAt,
      })
      .returning();
    jobIds.push(row!.id);

    await recoverStuckProcessing(db, RECOVER_STUCK_CUTOFF_MIN);

    const after = await getJob(row!.id);
    assert.equal(
      after.status,
      "processing",
      "a row claimed 12 minutes ago must NOT be reclaimed — another instance may still be running it",
    );
  });

  it("reclaims a processing row older than the cutoff", async () => {
    const claimedAt = new Date(Date.now() - (RECOVER_STUCK_CUTOFF_MIN + 1) * 60_000);
    const [row] = await db
      .insert(asyncJobsTable)
      .values({
        queue: `test_stuck_${randomUUID().slice(0, 8)}`,
        payload: {},
        status: "processing",
        updatedAt: claimedAt,
      })
      .returning();
    jobIds.push(row!.id);

    await recoverStuckProcessing(db, RECOVER_STUCK_CUTOFF_MIN);

    const after = await getJob(row!.id);
    assert.equal(
      after.status,
      "pending",
      "a genuinely stranded row must still be recovered — the cutoff bounds the race, it does not disable recovery",
    );
  });

  it("keeps the reclaim cutoff clear of the slowest real handler", () => {
    // The image-prompt planner alone can run ~180s before image generation
    // starts, and that is one handler on one instance. A cutoff anywhere near
    // it re-opens the reclaim race this constant exists to close, so guard the
    // floor rather than the exact value — 30 is the current choice, 15 is the
    // point below which the margin stops being real.
    assert.ok(
      RECOVER_STUCK_CUTOFF_MIN >= 15,
      `RECOVER_STUCK_CUTOFF_MIN is ${RECOVER_STUCK_CUTOFF_MIN}; below 15 minutes a slow handler can be reclaimed mid-run and executed twice`,
    );
  });

});
