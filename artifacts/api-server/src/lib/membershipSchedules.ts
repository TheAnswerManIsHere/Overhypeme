/**
 * The recurring membership job: the grace convergence sweep.
 *
 * It converges a stored projection the read path already enforces correctly, so
 * lateness is cosmetic. Hourly, and cheap — it makes no Stripe calls.
 *
 * It carries an alert: if it keeps failing, nobody loses access late — the read
 * path still demotes on the deadline — but the stored tier drifts, and that is
 * what the alert surfaces. A guarantee that depended on this job being healthy
 * would not be a guarantee, which is exactly why it does not.
 *
 * **Reconciliation used to be scheduled here too and is deferred** (PR #287).
 * It repaired SOURCE state that nothing else discovers — the answer to "what if
 * the event never arrives at all" — and its absence is a known, accepted gap:
 * a webhook Stripe never successfully delivers is not repaired automatically,
 * and — in the direction that costs money — cannot be repaired by hand either:
 * the admin surface grants and revokes ADMIN GRANTS, so it can restore access
 * wrongly lost but cannot mark a stale Stripe subscription cancelled or a stale
 * purchase refunded. That is a strictly smaller guarantee than the model itself
 * makes, not a defect in it: every path that DOES receive its event is still
 * authoritative, fenced and idempotent.
 */

import { loadMembershipConfig } from "./membershipTiming.js";
import { sweepExpiredGrace } from "./membershipGraceSweep.js";
import { logger } from "./logger.js";

/**
 * Null until a sweep has actually succeeded.
 *
 * Seeding this with the process start time invented a success that never
 * happened: the panel read "Healthy · last converged just now" while no sweep
 * had run, and — worse — every restart reset the alert clock, so redeploys could
 * mask a sweep that never succeeds indefinitely. Staleness is therefore measured
 * from process start only for the purpose of the alert threshold, and reported
 * as an explicit never-run state.
 */
let lastSuccessfulSweepAt: number | null = null;
const processStartedAt = Date.now();
let lastRunAt: number | null = null;
/** One sweep at a time. See `scheduleMembershipJobs`. */
let sweepInFlight = false;
let lastConverged: number | null = null;
let lastError: string | null = null;
let consecutiveFailures = 0;

/** Exposed for the health surface and for tests that advance a fake clock. */
export function graceSweepStaleSeconds(now: number = Date.now()): number {
  return Math.floor((now - (lastSuccessfulSweepAt ?? processStartedAt)) / 1000);
}

export interface GraceSweepHealth {
  intervalSeconds: number;
  alertAfterSeconds: number;
  staleSeconds: number;
  /** True once the sweep has been failing longer than its alert threshold. */
  alerting: boolean;
  lastRunAt: string | null;
  /** Null when no sweep has succeeded in this process — never a fabricated timestamp. */
  lastSuccessAt: string | null;
  /** True until the first successful sweep; `staleSeconds` then counts from process start. */
  neverRun: boolean;
  lastConvergedCount: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/**
 * The AGGREGATE altitude for the sweep.
 *
 * A background job that reports only through log lines is invisible from the
 * product, which is what the two-altitude rule exists to prevent. This is the
 * top half; `driftedMembershipUsers` is the per-item half.
 *
 * In-process state, deliberately: the sweep repairs a projection the read path
 * already enforces, so its history is operational rather than a durable record
 * anything depends on — and a restart resetting it is honest, because the sweep
 * schedule resets with it.
 */
export async function graceSweepHealth(now: number = Date.now()): Promise<GraceSweepHealth> {
  const config = await loadMembershipConfig();
  const staleSeconds = graceSweepStaleSeconds(now);
  return {
    intervalSeconds: config.grace_sweep_interval_seconds,
    alertAfterSeconds: config.grace_sweep_alert_after_seconds,
    staleSeconds,
    alerting: staleSeconds >= config.grace_sweep_alert_after_seconds,
    lastRunAt: lastRunAt === null ? null : new Date(lastRunAt).toISOString(),
    lastSuccessAt: lastSuccessfulSweepAt === null ? null : new Date(lastSuccessfulSweepAt).toISOString(),
    neverRun: lastSuccessfulSweepAt === null,
    lastConvergedCount: lastConverged,
    lastError,
    consecutiveFailures,
  };
}

export async function runGraceSweepOnce(opts: { asOf?: Date } = {}): Promise<void> {
  const config = await loadMembershipConfig();
  lastRunAt = (opts.asOf ?? new Date()).getTime();
  try {
    const result = await sweepExpiredGrace(opts);
    lastSuccessfulSweepAt = (opts.asOf ?? new Date()).getTime();
    lastConverged = result.converged;
    lastError = null;
    consecutiveFailures = 0;
    if (result.converged > 0) {
      logger.info(result, "grace sweep converged stored tiers");
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message.slice(0, 400) : String(err);
    consecutiveFailures += 1;
    const staleFor = graceSweepStaleSeconds((opts.asOf ?? new Date()).getTime());
    if (staleFor >= config.grace_sweep_alert_after_seconds) {
      // Reported, not escalated into an outage: access was already revoked on
      // the deadline by the read path. What is broken is the accuracy of the
      // stored value, and an operator needs to know that — bounded failure with
      // an alert beats an unbounded retry that expires nobody.
      logger.error(
        { err, staleForSeconds: staleFor, threshold: config.grace_sweep_alert_after_seconds },
        "grace sweep has been failing past its alert threshold — stored membership tiers are drifting " +
          "from what authorization enforces",
      );
    } else {
      logger.warn({ err, staleForSeconds: staleFor }, "grace sweep failed");
    }
  }
}

/**
 * Arm the sweep. The interval is read once at boot; changing the cadence takes
 * effect on the next deploy, which is the same contract every other interval in
 * this process has.
 */
export async function scheduleMembershipJobs(): Promise<void> {
  const config = await loadMembershipConfig();

  setInterval(() => {
    // One at a time. The interval is operator-tunable down to a second while a
    // run performs up to 500 sequential recompute transactions, so a slow sweep
    // would otherwise have the next tick start on top of it — concurrent
    // recomputes of the same users, unbounded accumulating work, and racing
    // writes to the shared health counters. A skipped tick is harmless: the
    // sweep converges a projection the read path already enforces.
    if (sweepInFlight) {
      logger.warn("grace sweep tick skipped — the previous run is still in flight");
      return;
    }
    sweepInFlight = true;
    void runGraceSweepOnce().finally(() => {
      sweepInFlight = false;
    });
  }, config.grace_sweep_interval_seconds * 1000).unref();

  logger.info(
    {
      graceSweepIntervalSeconds: config.grace_sweep_interval_seconds,
    },
    "membership grace sweep scheduled",
  );
}
