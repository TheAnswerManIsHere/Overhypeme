/**
 * @purpose The "job stopped or wedged" drill: a background job, started from the admin Operations page, that holds its slot without finishing, so the health check can be seen turning unhealthy and the phone alert arriving.
 * @subsystem operations
 *
 * Launch Phase 16 (Issue #1029; plan design G, "the fault-injection
 * afternoon"). No fault endpoint ships; this is the controlled stand-in for a
 * wedged job. It spends nothing and grants nothing: it waits, and ends itself
 * successfully at its time limit. While it is held past `alertWhenHeldMs` the
 * combined health address answers 503, which is the alert under test.
 *
 * At most one runs at a time (a dedupe key), on the bulk lane, and it is never
 * retried: a server that stops mid-drill puts it back for one more run at most.
 */
import { enqueueJob, registerJobHandler, type JobHandler } from "./asyncJobs";
import { jobAbortSignal } from "./jobFence";

export const OPERATIONS_DRILL_QUEUE = "operations_drill";
/** How long the drill holds its slot before ending itself. */
export const DRILL_HOLD_MS = 10 * 60_000;
/** When the health check reads the drill as wedged: well before it ends. */
export const DRILL_ALERT_WHEN_HELD_MS = 2 * 60_000;

const realWait = (ms: number, signal: AbortSignal | undefined): Promise<"held" | "stopped"> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve("stopped");
    const t = setTimeout(() => resolve("held"), ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve("stopped"); }, { once: true });
  });
/** Test seam: the wait, so a test need not take ten minutes. */
let wait = realWait;
export function __setDrillWaitForTest(fn: typeof realWait | null): void {
  wait = fn ?? realWait;
}

const drillHandler: JobHandler = {
  async run() {
    const outcome = await wait(DRILL_HOLD_MS, jobAbortSignal());
    return { ok: true, result: { drill: outcome === "held" ? "ended at its time limit" : "stopped" } };
  },
};

export function registerOperationsDrillHandler(): void {
  registerJobHandler(OPERATIONS_DRILL_QUEUE, drillHandler, {
    lane: "bulk",
    executionLimitMs: DRILL_HOLD_MS + 2 * 60_000,
    alertWhenHeldMs: DRILL_ALERT_WHEN_HELD_MS,
  });
}

/** Start the drill. A drill already queued or running is returned instead of a second. */
export async function startOperationsDrill(): Promise<{ jobId: number; alreadyRunning: boolean }> {
  const r = await enqueueJob({
    queue: OPERATIONS_DRILL_QUEUE,
    payload: { startedAt: new Date().toISOString() },
    dedupeKey: "operations-drill",
    maxAttempts: 1,
  });
  return { jobId: r.jobId, alreadyRunning: !r.inserted };
}
