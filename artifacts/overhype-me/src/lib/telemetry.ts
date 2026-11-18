/**
 * @purpose The one startup entry point for everything the browser sends to a third party about a visit — error monitoring (Sentry) and analytics (GA4, PostHog) — so Phase 14's visitor-admission check (PLAN_PHASE14_COMPLIANCE.md, S-e2) has one place to gate. Until that check lands, it starts both on load.
 * @subsystem public-site
 */
import { startMonitoring } from "./sentry";
import { startAnalytics } from "./analytics";

let started = false;

export function startTelemetry(): void {
  if (started) return;
  started = true;
  startMonitoring();
  startAnalytics();
}
