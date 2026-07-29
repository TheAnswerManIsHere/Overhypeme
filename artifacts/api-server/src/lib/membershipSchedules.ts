/**
 * The two recurring membership jobs, with a cadence, a home and a default each.
 *
 * They are deliberately separate settings rather than one shared value, because
 * they do different jobs:
 *
 *   - the **grace sweep** converges a stored projection the read path already
 *     enforces correctly, so lateness is cosmetic. Hourly, and cheap.
 *   - **reconciliation** repairs SOURCE state that nothing else will discover, so
 *     lateness is a correctness window. Six-hourly, because it enumerates Stripe.
 *
 * The sweep also carries an alert: if it keeps failing, nobody loses access late
 * — the read path still demotes on the deadline — but the stored tier drifts, and
 * that is what the alert surfaces. A guarantee that depended on this job being
 * healthy would not be a guarantee, which is exactly why it does not.
 */

import { loadMembershipConfig } from "./membershipTiming.js";
import { reconcileMemberships, sweepExpiredGrace } from "./membershipReconcile.js";
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

export async function runReconciliationOnce(): Promise<void> {
  try {
    const { getUncachableStripeClient } = await import("./stripeClient.js");
    const stripe = await getUncachableStripeClient();
    // Scheduled runs APPLY. The dry-run default protects a human invoking the
    // script by hand; a job that never writes would repair nothing.
    const report = await reconcileMemberships(stripe, { apply: true });
    logger.info({ ...report, staged: report.staged.length }, "membership reconciliation complete");
  } catch (err) {
    logger.error({ err }, "membership reconciliation failed");
  }
}

/**
 * Arm both schedules. Intervals are read once at boot; changing a cadence takes
 * effect on the next deploy, which is the same contract every other interval in
 * this process has.
 */
export async function scheduleMembershipJobs(): Promise<void> {
  const config = await loadMembershipConfig();

  setInterval(() => {
    void runGraceSweepOnce();
  }, config.grace_sweep_interval_seconds * 1000).unref();

  setInterval(() => {
    void runReconciliationOnce();
  }, config.reconcile_interval_seconds * 1000).unref();

  logger.info(
    {
      graceSweepIntervalSeconds: config.grace_sweep_interval_seconds,
      reconcileIntervalSeconds: config.reconcile_interval_seconds,
    },
    "membership jobs scheduled",
  );
}
