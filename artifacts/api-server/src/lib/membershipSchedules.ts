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
 * and needs a manual correction through the admin grant surface. That is a
 * strictly smaller guarantee than the model itself makes, not a defect in it:
 * every path that DOES receive its event is still authoritative, fenced and
 * idempotent.
 */

import { loadMembershipConfig } from "./membershipTiming.js";
import { sweepExpiredGrace } from "./membershipGraceSweep.js";
import { logger } from "./logger.js";

let lastSuccessfulSweepAt = Date.now();

/** Exposed for the health surface and for tests that advance a fake clock. */
export function graceSweepStaleSeconds(now: number = Date.now()): number {
  return Math.floor((now - lastSuccessfulSweepAt) / 1000);
}

export async function runGraceSweepOnce(opts: { asOf?: Date } = {}): Promise<void> {
  const config = await loadMembershipConfig();
  try {
    const result = await sweepExpiredGrace(opts);
    lastSuccessfulSweepAt = (opts.asOf ?? new Date()).getTime();
    if (result.converged > 0) {
      logger.info(result, "grace sweep converged stored tiers");
    }
  } catch (err) {
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
    void runGraceSweepOnce();
  }, config.grace_sweep_interval_seconds * 1000).unref();

  logger.info(
    {
      graceSweepIntervalSeconds: config.grace_sweep_interval_seconds,
    },
    "membership grace sweep scheduled",
  );
}
