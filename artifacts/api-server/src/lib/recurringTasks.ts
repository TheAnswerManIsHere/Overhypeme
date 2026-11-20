/**
 * @purpose The inventory of every timer in the API that does recurring work, and the record of each task's last completed run, so a task whose timer still fires while its work has stopped reads as overdue on the health check.
 * @subsystem operations
 *
 * Launch Phase 16, increment 2 (Issue #1029; plan
 * `docs/plans/PLAN_PHASE16_ANALYTICS_OPERATIONS.md`, design A, "Jobs stopped
 * or wedged").
 *
 * Three things live here, and a test (`recurringTasks.test.ts`) holds them
 * together:
 *
 *  - `TIMER_SITES` — every `setInterval` or `setTimeout` call in
 *    `artifacts/api-server/src` outside tests, by file and count, each
 *    classified: a recurring task below, a job lane (watched by the lane
 *    check), or not recurring work at all, with the reason. The class is
 *    "every timer that does recurring work"; its oracle is
 *    `git grep -n "setInterval\|setTimeout" -- artifacts/api-server/src`. The
 *    test fails when a file gains or loses a timer this table does not know:
 *    checked, not impossible to miss.
 *  - `RECURRING_TASKS` — each task's cadence (from the scheduler's own
 *    configuration), its first run after a start, and the grace past which a
 *    missing completion is an alert.
 *  - The completion record: one row per task in `worker_lane_heartbeats`
 *    (`lane = "task:<id>"`, a fleet-wide `instance_id`), written when a run
 *    **completes**, a successful no-op included, never when the timer merely
 *    fires. Its `last_scheduled_at` is set once, when monitoring of the task
 *    began, and is the reference for a task that has never completed. These
 *    rows are kept on a task-aware rule (a retired task's row is removed at
 *    boot), not by the 15-minute lane pruning, so they survive a restart.
 *
 * Every write here is best-effort: a completion record that fails is logged
 * and dropped, and never fails the task it describes.
 */
import { and, inArray, like, notInArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@workspace/db";
import { workerLaneHeartbeatsTable } from "@workspace/db/schema";
import { getConfigInt } from "./adminConfig";
import { logger } from "./logger";
import { TASK_LANE_PREFIX } from "./workerHeartbeats";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The `instance_id` every task row carries: a task's completion is a fleet-wide fact. */
export const TASK_INSTANCE_ID = "recurring-task";
export { TASK_LANE_PREFIX };

export interface RecurringTask {
  id: string;
  /** What David reads on the Operations page. */
  label: string;
  /** The file that schedules it: its own timer there, or a `scheduleRecurringTask` call there (lib/taskScheduler.ts). */
  site: string;
  /** The interval between runs, from the same configuration the scheduler reads. */
  cadenceMs: () => Promise<number> | number;
  /**
   * The longest wait from a process start to its first run. It must be
   * shorter than `graceMs`: the deadline counts from the last completion, whichever
   * process made it, so a restart just before a run is due pushes the next
   * run to the restart plus this, and a first run later than the grace makes
   * every such restart page as a stopped task (the grace sweep, 2026-11-19).
   */
  firstRunMs: number;
  /** How far past its expected run a missing completion may go before it is an alert. */
  graceMs: number;
  /** False where the task deliberately does not run (the media backup outside the published deployment). */
  runsHere?: () => boolean;
}

/**
 * How soon a task tries again after a run that failed. Five minutes: long
 * enough that a database waking up or a provider's blip has passed, short
 * enough that several attempts fit inside the shortest hourly grace (30
 * minutes) before the health check calls the task overdue.
 */
export const RETRY_AFTER_FAILURE_MS = 5 * MINUTE;

/** A task's first run after a process start, as the inventory declares it: the scheduler reads it from here so the two cannot drift. */
export function taskFirstRunMs(id: RecurringTaskId): number {
  return RECURRING_TASKS.find((t) => t.id === id)!.firstRunMs;
}

/** The wait before a task's next run: its cadence after a success, the retry delay (never longer than the cadence) after a failure. */
export function nextRunDelayMs(succeeded: boolean, cadenceMs: number): number {
  return succeeded ? cadenceMs : Math.min(RETRY_AFTER_FAILURE_MS, cadenceMs);
}

export const RECURRING_TASKS = [
  {
    id: "pricing_refresh",
    label: "Image engine price refresh",
    site: "index.ts",
    cadenceMs: () => getConfigInt("pricing_refresh_interval_ms", HOUR),
    firstRunMs: 0,
    graceMs: 30 * MINUTE,
  },
  {
    id: "transient_render_purge",
    label: "Transient render log purge",
    site: "index.ts",
    cadenceMs: () => HOUR,
    // Once a couple of minutes after a start (a restart straddling the top of
    // the hour never skips a run), then at the top of every hour.
    firstRunMs: 2 * MINUTE,
    graceMs: 30 * MINUTE,
  },
  {
    id: "provenance_retention_purge",
    label: "Image provenance retention purge",
    site: "index.ts",
    cadenceMs: () => HOUR,
    // Once a couple of minutes after a start (a restart straddling the top of
    // the hour never skips a run), then at the top of every hour.
    firstRunMs: 2 * MINUTE,
    graceMs: 30 * MINUTE,
  },
  {
    id: "rate_limit_counter_purge",
    label: "Rate-limit counter purge",
    site: "index.ts",
    cadenceMs: () => HOUR,
    firstRunMs: MINUTE,
    graceMs: 30 * MINUTE,
  },
  {
    id: "content_purge",
    label: "Deleted content purge",
    site: "index.ts",
    cadenceMs: () => HOUR,
    firstRunMs: 5 * MINUTE,
    graceMs: 30 * MINUTE,
  },
  {
    id: "account_deletion",
    label: "Account deletion worker",
    site: "index.ts",
    cadenceMs: () => HOUR,
    firstRunMs: 7 * MINUTE,
    graceMs: 30 * MINUTE,
  },
  {
    id: "session_sweep",
    label: "Expired sign-in session sweep",
    site: "index.ts",
    cadenceMs: () => HOUR,
    firstRunMs: 9 * MINUTE,
    graceMs: 30 * MINUTE,
  },
  {
    id: "retention_windows",
    label: "Retention window deletions",
    site: "index.ts",
    cadenceMs: () => HOUR,
    firstRunMs: 9 * MINUTE,
    graceMs: 30 * MINUTE,
  },
  {
    id: "media_backup",
    label: "Media backup",
    site: "index.ts",
    cadenceMs: () => HOUR,
    firstRunMs: 5 * MINUTE,
    graceMs: 30 * MINUTE,
    runsHere: () => process.env.REPLIT_DEPLOYMENT === "1",
  },
  {
    id: "fact_of_the_day",
    label: "Fact of the Day",
    site: "index.ts",
    cadenceMs: () => 24 * HOUR,
    // At 09:00 UTC, and a few minutes after any start: a start whose send
    // period has no recorded send catches up at once, so a restart at 09:00
    // never skips the day. Sending at most once a period, across every
    // instance, is jobs/factOfTheDay.ts's (runDailyFactOfTheDay), which is
    // what makes a retry after a failure safe too.
    firstRunMs: 5 * MINUTE,
    graceMs: 3 * HOUR,
  },
  {
    id: "oauth_state_sweep",
    label: "Expired sign-in state sweep",
    site: "routes/auth.ts",
    cadenceMs: () => 5 * MINUTE,
    firstRunMs: 5 * MINUTE,
    graceMs: 10 * MINUTE,
  },
  {
    id: "grace_sweep",
    label: "Membership grace sweep",
    site: "lib/membershipSchedules.ts",
    cadenceMs: async () => {
      const { loadMembershipConfig } = await import("./membershipTiming");
      return (await loadMembershipConfig()).grace_sweep_interval_seconds * SECOND;
    },
    // Soon after a start, not a full interval later, so a restart never
    // pushes it past its deadline. Not at the first instant: a run is up to
    // 500 recompute transactions, and the boot is the busiest minute there is.
    firstRunMs: 3 * MINUTE,
    graceMs: 30 * MINUTE,
  },
  {
    id: "lease_renewal",
    label: "Job lease renewal",
    site: "lib/asyncJobs.ts",
    cadenceMs: () => 20 * SECOND,
    firstRunMs: 20 * SECOND,
    graceMs: 10 * MINUTE,
  },
  {
    id: "job_reclaim",
    label: "Stopped-job reclaim sweep",
    site: "lib/asyncJobs.ts",
    cadenceMs: () => 30 * SECOND,
    firstRunMs: 0,
    graceMs: 10 * MINUTE,
  },
  {
    id: "job_retention_purge",
    label: "Finished-job purge",
    site: "lib/asyncJobs.ts",
    cadenceMs: () => MINUTE,
    firstRunMs: MINUTE,
    // It runs between the bulk lane's batches, not on a timer of its own, and
    // a healthy batch holds the lane for as long as its jobs take: up to ten
    // claims over three slots, with execution limits up to 45 minutes. A
    // deadline a healthy batch cannot reach is hours; a stopped purge costs
    // nothing for days (finished rows are kept 30 days). PR #1046 round 1.
    graceMs: 6 * HOUR,
  },
] as const satisfies readonly RecurringTask[];

export type RecurringTaskId = (typeof RECURRING_TASKS)[number]["id"];

/** Where a timer call sits and what it is, for every file under `src` that has one. */
export type TimerSite =
  | { file: string; calls: number; kind: "tasks"; note: string }
  | { file: string; calls: number; kind: "job-lanes"; note: string }
  | { file: string; calls: number; kind: "not-recurring"; note: string };

/**
 * Every file in `artifacts/api-server/src` (tests excluded) holding a
 * `setInterval` or `setTimeout` call, with how many. A site may hold both
 * recurring and one-off timers; `note` says which is which. A `tasks` site's
 * tasks are the `RECURRING_TASKS` entries whose `site` is that file.
 */
export const TIMER_SITES: readonly TimerSite[] = [
  {
    file: "index.ts",
    calls: 2,
    kind: "not-recurring",
    note:
      "The meme-bake backfill (once per boot) and the fatal-exit safety timer. Every recurring task scheduled here runs on lib/taskScheduler.ts.",
  },
  {
    file: "lib/taskScheduler.ts",
    calls: 1,
    kind: "tasks",
    note:
      "The shared scheduler: one timer per scheduled task, armed by a scheduleRecurringTask call in the task's own site (index.ts, lib/membershipSchedules.ts).",
  },
  { file: "routes/auth.ts", calls: 1, kind: "tasks", note: "Expired sign-in states, every 5 minutes." },
  {
    file: "lib/asyncJobs.ts",
    calls: 2,
    kind: "tasks",
    note:
      "One shared scheduler drives the four job lanes (watched by the lane check), lease renewal and reclaim; the finished-job purge runs inside the bulk lane's tick. The other call is a run's execution limit, one per job.",
  },
  {
    file: "lib/stripeInit.ts",
    calls: 2,
    kind: "not-recurring",
    note:
      "A boot verification timeout, and a retry armed only until Stripe setup completes (its state is on the Billing page); neither is steady recurring work.",
  },
  {
    file: "lib/globalRateLimitStore.ts",
    calls: 1,
    kind: "not-recurring",
    note: "In-memory expiry of the request limiter's keys: no database, no work that can quietly stop mattering.",
  },
  { file: "lib/operationsDrill.ts", calls: 1, kind: "not-recurring", note: "The drill job's wait, inside one run." },
  { file: "lib/bookkeepingTimeout.ts", calls: 1, kind: "not-recurring", note: "A per-call timeout." },
  { file: "lib/cliJobPoller.ts", calls: 1, kind: "not-recurring", note: "A sleep between polls of one job." },
  { file: "lib/comparison/transport.ts", calls: 1, kind: "not-recurring", note: "A retry backoff." },
  { file: "lib/falPricing.ts", calls: 1, kind: "not-recurring", note: "Pacing between price requests." },
  { file: "lib/membershipLease.ts", calls: 2, kind: "not-recurring", note: "Retry backoffs." },
  { file: "lib/membershipRefresh.ts", calls: 2, kind: "not-recurring", note: "A timeout and a retry backoff." },
  { file: "lib/moderation/arachnid.ts", calls: 1, kind: "not-recurring", note: "A request timeout." },
  { file: "lib/moderation/nsfwClassifier.ts", calls: 2, kind: "not-recurring", note: "Request timeouts." },
  { file: "lib/renderRequestRecovery.ts", calls: 1, kind: "not-recurring", note: "An abortable sleep." },
  { file: "routes/admin.ts", calls: 1, kind: "not-recurring", note: "A retry backoff inside one request." },
  { file: "shutdown.ts", calls: 1, kind: "not-recurring", note: "The forced-exit timer at shutdown." },
  { file: "testing/acceptance/driver.ts", calls: 1, kind: "not-recurring", note: "Test tooling." },
  { file: "testing/acceptance/inner.ts", calls: 1, kind: "not-recurring", note: "Test tooling." },
  { file: "testing/acceptance/selfTest.ts", calls: 1, kind: "not-recurring", note: "Test tooling." },
  { file: "testing/acceptance/sink.ts", calls: 1, kind: "not-recurring", note: "Test tooling." },
  { file: "testing/sentryLeakProbe.ts", calls: 1, kind: "not-recurring", note: "Test tooling: waits once for the stub transport to flush." },
];

type TaskDb = Pick<typeof defaultDb, "insert" | "delete" | "select">;

export function taskLane(id: RecurringTaskId): string {
  return `${TASK_LANE_PREFIX}${id}`;
}

/** This process's start: the reference for a task with no record at all. */
let processStartedAt = new Date();

/** Writes at most this often per task per process: a 20-second timer need not write every 20 seconds. */
const RECORD_MIN_INTERVAL_MS = MINUTE;
const lastRecordedAt = new Map<string, number>();

/**
 * Record that one run of a task completed. Never throws, and called only once
 * the run's work is done. Resolves false when the record could not be saved:
 * the health check then cannot see the run, so a scheduler treats it like a
 * failed run and tries again soon (taskScheduler.ts), rather than waiting a
 * cadence and reading as overdue (Issue #1076). True when it was saved, or
 * skipped by the write throttle because a save within the last minute stands.
 */
export async function recordTaskCompleted(id: RecurringTaskId, dbInstance: TaskDb = defaultDb): Promise<boolean> {
  const now = Date.now();
  const last = lastRecordedAt.get(id);
  if (last !== undefined && now - last < RECORD_MIN_INTERVAL_MS) return true;
  lastRecordedAt.set(id, now);
  try {
    await writeTaskCompletion(id, new Date(now), dbInstance);
    return true;
  } catch (err) {
    lastRecordedAt.delete(id);
    logger.warn({ err, task: id }, "[recurringTasks] could not record a completed run");
    return false;
  }
}

/**
 * Write one task's completion, exactly: no throttle, and it throws when it
 * fails. For a caller whose completion is part of a transaction (Fact of the
 * Day's mark commits with its queued emails); recordTaskCompleted is the
 * best-effort form every other task uses.
 */
export async function writeTaskCompletion(id: RecurringTaskId, at: Date, dbInstance: Pick<typeof defaultDb, "insert">): Promise<void> {
  await dbInstance
    .insert(workerLaneHeartbeatsTable)
    .values({
      instanceId: TASK_INSTANCE_ID,
      lane: taskLane(id),
      // 0: not a job worker; no protocol is claimed for this row.
      workerProtocolVersion: 0,
      lastScheduledAt: at,
      lastTickCompletedAt: at,
    })
    .onConflictDoUpdate({
      target: [workerLaneHeartbeatsTable.instanceId, workerLaneHeartbeatsTable.lane],
      // `last_scheduled_at` keeps when monitoring began; only the completion advances.
      set: {
        lastTickCompletedAt: sql`GREATEST(${workerLaneHeartbeatsTable.lastTickCompletedAt}, ${at})`,
        updatedAt: at,
      },
    });
}

/**
 * At boot: mark when monitoring began for every task that runs here (a row
 * that already exists keeps its date), and remove the rows of tasks this
 * release no longer has. Best-effort.
 */
export async function beginTaskMonitoring(dbInstance: TaskDb = defaultDb): Promise<void> {
  const now = new Date();
  const lanes = RECURRING_TASKS.map((t) => taskLane(t.id));
  try {
    const here = RECURRING_TASKS.filter((t) => taskRunsHere(t));
    if (here.length > 0) {
      await dbInstance
        .insert(workerLaneHeartbeatsTable)
        .values(here.map((t) => ({ instanceId: TASK_INSTANCE_ID, lane: taskLane(t.id), workerProtocolVersion: 0, lastScheduledAt: now })))
        .onConflictDoNothing();
    }
    await dbInstance
      .delete(workerLaneHeartbeatsTable)
      .where(and(like(workerLaneHeartbeatsTable.lane, `${TASK_LANE_PREFIX}%`), notInArray(workerLaneHeartbeatsTable.lane, lanes)));
  } catch (err) {
    logger.warn({ err }, "[recurringTasks] could not begin task monitoring");
  }
}

const taskRunsHere = (task: RecurringTask): boolean => task.runsHere?.() ?? true;

export interface TaskHealth {
  id: RecurringTaskId;
  label: string;
  cadenceMs: number;
  /** Null when no run has completed since monitoring began. */
  lastCompletedAt: Date | null;
  /** Null when monitoring has not begun (no row: this release has not booted here yet). */
  monitoredSince: Date | null;
  /** When a missing completion becomes an alert. */
  dueBy: Date;
  overdue: boolean;
}

/**
 * Every task that runs here, with whether its last completed run is overdue.
 * Throws when it cannot read: the caller answers that as unhealthy.
 */
export async function taskHealth(
  dbInstance: Pick<typeof defaultDb, "select"> = defaultDb,
  now: Date = new Date(),
): Promise<TaskHealth[]> {
  const tasks = RECURRING_TASKS.filter((t) => taskRunsHere(t));
  const rows = await dbInstance
    .select({
      lane: workerLaneHeartbeatsTable.lane,
      monitoredSince: workerLaneHeartbeatsTable.lastScheduledAt,
      lastCompletedAt: workerLaneHeartbeatsTable.lastTickCompletedAt,
    })
    .from(workerLaneHeartbeatsTable)
    .where(and(
      sql`${workerLaneHeartbeatsTable.instanceId} = ${TASK_INSTANCE_ID}`,
      inArray(workerLaneHeartbeatsTable.lane, tasks.map((t) => taskLane(t.id))),
    ));
  const byLane = new Map(rows.map((r) => [r.lane, r]));
  const cadences = await Promise.all(tasks.map((t) => t.cadenceMs()));
  const out: TaskHealth[] = [];
  for (const [i, task] of tasks.entries()) {
    const cadenceMs = cadences[i]!;
    const row = byLane.get(taskLane(task.id));
    const lastCompletedAt = row?.lastCompletedAt ? new Date(row.lastCompletedAt) : null;
    const monitoredSince = row?.monitoredSince ? new Date(row.monitoredSince) : null;
    // The reference for a task that has never completed is when monitoring
    // began; with no row at all (the boot marker failed), this process's own
    // start, so a missing row can never hide a task that never ran.
    const firstReference = monitoredSince ?? processStartedAt;
    const dueBy = lastCompletedAt
      ? new Date(lastCompletedAt.getTime() + cadenceMs + task.graceMs)
      : new Date(firstReference.getTime() + Math.max(cadenceMs, task.firstRunMs) + task.graceMs);
    out.push({
      id: task.id,
      label: task.label,
      cadenceMs,
      lastCompletedAt,
      monitoredSince,
      dueBy,
      overdue: now.getTime() > dueBy.getTime(),
    });
  }
  return out;
}

/** When a task's last run completed, fleet-wide; null when none has. Throws when it cannot read. */
export async function lastTaskCompletion(
  id: RecurringTaskId,
  dbInstance: Pick<typeof defaultDb, "select"> = defaultDb,
): Promise<Date | null> {
  const [row] = await dbInstance
    .select({ at: workerLaneHeartbeatsTable.lastTickCompletedAt })
    .from(workerLaneHeartbeatsTable)
    .where(and(
      sql`${workerLaneHeartbeatsTable.instanceId} = ${TASK_INSTANCE_ID}`,
      sql`${workerLaneHeartbeatsTable.lane} = ${taskLane(id)}`,
    ));
  return row?.at ? new Date(row.at) : null;
}

/** Test seam: forget the per-process write throttle, and optionally move this process's start. */
export function __resetTaskRecordThrottleForTest(startedAt?: Date): void {
  lastRecordedAt.clear();
  if (startedAt) processStartedAt = startedAt;
}
