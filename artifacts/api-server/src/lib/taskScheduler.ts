/**
 * @purpose The one scheduler every recurring task in index.ts runs on, so a task's first run after a start, its retry after a failure and its completion record follow the inventory (recurringTasks.ts) instead of each timer's own copy of them.
 * @subsystem operations
 *
 * Why it exists (Issues #1061, #1086, #1076): the health check calls a task
 * overdue when its last completed run is older than its cadence plus a grace.
 * Three separate routes each paged "site down" with nothing stopped, all
 * because a timer waited a full cadence where the inventory's rules said it
 * would not: after a failed run, after a process start, and after a run whose
 * completion record failed to save. Here those three are one rule each,
 * stated once:
 *
 *  - the first run comes `taskFirstRunMs` after a start (the earliest of the
 *    steps sharing the timer);
 *  - a run counts as done only when its work finished AND its completion was
 *    recorded; otherwise the next attempt comes `RETRY_AFTER_FAILURE_MS`
 *    later, not a cadence later (every task here is safe to run again);
 *  - otherwise the next run is the cadence away, or the step's own follow-up
 *    (a backlog), or the wall clock's next mark for a clock-aligned task.
 *
 * The timer and the recorder are injectable so a test can drive the rules
 * without a clock or a database.
 */
import { logger } from "./logger";
import {
  nextRunDelayMs,
  recordTaskCompleted,
  taskFirstRunMs,
  type RecurringTaskId,
} from "./recurringTasks";

export interface TaskStep {
  id: RecurringTaskId;
  /** The work. Throw on failure. May ask for an earlier follow-up (a backlog still draining). */
  run: () => Promise<void | { followUpMs?: number }>;
  /** Set where the step records its own completion (its record is part of what makes it safe to repeat); the scheduler then does not. */
  recordsItself?: boolean;
  /** Logged at error level with the error when the work throws; omitted where the step reports its own failures. */
  failureMessage?: string;
}

export interface ScheduleOptions {
  /** One or more tasks sharing a timer, run in order; one failing does not stop the others. */
  steps: TaskStep[];
  /** The cadence after a fully successful run. */
  cadenceMs: number;
  /** For a task pinned to the wall clock: the wait from now to its next mark, used in place of the cadence. */
  nextMarkMs?: () => number;
  /** Test seams. */
  setTimer?: (fn: () => void, ms: number) => void;
  record?: (id: RecurringTaskId) => Promise<boolean>;
}

const defaultTimer = (fn: () => void, ms: number): void => {
  setTimeout(fn, ms).unref();
};

/** Runs the steps once and returns the delay before the next run. Exported for tests. */
export async function runStepsOnce(opts: ScheduleOptions): Promise<number> {
  const record = opts.record ?? recordTaskCompleted;
  let allDone = true;
  let followUpMs: number | undefined;
  for (const step of opts.steps) {
    try {
      const result = await step.run();
      if (result && typeof result.followUpMs === "number") {
        followUpMs = Math.min(followUpMs ?? Infinity, result.followUpMs);
      }
    } catch (err) {
      allDone = false;
      if (step.failureMessage) logger.error({ err, task: step.id }, step.failureMessage);
      continue;
    }
    // The work is done; it counts only once the health check can see it.
    if (!step.recordsItself && !(await record(step.id))) allDone = false;
  }
  if (!allDone) return nextRunDelayMs(false, opts.cadenceMs);
  if (followUpMs !== undefined) return followUpMs;
  return opts.nextMarkMs ? opts.nextMarkMs() : opts.cadenceMs;
}

/** Arms the steps: first run per the inventory, then on the rules above, for the life of the process. */
export function scheduleRecurringTask(opts: ScheduleOptions): void {
  const setTimer = opts.setTimer ?? defaultTimer;
  // Never later than the cadence itself (an operator can tune a cadence below a first-run delay).
  const firstMs = Math.min(opts.cadenceMs, ...opts.steps.map((s) => taskFirstRunMs(s.id)));
  const arm = (delayMs: number) => {
    setTimer(() => {
      void runStepsOnce(opts)
        .catch((err: unknown) => {
          // runStepsOnce guards each step; this is the boundary for anything else.
          logger.error({ err }, "recurring task scheduler failed outside a step");
          return nextRunDelayMs(false, opts.cadenceMs);
        })
        .then(arm);
    }, delayMs);
  };
  arm(firstMs);
}

/** Milliseconds from now to the next top of the hour (UTC). */
export function msUntilNextTopOfHour(now = new Date()): number {
  const next = new Date(now.getTime());
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime() - now.getTime();
}
