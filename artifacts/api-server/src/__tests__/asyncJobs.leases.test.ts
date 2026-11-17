/**
 * Job leases and fenced effects (plan docs/plans/PLAN_JOB_RESUME.md §A–§B,
 * Issue #1000 increment 1). Each test names the plan's testing bullet it covers.
 *
 * A lease is 90 s of real time, so a lapse is simulated by moving
 * `lease_expires_at` into the past in the database — the same clock every
 * ownership check reads.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { asyncJobsTable } from "@workspace/db/schema";
import { eq, inArray, like, sql } from "drizzle-orm";

import {
  __resetHandlersForTest,
  asyncJobsTick,
  assertJobOwnership,
  enqueueJob,
  fencedTransaction,
  jobAbortSignal,
  recoverStuckProcessing,
  registerJobHandler,
  renewHeldLeases,
  JobOwnershipLostError,
  RECOVER_STUCK_CUTOFF_MIN,
  type JobHandler,
} from "../lib/asyncJobs.js";
import { whileOwned } from "../lib/jobFence.js";

const QUEUE_PREFIX = "test_job_leases_";
const newQueue = (): string => `${QUEUE_PREFIX}${randomUUID().slice(0, 8)}`;

function makeDeferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function getJob(id: number) {
  const [row] = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.id, id)).limit(1);
  assert.ok(row, `expected job ${id}`);
  return row;
}

/** Poll until `pred` holds (the handler reached a point), or fail after 5 s. */
async function until(pred: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await pred())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Simulate the holder going quiet: its lease lapses (database clock). */
async function lapseLease(id: number, agoMinutes = 0): Promise<void> {
  await db.execute(sql`
    UPDATE async_jobs
       SET lease_expires_at = now() - interval '1 second',
           claimed_at = now() - make_interval(mins => ${agoMinutes})
     WHERE id = ${id}`);
}

/** A sentinel row a handler writes to, standing in for a domain table. */
async function makeSentinel(): Promise<number> {
  const [row] = await db.insert(asyncJobsTable).values({
    queue: `${QUEUE_PREFIX}sentinel`, payload: {}, status: "done", result: { writes: 0 },
  }).returning();
  return row!.id;
}

async function sentinelWrites(id: number): Promise<number> {
  return ((await getJob(id)).result as { writes: number }).writes;
}

/** The fenced domain write a second run would also make. */
async function bumpSentinel(id: number): Promise<void> {
  await fencedTransaction(db, async (tx) => {
    await tx.update(asyncJobsTable)
      .set({ result: sql`jsonb_build_object('writes', (${asyncJobsTable.result}->>'writes')::int + 1)` })
      .where(eq(asyncJobsTable.id, id));
  });
}

describe("async job leases", () => {
  afterEach(async () => {
    __resetHandlersForTest();
    await db.delete(asyncJobsTable).where(like(asyncJobsTable.queue, `${QUEUE_PREFIX}%`));
  });

  it("stamps an owner, a token and a 90 s lease at claim", async () => {
    const queue = newQueue();
    const held = makeDeferred();
    let seen: Awaited<ReturnType<typeof getJob>> | undefined;
    registerJobHandler(queue, {
      async run(_p, row) { seen = await getJob(row.id); await held.promise; return { ok: true }; },
    });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    const tick = asyncJobsTick(db, new Date(), { queues: [queue] });
    await until(() => seen !== undefined, "handler started");
    assert.equal(seen!.status, "processing");
    assert.ok(seen!.claimOwner, "owner recorded");
    assert.ok(seen!.leaseToken, "token recorded");
    const leftMs = seen!.leaseExpiresAt!.getTime() - Date.now();
    assert.ok(leftMs > 60_000 && leftMs <= 91_000, `lease ~90 s out, got ${leftMs} ms`);
    held.resolve();
    await tick;
    const done = await getJob(jobId);
    assert.equal(done.status, "done");
    assert.equal(done.leaseExpiresAt, null, "the lease ends with the run");
  });

  it("a stop, simulated: a lapsed lease is reclaimed at once when fast reclaim is on", async () => {
    const queue = newQueue();
    registerJobHandler(queue, { async run() { return { ok: true }; } }, { fastReclaim: true });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    // A holder that claimed and then stopped: processing under a lapsed lease.
    await db.update(asyncJobsTable).set({
      status: "processing", leaseToken: randomUUID(), claimOwner: "gone",
    }).where(eq(asyncJobsTable.id, jobId));
    await lapseLease(jobId, 1);
    await recoverStuckProcessing(db);
    assert.equal((await getJob(jobId)).status, "pending", "reclaimed within the sweep");
    await asyncJobsTick(db, new Date(), { queues: [queue] });
    assert.equal((await getJob(jobId)).status, "done", "a second worker picked it up");
  });

  it("fast reclaim off (every queue in this release): a lapsed lease waits 30 minutes from the claim", async () => {
    const queue = newQueue();
    registerJobHandler(queue, { async run() { return { ok: true }; } });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    await db.update(asyncJobsTable).set({ status: "processing", leaseToken: randomUUID() })
      .where(eq(asyncJobsTable.id, jobId));
    await lapseLease(jobId, RECOVER_STUCK_CUTOFF_MIN - 1);
    await recoverStuckProcessing(db);
    assert.equal((await getJob(jobId)).status, "processing", "not before 30 minutes");
    await lapseLease(jobId, RECOVER_STUCK_CUTOFF_MIN + 1);
    await recoverStuckProcessing(db);
    assert.equal((await getJob(jobId)).status, "pending", "after 30 minutes, as before leases");
  });

  it("a healthy job that keeps renewing is never reclaimed, however long it runs", async () => {
    const queue = newQueue();
    const started = makeDeferred();
    const held = makeDeferred();
    registerJobHandler(queue, {
      async run() { started.resolve(); await held.promise; return { ok: true }; },
    }, { fastReclaim: true });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    const tick = asyncJobsTick(db, new Date(), { queues: [queue] });
    await started.promise;
    // Its claim is an hour old, but its lease is live and renewing.
    await db.execute(sql`UPDATE async_jobs SET claimed_at = now() - interval '60 minutes' WHERE id = ${jobId}`);
    const { renewed, lost } = await renewHeldLeases(db);
    assert.equal(renewed, 1);
    assert.equal(lost, 0);
    await recoverStuckProcessing(db);
    assert.equal((await getJob(jobId)).status, "processing", "a live lease is never reclaimed");
    held.resolve();
    await tick;
    assert.equal((await getJob(jobId)).status, "done");
  });

  it("the late returner: a run that lost its lease makes no finish, no domain write, no child job, no abandonment", async () => {
    const queue = newQueue();
    const childQueue = newQueue();
    const sentinel = await makeSentinel();
    const started = makeDeferred();
    const release = makeDeferred();
    let abandonCalls = 0;
    let effectError: unknown;
    registerJobHandler(queue, {
      async run() {
        started.resolve();
        await release.promise;
        try {
          await bumpSentinel(sentinel);
        } catch (err) { effectError = err; }
        try {
          await fencedTransaction(db, (tx) => enqueueJob({ queue: childQueue, payload: {} }, tx));
        } catch { /* refused too */ }
        return { ok: false, error: "late failure" };
      },
      onAbandon() { abandonCalls++; },
    });
    const { jobId } = await enqueueJob({ queue, payload: {}, maxAttempts: 1 });
    const tick = asyncJobsTick(db, new Date(), { queues: [queue] });
    await started.promise;

    // The holder goes quiet; the sweep reclaims the row and a second run finishes it.
    await lapseLease(jobId, RECOVER_STUCK_CUTOFF_MIN + 1);
    await recoverStuckProcessing(db);
    await db.update(asyncJobsTable).set({ status: "done", result: { by: "second run" } })
      .where(eq(asyncJobsTable.id, jobId));

    release.resolve();
    await tick;

    assert.ok(effectError instanceof JobOwnershipLostError, "the domain write was refused");
    assert.equal(await sentinelWrites(sentinel), 0, "no domain write");
    const children = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.queue, childQueue));
    assert.equal(children.length, 0, "no child job");
    const after = await getJob(jobId);
    assert.equal(after.status, "done", "the second run's result stands");
    assert.deepEqual(after.result, { by: "second run" });
    assert.equal(after.attempts, 0, "no finish from the late run");
    assert.equal(abandonCalls, 0, "no abandonment effect");
  });

  it("atomicity: a reclaim between a run's check and its write leaves the write undone", async () => {
    const queue = newQueue();
    const sentinel = await makeSentinel();
    let refused = false;
    registerJobHandler(queue, {
      async run(_p, row) {
        await assertJobOwnership(db); // the check passes …
        // … then a reclaim lands before the write.
        await lapseLease(row.id, RECOVER_STUCK_CUTOFF_MIN + 1);
        await recoverStuckProcessing(db);
        try { await bumpSentinel(sentinel); } catch (err) { refused = err instanceof JobOwnershipLostError; }
        return { ok: true };
      },
    });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    await asyncJobsTick(db, new Date(), { queues: [queue] });
    assert.ok(refused, "the write was refused");
    assert.equal(await sentinelWrites(sentinel), 0);
    assert.equal((await getJob(jobId)).status, "pending", "the reclaim, not the stale finish, decided");
  });

  it("atomicity: a fenced write holds the job row, so a reclaim waits for it", async () => {
    const queue = newQueue();
    let reclaimBlocked = false;
    registerJobHandler(queue, {
      async run(_p, row) {
        await fencedTransaction(db, async () => {
          // From another connection, a reclaim of this row cannot proceed while
          // the fenced transaction holds it.
          try {
            await db.transaction(async (other) => {
              await other.execute(sql`SET LOCAL lock_timeout = '200ms'`);
              await other.execute(sql`UPDATE async_jobs SET status = 'pending' WHERE id = ${row.id}`);
            });
          } catch { reclaimBlocked = true; }
        });
        return { ok: true };
      },
    });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    await asyncJobsTick(db, new Date(), { queues: [queue] });
    assert.ok(reclaimBlocked, "the concurrent update had to wait for the fenced transaction");
    assert.equal((await getJob(jobId)).status, "done");
  });

  it("execution limit: a wedged run is ended, and its late result is refused while its lease still has time", async () => {
    const queue = newQueue();
    const sentinel = await makeSentinel();
    const release = makeDeferred();
    let aborted = false;
    let lateWriteRefused = false;
    registerJobHandler(queue, {
      async run() {
        jobAbortSignal()?.addEventListener("abort", () => { aborted = true; });
        await release.promise; // wedged
        try { await bumpSentinel(sentinel); } catch (err) { lateWriteRefused = err instanceof JobOwnershipLostError; }
        return { ok: true };
      },
    }, { executionLimitMs: 150 });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    await asyncJobsTick(db, new Date(), { queues: [queue] });

    const after = await getJob(jobId);
    assert.equal(after.status, "pending", "put back for a retry");
    assert.equal(after.attempts, 1);
    assert.match(after.lastError ?? "", /execution limit/);
    assert.ok(aborted, "the run's abort signal fired");

    release.resolve(); // the late result arrives …
    await until(() => lateWriteRefused, "late write attempted");
    assert.equal(await sentinelWrites(sentinel), 0, "… and writes nothing");
    assert.equal((await getJob(jobId)).status, "pending", "nor finishes the job");
  });

  it("free-slot claim: a busy slot claims nothing more", async () => {
    const queue = newQueue();
    const held = makeDeferred();
    let runs = 0;
    registerJobHandler(queue, { async run() { runs++; await held.promise; return { ok: true }; } });
    const a = await enqueueJob({ queue, payload: { n: 1 } });
    const b = await enqueueJob({ queue, payload: { n: 2 } });
    const tick = asyncJobsTick(db, new Date(), { queues: [queue], maxConcurrency: 1 });
    await until(() => runs === 1, "first job running");
    assert.equal((await getJob(b.jobId)).status, "pending", "the second job is not claimed while the only slot is busy");
    assert.equal((await getJob(b.jobId)).leaseToken, null);
    held.resolve();
    await tick;
    assert.equal((await getJob(a.jobId)).status, "done");
    assert.equal((await getJob(b.jobId)).status, "done", "claimed once the slot freed");
  });

  it("renewal finds a lost lease and stops that run's effects", async () => {
    const queue = newQueue();
    const sentinel = await makeSentinel();
    const started = makeDeferred();
    const release = makeDeferred();
    let refused = false;
    registerJobHandler(queue, {
      async run() {
        started.resolve();
        await release.promise;
        try { await bumpSentinel(sentinel); } catch (err) { refused = err instanceof JobOwnershipLostError; }
        return { ok: true };
      },
    });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    const tick = asyncJobsTick(db, new Date(), { queues: [queue] });
    await started.promise;
    await lapseLease(jobId);
    const { lost } = await renewHeldLeases(db);
    assert.equal(lost, 1, "renewal noticed");
    release.resolve();
    await tick;
    assert.ok(refused);
    assert.equal(await sentinelWrites(sentinel), 0);
  });

  it("a fenced helper called inside a fenced transaction does not wait on its own lock", async () => {
    const queue = newQueue();
    const sentinel = await makeSentinel();
    registerJobHandler(queue, {
      async run() {
        await fencedTransaction(db, async () => {
          await bumpSentinel(sentinel); // nested: must not lock the job row again
          await whileOwned(() => bumpSentinel(sentinel));
        });
        return { ok: true };
      },
    }, { executionLimitMs: 5_000 });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    await asyncJobsTick(db, new Date(), { queues: [queue] });
    assert.equal((await getJob(jobId)).status, "done", "finished, not stopped at its limit");
    assert.equal(await sentinelWrites(sentinel), 2);
  });

  it("a child enqueue that meets an in-flight duplicate inside a fenced write keeps the rest of the write", async () => {
    const queue = newQueue();
    const childQueue = newQueue();
    const sentinel = await makeSentinel();
    const key = randomUUID();
    const existing = await enqueueJob({ queue: childQueue, payload: {}, dedupeKey: key });
    let attached: Awaited<ReturnType<typeof enqueueJob>> | undefined;
    registerJobHandler(queue, {
      async run() {
        await fencedTransaction(db, async (tx) => {
          await tx.update(asyncJobsTable)
            .set({ result: { writes: 1 } })
            .where(eq(asyncJobsTable.id, sentinel));
          attached = await enqueueJob({ queue: childQueue, payload: {}, dedupeKey: key }, tx);
        });
        return { ok: true };
      },
    });
    await enqueueJob({ queue, payload: {} });
    await asyncJobsTick(db, new Date(), { queues: [queue] });
    assert.equal(attached?.inserted, false, "attached to the in-flight child");
    assert.equal(attached?.jobId, existing.jobId);
    assert.equal(await sentinelWrites(sentinel), 1, "the write beside it committed");
  });

  describe("one locked job row holds up no other job (PR #1009 round 1)", () => {
    /** Hold a row lock on one job row from another connection, as a long fenced write would. */
    async function holdRowLock(id: number): Promise<{ release: () => Promise<void> }> {
      const held = makeDeferred();
      const release = makeDeferred();
      const done = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM async_jobs WHERE id = ${id} FOR UPDATE`);
        held.resolve();
        await release.promise;
      });
      await held.promise;
      return { release: async () => { release.resolve(); await done; } };
    }

    /** Resolve within `ms`, or fail: "promptly", as an observable. */
    async function promptly<T>(p: Promise<T>, what: string, ms = 3_000): Promise<T> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not return within ${ms} ms`)), ms);
      });
      try { return await Promise.race([p, timeout]); } finally { clearTimeout(timer); }
    }

    /** Start a held job: its handler parks until released. Returns its id and release. */
    async function startHeldJob(): Promise<{ jobId: number; release: () => void; tick: Promise<void>; refused: () => boolean }> {
      const queue = newQueue();
      const started = makeDeferred();
      const release = makeDeferred();
      const sentinel = await makeSentinel();
      let refused = false;
      registerJobHandler(queue, {
        async run() {
          started.resolve();
          await release.promise;
          try { await bumpSentinel(sentinel); } catch (err) { refused = err instanceof JobOwnershipLostError; }
          return { ok: true };
        },
      });
      const { jobId } = await enqueueJob({ queue, payload: {} });
      const tick = asyncJobsTick(db, new Date(), { queues: [queue] });
      await started.promise;
      return { jobId, release: () => release.resolve(), tick, refused: () => refused };
    }

    it("renewal returns promptly past a locked job row, renews the others, and does not stop the locked one", async () => {
      const a = await startHeldJob();
      const b = await startHeldJob();
      // Pull both leases close to expiry so a renewal is visible.
      await db.execute(sql`UPDATE async_jobs SET lease_expires_at = now() + interval '10 seconds' WHERE id IN (${a.jobId}, ${b.jobId})`);
      const lock = await holdRowLock(a.jobId);
      const { lost } = await promptly(renewHeldLeases(db), "renewal");
      assert.equal(lost, 0, "a locked row is not a lost one");
      const bAfter = await getJob(b.jobId);
      assert.ok(bAfter.leaseExpiresAt!.getTime() - Date.now() > 60_000, "B's lease moved forward");
      await lock.release();
      await promptly(renewHeldLeases(db), "second renewal");
      const aAfter = await getJob(a.jobId);
      assert.ok(aAfter.leaseExpiresAt!.getTime() - Date.now() > 60_000, "A renewed once its lock cleared");
      a.release(); b.release();
      await Promise.all([a.tick, b.tick]);
      assert.equal(a.refused(), false, "A was never stopped");
      assert.equal((await getJob(a.jobId)).status, "done");
      assert.equal((await getJob(b.jobId)).status, "done");
    });

    it("renewal still returns promptly when the locked row's lease has lapsed, and reports only that one lost", async () => {
      const a = await startHeldJob();
      const b = await startHeldJob();
      await lapseLease(a.jobId);
      const lock = await holdRowLock(a.jobId);
      const { renewed, lost } = await promptly(renewHeldLeases(db), "renewal");
      await lock.release();
      assert.equal(lost, 1, "only A is lost");
      assert.equal(renewed, 1, "B is renewed");
      a.release(); b.release();
      await Promise.all([a.tick, b.tick]);
      assert.equal(a.refused(), true, "A's later write is refused");
      assert.equal((await getJob(b.jobId)).status, "done");
    });

    it("the reclaim sweep returns promptly past a locked eligible row and reclaims the others", async () => {
      const queue = newQueue();
      registerJobHandler(queue, { async run() { return { ok: true }; } }, { fastReclaim: true });
      const ids: number[] = [];
      for (let i = 0; i < 2; i++) {
        const { jobId } = await enqueueJob({ queue, payload: { i } });
        await db.update(asyncJobsTable).set({ status: "processing", leaseToken: randomUUID() })
          .where(eq(asyncJobsTable.id, jobId));
        await lapseLease(jobId, 1);
        ids.push(jobId);
      }
      const lock = await holdRowLock(ids[0]!);
      await promptly(recoverStuckProcessing(db), "reclaim sweep");
      assert.equal((await getJob(ids[1]!)).status, "pending", "the unlocked row is reclaimed");
      assert.equal((await getJob(ids[0]!)).status, "processing", "the locked row waits for a later sweep");
      await lock.release();
      await recoverStuckProcessing(db);
      assert.equal((await getJob(ids[0]!)).status, "pending", "and is taken on the next one");
    });
  });

  it("execution limit inside a fenced write: once released, the write is not committed", async () => {
    const queue = newQueue();
    const sentinel = await makeSentinel();
    const inside = makeDeferred();
    const release = makeDeferred();
    registerJobHandler(queue, {
      async run() {
        await fencedTransaction(db, async (tx) => {
          await tx.update(asyncJobsTable)
            .set({ result: { writes: 1 } })
            .where(eq(asyncJobsTable.id, sentinel));
          inside.resolve();
          await release.promise; // the limit fires while the callback waits
        });
        return { ok: true };
      },
    }, { executionLimitMs: 150 });
    const { jobId } = await enqueueJob({ queue, payload: {} });
    const tick = asyncJobsTick(db, new Date(), { queues: [queue] });
    await inside.promise;
    await new Promise((r) => setTimeout(r, 400)); // past the limit
    release.resolve();
    await tick;
    assert.equal(await sentinelWrites(sentinel), 0, "the write was rolled back");
    const after = await getJob(jobId);
    assert.equal(after.status, "pending");
    assert.equal(after.attempts, 1);
    assert.match(after.lastError ?? "", /execution limit/);
  });

  describe("recovering rows", () => {
    async function insertRecovering(queue: string, requires: number): Promise<number> {
      const [row] = await db.insert(asyncJobsTable).values({
        queue, payload: {}, status: "recovering", recoveryProtocol: requires,
        nextAttemptAt: new Date(Date.now() - 1000),
      }).returning();
      return row!.id;
    }

    it("release pairs: a worker whose handler declares no recovery, or too low a version, never claims a recovering row", async () => {
      const queue = newQueue();
      let runs = 0;
      const handler: JobHandler = { async run() { runs++; return { ok: true }; } };
      const id = await insertRecovering(queue, 2);

      registerJobHandler(queue, handler); // declares nothing (the earlier release)
      await asyncJobsTick(db, new Date(), { queues: [queue] });
      registerJobHandler(queue, handler, { recoveryProtocol: 1 }); // too old
      await asyncJobsTick(db, new Date(), { queues: [queue] });
      assert.equal(runs, 0);
      assert.equal((await getJob(id)).status, "recovering");

      registerJobHandler(queue, handler, { recoveryProtocol: 2 }); // capable
      await asyncJobsTick(db, new Date(), { queues: [queue] });
      assert.equal(runs, 1);
      assert.equal((await getJob(id)).status, "done");
    });

    it("a recovered job that fails again stays recovering, for a recovery-capable worker only", async () => {
      const queue = newQueue();
      registerJobHandler(queue, { async run() { return { ok: false, error: "download failed" }; } }, { recoveryProtocol: 1 });
      const id = await insertRecovering(queue, 1);
      await asyncJobsTick(db, new Date(), { queues: [queue] });
      const after = await getJob(id);
      assert.equal(after.status, "recovering");
      assert.equal(after.recoveryProtocol, 1);
      assert.equal(after.attempts, 1);
    });

    it("a reclaimed row of a recovery-declaring queue becomes recovering, stamped with the version it needs", async () => {
      const queue = newQueue();
      registerJobHandler(queue, { async run() { return { ok: true }; } }, { recoveryProtocol: 3, fastReclaim: true });
      const { jobId } = await enqueueJob({ queue, payload: {} });
      await db.update(asyncJobsTable).set({ status: "processing", leaseToken: randomUUID(), claimRecoveryProtocol: 3 })
        .where(eq(asyncJobsTable.id, jobId));
      await lapseLease(jobId);
      await recoverStuckProcessing(db);
      const after = await getJob(jobId);
      assert.equal(after.status, "recovering");
      assert.equal(after.recoveryProtocol, 3);
    });

    it("dedupe: enqueueing a job whose key matches a recovering row is refused as a duplicate", async () => {
      const queue = newQueue();
      const key = randomUUID();
      const [row] = await db.insert(asyncJobsTable).values({
        queue, payload: {}, status: "recovering", recoveryProtocol: 1, dedupeKey: key,
      }).returning();
      const again = await enqueueJob({ queue, payload: {}, dedupeKey: key });
      assert.equal(again.inserted, false);
      assert.equal(again.jobId, row!.id);
      assert.equal(again.status, "recovering");
      const rows = await db.select().from(asyncJobsTable).where(inArray(asyncJobsTable.queue, [queue]));
      assert.equal(rows.length, 1);
    });
  });
});
