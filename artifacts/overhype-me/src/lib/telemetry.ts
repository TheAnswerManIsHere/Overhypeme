/**
 * @purpose The one startup entry point for everything the browser sends to a third party about a visit — error monitoring (Sentry), analytics (GA4, PostHog) and ads (AdSense) — called only by lib/admission.ts once the API has admitted the visit (launch Phase 14, increment 3, plan S-e2).
 * @subsystem public-site
 */
import { startMonitoring } from "./sentry";
import { startAnalytics } from "./analytics";

declare global {
  interface Window {
    /** Defined by index.html's adsense-init script; loads AdSense when it is configured. */
    __ohStartAds?: () => void;
  }
}

/** Each part is idempotent, so calling this twice starts nothing twice. */
export function startTelemetry(): void {
  startMonitoring();
  startAnalytics();
  window.__ohStartAds?.();
}
