/**
 * The recurring-task inventory (launch Phase 16, increment 2;
 * lib/recurringTasks.ts) against the timers the source actually holds, and
 * the completion record the health check reads.
 *
 * The class is "every timer that does recurring work"; the oracle is
 * `git grep -n "setInterval\|setTimeout" -- artifacts/api-server/src`. This
 * test counts `setInterval(` / `setTimeout(` calls per file (tests excluded)
 * and fails when a file gains or loses one the inventory does not account for.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@workspace/db";
import { workerLaneHeartbeatsTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";
import {
  RECURRING_TASKS,
  TIMER_SITES,
  TASK_LANE_PREFIX,
  recordTaskCompleted,
  beginTaskMonitoring,
  taskHealth,
  taskLane,
  nextRunDelayMs,
  RETRY_AFTER_FAILURE_MS,
  __resetTaskRecordThrottleForTest,
} from "../lib/recurringTasks.js";
import { laneHealth } from "../lib/queueHealth.js";
import { pruneDepartedInstances } from "../lib/workerHeartbeats.js";
import { DRILL_HOLD_MS } from "../lib/operationsDrill.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMER_CALL = /\bset(?:Interval|Timeout)\(/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sourceFiles(p));
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("the recurring-task inventory", () => {
  it("accounts for every timer call in the API source, file by file", () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(SRC)) {
      const n = readFileSync(file, "utf8").match(TIMER_CALL)?.length ?? 0;
      if (n > 0) found[relative(SRC, file)] = n;
    }
    const inventoried = Object.fromEntries(TIMER_SITES.map((s) => [s.file, s.calls]));
    assert.deepEqual(
      found,
      inventoried,
      "a timer was added or removed: classify it in TIMER_SITES (lib/recurringTasks.ts) — a recurring task, a job lane, or not recurring with the reason",
    );
  });

  it("every task names a site that is a tasks site, and every tasks site has a task", () => {
    const taskSites = new Set(TIMER_SITES.filter((s) => s.kind === "tasks").map((s) => s.file));
    for (const t of RECURRING_TASKS) assert.ok(taskSites.has(t.site), `${t.id}'s site ${t.site} is not a tasks site`);
    for (const file of taskSites) assert.ok(RECURRING_TASKS.some((t) => t.site === file), `${file} schedules no task`);
  });

  it("every task records its completed runs somewhere in the source", () => {
    const all = sourceFiles(SRC).filter((f) => !f.endsWith("recurringTasks.ts")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const task of RECURRING_TASKS) {
      assert.ok(all.includes(`recordTaskCompleted("${task.id}")`), `${task.id} never records a completed run`);
    }
  });

  it("every task's row fits the lane column", () => {
    for (const task of RECURRING_TASKS) assert.ok(taskLane(task.id).length <= 32, task.id);
  });
});

// The phone alert of 2026-11-18: the hourly session sweep failed once on a
// production database that timed out, waited the full hour to try again, and
// the health check called the site down for half an hour. A single failed run
// is not a stopped task; every task but the ones that say why must try again
// soon enough that one failure never makes it overdue.
describe("one failed run never makes a task overdue", () => {
  it("retries after a failure, and keeps the cadence after a success", () => {
    const HOUR = 60 * 60 * 1000;
    assert.equal(nextRunDelayMs(true, HOUR), HOUR);
    assert.equal(nextRunDelayMs(false, HOUR), RETRY_AFTER_FAILURE_MS);
    // Never later than the cadence itself.
    assert.equal(nextRunDelayMs(false, 20_000), 20_000);
  });

  it("fits a retry inside every task's grace, unless the task says why it does not retry", async () => {
    for (const task of RECURRING_TASKS) {
      if ("noRetryAfterFailure" in task) {
        assert.ok(task.noRetryAfterFailure.length > 20, `${task.id} must say why it does not retry`);
        continue;
      }
      const cadence = await task.cadenceMs();
      assert.ok(
        nextRunDelayMs(false, cadence) < task.graceMs,
        `${task.id}: a retry after one failure (${nextRunDelayMs(false, cadence)} ms) must land inside its grace (${task.graceMs} ms)`,
      );
    }
  });

  it("every hourly scheduler waits the retry delay, not the full hour, after a failure", () => {
    // The schedulers are closures in index.ts and membershipSchedules.ts; this
    // pins that each one routes its next delay through nextRunDelayMs, so a new
    // or edited scheduler that hard-codes the hour again fails here.
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    for (const hardCoded of ["schedule(HOURLY_MS);", "schedule(60 * 60 * 1000);"]) {
      assert.ok(!index.includes(hardCoded), `index.ts reschedules with ${hardCoded} regardless of failure`);
    }
    assert.ok(!/setInterval\(/.test(index), "index.ts has a setInterval, which cannot retry a failed run early");
    const membership = readFileSync(join(SRC, "lib/membershipSchedules.ts"), "utf8");
    assert.ok(membership.includes("nextRunDelayMs(ok, intervalMs)"), "the grace sweep must retry a failed run early");
    assert.ok(!/setInterval\(/.test(membership), "the grace sweep must not run on a fixed interval");
  });
});

describe("the completion record", () => {
  beforeEach(async () => {
    await db.delete(workerLaneHeartbeatsTable).where(like(workerLaneHeartbeatsTable.lane, `${TASK_LANE_PREFIX}%`));
    __resetTaskRecordThrottleForTest(new Date());
  });

  it("a task never completed is judged from when monitoring began", async () => {
    await beginTaskMonitoring();
    const fresh = await taskHealth();
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((t) => !t.overdue && t.lastCompletedAt === null && t.monitoredSince !== null));
    const muchLater = new Date(Date.now() + 30 * 3_600_000);
    const later = await taskHealth(db, muchLater);
    assert.ok(later.every((t) => t.overdue), "every task is overdue once a day and more has passed with no run");
  });

  it("a completed run clears the task; the next missed one makes it overdue", async () => {
    await beginTaskMonitoring();
    await recordTaskCompleted("content_purge");
    const t0 = (await taskHealth()).find((t) => t.id === "content_purge")!;
    assert.ok(t0.lastCompletedAt);
    assert.equal(t0.overdue, false);
    const at = new Date(t0.lastCompletedAt!.getTime() + 60 * 60_000 + 31 * 60_000);
    const t1 = (await taskHealth(db, at)).find((t) => t.id === "content_purge")!;
    assert.equal(t1.overdue, true, "an hourly task with no run for 91 minutes is overdue");
  });

  it("the finished-job purge survives a long healthy bulk batch and the drill's hold, and is overdue once really stopped", async () => {
    // It runs only between the bulk lane's batches (PR #1046 round 1): a
    // batch can hold the lane for longer than any one job's 45-minute limit.
    await beginTaskMonitoring();
    await recordTaskCompleted("job_retention_purge");
    const at = (ms: number) => taskHealth(db, new Date(Date.now() + ms)).then((h) => h.find((t) => t.id === "job_retention_purge")!);
    assert.equal((await at(DRILL_HOLD_MS + 2 * 60_000)).overdue, false, "through the drill's hold");
    assert.equal((await at(46 * 60_000)).overdue, false, "past the longest bulk execution limit");
    assert.equal((await at(3 * 3_600_000)).overdue, false, "a long batch of several jobs");
    assert.equal((await at(6 * 3_600_000 + 2 * 60_000)).overdue, true, "really stopped");
  });

  it("with no row at all, a task is judged from this process's start", async () => {
    __resetTaskRecordThrottleForTest(new Date(Date.now() - 3 * 3_600_000));
    const row = (await taskHealth()).find((t) => t.id === "content_purge")!;
    assert.equal(row.monitoredSince, null);
    assert.equal(row.overdue, true);
  });

  it("keeps when monitoring began across restarts, and survives the lane pruning", async () => {
    await beginTaskMonitoring();
    const before = (await taskHealth()).find((t) => t.id === "account_deletion")!.monitoredSince!;
    await beginTaskMonitoring();
    const after = (await taskHealth()).find((t) => t.id === "account_deletion")!.monitoredSince!;
    assert.equal(after.getTime(), before.getTime());
    // A TTL of zero would remove every lane row whose schedule is older than now.
    await new Promise((r) => setTimeout(r, 5));
    await pruneDepartedInstances(db, 0);
    assert.ok((await taskHealth()).find((t) => t.id === "account_deletion")!.monitoredSince, "task rows are not lane rows");
  });

  it("removes the row of a task this release no longer has", async () => {
    await db.insert(workerLaneHeartbeatsTable).values({
      instanceId: "recurring-task",
      lane: `${TASK_LANE_PREFIX}retired_task`,
      workerProtocolVersion: 0,
    });
    await beginTaskMonitoring();
    const left = await db.select().from(workerLaneHeartbeatsTable).where(like(workerLaneHeartbeatsTable.lane, `${TASK_LANE_PREFIX}retired%`));
    assert.equal(left.length, 0);
  });

  it("task rows do not change any lane's verdict", async () => {
    await beginTaskMonitoring();
    const lanes = await laneHealth();
    assert.deepEqual(lanes.map((l) => l.lane), ["fast", "render", "bulk", "ai_meme_backfill"]);
  });
});
