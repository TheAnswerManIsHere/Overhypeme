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
 *
 * Repeats of one source are throttled by the Sentry rule (one push per five
 * minutes per source), not here: an in-process cooldown would not be shared
 * across autoscaled servers.
 */
import * as Sentry from "@sentry/node";
import { logger } from "./logger";

/**
 * Every source of an operational alert, defined once: its title (the push
 * body, and how the Operations page recognises the incident), its label on
 * that page, and its Sentry level. One Sentry issue per source.
 */
const SOURCES = {
  test: { title: "Test alert from the Operations page", label: "Test alert", level: "error" },
  job_failed: { title: "A background job failed for good", label: "Job failed", level: "error" },
  job_interrupted: { title: "A background job was interrupted and resumed", label: "Job interrupted", level: "warning" },
  payment_webhook_failed: { title: "A Stripe webhook could not be processed", label: "Payment webhook", level: "error" },
  unrecorded_spend: { title: "Spend could not be recorded after a paid call", label: "Spend not recorded", level: "error" },
} as const satisfies Record<string, { title: string; label: string; level: "error" | "warning" }>;

export type AlertSource = keyof typeof SOURCES;
export const ALERT_SOURCES = Object.keys(SOURCES) as AlertSource[];

export function alertTitle(source: AlertSource): string {
  return SOURCES[source].title;
}

export function alertLabel(source: AlertSource): string {
  return SOURCES[source].label;
}

/** The source whose title this is, if any. */
const SOURCE_BY_TITLE = new Map<string, AlertSource>(ALERT_SOURCES.map((s) => [SOURCES[s].title, s]));
export function alertSourceForTitle(title: string | undefined): AlertSource | null {
  return (title && SOURCE_BY_TITLE.get(title)) || null;
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
    capture(SOURCES[source].title, {
      level: SOURCES[source].level,
      fingerprint: ["operational-alert", source],
      tags: { alert_source: source },
      extra: detail,
    });
  } catch (err) {
    logger.error({ err, source }, "[operationalAlerts] could not report an operational alert");
  }
}
