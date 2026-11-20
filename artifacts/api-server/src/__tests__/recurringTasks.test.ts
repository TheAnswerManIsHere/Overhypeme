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
  type RecurringTaskId,
} from "../lib/recurringTasks.js";
import { scheduleRecurringTask, msUntilNextTopOfHour } from "../lib/taskScheduler.js";
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

  it("every task names a site that schedules it, and every timer site but the shared scheduler has a task", () => {
    const timerSites = new Set(TIMER_SITES.filter((s) => s.kind === "tasks").map((s) => s.file));
    const callerSites = new Set(
      sourceFiles(SRC)
        .filter((f) => readFileSync(f, "utf8").includes("scheduleRecurringTask({"))
        .map((f) => relative(SRC, f)),
    );
    for (const t of RECURRING_TASKS) {
      assert.ok(timerSites.has(t.site) || callerSites.has(t.site), `${t.id}'s site ${t.site} neither holds a task timer nor calls scheduleRecurringTask`);
    }
    for (const file of timerSites) {
      if (file === "lib/taskScheduler.ts") continue;
      assert.ok(RECURRING_TASKS.some((t) => t.site === file), `${file} schedules no task`);
    }
  });

  it("every task records its completed runs: directly, or as a step of the shared scheduler in its site", () => {
    const all = sourceFiles(SRC).filter((f) => !f.endsWith("recurringTasks.ts")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const task of RECURRING_TASKS) {
      const site = readFileSync(join(SRC, task.site), "utf8");
      // Directly, best-effort, or exactly inside a transaction (Fact of the Day's mark commits with its emails).
      const direct = all.includes(`recordTaskCompleted("${task.id}")`) || all.includes(`writeTaskCompletion("${task.id}"`);
      const asStep = site.includes("scheduleRecurringTask({") && site.includes(`id: "${task.id}"`);
      assert.ok(direct || asStep, `${task.id} never records a completed run`);
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

  it("fits a retry inside every task's grace", async () => {
    for (const task of RECURRING_TASKS) {
      const cadence = await task.cadenceMs();
      assert.ok(
        nextRunDelayMs(false, cadence) < task.graceMs,
        `${task.id}: a retry after one failure (${nextRunDelayMs(false, cadence)} ms) must land inside its grace (${task.graceMs} ms)`,
      );
    }
  });

  it("index.ts and the grace sweep hold no task timer of their own", () => {
    // Every other task there runs on the shared scheduler, whose rules the
    // tests below drive; a hand-rolled timer would carry its own copy of them.
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    assert.equal(index.match(/\bsetTimeout\(/g)?.length, 2, "index.ts: the meme-bake backfill and the exit safety timer only");
    assert.ok(!/setInterval\(/.test(index));
    const membership = readFileSync(join(SRC, "lib/membershipSchedules.ts"), "utf8");
    assert.ok(!/set(?:Timeout|Interval)\(/.test(membership), "the grace sweep must run on the shared scheduler");
  });
});

describe("a restart never makes a task overdue", () => {
  it("every task first runs inside its grace after a start", () => {
    for (const task of RECURRING_TASKS) {
      assert.ok(
        task.firstRunMs < task.graceMs,
        `${task.id}: its first run after a start (${task.firstRunMs} ms) must land inside its grace (${task.graceMs} ms)`,
      );
    }
  });

});

// The shared scheduler (lib/taskScheduler.ts), driven with an injected timer
// and recorder: the three routes that each paged "site down" with nothing
// stopped (Issues #1061, #1086, #1076) as behaviour, not as source text.
describe("the shared scheduler", () => {
  const HOUR = 60 * 60 * 1000;
  function harness(opts: { record?: (id: RecurringTaskId) => Promise<boolean> } = {}) {
    const delays: number[] = [];
    let pending: (() => void) | null = null;
    const setTimer = (fn: () => void, ms: number) => {
      delays.push(ms);
      pending = fn;
    };
    const fire = async () => {
      const fn = pending!;
      pending = null;
      fn();
      for (let i = 0; i < 50 && pending === null; i++) await new Promise((r) => setImmediate(r));
    };
    const recorded: string[] = [];
    const record = opts.record ?? (async (id: RecurringTaskId) => (recorded.push(id), true));
    return { delays, fire, recorded, setTimer, record };
  }

  it("first runs when the inventory says, for every task it can schedule", () => {
    for (const task of RECURRING_TASKS) {
      const h = harness();
      scheduleRecurringTask({ cadenceMs: HOUR, steps: [{ id: task.id, run: async () => {} }], setTimer: h.setTimer, record: h.record });
      assert.equal(h.delays[0], Math.min(HOUR, task.firstRunMs), `${task.id}'s first run`);
    }
  });

  it("a failed run is retried in minutes; a success waits the cadence and records", async () => {
    let fail = true;
    const h = harness();
    scheduleRecurringTask({
      cadenceMs: HOUR,
      steps: [{ id: "session_sweep", run: async () => { if (fail) throw new Error("Authentication timed out"); } }],
      setTimer: h.setTimer,
      record: h.record,
    });
    await h.fire();
    assert.equal(h.delays.at(-1), RETRY_AFTER_FAILURE_MS);
    assert.deepEqual(h.recorded, []);
    fail = false;
    await h.fire();
    assert.equal(h.delays.at(-1), HOUR);
    assert.deepEqual(h.recorded, ["session_sweep"]);
  });

  it("a run whose completion could not be recorded is retried in minutes, not a cadence later", async () => {
    const h = harness({ record: async () => false });
    scheduleRecurringTask({ cadenceMs: HOUR, steps: [{ id: "content_purge", run: async () => {} }], setTimer: h.setTimer, record: h.record });
    await h.fire();
    assert.equal(h.delays.at(-1), RETRY_AFTER_FAILURE_MS);
  });

  it("one failing step does not stop the others on its timer, and the timer retries soon", async () => {
    const h = harness();
    scheduleRecurringTask({
      cadenceMs: HOUR,
      steps: [
        { id: "session_sweep", run: async () => { throw new Error("down"); } },
        { id: "retention_windows", run: async () => {} },
      ],
      setTimer: h.setTimer,
      record: h.record,
    });
    await h.fire();
    assert.deepEqual(h.recorded, ["retention_windows"]);
    assert.equal(h.delays.at(-1), RETRY_AFTER_FAILURE_MS);
  });

  it("a clock-aligned task waits for its next mark after a success, and a backlog's follow-up wins over the cadence", async () => {
    const clock = harness();
    scheduleRecurringTask({ cadenceMs: HOUR, nextMarkMs: () => 1234, steps: [{ id: "transient_render_purge", run: async () => {} }], setTimer: clock.setTimer, record: clock.record });
    await clock.fire();
    assert.equal(clock.delays.at(-1), 1234);
    const backlog = harness();
    scheduleRecurringTask({ cadenceMs: HOUR, steps: [{ id: "rate_limit_counter_purge", run: async () => ({ followUpMs: 60_000 }) }], setTimer: backlog.setTimer, record: backlog.record });
    await backlog.fire();
    assert.equal(backlog.delays.at(-1), 60_000);
  });

  it("the next top of the hour is never more than an hour away", () => {
    assert.equal(msUntilNextTopOfHour(new Date("2026-11-20T10:59:30Z")), 30_000);
    assert.equal(msUntilNextTopOfHour(new Date("2026-11-20T10:00:00Z")), HOUR);
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
