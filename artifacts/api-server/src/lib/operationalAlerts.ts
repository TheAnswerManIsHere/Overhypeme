/**
 * @purpose Report a failure that throws nothing to Sentry, where an alert rule turns it into a push on David's phone.
 * @subsystem operations
 *
 * Launch Phase 16 (Issue #1029; plan `docs/plans/PLAN_PHASE16_ANALYTICS_OPERATIONS.md`,
 * design A, "detector kind 2"). Every report carries the tag `alert_source`,
 * and the Sentry rule "Phone: operational alert" fires on any production event
 * that has it. Each source has its own fingerprint, so each is one Sentry
 * issue whose history is the alert history (no alert table: decision taken
 * on the plan's recommendation).
 *
 * Two rules hold for every caller, and this module is where they are kept:
 *  - **No database write is on this path.** The failure being reported may be
 *    the database itself.
 *  - **It never throws and never waits.** A report that fails is logged and
 *    dropped; the work being reported on carries on unaffected.
 */
import * as Sentry from "@sentry/node";
import { logger } from "./logger";

/** Every source of an operational alert. One Sentry issue per source. */
export const ALERT_SOURCES = [
  "test",
  "job_failed",
  "job_interrupted",
  "payment_webhook_failed",
  "unrecorded_spend",
] as const;
export type AlertSource = (typeof ALERT_SOURCES)[number];

/** Short, fixed titles: the push body is the Sentry event title. */
const TITLES: Record<AlertSource, string> = {
  test: "Test alert from the Operations page",
  job_failed: "A background job failed for good",
  job_interrupted: "A background job was interrupted and resumed",
  payment_webhook_failed: "A Stripe webhook could not be processed",
  unrecorded_spend: "Spend could not be recorded after a paid call",
};

export function alertTitle(source: AlertSource): string {
  return TITLES[source];
}

/** The capture function, swappable in tests. */
type Capture = (message: string, context: Parameters<typeof Sentry.captureMessage>[1]) => unknown;
let capture: Capture = (message, context) => Sentry.captureMessage(message, context);

export function __setAlertCaptureForTest(fn: Capture | null): void {
  capture = fn ?? ((message, context) => Sentry.captureMessage(message, context));
}

/**
 * Report one operational failure. `detail` holds short, non-personal facts
 * (ids, queue names, counts) that help David act; never an email address,
 * a name or a payload.
 */
export function reportOperationalAlert(
  source: AlertSource,
  detail: Record<string, string | number | boolean | null> = {},
): void {
  try {
    capture(TITLES[source], {
      level: source === "job_interrupted" ? "warning" : "error",
      fingerprint: ["operational-alert", source],
      tags: { alert_source: source },
      extra: detail,
    });
  } catch (err) {
    logger.error({ err, source }, "[operationalAlerts] could not report an operational alert");
  }
}
